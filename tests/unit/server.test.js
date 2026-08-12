// The server is the session, so a fault has nowhere to go: there is no second
// copy of pi and restarting means losing it. These are the paths where one
// viewer could take the rest down with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createTerminalServer } from '../../server/index.js'
import { Mirror } from '../../server/mirror.js'

const start = async (command = 'tests/fixtures/fake-pi.sh', args = []) => {
  const server = createTerminalServer({
    port: 0, bind: '127.0.0.1', index: 'dist/client.html', command, args,
  })
  await new Promise(r => server.http.on('listening', r))
  return { server, url: `ws://127.0.0.1:${server.http.address().port}/ws` }
}

/** Connect, handshake, and report how much screen arrived before it settled. */
const join = (url, handshake = { AuthToken: '', columns: 50, rows: 20 }) => new Promise(resolve => {
  const ws = new WebSocket(url, ['tty'])
  let output = 0
  ws.on('open', () => ws.send(JSON.stringify(handshake)))
  ws.on('message', d => { if (Buffer.from(d)[0] === 0x30) output += Buffer.from(d).length - 1 })
  ws.on('close', code => resolve({ code, output }))
  setTimeout(() => { ws.close(); resolve({ code: null, output }) }, 1200)
})

test('a failed admission costs one viewer, not every viewer after it', async () => {
  const { server, url } = await start()
  const real = Mirror.prototype.snapshot
  let fail = true
  Mirror.prototype.snapshot = function (...a) {
    if (!fail) return real.apply(this, a)
    fail = false
    throw new Error('rigged')
  }
  try {
    const broken = await join(url)
    assert.equal(broken.code, 1011, 'the viewer whose snapshot failed is closed')
    assert.equal(broken.output, 0)

    // Admissions are serialized through one promise, so a rejection left
    // unhandled would skip the body for every viewer that followed.
    const after = await join(url)
    assert.equal(after.code, null, 'the next viewer stays connected')
    assert.ok(after.output > 0, 'the next viewer gets a screen')
  } finally {
    Mirror.prototype.snapshot = real
    await server.close()
  }
})

test('a nonsense handshake closes that socket and nothing else', async () => {
  const { server, url } = await start()
  try {
    const bad = await join(url, { AuthToken: '', columns: 'wide', rows: null })
    assert.equal(bad.code, 1002)

    const good = await join(url)
    assert.ok(good.output > 0, 'a later viewer is unaffected')
  } finally { await server.close() }
})

test('a resize arriving after the program exits does not take the server down', async () => {
  const { Session } = await import('../../server/session.js')
  const session = new Session({ command: 'sh', args: ['-c', 'exit 0'], cols: 80, rows: 24 })
  session.viewers.add({ size: { cols: 40, rows: 12 } })
  await new Promise(resolve => { session.onExit = resolve })
  await new Promise(resolve => setTimeout(resolve, 150))

  // Viewers outlive the program by however long their sockets take to close, so
  // a coalesced resize can land on a closed PTY — which throws EBADF from a
  // timer, where nothing can catch it and the process is the session.
  assert.doesNotThrow(() => session.fit())
})

/** Connect, ask for a size, and collect every grid the server reports. */
const viewer = (url, columns, rows) => {
  const seen = []
  const ws = new WebSocket(url, ['tty'])
  ws.on('open', () => ws.send(JSON.stringify({ AuthToken: '', columns, rows })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x33) seen.push(JSON.parse(buf.subarray(1)))
  })
  return { seen, close: () => ws.close() }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 500))

test('the narrowest viewer sets the grid, and leaving hands it back', async () => {
  const { server, url } = await start()
  const wide = viewer(url, 100, 30)
  await settle()
  assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'alone, a viewer gets what it asked for')

  const narrow = viewer(url, 40, 12)
  await settle()
  assert.deepEqual(narrow.seen.at(-1), { columns: 40, rows: 12 })
  assert.deepEqual(wide.seen.at(-1), { columns: 40, rows: 12 }, 'the wide viewer is told it lost')

  narrow.close()
  await settle()
  assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'and told again when it wins it back')

  wide.close()
  await server.close()
})

/** Render everything a viewer is sent, the way the phone's core would. */
const rendering = async url => {
  const { WasmBridge } = await import('@wterm/core')
  const core = await WasmBridge.load()
  core.init(80, 24)
  const ws = new WebSocket(url, ['tty'])
  ws.on('open', () => ws.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) core.writeRaw(buf.subarray(1))
    if (buf[0] === 0x33) {
      const { columns, rows } = JSON.parse(buf.subarray(1))
      if (columns !== core.getCols() || rows !== core.getRows()) core.resize(columns, rows)
    }
  })
  // Oldest first: wterm numbers saved rows newest to oldest.
  const history = () => Array.from({ length: core.getScrollbackCount() }, (_, i) =>
    Array.from({ length: core.getCols() }, (_, x) =>
      String.fromCodePoint(core.getScrollbackCell(i, x).char || 32)).join('').trimEnd()).reverse()
  return { history, close: () => ws.close() }
}

test('a resize leaves every viewer with the same history, whenever it joined', async () => {
  // Print a page of history and go quiet, so nothing redraws over the evidence.
  const lines = Array.from({ length: 60 }, (_, n) => `L${String(n).padStart(3, '0')}:${'x'.repeat(70)}`)
  const { server, url } = await start('sh', ['-c', `printf '%s\\n' ${lines.join(' ')}; sleep 30`])

  const early = await rendering(url)
  await settle()

  // A narrower viewer takes the grid. The client core mangles its own history on
  // a column shrink, so a viewer left to reflow diverges from one sent the screen.
  const narrow = viewer(url, 50, 20)
  await settle()
  await settle()

  const late = await rendering(url)

  // Poll rather than sample: both viewers are being served through the same
  // serialized queue, so agreement is what matters, not the instant it arrives.
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      assert.deepEqual(early.history(), late.history())
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  assert.deepEqual(early.history(), late.history(),
    'a viewer resized into the grid and one that arrived at it never agree')

  narrow.close(); early.close(); late.close()
  await server.close()
})
