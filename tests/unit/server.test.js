// The server is the session, so a fault has nowhere to go: there is no second
// copy of pi and restarting means losing it. These are the paths where one
// viewer could take the rest down with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocket } from 'ws'
import { createGhosttyCore } from '../ghostty.js'
import { createTerminalServer } from '../../server/index.js'
import { Mirror } from '../../server/mirror.js'

const start = async (command = 'tests/fixtures/fake-pi.js', args = [], options = {}) => {
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

test('shutting down does not wait on a viewer that has stopped answering', async () => {
  const { server, url } = await start()
  const ws = new WebSocket(url, ['tty'])
  await new Promise(resolve => ws.on('open', resolve))
  ws.send(JSON.stringify({ AuthToken: '', columns: 50, rows: 20 }))
  await new Promise(resolve => setTimeout(resolve, 300))

  // A phone asleep behind a dead tunnel: the socket is up and never answers.
  // A close frame would wait 30s for a reply that is not coming, and an
  // upgraded socket holds http.close() open until it goes — so Ctrl-C hangs.
  ws._socket.pause()

  const began = Date.now()
  await server.close()
  assert.ok(Date.now() - began < 5_000, `close() took ${Date.now() - began}ms`)
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
    await writeFile(`${footerPath}.tmp`, 'orphan')
  } finally {
    await server.close()
    await assert.rejects(stat(footerPath), { code: 'ENOENT' })
    await assert.rejects(stat(`${footerPath}.tmp`), { code: 'ENOENT' })
    await rm(dir, { recursive: true, force: true })
  }
})

test('attach avoids a second snapshot reset on a grid change', async () => {
  const { server, url } = await start('sh', ['-c', 'printf ready; sleep 30'])
  const output = []
  const sizes = []
  const attach = new WebSocket(url, ['tty'])
  attach.on('open', () => attach.send(JSON.stringify({
    AuthToken: '', client: 'attach', columns: 80, rows: 24,
  })))
  attach.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) output.push(buf.subarray(1))
    if (buf[0] === 0x33) sizes.push(JSON.parse(buf.subarray(1)))
  })
  let narrow
  try {
    await settle()
    assert.ok(output[0]?.toString().startsWith('\x1bc\x1b[3J'),
      'attach gets the normal replacement snapshot on its initial admission')

    narrow = viewer(url, 40, 12)
    await settle()
    assert.deepEqual(sizes.at(-1), { columns: 40, rows: 12 })
    assert.equal(output.slice(1).some(bytes => bytes.includes(Buffer.from('\x1bc'))), false,
      'a grid change does not clear attach scrollback with RIS')
  } finally {
    narrow?.close()
    attach.close()
    await server.close()
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
  const core = await createGhosttyCore()
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

// ---------------------------------------------------------------- switching

/** A store like pi's, holding history for folders that really exist. */
const storeFor = async cwds => {
  // Resolved, because a place is always reported at the folder's one true path
  // and a switch is only honoured for a path the server itself listed.
  const root = await realpath(await mkdtemp(pathJoin(tmpdir(), 'mtty-switch-')))
  const sessionDir = pathJoin(root, 'sessions')
  await mkdir(sessionDir)
  for (const name of cwds) {
    const cwd = pathJoin(root, name)
    await mkdir(cwd)
    await mkdir(pathJoin(sessionDir, `-${cwd.replaceAll('/', '-')}-`))
    await writeFile(pathJoin(sessionDir, `-${cwd.replaceAll('/', '-')}-`, 'a.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, cwd })}\n`)
  }
  return { root, sessionDir, at: name => pathJoin(root, name) }
}

/** A viewer that can also send the frames the key bar and the menu send. */
const talker = (url, columns = 50, rows = 20) => {
  const ws = new WebSocket(url, ['tty'])
  let output = ''
  let places = null
  ws.on('open', () => ws.send(JSON.stringify({ AuthToken: '', columns, rows })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) output += buf.subarray(1).toString()
    if (buf[0] === 0x35) places = JSON.parse(buf.subarray(1))
  })
  const send = (cmd, text) => ws.send(Buffer.concat([Buffer.from([cmd]), Buffer.from(text)]))
  return {
    get output() { return output },
    get places() { return places },
    clear: () => { output = '' },
    ask: () => send(0x33, ''),
    switchTo: (cwd, resume = false) => send(0x32, JSON.stringify({ cwd, resume })),
    close: () => ws.close(),
  }
}

/** Poll for something that arrives through a serialized queue, not on a clock. */
const until = async (check, what, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await settle(100)
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a switch ends the program and starts one in the folder chosen', async () => {
  const store = await storeFor(['target-project'])
  const { server, url } = await start(undefined, [], { sessionDir: store.sessionDir })
  const viewer = talker(url)
  try {
    // fake-pi draws its own cwd, so the screen says where the program is.
    await until(() => viewer.output.includes('mobile-tty'), 'the first screen')

    viewer.switchTo(store.at('target-project'))
    await until(() => viewer.output.includes('target-project'), 'the new folder')

    // The program was replaced, not the server: everyone is still connected and
    // the session did not end underneath them.
    assert.equal(server.http.listening, true)
  } finally {
    viewer.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a switch to a folder the server never offered is refused, and costs nothing', async () => {
  const store = await storeFor(['known'])
  const { server, url } = await start(undefined, [], { sessionDir: store.sessionDir })
  const viewer = talker(url)
  try {
    await until(() => viewer.output.includes('mobile-tty'), 'the first screen')

    // This frame is the one that would turn a terminal into a way to start
    // programs anywhere, so a cwd nobody listed must not be honoured.
    viewer.switchTo('/etc')
    await settle(700)

    // A viewer arriving now is given the screen of whatever is running, which
    // is the only proof that it was never replaced.
    const late = talker(url)
    await until(() => late.output.includes('mobile-tty'), 'the original program still running')
    assert.equal(late.output.includes('/etc'), false)
    late.close()
  } finally {
    viewer.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('the folder list names the current folder and only offers continue for pi', async () => {
  const store = await storeFor(['one', 'two'])
  const { server, url } = await start(undefined, [], { sessionDir: store.sessionDir })
  const viewer = talker(url)
  try {
    // Only once it is actually admitted: the menu cannot open before then either.
    await until(() => viewer.output.length > 0, 'the first screen')
    viewer.ask()
    await until(() => viewer.places, 'the folder list')

    assert.equal(viewer.places.cwd, process.cwd(), 'the folder the server started in is where it says it is')
    assert.deepEqual(viewer.places.places.map(place => place.name).sort(), ['mobile-tty', 'one', 'two'].sort())
    // fake-pi.js is not pi, and `--continue` is pi's flag.
    assert.equal(viewer.places.resume, false)
  } finally {
    viewer.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('the folder you are in stays in the list even when pi\'s store forgets it', async () => {
  const store = await storeFor(['elsewhere'])
  const { server, url } = await start(undefined, [], { sessionDir: store.sessionDir })
  const viewer = talker(url)
  try {
    await until(() => viewer.output.length > 0, 'the first screen')
    viewer.switchTo(store.at('elsewhere'))
    await until(() => viewer.output.includes('elsewhere'), 'the switch')

    // The store is pruned under us, which is ordinary — it is full of folders
    // that come and go. The list must still be one you can find your way back
    // through, or the folder in front of you becomes unreachable.
    await rm(pathJoin(store.sessionDir, `-${store.at('elsewhere').replaceAll('/', '-')}-`), { recursive: true })

    viewer.ask()
    await until(() => viewer.places, 'the folder list')
    assert.equal(viewer.places.cwd, store.at('elsewhere'))
    assert.ok(viewer.places.places.some(place => place.cwd === store.at('elsewhere')),
      'the current folder is missing from the list')
  } finally {
    viewer.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a switch sends attach a fresh screen — nothing on its end will redraw it', async () => {
  const store = await storeFor(['elsewhere'])
  const { server, url } = await start(undefined, [], { sessionDir: store.sessionDir })
  const output = []
  const ws = new WebSocket(url, ['tty'])
  ws.on('open', () => ws.send(JSON.stringify({ AuthToken: '', client: 'attach', columns: 80, rows: 24 })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) output.push(buf.subarray(1).toString())
  })
  try {
    await until(() => output.join('').includes('mobile-tty'), 'the first screen')

    // A resize deliberately spares attach the replacement snapshot, because the
    // program redraws through the PTY for it. A switch is the opposite case:
    // the program that would have redrawn is the one that just went away, so
    // skipping it here leaves a real terminal showing a session that is gone
    // while its keystrokes reach the new one.
    const before = output.length
    ws.send(Buffer.concat([
      Buffer.from([0x32]),
      Buffer.from(JSON.stringify({ cwd: store.at('elsewhere'), resume: false })),
    ]))
    await until(() => output.slice(before).some(chunk => chunk.startsWith('\x1bc\x1b[3J')),
      'the screen to be replaced')
    await until(() => output.slice(before).join('').includes('elsewhere'), 'the new folder')
  } finally {
    ws.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('continuing a folder is offered only for pi, and reaches it as --continue', async () => {
  const store = await storeFor(['work'])
  // Named `pi`, because that is what decides whether continuing means anything.
  // It reports its own cwd and argv, which is all this needs to see.
  const program = pathJoin(store.root, 'pi')
  await writeFile(program, '#!/bin/bash\necho "cwd=$PWD args=$*"\nsleep 30\n')
  await chmod(program, 0o755)

  const { server, url } = await start(program, [], { sessionDir: store.sessionDir })
  const viewer = talker(url)
  try {
    await until(() => viewer.output.length > 0, 'the first screen')
    viewer.ask()
    await until(() => viewer.places, 'the folder list')
    assert.equal(viewer.places.resume, true)

    viewer.switchTo(store.at('work'), true)
    await until(() => viewer.output.includes('args=--continue'), 'the flag reaching the program')
    assert.ok(viewer.output.includes(store.at('work')), 'and in the folder chosen')
  } finally {
    viewer.close()
    await server.close()
    await rm(store.root, { recursive: true, force: true })
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
