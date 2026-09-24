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

const start = async ({ sessionDir, cap = 4, idleMs, socketDir, command = fakePi, args = [], pingMs, childReadyMs, cli = cliPath }) => {
  const supervisor = createSupervisor({
    port: 0, bind: '127.0.0.1', command, args, cliPath: cli, sessionDir, cap, idleMs, pingMs, childReadyMs,
    socketDir: socketDir ?? await mkdtemp(pathJoin(tmpdir(), 'mtty-sock-')),
  })
  await new Promise(r => supervisor.http.on('listening', r))
  const { port } = supervisor.http.address()
  return { supervisor, base: `ws://127.0.0.1:${port}/ws`, page: `http://127.0.0.1:${port}` }
}

/** Join a session, collecting its screen output as text. */
const join = (base, id, { columns = 50, rows = 20, cwd, processId } = {}) => {
  const query = processId ? `process=${processId}` : `session=${id}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`
  const ws = new WebSocket(`${base}?${query}`, ['tty'])
  let output = ''
  const opened = new Promise(resolve => ws.on('open', () => {
    ws.send(JSON.stringify({ AuthToken: '', columns, rows }))
    resolve()
  }))
  const closeDetails = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const closed = closeDetails.then(({ code }) => code)
  ws.on('message', d => { if (Buffer.from(d)[0] === 0x30) output += Buffer.from(d).subarray(1).toString() })
  return {
    opened, closed, closeDetails, ws,
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

test('a session that cannot be reached is refused with its own code', async () => {
  const store = await storeFor([{ name: 'known', id: 'a' }])
  // A child that dies before it can listen: the join waits for it, gives up,
  // and says so distinctly from a conversation that does not exist.
  const cli = pathJoin(store.root, 'not-a-cli.js')
  const { supervisor, base } = await start({ sessionDir: store.sessionDir, cli, childReadyMs: 300 })
  const viewer = join(base, 'a')
  try {
    const { code, reason } = await viewer.closeDetails
    assert.equal(code, 4005)
    assert.match(reason, /could not reach/)
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
    // beta holds the newer transcript, so only a running-first list puts the
    // joined alpha on top.
    assert.equal(sessions[0].id, 'a', 'the running session is listed first')
    const byId = Object.fromEntries(sessions.map(s => [s.id, s]))
    assert.equal(byId.a.running, true, 'the session that was joined is running')
    assert.equal(byId.a.viewers, 1, 'the open join is counted')
    assert.equal(byId.b.running, false, 'the one nobody joined is not')
    assert.equal(byId.b.viewers, 0, 'an unjoined session has no viewers')
  } finally {
    a.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/places scopes viewers to the exact folder when an id is listed twice', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a', { cwd: store.at('two') })
  try {
    await viewer.opened
    await until(() => viewer.output.includes('two'), 'the selected folder to be served')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const byCwd = Object.fromEntries(sessions.map(s => [s.cwd, s]))
    assert.equal(byCwd[store.at('one')].viewers, 0)
    assert.equal(byCwd[store.at('two')].viewers, 1)
    assert.equal(byCwd[store.at('two')].running, true)
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('DELETE ends one running session and closes its viewer', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the joined session to be up')
    await until(async () => {
      const { sessions } = await fetch(`${page}/places`).then(r => r.json())
      return sessions.find(s => s.id === 'a')?.viewers === 1
    }, 'the viewer to appear in the list')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const processId = sessions.find(s => s.id === 'a').processId
    const refused = await fetch(`${page}/terminal?process=${processId}`, {
      method: 'DELETE', headers: { origin: 'https://attacker.example' },
    })
    assert.equal(refused.status, 403)
    assert.equal(registryRunning(supervisor), 1)

    const ended = await fetch(`${page}/terminal?process=${processId}`, { method: 'DELETE' })
    assert.equal(ended.status, 200)
    assert.deepEqual(await ended.json(), { ended: processId })
    await until(() => registryRunning(supervisor) === 0, 'the child to exit')
    assert.equal(await viewer.closed, 1001, 'the connected viewer sees the session end')
    assert.equal((await viewer.closeDetails).reason, 'ended by a terminal')

    assert.equal((await fetch(`${page}/terminal?process=${processId}`, { method: 'DELETE' })).status, 404)
    assert.equal((await fetch(`${page}/terminal`, { method: 'DELETE' })).status, 404)
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('pi exiting on its own reports a neutral close reason', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    await until(() => viewer.output.includes('work'), 'the session to be up')
    viewer.send('/quit\r')
    const closed = await viewer.closeDetails
    assert.equal(closed.code, 1001)
    assert.equal(closed.reason, 'pi exited')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('past the cap, the one written longest ago is ended to make room', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }, { name: 'three', id: 'c' }])
  // Everything counts as idle here; which one goes is what is under test.
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 2, idleMs: 0 })
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

test('a watched session is never ended to make room', async () => {
  // Cap one, one session up and still on somebody's screen: the join that
  // would need the room is refused instead, and the viewer keeps what it has.
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 1 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')

    const b = join(base, 'b')
    const { code, reason } = await b.closeDetails
    assert.equal(code, 4006, 'the join is refused rather than anything being ended')
    assert.equal(reason, 'every session is busy or watched; end one first')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    assert.equal(sessions.find(s => s.id === 'a').running, true, 'the watched session is untouched')
    a.send('hello\r')
    await until(() => a.output.includes('ok: 5 chars'), 'the viewer still has its terminal')
  } finally {
    a.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a session nobody is watching is kept while it is still busy', async () => {
  // The viewer is gone, but the session was worked on moments ago: pi may be
  // mid-reply, and work it handed to a subagent lives in a forked session of
  // its own. Only something quiet for idleMs is a victim, so this is refused
  // too -- a fresh idleMs, and nothing about timing has to be guessed.
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir, cap: 1, idleMs: 60_000 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')
    a.send('hello\r')
    await until(() => a.output.includes('ok: 5 chars'), 'the line landing')
    a.close()
    await a.closed

    const b = join(base, 'b')
    assert.equal((await b.closeDetails).code, 4006)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})
test('two folders with the same conversation id get separate PTYs', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  try {
    const first = join(base, 'a', { cwd: store.at('one') })
    await first.opened
    const second = join(base, 'a', { cwd: store.at('two') })
    await second.opened
    await until(() => first.output.includes('one') && second.output.includes('two'), 'each folder to serve its own screen')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    assert.equal(new Set(sessions.map(s => s.processId)).size, 2)
    assert.equal(registryRunning(supervisor), 2)
    first.close()
    second.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/start begins a session in any directory that exists', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const post = (body) => fetch(`${page}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const fresh = await mkdtemp(pathJoin(tmpdir(), 'mtty-new-'))
  try {
    // A folder that does not exist is refused, spawning nothing.
    const refused = await post({ cwd: pathJoin(store.root, 'elsewhere') })
    assert.equal(refused.status, 422)
    assert.equal(registryRunning(supervisor), 0)

    // A folder that was never a place and is not this server's own still
    // spawns: `mobile-tty new` runs it in any project folder the user is in.
    const ok = await post({ cwd: fresh })
    assert.equal(ok.status, 200)
    const { id, cwd, processId } = await ok.json()
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(cwd, await realpath(fresh))
    const viewer = join(base, id, { processId })
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the started session serves its screen')
    viewer.close()

    // A folder the listing offers still works as it always did.
    const listed = await post({ cwd: store.at('listed') })
    assert.equal(listed.status, 200)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
    await rm(fresh, { recursive: true, force: true })
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

test('a viewer that stops answering pings is dropped, not counted forever', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  // Ping every 200ms: the round that notices the dead socket is fast enough
  // to wait for in a test.
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, pingMs: 200 })
  const cli = join(base, 'a', { columns: 40, rows: 12 })
  const web = join(base, 'a', { columns: 100, rows: 30 })
  try {
    await Promise.all([cli.opened, web.opened])
    await until(() => cli.output.includes('40x12'), 'the narrow grid, while both viewers count')

    // The web viewer is killed mid-tunnel: the TCP socket stays up and nothing
    // ever answers the pings. Its close frame never arrives either. Before the
    // fix, the ping loop never noticed and /places counted it forever.
    web.ws._socket.pause()
    await until(async () => {
      const { sessions } = await fetch(`${page}/places`).then(r => r.json())
      return sessions.find(s => s.id === 'a')?.viewers === 1
    }, 'the dead viewer to stop counting')
    await until(() => cli.output.includes('40x12'), 'the remaining viewer keeps its screen')
  } finally {
    cli.close()
    web.ws.terminate()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})
