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

export class Session {
  constructor({ command, args = [], cwd = process.cwd(), env = process.env, cols = 80, rows = 24 }) {
    this.viewers = new Set()
    this.size = { cols, rows }
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
    this.pty.onExit(({ exitCode, signal }) => this.onExit?.({ exitCode, signal }))
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
    if (this.viewers.size === 0) return this.size
    let cols = Infinity
    let rows = Infinity
    for (const v of this.viewers) {
      if (v.size.cols > 0) cols = Math.min(cols, v.size.cols)
      if (v.size.rows > 0) rows = Math.min(rows, v.size.rows)
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return this.size

    const next = { cols, rows }
    if (!same(next, this.size)) {
      this.size = next
      this.pty.resize(cols, rows)
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

  kill(signal) { this.pty.kill(signal) }
}
