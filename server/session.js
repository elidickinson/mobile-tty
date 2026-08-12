// One PTY, N viewers.
//
// The session owns pi and every byte it produces. Viewers come and go; the PTY
// does not notice. Nothing here may drop a byte for a viewer that is still
// attached — that is the whole reason this exists rather than dtach, which
// abandons the unwritten tail of a read when a client socket fills.
import { spawn } from 'node-pty'

// pi renders relatively and re-renders its whole transcript on SIGWINCH, so a
// resize is expensive and gets more so as the conversation grows. Only send one
// when the size actually changes.
const same = (a, b) => a.cols === b.cols && a.rows === b.rows

// The narrowest viewer wins, so without a floor any viewer could hand everyone
// a 1x1 grid. Nothing legible is narrower than this.
const MIN_COLS = 20
const MIN_ROWS = 8

export class Session {
  constructor({ command, args = [], cwd = process.cwd(), env = process.env, cols = 80, rows = 24 }) {
    this.viewers = new Set()
    this.size = { cols, rows }
    this.exited = false
    this.onData = null
    this.onExit = null
    this.onResize = null

    this.pty = spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      // Bytes, not strings: a multi-byte sequence split across reads must not be
      // decoded here — the VT parsers at both ends reassemble it.
      encoding: null,
    })
    this.pty.onData(data => this.onData?.(data))
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.onExit?.({ exitCode, signal })
    })
  }

  write(bytes) { this.pty.write(bytes) }

  /**
   * The narrowest viewer wins.
   *
   * This is a phone-first tool: a desktop showing a phone-width column is
   * legible, a phone showing a desktop-width screen is not. It also makes the
   * common case free — the phone is already the narrowest, so nothing resizes.
   */
  fit() {
    // Viewers can outlive the program by the moment it takes to close them, and
    // resizing a closed PTY throws EBADF from a timer, where it would take the
    // whole server down.
    if (this.exited || this.viewers.size === 0) return this.size
    let cols = Infinity
    let rows = Infinity
    for (const v of this.viewers) {
      if (v.size.cols > 0) cols = Math.min(cols, v.size.cols)
      if (v.size.rows > 0) rows = Math.min(rows, v.size.rows)
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return this.size

    const next = { cols: Math.max(cols, MIN_COLS), rows: Math.max(rows, MIN_ROWS) }
    if (!same(next, this.size)) {
      try {
        this.pty.resize(next.cols, next.rows)
      } catch (err) {
        // `exited` is only set once the async exit event lands, and kill()
        // can close the fd before that arrives — a viewer's socket dropping in
        // that window reaches here with a pty that is already gone in every
        // sense but the flag. Committing `size` before the attempt would leave
        // it claiming a size the pty never reached, and `same()` would then
        // skip every future resize back to it — so it moves here, after.
        console.error('server: pty resize failed', err)
        return this.size
      }
      this.size = next
      this.onResize?.(next)
    }
    return this.size
  }

  add(viewer) {
    this.viewers.add(viewer)
    return this.fit()
  }

  remove(viewer) {
    this.viewers.delete(viewer)
    if (this.viewers.size > 0) this.fit()
  }

  // node-pty defaults to SIGHUP, which pi handles but which is a surprising
  // thing for Ctrl-C on the server to turn into. Say what we mean.
  kill(signal = 'SIGTERM') { this.pty.kill(signal) }
}
