// The server: it owns pi, and it is the session.
//
// It replaces ttyd and dtach both. dtach is gone because it silently discarded
// the unwritten tail of a read whenever a client socket filled, which is where
// the corrupt escape sequences came from; nothing here may repeat that.
//
// There is exactly one program at a time, and switching folders ends it and
// starts another — so every invariant below is still "one PTY, N viewers, one
// screen". What changes on a switch is which program that screen belongs to.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { Auth, loginPage, submittedPassword } from './auth.js'
import { buildClient } from './client.js'
import { removeFooterFiles, watchFooter } from './footer.js'
import { isAddress, originAllowed } from './origin.js'
import { PI_SESSIONS, placeFor, readPlaces } from './places.js'
import { Session } from './session.js'
import { Viewer } from './viewer.js'
import { Mirror } from './mirror.js'
import { INPUT, RESIZE, SWITCH, ASK_PLACES, decodeHandshake, decodeSize, decodeSwitch } from './protocol.js'

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

// pi's own flag for picking a folder's last session back up, and the test for
// whether offering it means anything: `bash --continue` is not a thing.
const RESUME_FLAG = '--continue'
const isPi = command => basename(command) === 'pi'

// A switch waits for the old program to be gone before starting the next one,
// so the two can never both hold the footer file or the grid. SIGTERM is what
// pi is asked with; this is how long it gets before the question stops being
// one, because a program that will not leave must not strand the server with
// nothing to serve.
const KILL_GRACE_MS = 2_000

// A switch the server declines, as against one that goes wrong. A client only
// ever names a folder the server listed, so a refusal means a list that went
// stale under an open menu, or a client that made something up: expected
// either way, and worth one line rather than a stack.
class Refused extends Error {}

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
export function createTerminalServer({ port, bind, hostname, password, command, args = [], scrollback = DEFAULT_SCROLLBACK, sessionDir = PI_SESSIONS, footerPath = join(tmpdir(), `mtty-${process.pid}-${randomUUID()}-footer.json`), onListen, onExit }) {
  const auth = new Auth(password)

  const startCwd = process.cwd()
  // A program named by path means that program, not whatever happens to sit at
  // the same relative path in the folder we switch to. A bare name is a PATH
  // lookup and is already independent of the cwd.
  const program = command.includes('/') ? resolve(startCwd, command) : command
  const resumable = isPi(program)
  const viewers = new Set()

  // The program, its screen, and the folder it is in. Replaced wholesale by a
  // switch; never two at once, and never absent once the first one has started.
  // A switch retires the outgoing one before its replacement exists, so this
  // keeps pointing at something a keystroke or a handshake can safely land on
  // for the moment in between.
  let active = null

  // Non-null while a snapshot is being taken. The mirror stops consuming for
  // that moment so the screen it serializes is exactly the screen these bytes
  // come after — see admit().
  let held = null

  // Work queued on the admitting chain can outlive the server, and a switch
  // that ran after close() would start a program nothing is left to serve.
  let closed = false

  /**
   * Start a program in a folder and make it the session.
   *
   * `active` is assigned in here rather than by the caller: the PTY can produce
   * bytes as soon as it exists, and a handler that cannot yet recognise itself
   * as the active one would throw them away.
   */
  const start = ({ place, resume, size }) => {
    // Before the program exists, so nothing of the last one's is left for this
    // one's watcher to read as its own — a program on its way out can write the
    // file after it has been told to stop.
    removeFooterFiles(footerPath)
    const session = new Session({
      command: program,
      args: resume ? [...args, RESUME_FLAG] : args,
      cwd: place.cwd,
      // The mtty-footer pi extension is gated on this variable, so any program
      // can be served: only one that understands it writes the file.
      env: { ...process.env, MTTY_FOOTER: footerPath },
      ...size,
    })
    // `retired` is set the moment a switch decides this one is over, which is
    // before it has actually gone and before there is anything to replace it
    // with. Everything below asks it rather than comparing against `active`,
    // which still points here until the replacement exists.
    const unit = { session, place, resume, mirror: new Mirror({ ...session.size, scrollback }), lastFooter: null, retired: false }
    unit.gone = new Promise(resolve => { unit.resolveGone = resolve })

    unit.stopFooter = watchFooter(footerPath, text => {
      if (unit.retired) return
      unit.lastFooter = text
      for (const viewer of viewers) viewer.footer(text)
    })

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
      if (unit.retired) return
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

    session.onData = data => {
      // A program on its way out after a switch still produces bytes — pi
      // repaints on the way down. They belong to a screen nobody is looking at
      // any more.
      if (unit.retired) return
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
      // Ended by a switch, which is already starting its replacement. Only the
      // program that is still the session ends the server with it.
      if (unit.retired) return
      unit.stopFooter()
      for (const viewer of viewers) viewer.close(1000, 'session ended')
      onExit?.(status)
    }

    active = unit
    return unit
  }

  /** Wait for a program to actually be gone, asking nicely first. */
  const end = async unit => {
    unit.session.kill()
    // Unconditional: node-pty swallows the ESRCH from signalling a process that
    // has already gone, so this needs no guard against losing the race.
    const escalate = setTimeout(() => unit.session.kill('SIGKILL'), KILL_GRACE_MS)
    escalate.unref()
    await unit.gone
    clearTimeout(escalate)
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
   * Switching runs on the same chain, so no admission is ever in flight while
   * the program underneath it is being replaced.
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

  const titleFor = place => `${basename(program)} — ${place.path}`

  const admit = viewer => {
    active.session.add(viewer)
    viewer.title(titleFor(active.place))
    // The latest strip line after the screen: a viewer that connects mid-session
    // gets the current stats, not the stale screen's.
    return sendScreen(viewer).then(() => {
      if (viewer.open && active.lastFooter !== null) viewer.footer(active.lastFooter)
    })
  }

  /**
   * The folders that can be switched to.
   *
   * The folder in front of you is always among them, and so is the one the
   * server started in, whether or not pi's store knows about either yet — a
   * list you cannot find your way back to is a trap. Only prepended when the
   * store does not have them already, so a folder with history of its own keeps
   * its place in the recency order.
   */
  const listPlaces = async () => {
    const places = await readPlaces({ sessionDir })
    for (const cwd of [active.place.cwd, startCwd]) {
      if (!places.some(place => place.cwd === cwd)) places.unshift(placeFor(cwd))
    }
    return places
  }

  const sendPlaces = async viewer => {
    const places = await listPlaces()
    viewer.places(JSON.stringify({ cwd: active.place.cwd, resume: resumable, places }))
  }

  /**
   * End the program and start one in another folder.
   *
   * The cwd is checked against the folders the server found for itself, not
   * taken on the client's word. The socket is authenticated and origin-checked
   * before it can send anything at all, so this is not the only thing standing
   * there — but it is the difference between "start pi in a folder I have used"
   * and a general way to run programs anywhere, and only one of those is a
   * feature.
   */
  const switchTo = async ({ cwd, resume }) => {
    if (resume && !resumable) throw new Refused(`${command} has no ${RESUME_FLAG}`)
    const place = (await listPlaces()).find(candidate => candidate.cwd === cwd)
    if (!place) throw new Refused(`no pi history in ${cwd}`)

    admitting = admitting.catch(() => {}).then(async () => {
      // The server came down, or the program ended by itself, while this waited
      // its turn behind other work on the chain. Either way the session is over
      // and there is nothing here to replace.
      if (closed || active.session.exited) return

      const outgoing = active
      // Over, from here: its remaining output is dropped and its exit no longer
      // ends the server. `active` still points at it until there is something
      // to point at instead.
      outgoing.retired = true
      outgoing.stopFooter()
      await end(outgoing)

      try {
        // Started at the grid the last one had, so the new program paints at
        // the size the viewers are already rendering and nothing has to resize.
        start({ place, resume, size: outgoing.session.size })
      } catch (err) {
        // The old program is already gone, so there is nothing to fail back to:
        // this is the session ending, and it has to end the way any other
        // ending does. Otherwise `active` points at a corpse for ever — input
        // silently dropped, and every viewer left in front of a screen with
        // nothing behind it.
        console.error('server: the session ended: could not start the program', err)
        for (const viewer of viewers) viewer.close(1000, 'session ended')
        onExit?.({ exitCode: 1, signal: 0 })
        return
      }

      for (const viewer of viewers) {
        // Nothing may be sent to a viewer that has not said hello — `attach`
        // holds its handshake back to give its banner the screen.
        if (!viewer.started) continue
        active.session.add(viewer)
        viewer.title(titleFor(place))
        // Every viewer gets a fresh screen, `attach` included. Unlike a resize
        // there is no program on the other side that will redraw for them, and
        // the screen they are holding belongs to something that no longer
        // exists. Queued behind this body rather than awaited inside it.
        sendScreen(viewer).catch(err => {
          console.error('server: could not send the screen after a switch', err)
          viewer.close()
        })
      }
    })
    await admitting
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

    // /login answers only when there is a password to log in with. Rejecting
    // it when there is not matters beyond tidiness: `accepts` would compare
    // against nothing, and a client that goes away mid-body is an ordinary
    // event for a phone, not a fault worth ending a terminal over.
    if (path === '/login' && req.method === 'POST' && auth.required) {
      const attempt = await submittedPassword(req).catch(() => null)
      if (!attempt || !auth.accepts(attempt)) return void res.writeHead(401, loginHeaders).end(loginPage(true))
      // Secure only where the connection actually was: on `--lan` it is plain
      // http, and a cookie the browser refuses to send is a login that loops.
      const secure = req.headers['x-forwarded-proto'] === 'https'
      return void res.writeHead(303, { location: '/', 'set-cookie': auth.grant({ secure }) }).end()
    }

    if (path !== '/') return void res.writeHead(404).end()
    if (!auth.admits(req)) return void res.writeHead(200, loginHeaders).end(loginPage())

    let client
    try {
      client = await buildClient()
    } catch (err) {
      // A phone has no console, so a build that fails has to be legible in the
      // page. The server stays up: fix the source and reload.
      return void res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.message ?? err))
    }
    // `no-cache` is revalidate, not don't-store. An unchanged client costs a
    // conditional request instead of the whole document, and the build-id check
    // at startup covers the platforms that revalidate only when they feel like
    // it — which is iOS standalone, the one that matters.
    const headers = { etag: client.etag, 'cache-control': 'no-cache' }
    if (req.headers['if-none-match'] === client.etag) return void res.writeHead(304, headers).end()
    res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(client.page)
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_FRAME,
    handleProtocols: () => 'tty',
    // Refused at the handshake rather than after the socket is up. Said out
    // loud because the other way to land here is a proxy that was never named
    // with --hostname, and a socket that silently will not open is a mystery.
    verifyClient: ({ req }) => {
      const { origin, host } = req.headers
      if (!auth.admits(req)) {
        console.error('server: refused a socket that has not logged in')
        return false
      }
      if (originAllowed({ origin, host, hostname })) return true
      // Only where it is the likely explanation: arriving under a name nobody
      // declared. A hostile page reaching the address direct is not a setup
      // mistake and must not be answered with advice.
      const undeclared = !hostname && host && !isAddress(host)
      console.error(`server: refused a socket from ${origin} for host ${host}` +
        `${undeclared ? ' — a proxy in front of this needs --hostname' : ''}`)
      return false
    },
  })

  // A failed bind arrives here rather than on the http server: ws forwards its
  // errors to itself, and an 'error' with no listener is fatal. Nothing has
  // been spawned at this point — the program starts from the listen callback —
  // so a port we cannot have costs only this message.
  wss.on('error', err => {
    console.error(err.code === 'EADDRINUSE'
      ? `server: port ${port} is already in use\n` +
        `  if that is another mobile-tty:  mobile-tty --port ${port} attach\n` +
        `  if it is something else:        serve on another --port`
      : `server: cannot listen on ${bind}:${port}: ${err.message}`)
    onExit?.({ exitCode: 1, signal: 0 })
  })

  wss.on('connection', ws => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)
    ws.on('pong', () => { viewer.alive = true })

    // One viewer's bad frame is not allowed to reach any other viewer, or pi.
    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!viewer.started) {
        const hello = decodeHandshake(buf)
        if (!hello) return void viewer.close(1002, 'bad handshake')
        viewer.started = true
        viewer.kind = hello.client === 'attach' ? 'attach' : 'browser'
        viewer.size = { cols: hello.cols, rows: hello.rows }
        // Nothing about one viewer's admission may reach another, so a failure
        // here costs that viewer its connection and nothing else.
        admit(viewer).catch(err => {
          console.error('server: could not admit a viewer', err)
          viewer.close(1011, 'could not send the screen')
        })
        return
      }
      if (buf.length === 0) return
      switch (buf[0]) {
        case INPUT:
          // Dropped while a switch is in flight: these were typed at a program
          // that is on its way out, and writing to a pty whose fd has closed
          // throws from inside this handler.
          if (!active.retired) active.session.write(buf.subarray(1))
          break
        case RESIZE: {
          const size = decodeSize(buf.subarray(1))
          if (size) {
            viewer.size = size
            scheduleFit()
          }
          break
        }
        case ASK_PLACES:
          // Read fresh every time rather than cached: the store changes under
          // us as pi is used elsewhere, and this is a hundred stats, not work.
          sendPlaces(viewer).catch(err => console.error('server: could not list the folders', err))
          break
        case SWITCH: {
          const target = decodeSwitch(buf.subarray(1))
          if (!target) {
            console.error('server: ignored a malformed switch')
            break
          }
          // One viewer's switch is everyone's — there is one screen here. A
          // refusal is logged and nothing happens; the program in front of you
          // is not worth losing to a bad frame.
          switchTo(target).catch(err => err instanceof Refused
            ? console.error(`server: did not switch: ${err.message}`)
            // Anything else is a fault rather than an answer, and its stack is
            // the only account of it there will be.
            : console.error('server: did not switch:', err))
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
      // Unanswered from last round: a phone that slept through a tunnel drop
      // would otherwise sit in the set forever, holding the shared grid at its
      // width because the narrowest viewer wins.
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
  // Port 0 means the OS picks, so report what it actually bound rather than
  // what was asked for.
  http.listen(port, bind, () => {
    start({ place: placeFor(startCwd), resume: false })
    onListen?.({ port: http.address().port, bind })
  })

  return {
    http,
    async close() {
      closed = true
      clearInterval(ping)
      clearTimeout(fitTimer)
      active?.stopFooter()
      active?.session.kill()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
