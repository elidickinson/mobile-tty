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
import { INPUT, RESIZE, decodeHandshake, decodeResize } from './protocol.js'

// Cloudflare drops idle sockets and the phone sleeps, so the socket has to be
// spoken to even when pi is silent. ttyd did this and it is why `up` survived a
// quiet evening.
const PING_MS = 30_000
// A resize costs pi a full transcript re-render, so viewers that flap their size
// are made to settle before anyone pays for it.
const RESIZE_COALESCE_MS = 100

export function createTerminalServer({ port, bind, index, command, args = [], onListen, onExit }) {
  const session = new Session({ command, args })
  const mirror = new Mirror(session.size)
  const viewers = new Set()

  session.onResize = size => {
    mirror.resize(size.cols, size.rows)
    for (const viewer of viewers) if (viewer.queue === null) viewer.sendSize(size)
  }
  session.onData = data => {
    mirror.write(data)
    for (const viewer of viewers) {
      // Not yet given a screen, so these bytes are already in the snapshot it
      // is about to get.
      if (viewer.queue === undefined) continue
      // Queued rather than sent: its snapshot has been taken but not delivered,
      // and these bytes belong after it.
      if (viewer.queue) viewer.queue.push(data)
      else if (!viewer.output(data)) viewers.delete(viewer)
    }
  }

  /**
   * Give a viewer the screen, then everything that happened while we took it.
   *
   * The order is the whole point: take the snapshot from a drained parser, then
   * flush what arrived meanwhile. Sending live bytes first would apply them to a
   * screen the viewer has not been given, and sending them twice would double.
   */
  const admit = async viewer => {
    session.add(viewer)
    mirror.resize(session.size.cols, session.size.rows)
    await mirror.drain()
    // Nothing can arrive between here and the snapshot: `onData` is an I/O
    // callback and this is the microtask continuing the await, so the queue
    // opens on exactly the byte the snapshot ends at. Opening it any earlier
    // sends those bytes twice, once inside the snapshot and once after it.
    viewer.queue = []
    const snapshot = Buffer.from(mirror.snapshot())
    // Size before screen: the snapshot is drawn for the PTY's grid, so a viewer
    // that asked for a different one has to be rendering at this size before it
    // arrives.
    viewer.sendSize(session.size)
    if (!viewer.output(snapshot)) return
    for (const chunk of viewer.queue) if (!viewer.output(chunk)) return
    viewer.queue = null
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

  const wss = new WebSocketServer({ server: http, path: '/ws', handleProtocols: () => 'tty' })

  wss.on('connection', ws => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)

    // One viewer's bad frame is not allowed to reach any other viewer, or pi.
    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!viewer.started) {
        const size = decodeHandshake(buf)
        if (!size) return void viewer.close(1002, 'bad handshake')
        viewer.started = true
        viewer.size = size
        viewer.title(command)
        viewer.prefs({})
        admit(viewer)
        return
      }
      if (buf.length === 0) return
      switch (buf[0]) {
        case INPUT:
          session.write(buf.subarray(1))
          break
        case RESIZE: {
          const size = decodeResize(buf.subarray(1))
          if (size) {
            viewer.size = size
            scheduleFit()
          }
          break
        }
        default:
          break   // PAUSE and RESUME exist in the protocol; nothing needs them
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
    for (const viewer of viewers) if (viewer.open) viewer.ws.ping()
  }, PING_MS)
  ping.unref()

  // Port 0 means the OS picks, so report what it actually bound rather than
  // what was asked for.
  http.listen(port, bind, () => onListen?.({ port: http.address().port, bind }))

  return {
    http,
    wss,
    session,
    async close() {
      clearInterval(ping)
      clearTimeout(fitTimer)
      session.kill()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
