// The front door: one process, holding one Unix-socket child per pi session.
//
// Auth, origin-checking and the client HTML build live here, once, the way
// server/index.js used to hold them for its one program. What used to be
// `switchTo` — end the program, start another — is gone: a session a viewer
// joins keeps running after that viewer leaves, and a different viewer (phone,
// a second `attach`, a third) can be looking at a different one at the same
// time. `GET /places` answers what sessions exist and which are running;
// `POST /start` begins one that has no transcript yet; `/ws?session=<id>` is a
// raw pipe into that session's child, spawning it via `server/registry.js` if
// it is not already up.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { Auth, loginPage, submittedPassword } from './auth.js'
import { buildClient } from './client.js'
import { isAddress, originAllowed } from './origin.js'
import { PI_SESSIONS, readPlaces, canonical, shorten } from './places.js'
import { BACKLOG_LIMIT, TOO_FAR_BEHIND } from './viewer.js'
import { Registry } from './registry.js'

const MAX_FRAME = 1024 * 1024

// How long a just-spawned child gets to come up before a join gives up on it,
// and how often to retry while waiting. Generous: a slow machine cold-starting
// node plus pi is not the same failure as pi simply not existing.
const CHILD_READY_MS = 8_000
const CHILD_RETRY_MS = 75

const connectChild = socketPath => new Promise((resolveConn, rejectConn) => {
  const deadline = Date.now() + CHILD_READY_MS
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

export function createSupervisor({ port, bind, hostname, password, command, args = [], cliPath, sessionDir = PI_SESSIONS, socketDir = tmpdir(), cap = 4, theme = 'dark', newDir, onListen, onExit }) {
  const auth = new Auth(password)
  const registry = new Registry({ cliPath, program: command, programArgs: args, socketDir, cap, theme })
  // Where a brand-new session starts: given, or the folder this run was
  // launched from (see cli.js, which pins it before anything can chdir away).
  const defaultDir = newDir ?? process.cwd()

  const loginHeaders = { 'content-type': 'text/html', 'cache-control': 'no-store' }

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

  const http = createServer(async (req, res) => {
    const path = req.url?.split('?')[0]

    if (path === '/login' && req.method === 'POST' && auth.required) {
      const attempt = await submittedPassword(req).catch(() => null)
      if (!attempt || !auth.accepts(attempt)) return void res.writeHead(401, loginHeaders).end(loginPage(true))
      const secure = req.headers['x-forwarded-proto'] === 'https'
      return void res.writeHead(303, { location: '/', 'set-cookie': auth.grant({ secure }) }).end()
    }

    if (path === '/places' && req.method === 'GET') {
      if (!auth.admits(req)) return void res.writeHead(401).end()
      const { sessions: found, total } = await readPlaces({ sessionDir })
      // A live child pins its row: same id resumed under two folders lists
      // twice, but only the folder the child actually runs in is running.
      // And a child with no transcript yet (just started) is listed anyway —
      // otherwise the thing it just began on the phone would vanish from the
      // very menu that started it.
      const listed = new Set(found.map(p => `${p.id}\u0000${p.cwd}`))
      const fresh = registry.running().flatMap(id => {
        const child = registry.child(id)
        return listed.has(`${id}\u0000${child.cwd}`)
          ? []
          : [{ id, cwd: child.cwd, name: basename(child.cwd), path: shorten(child.cwd), at: child.joinedAt, label: basename(child.cwd) }]
      })
      const rows = [...found, ...fresh].sort((a, b) => b.at - a.at)
      const live = id => registry.child(id)?.cwd
      const sessions = rows.map(place => ({ ...place, running: live(place.id) === place.cwd }))
      const body = JSON.stringify({ current: sessions[0]?.id ?? null, sessions, total, here: defaultDir })
      return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    }

    // Start a session that has no transcript yet: mint an id, spawn pi in the
    // named directory, and let the client join it like any other. The
    // directory is one this server itself offers (its own cwd, or one some
    // /places row already refers to), checked fresh here against the store as
    // it stands now — so a posted path is only ever honored if the operator
    // has been running pi there, and one deleted since the last listing
    // fails cleanly instead of spawning anywhere.
    if (path === '/start' && req.method === 'POST') {
      if (!auth.admits(req)) return void res.writeHead(401).end()
      if (!originAllowed({ origin: req.headers.origin, host: req.headers.host, hostname })) {
        return void res.writeHead(403).end()
      }
      const body = await readBody(req, 512).catch(() => null)
      const wanted = body ? await canonical(body.cwd?.trim()) : null
      let spawnable = false
      if (wanted) {
        if (wanted === await canonical(defaultDir)) spawnable = true
        else {
          const { sessions } = await readPlaces({ sessionDir })
          spawnable = sessions.some(place => place.cwd === wanted)
        }
      }
      if (!spawnable) return void res.writeHead(422, { 'content-type': 'text/plain' }).end('no such place to start a session in')
      const id = randomUUID()
      registry.ensure(id, wanted)
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, cwd: wanted }))
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

  // `?session=<id>&cwd=<path>` names which session to join. There is no
  // "start a random one" here — a viewer only ever names an id and folder it
  // learned from `GET /places` or made by `POST /start`.
  //
  // The cwd is part of the contract because an id alone no longer is one:
  // pi files a session per (id, cwd) pair, so the same conversation resumed
  // elsewhere lists twice, and a running child pins its own folder. Joining
  // names the folder you meant; if the child already up lives in a different
  // one, that is refused rather than silently served from somewhere else.
  wss.on('connection', (ws, req) => {
    // Cleared before each ping and set by the pong that answers it.
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    ws.on('close', () => alive.delete(ws))
    ws.on('error', () => alive.delete(ws))

    const url = new URL(req.url, 'http://internal')
    const id = url.searchParams.get('session')
    const cwd = url.searchParams.get('cwd')

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

    readPlaces({ sessionDir }).then(async ({ sessions }) => {
      // A live child pins its own folder — registry.child(id) is authoritative
      // over whatever any listing said. Without a cwd in the join, the child's
      // folder (or the newest row's) is what you get; with one, a mismatch is
      // refused rather than served from the wrong place.
      const running = registry.child(id)
      // A started-with-no-transcript session exists only as its live child;
      // the store will list it once pi writes the file. Either way, a cwd on
      // the join must match the folder the child actually runs in.
      const place = (cwd
        ? sessions.find(p => p.id === id && p.cwd === cwd)
          ?? (running?.cwd === cwd ? { id, cwd } : null)
        : sessions.find(p => p.id === id && p.cwd === running?.cwd)
          ?? sessions.find(p => p.id === id)
          ?? (running ? { id, cwd: running.cwd } : null))
      if (closed) return
      if (!id || !place) {
        ws.close(4004, 'no such session')
        return
      }
      if (cwd && place.cwd !== cwd) {
        ws.close(4009, 'that session is running somewhere else')
        return
      }

      const child = registry.ensure(id, place.cwd)
      const sock = await connectChild(child.socketPath)
      if (closed) { sock.close(); return }
      inner = sock
      registered = registry.watch(id, () => { sock.close(); ws.close(1001, 'session ended') })
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
      inner.on('close', () => { registered?.(); ws.close(1001, 'session ended') })
      inner.on('error', () => { registered?.(); ws.close(1011, 'lost the session') })
    }).catch(err => {
      console.error(`server: could not reach session ${id}`, err)
      ws.close(1011, 'could not reach the session')
    })
  })

  // Sockets we have pinged and are waiting on. Terminated on the second
  // unanswered ping, exactly as one session's server does its viewers.
  const alive = new WeakSet()

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue
      // Unanswered from last round: a phone asleep behind a dead tunnel is gone
      // for good, and holding its relay open holds memory on this side too.
      if (!alive.has(ws)) { ws.terminate(); continue }
      alive.add(ws)
      ws.ping()
    }
  }, 30_000)
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
