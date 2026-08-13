import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { WasmBridge } from '@wterm/core'
import { createTerminalServer } from '../../server/index.js'

const INPUT = 0x30
const OUTPUT = 0x30
const SET_SIZE = 0x33
const FOOTER = 0x34
const execFileAsync = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (predicate, description, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${description}`)
}

const row = (core, y, saved = false) =>
  Array.from({ length: core.getCols() }, (_, x) => {
    const cell = saved ? core.getScrollbackCell(y, x) : core.getCell(y, x)
    return String.fromCodePoint(cell.char || 32)
  }).join('').trimEnd()

const connectViewer = async (url, columns, rows) => {
  const core = await WasmBridge.load()
  core.init(columns, rows)
  const ws = new WebSocket(url, ['tty'])
  let lastOutput = Date.now()
  let outputCount = 0
  const footers = []

  ws.on('message', data => {
    const frame = Buffer.from(data)
    if (frame[0] === OUTPUT) {
      core.writeRaw(frame.subarray(1))
      lastOutput = Date.now()
      outputCount++
    } else if (frame[0] === SET_SIZE) {
      const size = JSON.parse(frame.subarray(1))
      if (size.columns !== core.getCols() || size.rows !== core.getRows()) {
        core.resize(size.columns, size.rows)
      }
    } else if (frame[0] === FOOTER) {
      footers.push(JSON.parse(frame.subarray(1).toString()))
    }
  })

  await new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ AuthToken: '', columns, rows }))
      resolve()
    })
    ws.once('error', reject)
  })

  const history = () => Array.from({ length: core.getScrollbackCount() }, (_, i) => row(core, i, true)).reverse()
  const screen = () => Array.from({ length: core.getRows() }, (_, i) => row(core, i))
  const text = () => [...history(), ...screen()].join('\n')
  const quiet = (ms = 300) => waitFor(() => Date.now() - lastOutput >= ms, `${ms}ms of terminal quiet`)

  return {
    core,
    history,
    screen,
    text,
    quiet,
    outputCount: () => outputCount,
    footers: () => footers,
    input: text => ws.send(Buffer.concat([Buffer.from([INPUT]), Buffer.from(text)])),
    resize: (cols, nextRows) => ws.send(Buffer.from(`1${JSON.stringify({ columns: cols, rows: nextRows })}`)),
    close: () => ws.terminate(),
  }
}

const fixtureIds = text => [...text.matchAll(/MTTY-LINE-(\d{3})/g)].map(match => Number(match[1]))
const expectedIds = Array.from({ length: 100 }, (_, i) => i)

test('real pi keeps an attached and post-resize viewer coherent', { timeout: 60_000 }, async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'mobile-tty-real-pi-'))
  const extension = resolve('tests/real-pi/fixture-extension.ts')
  const footerExtension = resolve('ext/mtty-footer.ts')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousOffline = process.env.PI_OFFLINE
  const restoreEnvironment = () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
  }

  const startedAt = performance.now()
  const viewers = []
  let piPid
  let piStopped = false
  let server
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_OFFLINE = '1'
    server = createTerminalServer({
      port: 0,
      bind: '127.0.0.1',
      scrollback: 500,
      command: process.env.MOBILE_TTY_PI ?? 'pi',
      args: [
        '-ne', '--offline', '--no-session', '--no-builtin-tools',
        '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
        '--no-approve', '--tui-mode', 'regular',
        '-e', extension, '-e', footerExtension,
      ],
    })
    restoreEnvironment()

    await new Promise(resolve => server.http.on('listening', resolve))
    const url = `ws://127.0.0.1:${server.http.address().port}/ws`

    const early = await connectViewer(url, 80, 24)
    viewers.push(early)
    await waitFor(() => early.text().includes('MTTY_EXTENSION_READY'), 'real pi and test extension startup')
    await waitFor(() => early.footers().length > 0, 'a status-strip frame from the mtty-footer extension')
    const footer = early.footers().at(-1)
    assert.equal(typeof footer.ts, 'number', 'the strip line carries a timestamp')
    assert.ok(footer.text.length > 0, 'the strip line carries pi\'s stats')
    const ready = early.text().match(/MTTY_EXTENSION_READY pid=(\d+)/)
    assert.ok(ready, 'extension readiness marker has the scratch pi PID')
    piPid = Number(ready[1])
    const bootMs = Math.round(performance.now() - startedAt)

    early.input('/mtty-fixture\r')
    await waitFor(() => early.text().includes('MTTY_FIXTURE_DONE'), 'the complete 100-line fixture')
    await early.quiet()
    assert.deepEqual(fixtureIds(early.text()), expectedIds, 'fixture order at 80 columns')

    // Hold Pi before SIGWINCH can repaint. This makes the resize boundary
    // deterministic: the fixed server repairs the attached core from its mirror,
    // while the old server leaves that core's lossy reflow in place.
    process.kill(piPid, 'SIGSTOP')
    piStopped = true
    await waitFor(async () => {
      const { stdout } = await execFileAsync('ps', ['-o', 'state=', '-p', String(piPid)])
      return stdout.trim().startsWith('T')
    }, 'scratch pi to stop')

    early.resize(50, 24)
    await waitFor(() => early.core.getCols() === 50, 'the 50-column server grid')

    const late = await connectViewer(url, 50, 24)
    viewers.push(late)
    await waitFor(() => late.text().includes('MTTY_FIXTURE_DONE'), 'post-resize snapshot')
    await early.quiet()
    await late.quiet()

    assert.deepEqual(late.history(), early.history(), 'attached and post-resize viewer history')
    assert.deepEqual(late.screen(), early.screen(), 'attached and post-resize viewer screen')
    assert.deepEqual(fixtureIds(early.text()), expectedIds, 'fixture order after shrinking to 50 columns')
    assert.deepEqual(fixtureIds(late.text()), expectedIds, 'the snapshot preserves every fixture line in order')
    const boundaryRows = early.history().length

    // Let Pi consume the pending SIGWINCH and perform its real 50-column redraw,
    // then put a marker after that draw before checking the viewers again.
    const beforeRedraw = early.outputCount()
    process.kill(piPid, 'SIGCONT')
    piStopped = false
    await waitFor(() => early.outputCount() > beforeRedraw, 'pi SIGWINCH redraw to begin')
    await early.quiet()
    early.input('/mtty-mark after-resize\r')
    await waitFor(() => early.text().includes('MTTY_MARK_AFTER_RESIZE'), 'post-redraw marker on attached viewer')
    await waitFor(() => late.text().includes('MTTY_MARK_AFTER_RESIZE'), 'post-redraw marker on late viewer')
    await early.quiet()
    await late.quiet()

    assert.deepEqual(late.history(), early.history(), 'viewers after pi redraw')
    assert.deepEqual(late.screen(), early.screen(), 'screens after pi redraw')
    assert.deepEqual(fixtureIds(early.text()), expectedIds, 'pi redraw preserves every fixture line in order')
    assert.ok(early.history().length > 250, `expected deep history, got ${early.history().length} rows`)

    t.diagnostic(`pi boot + extension ready: ${bootMs}ms`)
    t.diagnostic(`50-column history: ${boundaryRows} mirror rows, ${early.history().length} pi-redrawn rows`)
    t.diagnostic(`scratch WebSocket port: ${server.http.address().port}`)
  } finally {
    restoreEnvironment()
    if (piStopped) {
      process.kill(piPid, 'SIGCONT')
      await sleep(50)
    }
    for (const viewer of viewers) viewer.close()
    if (server) await server.close()
    await rm(agentDir, { recursive: true, force: true })
  }
})
