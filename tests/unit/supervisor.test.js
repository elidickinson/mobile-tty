// The supervisor: what used to be "switching" is now "which of several
// sessions, kept running in the background, is this viewer looking at" — so
// these are the tests for background persistence and concurrent sessions that
// used to live in server.test.js's switching section.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createSupervisor } from '../../server/supervisor.js'

const cliPath = fileURLToPath(new URL('../../server/cli.js', import.meta.url))
const fakePi = fileURLToPath(new URL('../fixtures/fake-pi.js', import.meta.url))

/** A store like pi's, one session file per (folder, id) pair. */
const storeFor = async entries => {
  const root = await realpath(await mkdtemp(pathJoin(tmpdir(), 'mtty-sup-')))
  const sessionDir = pathJoin(root, 'sessions')
  await mkdir(sessionDir)
  for (const { name, id } of entries) {
    const cwd = pathJoin(root, name)
    await mkdir(cwd, { recursive: true })
    const dir = pathJoin(sessionDir, `-${cwd.replaceAll('/', '-')}-`)
    await mkdir(dir, { recursive: true })
    await writeFile(pathJoin(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)
  }
  return { root, sessionDir, at: name => pathJoin(root, name) }
}

const start = async ({ sessionDir, cap = 4, socketDir, command = fakePi, args = [] }) => {
  const supervisor = createSupervisor({
    port: 0, bind: '127.0.0.1', command, args, cliPath, sessionDir, cap,
    socketDir: socketDir ?? await mkdtemp(pathJoin(tmpdir(), 'mtty-sock-')),
  })
  await new Promise(r => supervisor.http.on('listening', r))
  const { port } = supervisor.http.address()
  return { supervisor, base: `ws://127.0.0.1:${port}/ws`, page: `http://127.0.0.1:${port}` }
}

/** Join a session, collecting its screen output as text. */
const join = (base, id, { columns = 50, rows = 20, cwd } = {}) => {
  const ws = new WebSocket(`${base}?session=${id}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`, ['tty'])
  let output = ''
  const opened = new Promise(resolve => ws.on('open', () => {
    ws.send(JSON.stringify({ AuthToken: '', columns, rows }))
    resolve()
  }))
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)))
  ws.on('message', d => { if (Buffer.from(d)[0] === 0x30) output += Buffer.from(d).subarray(1).toString() })
  return {
    opened, closed,
    get output() { return output },
    send: text => ws.send(Buffer.concat([Buffer.from([0x30]), Buffer.from(text)])),
    close: () => ws.close(),
  }
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, what, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await settle(100)
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('joining a known session spawns it and serves its screen', async () => {
  const store = await storeFor([{ name: 'target-project', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    // fake-pi draws its own cwd, so the screen says where the program landed.
    await until(() => viewer.output.includes('target-project'), 'the session\'s own folder')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('joining an id the server never listed is refused', async () => {
  const store = await storeFor([{ name: 'known', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'not-a-real-id')
  try {
    const code = await viewer.closed
    assert.equal(code, 4004)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('leaving a session does not end it: it is there, unchanged, on rejoin', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const first = join(base, 'a')
  try {
    await first.opened
    await until(() => first.output.includes('work'), 'the first screen')
    first.send('hello\r')
    await until(() => first.output.includes('ok: 5 chars'), 'the line landing')
    first.close()
    await first.closed

    // Rejoin as a different viewer entirely. If the process were killed and
    // restarted, fake-pi's in-memory history would be gone and this would not
    // be in the snapshot; it surviving is exactly what "kept running in the
    // background" means.
    const second = join(base, 'a')
    await second.opened
    await until(() => second.output.includes('ok: 5 chars'), 'the earlier line, still there')
    second.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('two sessions run at once, each its own screen', async () => {
  const store = await storeFor([{ name: 'alpha', id: 'a' }, { name: 'beta', id: 'b' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const a = join(base, 'a')
  const b = join(base, 'b')
  try {
    await Promise.all([a.opened, b.opened])
    await until(() => a.output.includes('alpha'), 'the first session\'s folder')
    await until(() => b.output.includes('beta'), 'the second session\'s folder')
    assert.equal(a.output.includes('beta'), false, 'one session\'s screen does not leak into the other\'s')
    assert.equal(b.output.includes('alpha'), false)
  } finally {
    a.close(); b.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('GET /places lists every session and which ones are running', async () => {
  const store = await storeFor([{ name: 'alpha', id: 'a' }, { name: 'beta', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.length > 0, 'the joined session to be up')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const byId = Object.fromEntries(sessions.map(s => [s.id, s]))
    assert.equal(byId.a.running, true, 'the session that was joined is running')
    assert.equal(byId.b.running, false, 'the one nobody joined is not')
  } finally {
    a.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('past the cap, the least recently joined session is ended to make room', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }, { name: 'three', id: 'c' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 2 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')
    a.close()
    await a.closed

    const b = join(base, 'b')
    await b.opened
    await until(() => b.output.includes('two'), 'the second session up')
    b.close()
    await b.closed

    // A third join past the cap of two evicts the oldest (`a`), which is not
    // running any more even though nothing ever asked to end it outright.
    const c = join(base, 'c')
    await c.opened
    await until(() => c.output.includes('three'), 'the third session up')

    await until(async () => {
      const { sessions } = await fetch(`${page}/places`).then(r => r.json())
      const byId = Object.fromEntries(sessions.map(s => [s.id, s.running]))
      return byId.a === false && byId.b === true && byId.c === true
    }, 'the oldest session evicted and the rest still running', 8_000)
    c.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('evicting a session pulls the relay out from under its viewer at once', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir, cap: 1 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')

    // The next join evicts `a` while this viewer is still attached to it.
    // Whatever the child does on the way down — a graceful close, or a socket
    // that simply stops speaking — the browser side must hear an ending within
    // a beat, not hang on a dead pipe until the OS gives up on it.
    const closing = a.closed
    const b = join(base, 'b')
    await b.opened
    // The losing arm's timeout must be cleared, or node --test sits on it for
    // the full 8s after the test itself has passed.
    let cutoff
    const why = await Promise.race([
      closing.then(code => (clearTimeout(cutoff), code)),
      new Promise((_, bad) => { cutoff = setTimeout(() => bad(new Error('viewer never told')), 8_000) }),
    ])
    assert.equal(why === null || why === 1001, true, `expected a clean end, got ${why}`)
    b.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})
test('joining a running session in the wrong folder is refused, not redirected', async () => {
  // Two rows share the id in the store (resumed under two folders); one child
  // is up in the first. A join naming the second folder must get a clear
  // refusal — ensure() would happily keep the running child and attach the
  // viewer to the wrong folder with no word.
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  try {
    const running = join(base, 'a', { cwd: store.at('one') })
    await running.opened

    const stranger = join(base, 'a', { cwd: store.at('two') })
    const code = await stranger.closed
    assert.equal(code, 4009, 'a mismatched join is refused')
    assert.equal(registryRunning(supervisor), 1, 'the refusal spawned nothing')
    // The original viewer is untouched by it.
    await until(() => running.output.length > 0, 'the running session still streams')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/start begins a session in an offered folder, and nowhere else', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const post = (body) => fetch(`${page}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // An unlisted folder is refused with a clear status, spawning nothing.
    const refused = await post({ cwd: pathJoin(store.root, 'elsewhere') })
    assert.equal(refused.status, 422)
    assert.equal(registryRunning(supervisor), 0)

    // A folder the listing offers spawns a session that then joins.
    const ok = await post({ cwd: store.at('listed') })
    assert.equal(ok.status, 200)
    const { id, cwd } = await ok.json()
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(cwd, store.at('listed'))
    const viewer = join(base, id, { cwd })
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the started session serves its screen')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

/** How many children the supervisor's registry is holding. */
const registryRunning = supervisor => supervisor.registry.running().length

test('a program that is not pi gets no pi-only flags on its command line', async () => {
  // bash exits on an unknown `--session-id` option, so if the flag reached it,
  // the child would be gone before its socket answered and this join would
  // land nowhere at all. sh with a marker program proves the pipe end to end:
  // the program ran, and therefore its arguments were valid ones.
  const store = await storeFor([{ name: 'plain', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir, command: 'sh', args: ['-c', 'printf flagged-ready; sleep 30'] })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    await until(() => viewer.output.includes('flagged-ready'), 'the program having run')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('rejoining a still-running session at a full cap evicts nothing', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 2 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')
    a.send('hello\r')
    await until(() => a.output.includes('ok: 5 chars'), 'the line landing')
    a.close()
    await a.closed

    const b = join(base, 'b')
    await b.opened
    await until(() => b.output.includes('two'), 'the second session up')
    b.close()
    await b.closed

    // Cap two, two sessions up, and the older one (`a`) is the LRU candidate.
    // Rejoining it must serve the process already running — its in-memory
    // history is the proof — and end nothing to make room.
    const again = join(base, 'a')
    await again.opened
    await until(() => again.output.includes('ok: 5 chars'), 'the earlier line, still there')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const running = Object.fromEntries(sessions.map(s => [s.id, s.running]))
    assert.deepEqual(running, { a: true, b: true })
    again.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})
