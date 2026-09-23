// The front door: one process, holding one Unix-socket child per pi session.
//
// Auth, origin-checking and the client HTML build live here, once, the way
// server/index.js used to hold them for its one program. What used to be
// `switchTo` — end the program, start another — is gone: a session a viewer
// joins keeps running after that viewer leaves, and a different viewer (phone,
// a second `attach`, a third) can be looking at a different one at the same
// time. `GET /places` answers what sessions exist and which are running;
// `/ws?session=<id>` is a raw pipe into that session's child, spawning it via
// `server/registry.js` if it is not already up.
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import { Auth, loginPage, submittedPassword } from './auth.js'
import { buildClient } from './client.js'
import { isAddress, originAllowed } from './origin.js'
import { PI_SESSIONS, readPlaces } from './places.js'
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

export function createSupervisor({ port, bind, hostname, password, command, args = [], cliPath, sessionDir = PI_SESSIONS, socketDir = tmpdir(), cap = 4, onListen, onExit }) {
  const auth = new Auth(password)
  const registry = new Registry({ cliPath, program: command, programArgs: args, socketDir, cap })

  const loginHeaders = { 'content-type': 'text/html', 'cache-control': 'no-store' }

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
      const sessions = found.map(place => ({ ...place, running: registry.has(place.id) }))
      const body = JSON.stringify({ current: sessions[0]?.id ?? null, sessions, total })
      return void res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    }

    if (path !== '/') return void res.writeHead(404).end()
    if (!auth.admits(req)) return void res.writeHead(200, loginHeaders).end(loginPage())

    let client
    try {
      client = await buildClient()
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

  // `?session=<id>` names which of pi's own sessions to join. There is no
  // "start a new one" here — a viewer only ever names an id it learned from
  // `GET /places`, which only ever lists sessions pi's own store already has.
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://internal')
    const id = url.searchParams.get('session')

    let inner = null
    let buffered = []
    let closed = false

    // Attached before anything here awaits: the client sends its handshake the
    // instant its socket opens, and a listener added even one microtask late
    // would simply never see it — an EventEmitter drops what nothing is
    // listening for rather than queuing it.
    ws.on('message', data => {
      if (inner && inner.readyState === inner.OPEN) inner.send(data)
      else buffered?.push(data)
    })
    ws.on('close', () => { closed = true; inner?.close() })
    ws.on('error', () => { closed = true; inner?.close() })

    readPlaces({ sessionDir }).then(async ({ sessions }) => {
      const place = sessions.find(p => p.id === id)
      if (closed) return
      if (!id || !place) {
        ws.close(4004, 'no such session')
        return
      }

      const child = registry.ensure(id, place.cwd)
      const sock = await connectChild(child.socketPath)
      if (closed) { sock.close(); return }
      inner = sock
      for (const data of buffered) inner.send(data)
      buffered = null
      inner.on('message', data => { if (ws.readyState === ws.OPEN) ws.send(data) })
      inner.on('close', () => ws.close(1001, 'session ended'))
      inner.on('error', () => ws.close(1011, 'lost the session'))
    }).catch(err => {
      console.error(`server: could not reach session ${id}`, err)
      ws.close(1011, 'could not reach the session')
    })
  })

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue
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
      await registry.endAll()
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
