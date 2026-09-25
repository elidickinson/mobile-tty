// The status strip's channel. The mtty-footer pi extension connects to the
// socket named by $MTTY_FOOTER and sends one JSON object -- the active model
// and its thinking level -- per change, closing the connection behind it.
//
// A connection is a message, so there is nothing to frame and nothing to clean
// up: the state is read once the extension is done sending it, which is the
// whole reason this is not a file being written and watched. The extension
// decides when something has changed, so whatever arrives here is worth
// relaying.
import { createServer } from 'node:net'

// A report is a couple of hundred bytes. Anything longer is not one, and taking
// it whole would be a way for whoever can reach this socket to spend this
// process's memory.
const MAX_REPORT = 1024

/**
 * Listen on `path`, handing each reported state to `onState`. Returns what
 * closes the listener and everything it accepted; the socket file goes with
 * it, since node unlinks a closed Unix socket.
 */
export function openFooter(path, onState) {
  let stopped = false
  const senders = new Set()
  const server = createServer(sock => {
    senders.add(sock)
    let body = ''
    sock.setEncoding('utf8')
    sock.on('data', chunk => {
      body += chunk
      if (body.length > MAX_REPORT) sock.destroy()
    })
    // A sender that goes away mid-report is one missed status line, which is
    // all it is: the program in the PTY is what this server exists for.
    sock.on('error', () => {})
    sock.on('close', () => senders.delete(sock))
    sock.on('end', () => { if (!stopped) onState(body) })
  })
  server.on('error', err => console.error(`server: the status strip is off (${err.message})`))
  server.listen(path)
  return () => {
    stopped = true
    server.close()
    // A sender still connected here never finished its report, and nothing is
    // going to read it now.
    for (const sock of senders) sock.destroy()
  }
}
