// The front door: one supervisor holding live PTYs independently of pi conversations.
//
// Auth, origin-checking and the client HTML build live here, once, the way
// server/index.js used to hold them for its one program. What used to be
// `switchTo` — end the program, start another — is gone: a session a viewer
// joins keeps running after that viewer leaves, and a different viewer (phone,
// a second `attach`, a third) can be looking at a different one at the same
// time. `GET /places` answers what sessions exist and which are running;
// `POST /start` begins a fresh PTY; `/ws?process=<id>` joins a live one,
// while `/ws?session=<id>&cwd=<path>` opens a saved conversation.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { Auth, loginPage, submittedPassword } from './auth.js'
import { buildClient } from './client.js'
import { isAddress, originAllowed } from './origin.js'
import { PI_SESSIONS, placeNames, readPlaces, canonical } from './places.js'
import { BACKLOG_LIMIT, TOO_FAR_BEHIND } from './viewer.js'
import { Registry } from './registry.js'

const MAX_FRAME = 1024 * 1024

// How long a just-spawned child gets to come up before a join gives up on it,
// and how often to retry while waiting. Generous: a slow machine cold-starting
// node plus pi is not the same failure as pi simply not existing.
const CHILD_READY_MS = 8_000
const CHILD_RETRY_MS = 75

// Said the same way whether /start answers it or a socket closes on it.
const POOL_FULL = 'every session is busy or watched; end one first'

const connectChild = (socketPath, readyMs) => new Promise((resolveConn, rejectConn) => {
  const deadline = Date.now() + readyMs
  const attempt = () => {
    const sock = new WebSocket(`ws+unix://${socketPath}:/ws`, ['tty'])
    sock.once('open', () => resolveConn(sock))
    sock.once('error', () => {
      sock.terminate()
      if (Date.now() > deadline) return rejectConn(new Error(`session on ${socketPath} never came up`))
      setTimeout(attempt, CHILD_RETRY_MS)
    })
  }
  attempt()
})

export function createSupervisor({ port, bind, hostname, password, command, args = [], cliPath, sessionDir = PI_SESSIONS, socketDir = tmpdir(), cap = 4, theme = 'dark', newDir, pingMs = 30_000, childReadyMs = CHILD_READY_MS, idleMs, onListen, onExit }) {
  const auth = new Auth(password)
  const registry = new Registry({ cliPath, program: command, programArgs: args, socketDir, cap, theme, idleMs })
  // Where a brand-new session starts: given, or the folder this run was
  // launched from (see cli.js, which pins it before anything can chdir away).
  const defaultDir = newDir ?? process.cwd()

  const loginHeaders = { 'content-type': 'text/html', 'cache-control': 'no-store' }
  const originAllowedReq = req => originAllowed({
    origin: req.headers.origin,
    host: req.headers.host,
    hostname,
  })

  /** A JSON body, capped hard: /start's whole payload is one directory string. */
  const readBody = (req, cap) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > cap) return void req.destroy()
      chunks.push(chunk)
    })
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
    req.on('error', reject)
  })

  const handle = async (req, res) => {
    const path = req.url?.split('?')[0]

    if (path === '/login' && req.method === 'POST' && auth.required) {
      const attempt = await submittedPassword(req).catch(() => null)
      if (!attempt || !auth.accepts(attempt)) return void res.writeHead(401, loginHeaders).end(loginPage(true))
      const secure = req.headers['x-forwarded-proto'] === 'https'
      return void res.writeHead(303, { location: '/', 'set-cookie': auth.grant({ secure }) }).end()
    }

    if (path === '/places' && req.method === 'GET') {
      if (!auth.admits(req)) return void res.writeHead(401).end()
      // How many viewers are on each live child, for the listings: "2 watching"
      // on a row says the session is shared right now, not just alive.
      const { sessions: found, total } = await readPlaces({ sessionDir })
      const rows = [...found]
      for (const child of registry.running()) {
        const current = registry.current(child)
        let row = rows.find(p => p.id === current.id && p.cwd === current.cwd)
        if (!row) {
          row = { id: current.id, cwd: current.cwd, ...placeNames(current.cwd), at: current.at ?? child.joinedAt, label: basename(current.cwd) }
          rows.push(row)
        }
        row.processId = child.processId
      }
      // Live sessions lead the list -- what is alive is what is worth finding
      // first -- and each group falls back to recency.
      const sessions = rows.sort((a, b) => Boolean(b.processId) - Boolean(a.processId) || b.at - a.at).map(place => ({
        ...place,
        running: Boolean(place.processId),
        viewers: place.processId ? [...wss.clients].filter(c => c.readyState === c.OPEN && c.processId === place.processId).length : 0,
      }))
      // `total` counts store transcripts; the list also carries transcript-
      // less live sessions, so "older, not shown" must count from what is
      // actually shown, not from the store total alone.
      const hidden = Math.max(0, total - found.length)
      const body = JSON.stringify({ current: sessions.find(s => s.running)?.processId ?? null, sessions, hidden, here: defaultDir })
      return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    }

    // End a running session for good: the child gets SIGTERM, then SIGKILL
    // after a grace (`registry.end`), and its viewers hear that a terminal
    // asked for it. Deleted-for-real is pi's own business; this stops the
    // process, which is what mobile-tty owns.
    if (path === '/terminal' && req.method === 'DELETE') {
      if (!auth.admits(req)) return void res.writeHead(401).end()
      if (!originAllowedReq(req)) return void res.writeHead(403).end()
      const id = new URL(req.url, 'http://internal').searchParams.get('process')
      const child = id && registry.child(id)
      if (!child) return void res.writeHead(404, { 'content-type': 'text/plain' }).end(id ? 'that terminal is not running' : 'which terminal')
      console.error(`server: ending terminal ${id} on request`)
      await registry.end(id)
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ended: id }))
    }

    // Start a session that has no transcript yet: mint an id, spawn pi in the
    // named directory, and let the client join it like any other.
    if (path === '/start' && req.method === 'POST') {
      if (!auth.admits(req)) return void res.writeHead(401).end()
      if (!originAllowedReq(req)) return void res.writeHead(403).end()
      const body = await readBody(req, 512).catch(() => null)
      // Any directory that exists can hold a session: joining one already
      // gives a full bash prompt, so restricting the start list would be
      // ceremony. canonical() is null for a path that does not resolve.
      const wanted = body ? await canonical(body.cwd?.trim()) : null
      if (!wanted) return void res.writeHead(422, { 'content-type': 'text/plain' }).end('no such directory to start a session in')
      const id = randomUUID()
      // Past the cap, starting one means ending one -- and the registry ends
      // nothing busy or watched, so ask it first and refuse when it cannot.
      const child = await registry.start(id, wanted)
      if (!child) return void res.writeHead(409, { 'content-type': 'text/plain' }).end(POOL_FULL)
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, cwd: wanted, processId: child.processId }))
    }

    if (path !== '/') return void res.writeHead(404).end()
    if (!auth.admits(req)) return void res.writeHead(200, loginHeaders).end(loginPage())

    let client
    try {
      client = await buildClient({ theme })
    } catch (err) {
      return void res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.message ?? err))
    }
    const headers = { etag: client.etag, 'cache-control': 'no-cache' }
    if (req.headers['if-none-match'] === client.etag) return void res.writeHead(304, headers).end()
    res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(client.page)
  }

  // A throw in here used to be the end of the supervisor and every PTY under
  // it; a request that cannot be answered is one 500 instead.
  const http = createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('server: could not answer a request', err)
      if (res.headersSent) return void res.end()
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.message ?? err))
    })
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_FRAME,
    handleProtocols: () => 'tty',
    verifyClient: ({ req }) => {
      const { origin, host } = req.headers
      if (!auth.admits(req)) {
        console.error('server: refused a socket that has not logged in')
        return false
      }
      if (originAllowed({ origin, host, hostname })) return true
      const undeclared = !hostname && host && !isAddress(host)
      console.error(`server: refused a socket from ${origin} for host ${host}` +
        `${undeclared ? ' — a proxy in front of this needs --hostname' : ''}`)
      return false
    },
  })

  wss.on('error', err => {
    console.error(err.code === 'EADDRINUSE'
      ? `server: port ${port} is already in use\n` +
        `  if that is another mobile-tty:  mobile-tty --port ${port} attach\n` +
        `  if it is something else:        serve on another --port`
      : `server: cannot listen on ${bind}:${port}: ${err.message}`)
    onExit?.({ exitCode: 1, signal: 0 })
  })

  // A process ID joins an existing PTY regardless of /new or /resume inside
  // it. A conversation ID plus cwd opens history only if it is not live.
  wss.on('connection', (ws, req) => {
    // Set by the pong that answers each ping and cleared by the ping itself;
    // a socket that misses a round is terminated by the loop below.
    ws.answered = true
    ws.on('pong', () => { ws.answered = true })

    const url = new URL(req.url, 'http://internal')
    const id = url.searchParams.get('session')
    const cwd = url.searchParams.get('cwd')
    const processId = url.searchParams.get('process')

    let inner = null
    let buffered = []
    let closed = false
    // Registered with the registry once the relay is live, so an eviction or
    // death of the child can cut this browser side down here rather than
    // waiting for the socket teardown to be noticed below.
    let registered = null

    // Attached before anything here awaits: the client sends its handshake the
    // instant its socket opens, and a listener added even one microtask late
    // would simply never see it — an EventEmitter drops what nothing is
    // listening for rather than queuing it.
    ws.on('message', data => {
      if (inner && inner.readyState === inner.OPEN) inner.send(data)
      else buffered?.push(data)
    })
    ws.on('close', () => { closed = true; registered?.(); inner?.close() })
    ws.on('error', () => { closed = true; registered?.(); inner?.close() })

    ;(async () => {
      let child
      if (processId) {
        child = registry.child(processId)
        if (!child) { ws.close(4004, 'terminal is no longer running'); return }
        child.joinedAt = Date.now()
      } else {
        const { sessions } = await readPlaces({ sessionDir })
        const place = cwd ? sessions.find(p => p.id === id && p.cwd === cwd) : sessions.find(p => p.id === id)
        if (!id || !place) { ws.close(4004, 'no such conversation'); return }
        child = await registry.ensure(id, place.cwd)
        if (!child) { ws.close(4006, POOL_FULL); return }
      }
      if (closed) return
      ws.processId = child.processId
      const sock = await connectChild(child.socketPath, childReadyMs)
      if (closed) { sock.close(); return }
      // The child states the place on admission, from the identity file it
      // owns: this relay carries frames, it does not invent them.
      inner = sock
      registered = registry.watch(child.processId, reason => { sock.close(); ws.close(1001, reason) })
      for (const data of buffered) inner.send(data)
      buffered = null
      // Same rule the session itself applies to its viewers (server/viewer.js):
      // catch up, or be disconnected — never fall behind without bound. The
      // check is before the write, so a socket that cannot take this chunk is
      // cut loose instead of being sent part of it; the client's own reconnect
      // picks the stream back up at a fresh snapshot. Cutting only this hop
      // also stops the drain here from hiding a stalled phone from the child's
      // own backlog limit, which is what would otherwise grow without bound.
      inner.on('message', data => {
        if (ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount + data.length > BACKLOG_LIMIT) {
          ws.close(TOO_FAR_BEHIND, 'too far behind')
          return
        }
        ws.send(data)
      })
      inner.on('close', () => {
        registered?.()
        // end() records the reason before it signals, so this lookup sees it
        // whenever the inner socket beats the registry's own exit callback
        // here; the other order, the callback above already closed this ws
        // with the same reason and this close is the ignored one.
        ws.close(1001, registry.child(child.processId)?.endReason ?? 'pi exited')
      })
      inner.on('error', () => { registered?.(); ws.close(1011, 'lost the session') })
    })().catch(err => {
      console.error(`server: could not reach terminal ${processId ?? id}`, err)
      ws.close(4005, 'could not reach the session')
    })
  })

  // Cleared before each ping and set by the pong that answers it, exactly as
  // one session's server does its viewers (server/index.js): a socket that
  // has not answered the last ping is terminated, since a phone asleep behind
  // a dead tunnel is gone for good — and holding its relay open holds memory
  // on this side too.
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue
      if (!ws.answered) { ws.terminate(); continue }
      ws.answered = false
      ws.ping()
    }
  }, pingMs)
  ping.unref()

  http.listen(port, bind, () => onListen?.({ port: http.address().port, bind }))

  return {
    http,
    registry,
    async close() {
      clearInterval(ping)
      // Children first, then the browser sockets: ending a session makes its
      // viewers reconnect, so the sockets have to be gone before the sessions
      // they would be reconnecting to start dying — otherwise a phone attached
      // at Ctrl-C hammers a server that is already closing.
      for (const ws of wss.clients) ws.terminate()
      await registry.endAll()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
