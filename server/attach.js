// `mobile-tty attach`: a viewer like any other, in a real terminal.
//
// It speaks the same protocol as the phone, so the desktop is not a special
// case and cannot resize the PTY behind the server's back. What it has to do
// that a browser gets for free is act like a terminal: raw mode restored
// whatever happens, SIGWINCH forwarded, and Ctrl-C and Ctrl-Z passed through to
// the far side rather than acted on here.
import { WebSocket } from 'ws'
import { INPUT, RESIZE, OUTPUT, SET_TITLE, SET_SIZE } from './protocol.js'

// Ctrl-] detaches, the way telnet and ssh do it. Not Ctrl-\, which pi wants,
// and not Ctrl-C or Ctrl-Z, which are the whole point of passing through.
//
// The snapshot's preamble enables the kitty keyboard protocol, so a terminal
// that honors it reports Ctrl-] as `ESC[93;5u` — the ] codepoint with the
// ctrl bit set — instead of the raw 0x1d byte. Both are the same chord.
const DETACH = 0x1d
const DETACH_KITTY = /\x1b\[93(:[0-9]+)?;\d+u/

// Same chord in either encoding.
export const isDetach = chunk => chunk.includes(DETACH) || DETACH_KITTY.test(chunk)

const frame = (cmd, text) => Buffer.concat([Buffer.from([cmd]), Buffer.from(text)])

export function attach({ url }) {
  const { stdin, stdout } = process
  if (!stdin.isTTY) {
    console.error('attach: not a terminal')
    process.exit(2)
  }

  const ws = new WebSocket(url, ['tty'])
  let restored = false

  // The snapshot's preamble leaves the terminal in the kitty keyboard protocol
  // and bracketed paste, and pi's own frames leave the cursor hidden and may
  // leave synchronized output holding. Undo all of it on the way out, or the
  // shell that comes back is fed escape-encoded keys and has no cursor.
  const UNPREP = '\x1b[?2026l\x1b[<1u\x1b[?2004l\x1b[?25h'

  // One restore path for every exit, including a throw: leaving a terminal in
  // raw mode is the kind of bug that outlives the process that caused it.
  const restore = () => {
    if (restored) return
    restored = true
    stdout.write(UNPREP)
    if (stdin.isRaw) stdin.setRawMode(false)
    stdin.pause()
  }
  const leave = (message, code = 0) => {
    restore()
    if (message) stdout.write(`\r\n${message}\r\n`)
    process.exit(code)
  }
  process.on('exit', restore)
  process.on('uncaughtException', err => { restore(); throw err })
  // Killed from outside, the terminal still gets restored.
  process.on('SIGTERM', () => leave())
  process.on('SIGHUP', () => leave())

  const size = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 })

  ws.on('open', () => {
    ws.send(JSON.stringify({ AuthToken: '', ...size() }))
    stdin.setRawMode(true)
    stdin.resume()
    stdout.on('resize', () => ws.send(frame(RESIZE, JSON.stringify(size()))))
    stdin.on('data', chunk => {
      if (isDetach(chunk)) leave('detached; the session is still running')
      ws.send(frame(INPUT, chunk))
    })
  })

  let announced = null

  ws.on('message', data => {
    const buf = Buffer.from(data)
    if (buf[0] === OUTPUT) {
      // A terminal that cannot keep up must slow the socket down rather than
      // let the server's queue grow until it disconnects us.
      if (!stdout.write(buf.subarray(1))) {
        ws._socket.pause()
        stdout.once('drain', () => ws._socket.resume())
      }
    }
    else if (buf[0] === SET_TITLE) stdout.write(`\x1b]0;${buf.subarray(1)}\x07`)
    else if (buf[0] === SET_SIZE) {
      // A real terminal cannot be resized from in here, so when a narrower
      // viewer owns the grid the program simply draws in part of this window.
      // Say so once, or it reads as a rendering fault.
      const { columns, rows } = JSON.parse(buf.subarray(1))
      const note = `${columns}x${rows}`
      if (note !== announced && columns < size().columns) {
        stdout.write(`\r\n[drawing at ${note} — a narrower viewer owns the grid]\r\n`)
      }
      announced = note
    }
  })

  ws.on('close', (code, reason) => leave(
    code === 1013 ? 'disconnected: this terminal fell too far behind' : `disconnected (${code}) ${reason}`))
  ws.on('error', err => leave(`attach: ${err.message}`, 1))
}
