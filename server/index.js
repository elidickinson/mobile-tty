// The server: it owns pi, and it is the session.
//
// It replaces ttyd and dtach both. dtach is gone because it silently discarded
// the unwritten tail of a read whenever a client socket filled, which is where
// the corrupt escape sequences came from; nothing here may repeat that.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { Session } from './session.js'
import { Viewer } from './viewer.js'
import { Mirror } from './mirror.js'
import { INPUT, RESIZE, decodeSize } from './protocol.js'

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

/**
 * `scrollback` is how much history a reconnecting viewer gets back. It is worth
 * tuning: pi does not page its own transcript, so this is the only way to read
 * back through a conversation on a phone. Roughly 75 bytes a line — 500 lines is
 * about 37 KB per connect, against a pi transcript re-render that starts at
 * 12 KB and grows with every turn.
 */
export function createTerminalServer({ port, bind, index, command, args = [], scrollback = 500, onListen, onExit }) {
  const session = new Session({ command, args })
  const mirror = new Mirror({ ...session.size, scrollback })
  const viewers = new Set()

  // Non-null while a snapshot is being taken. The mirror stops consuming for
  // that moment so the screen it serializes is exactly the screen these bytes
  // come after — see admit().
  let held = null

  /**
   * A resize re-sends the screen rather than letting viewers reflow it.
   *
   * The client's VT core loses a third to two-thirds of its text on a column
   * shrink, so a viewer that reflows its own history ends up with something the
   * mirror disagrees with — content in the wrong places, and different again
   * from what the next viewer to connect is given. The mirror reflows correctly,
   * so it is the only thing allowed to: everyone else is handed the result.
   */
  session.onResize = size => {
    mirror.resize(size.cols, size.rows)
    for (const viewer of viewers) if (viewer.queue === null) sendScreen(viewer)
  }
  session.onData = data => {
    // Viewers first: the mirror is a convenience, and a failure in it must not
    // cost anyone bytes it was about to be sent.
    for (const viewer of viewers) {
      if (viewer.queue) viewer.queue.push(data)
      else if (viewer.queue === null && !viewer.output(data)) viewers.delete(viewer)
    }
    if (held) held.push(data)
    else mirror.write(data)
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

      held = []
      viewer.queue = []
      try {
        await mirror.drain()
        const snapshot = Buffer.from(mirror.snapshot())

        // Size before screen: the snapshot is drawn for the PTY's grid, so a
        // viewer that asked for a different one has to be rendering at this
        // size before it arrives.
        viewer.sendSize(session.size)
        // Screen, then the bytes the screen could not contain yet, then what
        // arrived while it was being taken.
        if (viewer.output(snapshot)) {
          const rest = mirror.pending.length ? [Buffer.from(mirror.pending), ...viewer.queue] : viewer.queue
          for (const chunk of rest) if (!viewer.output(chunk)) break
        }
      } finally {
        // Whatever happened to this viewer, the mirror has to be fed again or
        // every screen after this one is stale.
        viewer.queue = null
        for (const chunk of held) mirror.write(chunk)
        held = null
      }
    })
    return admitting
  }

  const admit = viewer => {
    session.add(viewer)
    return sendScreen(viewer)
  }

  session.onExit = status => {
    for (const viewer of viewers) viewer.close(1000, 'session ended')
    onExit?.(status)
  }

  let fitTimer = null
  const scheduleFit = () => {
    if (fitTimer) return
    fitTimer = setTimeout(() => { fitTimer = null; session.fit() }, RESIZE_COALESCE_MS)
    fitTimer.unref()
  }

  const http = createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/') return void res.writeHead(404).end()
    try {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(await readFile(index))
    } catch {
      res.writeHead(500).end('cannot read the client')
    }
  })

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_FRAME, handleProtocols: () => 'tty' })

  wss.on('connection', ws => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)
    ws.on('pong', () => { viewer.alive = true })

    // One viewer's bad frame is not allowed to reach any other viewer, or pi.
    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!viewer.started) {
        const size = decodeSize(buf)
        if (!size) return void viewer.close(1002, 'bad handshake')
        viewer.started = true
        viewer.size = size
        viewer.title(command)
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
          session.write(buf.subarray(1))
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
      session.remove(viewer)
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

  // Port 0 means the OS picks, so report what it actually bound rather than
  // what was asked for.
  http.listen(port, bind, () => onListen?.({ port: http.address().port, bind }))

  return {
    http,
    async close() {
      clearInterval(ping)
      clearTimeout(fitTimer)
      session.kill()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
