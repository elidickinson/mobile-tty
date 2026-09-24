// One live terminal: it owns a PTY and the program inside it.
//
// It replaces ttyd and dtach both. dtach is gone because it silently discarded
// the unwritten tail of a read whenever a client socket filled, which is where
// the corrupt escape sequences came from; nothing here may repeat that.
//
// One instance serves exactly one program, in one folder, for its whole life
// — no switching. Running several sessions concurrently, and picking between
// them, is `server/supervisor.js`'s job: it spawns one of these per PTY
// (over a Unix socket, see `socketPath` below) and keeps it running in the
// background, so this file only ever has to think about "one PTY, N viewers,
// one screen".
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { Auth, loginPage, submittedPassword } from './auth.js'
import { buildClient } from './client.js'
import { removeFooterFiles, watchFooter } from './footer.js'
import { isAddress, originAllowed } from './origin.js'
import { placeNames } from './places.js'
import { Session } from './session.js'
import { Viewer } from './viewer.js'
import { Mirror } from './mirror.js'
import { INPUT, RESIZE, PROCESS, decodeHandshake, decodeSize } from './protocol.js'

// Cloudflare drops idle sockets and the phone sleeps, so the socket has to be
// spoken to even when pi is silent. ttyd did this and it is why `up` survived a
// quiet evening.
const PING_MS = 30_000
// A resize costs pi a full transcript re-render, so viewers that flap their size
// are made to settle before anyone pays for it.
const RESIZE_COALESCE_MS = 100
// Generous for a paste, far short of what it takes to matter. Without it a
// viewer could hand the PTY a hundred megabytes in one frame.
const MAX_FRAME = 1024 * 1024
const DEFAULT_SCROLLBACK = 1000
// How often the PTY's movement is told to the supervisor at most. Ending idle
// sessions is what it is for, so a word a second is all that needs.
const ACTIVITY_MS = 1_000

/**
 * `scrollback` is how much history a reconnecting viewer gets back. pi does not
 * page its own transcript, so this is the only way to read back through a
 * conversation on a phone — roughly 75 bytes a line, so 1000 lines is about
 * 75 KB per connect, against a pi transcript re-render that starts at 12 KB and
 * grows with every turn.
 *
 * 1000 is the browser client's own ceiling: its VT core keeps that many and
 * silently drops the rest, and the limit lives inside its WASM with no option to
 * raise it. One snapshot serves every viewer, so a larger number would reach
 * only `attach` while making each phone reconnect pay for lines it will throw
 * away — which is why this is a parameter for tests rather than a flag. If
 * desktop history ever matters, the answer is a deeper snapshot for `attach`
 * alone.
 */
export function createTerminalServer({ port, bind, socketPath, hostname, password, command, args = [], cwd = process.cwd(), scrollback = DEFAULT_SCROLLBACK, theme = 'dark', footerPath = join(tmpdir(), `mtty-${process.pid}-${randomUUID()}-footer.json`), onListen, onExit }) {
  const auth = new Auth(password)

  // A program named by path means that program, not whatever happens to sit at
  // the same relative path in the session's own folder. A bare name is a PATH
  // lookup and is already independent of the cwd. Resolved against this
  // process's own directory, which for a supervisor-spawned child is the
  // directory the supervisor itself was launched from.
  const program = command.includes('/') ? resolve(process.cwd(), command) : command
  const viewers = new Set()
  // Set for a background child: the supervisor seeds it before forking and the
  // mtty-session extension rewrites it as pi switches conversations. The
  // program may not be pi at all, so this is the only thing that knows what
  // conversation a viewer was admitted to.
  const identityPath = process.env.MTTY_IDENTITY

  // The program, its screen, and the folder it is in. Set once, from listen(),
  // and never replaced — there is no switching here any more.
  let active = null

  // Non-null while a snapshot is being taken. The mirror stops consuming for
  // that moment so the screen it serializes is exactly the screen these bytes
  // come after — see admit().
  let held = null

  const title = `${basename(program)} — ${cwd}`

  /**
   * The place this PTY is in, as one frame. The child is the only sender: it
   * owns the identity file, so a relay never has to guess. `name` and `path`
   * come from the same formatter a menu row uses.
   */
  const processFrame = state => JSON.stringify({
    ...state,
    processId: process.env.MTTY_PROCESS_ID,
    ...placeNames(state.cwd),
  })

  /** Start the program and make it the session. Called exactly once. */
  const start = () => {
    const session = new Session({ command: program, args, cwd, env: { ...process.env, MTTY_FOOTER: footerPath } })
    const unit = { session, mirror: new Mirror({ ...session.size, scrollback }), lastFooter: null, retired: false }
    unit.gone = new Promise(resolve => { unit.resolveGone = resolve })

    unit.stopFooter = watchFooter(footerPath, text => {
      if (unit.retired) return
      unit.lastFooter = text
      for (const viewer of viewers) viewer.footer(text)
    })
    unit.stopIdentity = identityPath && watchFooter(identityPath, text => {
      if (unit.retired) return
      const frame = processFrame(JSON.parse(text))
      for (const viewer of viewers) viewer.send(PROCESS, frame)
    }, { removeOnStop: false })

    /**
     * A resize re-sends the screen rather than letting viewers reflow it.
     *
     * The client's VT core loses a third to two-thirds of its text on a column
     * shrink, so a viewer that reflows its own history ends up with something
     * the mirror disagrees with — content in the wrong places, and different
     * again from what the next viewer to connect is given. The mirror reflows
     * correctly, so it is the only thing allowed to: everyone else is handed
     * the result.
     */
    session.onResize = size => {
      unit.mirror.resize(size.cols, size.rows)
      for (const viewer of viewers) if (viewer.queue === null) {
        if (viewer.kind === 'attach') {
          // A real terminal receives pi's redraw through the PTY. Sending it a
          // fresh snapshot would clear its scrollback again.
          viewer.sendSize(size)
          continue
        }
        // Same unhandled-rejection guard as admit(): a throw while serializing
        // the snapshot after a resize must not take the server (and the pi it
        // owns) down with it. The viewer just loses the refresh.
        sendScreen(viewer).catch(err => {
          console.error('server: could not re-send the screen after a resize', err)
          viewer.close()
        })
      }
    }

    let announcedActivity = 0
    session.onData = data => {
      // With no viewer attached, this PTY is the only sign the session is
      // still being worked, and the supervisor checks before it ends one.
      const now = Date.now()
      if (process.send && now - announcedActivity >= ACTIVITY_MS) {
        announcedActivity = now
        process.send({ mtty: 'activity', at: now })
      }
      // Viewers first: the mirror is a convenience, and a failure in it must not
      // cost anyone bytes it was about to be sent.
      for (const viewer of viewers) {
        if (viewer.queue) viewer.queue.push(data)
        else if (viewer.queue === null && !viewer.output(data)) viewers.delete(viewer)
      }
      if (held) held.push(data)
      else unit.mirror.write(data)
    }

    session.onExit = status => {
      unit.resolveGone()
      unit.stopFooter()
      unit.stopIdentity?.()
      for (const viewer of viewers) viewer.close(1000, 'session ended')
      onExit?.(status)
    }

    active = unit
    return unit
  }

  /**
   * Give a viewer the screen, then everything that happened while we took it.
   *
   * The split has to be exact. Draining alone is not enough: the parser is
   * asynchronous, so bytes written behind the drain marker are parsed after the
   * snapshot is serialized and would be in neither the screen nor the queue.
   * Holding them out of the mirror instead makes the boundary a real one.
   *
   * Admissions are serialized, since two at once would fight over what is held.
   */
  let admitting = Promise.resolve()
  const sendScreen = viewer => {
    // `catch` before `then`, or one failure poisons the chain and every viewer
    // after it is refused a screen for the life of the process — which, since
    // the server is the session, means until pi is killed.
    admitting = admitting.catch(() => {}).then(async () => {
      if (!viewer.open) return
      const unit = active

      held = []
      viewer.queue = []
      try {
        await unit.mirror.drain()
        const snapshot = Buffer.from(unit.mirror.snapshot())

        // Size before screen: the snapshot is drawn for the PTY's grid, so a
        // viewer that asked for a different one has to be rendering at this
        // size before it arrives.
        viewer.sendSize(unit.session.size)
        // Screen, then the bytes the screen could not contain yet, then what
        // arrived while it was being taken.
        if (viewer.output(snapshot)) {
          const rest = unit.mirror.pending.length ? [Buffer.from(unit.mirror.pending), ...viewer.queue] : viewer.queue
          for (const chunk of rest) if (!viewer.output(chunk)) break
        }
      } finally {
        // Whatever happened to this viewer, the mirror has to be fed again or
        // every screen after this one is stale.
        viewer.queue = null
        for (const chunk of held) unit.mirror.write(chunk)
        held = null
      }
    })
    return admitting
  }

  const admit = viewer => {
    // Before the screen: a viewer knows which place it landed on by the frame
    // that says so, and the frame cannot be second if the screen is to be
    // committed to it. Reading the file rather than a cached copy, since
    // admission can beat the watcher's first poll.
    if (identityPath) viewer.send(PROCESS, processFrame(JSON.parse(readFileSync(identityPath, 'utf8'))))
    active.session.add(viewer)
    viewer.title(title)
    // The latest strip line after the screen: a viewer that connects mid-session
    // gets the current stats, not the stale screen's.
    return sendScreen(viewer).then(() => {
      if (viewer.open && active.lastFooter !== null) viewer.footer(active.lastFooter)
    })
  }

  let fitTimer = null
  const scheduleFit = () => {
    if (fitTimer) return
    fitTimer = setTimeout(() => { fitTimer = null; active?.session.fit() }, RESIZE_COALESCE_MS)
    fitTimer.unref()
  }

  // The query is ignored: `?b=<id>` is only there to give the client a URL iOS
  // has no cached copy of, and what it gets back is whatever is current. It must
  // not be cached any harder than `/` either — the home screen launches a fixed
  // URL, so pinning that one would strand the phone on an old build for good.
  const loginHeaders = { 'content-type': 'text/html', 'cache-control': 'no-store' }

  const http = createServer(async (req, res) => {
    const path = req.url?.split('?')[0]

    if (path === '/login' && req.method === 'POST' && auth.required) {
      const attempt = await submittedPassword(req).catch(() => null)
      if (!attempt || !auth.accepts(attempt)) return void res.writeHead(401, loginHeaders).end(loginPage(true))
      const secure = req.headers['x-forwarded-proto'] === 'https'
      return void res.writeHead(303, { location: '/', 'set-cookie': auth.grant({ secure }) }).end()
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
      : `server: cannot listen on ${socketPath ?? `${bind}:${port}`}: ${err.message}`)
    onExit?.({ exitCode: 1, signal: 0 })
  })

  wss.on('connection', ws => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)
    ws.on('pong', () => { viewer.alive = true })

    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!viewer.started) {
        const hello = decodeHandshake(buf)
        if (!hello) return void viewer.close(1002, 'bad handshake')
        viewer.started = true
        viewer.kind = hello.client === 'attach' ? 'attach' : 'browser'
        viewer.size = { cols: hello.cols, rows: hello.rows }
        admit(viewer).catch(err => {
          console.error('server: could not admit a viewer', err)
          viewer.close(1011, 'could not send the screen')
        })
        return
      }
      if (buf.length === 0) return
      switch (buf[0]) {
        case INPUT:
          active.session.write(buf.subarray(1))
          break
        case RESIZE: {
          const size = decodeSize(buf.subarray(1))
          if (size) {
            viewer.size = size
            scheduleFit()
          }
          break
        }
        default:
          break
      }
    })

    const drop = () => {
      viewers.delete(viewer)
      active?.session.remove(viewer)
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })

  const ping = setInterval(() => {
    for (const viewer of viewers) {
      if (!viewer.open) continue
      if (!viewer.alive) { viewer.ws.terminate(); continue }
      viewer.alive = false
      viewer.ws.ping()
    }
  }, PING_MS)
  ping.unref()

  // The program starts here rather than before listening: one that cannot be
  // served should never have been spawned, and a pi that starts only to be
  // killed leaves a session file behind for the folder list to offer.
  //
  // A socket path means a background child of the supervisor, reachable only
  // by whatever can open that file — never a network port. Port 0 means the OS
  // picks, so report what it actually bound rather than what was asked for.
  http.listen(socketPath ?? port, socketPath ? undefined : bind, () => {
    start()
    onListen?.(socketPath ? { socketPath } : { port: http.address().port, bind })
  })

  return {
    http,
    async close() {
      clearInterval(ping)
      clearTimeout(fitTimer)
      active?.stopFooter()
      active?.stopIdentity?.()
      active?.session.kill()
      // Terminated, not closed: a close frame waits for one back, and a phone
      // asleep behind a dead tunnel does not answer for 30 seconds — which is
      // how long Ctrl-C would appear to hang, since an upgraded socket holds
      // http.close() open until it goes. Nobody is owed a handshake from a
      // server that is already gone.
      for (const viewer of viewers) viewer.ws.terminate()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
