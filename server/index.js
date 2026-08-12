// The server: one PTY per connection, attached to a dtach session that outlives
// them all, speaking the same five-byte protocol the client already knows.
//
// It replaces ttyd so that the screen can live here rather than nowhere — see
// eli/plan.md. This step changes nothing the client can observe.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { spawn } from 'node-pty'

// client -> server            server -> client
const INPUT = 0x30            // '0'   OUTPUT
const RESIZE = 0x31           // '1'   SET_WINDOW_TITLE
                              // '2'   SET_PREFERENCES

export function createTerminalServer({ port, bind, index, command, args = [], onListen }) {
  const http = createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/') {
      res.writeHead(404).end()
      return
    }
    try {
      const page = await readFile(index)
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(page)
    } catch {
      res.writeHead(500).end('cannot read the client')
    }
  })

  const wss = new WebSocketServer({ server: http, path: '/ws', handleProtocols: () => 'tty' })

  wss.on('connection', ws => {
    let pty = null

    const send = (kind, payload) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(Buffer.concat([Buffer.from(kind), Buffer.from(payload)]))
    }

    // The first message is the handshake, and carries the size to open at.
    const start = ({ columns, rows }) => {
      pty = spawn(command, args, {
        name: 'xterm-256color',
        cols: columns || 80,
        rows: rows || 24,
        cwd: process.cwd(),
        env: process.env,
        // Bytes, not strings: a multi-byte sequence split across reads must not
        // be decoded here — the client's VT core reassembles it.
        encoding: null,
      })
      pty.onData(data => send('0', data))
      pty.onExit(() => ws.close())
      send('1', command)
      send('2', JSON.stringify({}))
    }

    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!pty) {
        // Anything before the handshake is either the handshake or noise.
        try { start(JSON.parse(buf.toString())) } catch { /* not yet */ }
        return
      }
      switch (buf[0]) {
        case INPUT:
          pty.write(buf.subarray(1))
          break
        case RESIZE: {
          const { columns, rows } = JSON.parse(buf.subarray(1).toString())
          if (columns > 0 && rows > 0) pty.resize(columns, rows)
          break
        }
        default:
          break   // PAUSE and RESUME exist in the protocol; nothing needs them yet
      }
    })

    ws.on('close', () => pty?.kill())
    ws.on('error', () => pty?.kill())
  })

  http.listen(port, bind, () => onListen?.({ port, bind }))
  return { http, wss, close: () => new Promise(res => { wss.close(); http.close(res) }) }
}
