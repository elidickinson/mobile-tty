// The server is the session, so a fault has nowhere to go: there is no second
// copy of pi and restarting means losing it. These are the paths where one
// viewer could take the rest down with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocket } from 'ws'
import { createTerminalServer } from '../../server/index.js'
import { Mirror } from '../../server/mirror.js'

const start = async (command = 'tests/fixtures/fake-pi.sh', args = [], options = {}) => {
  const server = createTerminalServer({ port: 0, bind: '127.0.0.1', command, args, ...options })
  await new Promise(r => server.http.on('listening', r))
  const { port } = server.http.address()
  return { server, url: `ws://127.0.0.1:${port}/ws`, page: `http://127.0.0.1:${port}/` }
}

/** Just the handshake: was this socket let up at all? */
const handshake = (url, options) => new Promise(resolve => {
  const ws = new WebSocket(url, ['tty'], options)
  ws.on('open', () => { ws.close(); resolve('opened') })
  ws.on('error', () => resolve('refused'))
})

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

const settle = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms))

test('the status strip: relayed on change, replayed to latecomers', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'mobile-tty-footer-'))
  const footerPath = pathJoin(dir, 'footer.json')
  const { server, url } = await start('sh', ['-c', 'sleep 60'], { footerPath })
  const frames = []
  const stripViewer = () => {
    const ws = new WebSocket(url, ['tty'])
    ws.on('open', () => ws.send(JSON.stringify({ AuthToken: '', columns: 50, rows: 20 })))
    ws.on('message', d => {
      if (Buffer.from(d)[0] === 0x34) frames.push(Buffer.from(d).subarray(1).toString())
    })
    return ws
  }
  try {
    const first = stripViewer()
    await settle()
    assert.equal(frames.length, 0, 'nothing until the program writes one')

    await writeFile(footerPath, JSON.stringify({ ts: 1, text: 'first' }))
    await settle(700)
    assert.deepEqual(frames, ['{"ts":1,"text":"first"}'])

    // The same content under a new mtime is not broadcast again.
    await writeFile(footerPath, JSON.stringify({ ts: 1, text: 'first' }))
    await settle(700)
    assert.equal(frames.length, 1)

    await writeFile(footerPath, JSON.stringify({ ts: 3, text: 'second' }))
    await settle(700)
    assert.equal(frames.length, 2, 'the changed line reaches the same viewer')

    // A viewer arriving after the fact gets the latest line after its screen.
    const late = stripViewer()
    await settle(700)
    assert.deepEqual(frames.at(-1), '{"ts":3,"text":"second"}')
    first.close()
    late.close()
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the narrowest viewer sets the grid, and leaving hands it back', async () => {
  const { server, url } = await start()
  const wide = viewer(url, 100, 30)
  let narrow
  try {
    await settle()
    assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'alone, a viewer gets what it asked for')

    narrow = viewer(url, 40, 12)
    await settle()
    assert.deepEqual(narrow.seen.at(-1), { columns: 40, rows: 12 })
    assert.deepEqual(wide.seen.at(-1), { columns: 40, rows: 12 }, 'the wide viewer is told it lost')

    narrow.close()
    await settle()
    assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'and told again when it wins it back')
  } finally {
    narrow?.close()
    wide.close()
    await server.close()
  }
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

  let narrow, early, late
  try {
    early = await rendering(url)
    await settle()

    // A narrower viewer takes the grid. The client core mangles its own history on
    // a column shrink, so a viewer left to reflow diverges from one sent the screen.
    narrow = viewer(url, 50, 20)
    await settle()
    await settle()

    late = await rendering(url)

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
  } finally {
    narrow?.close(); early?.close(); late?.close()
    await server.close()
  }
})

test('the document validates against its build id, so an unchanged client costs a 304', async () => {
  const { server, page } = await start()
  try {
    const first = await fetch(page)
    const etag = first.headers.get('etag')
    assert.equal(first.status, 200)
    assert.ok(etag, 'the document carries a validator')
    // One value does both jobs: what the cache validates against is what the
    // client compares itself to.
    assert.match(await first.text(), new RegExp(`<meta name="build" content="${etag.slice(1, -1)}">`))

    const again = await fetch(page, { headers: { 'if-none-match': etag } })
    assert.equal(again.status, 304)
  } finally {
    await server.close()
  }
})

test('a socket from another origin never reaches the session', async () => {
  const { server, url } = await start()
  try {
    assert.equal(await handshake(url, { origin: 'http://evil.example' }), 'refused',
      'a hostile page got a terminal')
  } finally {
    await server.close()
  }
})

test('a password puts a login in front of both the page and the socket', async () => {
  const { server, url, page } = await start(undefined, [], { password: 'hunter2' })
  const submit = password => fetch(`${page}login`, {
    method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual',
  })
  try {
    assert.match(await (await fetch(page)).text(), /<form method="post"/,
      'the terminal was served to someone who has not logged in')
    assert.equal(await handshake(url), 'refused')
    assert.equal((await submit('wrong')).status, 401)

    const granted = await submit('hunter2')
    assert.equal(granted.status, 303)
    const cookie = granted.headers.getSetCookie()[0].split(';')[0]

    assert.match(await (await fetch(page, { headers: { cookie } })).text(), /name="build"/)
    assert.equal(await handshake(url, { headers: { cookie } }), 'opened')
  } finally {
    await server.close()
  }
})

test('/login is a 404 when no password is set, and must not reach the compare', async () => {
  const { server, page } = await start()
  try {
    const res = await fetch(`${page}login`, { method: 'POST', body: new URLSearchParams({ password: 'x' }) })
    assert.equal(res.status, 404)
  } finally {
    await server.close()
  }
})

test('a client that abandons its login body costs that connection, not the server', async (t) => {
  const { server, page } = await start(undefined, [], { password: 'hunter2' })
  t.after(() => server.close().catch(() => {}))
  const { port } = server.http.address()

  // Declare a body, send part of it, reset the socket. A phone sleeping
  // mid-login does this; the server must shrug it off, not fall over.
  await new Promise(resolve => {
    const req = http.request({ method: 'POST', port, path: '/login', headers: { 'content-length': 100 }, keepAlive: true })
    req.write('password=hun')
    req.on('socket', () => setTimeout(() => req.destroy(new Error('simulated drop')), 50))
    req.on('error', () => resolve())
    setTimeout(resolve, 600)
  })

  assert.equal(server.http.listening, true, 'a dropped login crashed the server')
  // Reset and recovered: a real one right after is still let in.
  const res = await fetch(`${page}login`, { method: 'POST', body: new URLSearchParams({ password: 'hunter2' }), redirect: 'manual' })
  assert.equal(res.status, 303)
})
