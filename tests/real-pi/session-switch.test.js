import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createSupervisor } from '../../server/supervisor.js'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    const result = await check()
    if (result) return result
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const joinProcess = async (url, processId) => {
  const ws = new WebSocket(`${url}?process=${processId}`, ['tty'])
  let output = ''
  ws.on('message', data => {
    const frame = Buffer.from(data)
    if (frame[0] === 0x30) output += frame.subarray(1).toString()
  })
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail) })
  ws.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }))
  return { ws, output: () => output, input: text => ws.send(Buffer.concat([Buffer.from([0x30]), Buffer.from(text)])) }
}

test('pi /new and resume change conversation without changing the running terminal', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mtty-switch-'))
  const cwd = await realpath(root)
  const sessionDir = join(root, 'sessions')
  const socketDir = join(root, 'sockets')
  await mkdir(sessionDir)
  await mkdir(socketDir)
  const id = randomUUID()
  await writeFile(join(sessionDir, `${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)
  const saved = {
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
  }
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  const supervisor = createSupervisor({
    port: 0, bind: '127.0.0.1', socketDir, sessionDir, newDir: root,
    command: process.env.MOBILE_TTY_PI ?? 'pi',
    cliPath: fileURLToPath(new URL('../../server/cli.js', import.meta.url)),
    args: ['-ne', '--offline', '--no-builtin-tools', '--no-skills', '--no-prompt-templates',
      '--no-themes', '--no-context-files', '--no-approve', '-e', resolve('tests/real-pi/fixture-extension.ts')],
  })
  const viewers = []
  try {
    await new Promise(done => supervisor.http.on('listening', done))
    const base = `http://127.0.0.1:${supervisor.http.address().port}`
    const list = async () => (await (await fetch(`${base}/places`)).json()).sessions
    const before = await until(async () => (await list()).find(row => row.id === id), 'seeded conversation')
    const wsUrl = `ws://127.0.0.1:${supervisor.http.address().port}/ws`
    const started = new WebSocket(`${wsUrl}?session=${id}&cwd=${encodeURIComponent(cwd)}`, ['tty'])
    viewers.push(started)
    await new Promise((done, fail) => { started.once('open', done); started.once('error', fail) })
    started.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }))
    const live = await until(async () => (await list()).find(row => row.id === id && row.processId), 'running pi')
    let output = ''
    const identities = []
    started.on('message', data => {
      const frame = Buffer.from(data)
      if (frame[0] === 0x30) output += frame.subarray(1).toString()
      if (frame[0] === 0x35) identities.push(JSON.parse(frame.subarray(1).toString()))
    })
    await until(() => output.includes('MTTY_EXTENSION_READY'), 'pi startup')
    started.send(Buffer.concat([Buffer.from([0x30]), Buffer.from('/new\r')]))
    const switched = await until(async () => (await list()).find(row => row.processId === live.processId && row.id !== id), 'new conversation in the same PTY')
    assert.notEqual(switched.id, before.id)
    await until(() => identities.some(identity => identity.id === switched.id && identity.processId === live.processId), 'switch reported to attached viewer')
    assert.equal((await list()).find(row => row.id === id).running, false)
    const again = await joinProcess(wsUrl, live.processId)
    viewers.push(again.ws)
    await until(() => again.output().length > 0, 'rejoining the same process')
    assert.equal((await list()).find(row => row.id === switched.id).processId, live.processId)
    started.send(Buffer.concat([Buffer.from([0x30]), Buffer.from(`/mtty-resume ${join(sessionDir, `${id}.jsonl`)}\r`)]))
    await until(async () => (await list()).find(row => row.id === id && row.processId === live.processId), 'resumed conversation in the same PTY')
    await until(() => identities.some(identity => identity.id === id && identity.processId === live.processId), 'resume reported to attached viewer')
    assert.equal(supervisor.registry.running().length, 1)

    const otherId = randomUUID()
    const otherFile = join(sessionDir, `${otherId}.jsonl`)
    await writeFile(otherFile, `${JSON.stringify({ type: 'session', version: 3, id: otherId, cwd })}\n`)
    const other = new WebSocket(`${wsUrl}?session=${otherId}&cwd=${encodeURIComponent(cwd)}`, ['tty'])
    viewers.push(other)
    await new Promise((done, fail) => { other.once('open', done); other.once('error', fail) })
    let otherOutput = ''
    other.on('message', data => { if (Buffer.from(data)[0] === 0x30) otherOutput += Buffer.from(data).subarray(1).toString() })
    other.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }))
    await until(() => otherOutput.includes('MTTY_EXTENSION_READY'), 'second pi startup')
    const owner = await until(async () => (await list()).find(row => row.id === otherId && row.processId), 'second conversation owner')
    started.send(Buffer.concat([Buffer.from([0x30]), Buffer.from(`/mtty-resume ${otherFile}\r`)]))
    started.send(Buffer.concat([Buffer.from([0x30]), Buffer.from('/mtty-mark after-conflict\r')]))
    await until(() => output.includes('MTTY_MARK_AFTER_CONFLICT'), 'first pi to finish the refused switch')
    assert.equal((await list()).find(row => row.id === id).processId, live.processId)
    assert.equal((await list()).find(row => row.id === otherId).processId, owner.processId)
  } finally {
    for (const ws of viewers) ws.terminate()
    await supervisor.close()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
