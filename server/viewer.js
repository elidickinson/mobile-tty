// A viewer: one WebSocket, and the rule that it can only ever hurt itself.
//
// The bug this whole server exists to escape was a fan-out that quietly dropped
// bytes when a client socket filled. So there are exactly three things a slow
// viewer may do here — catch up, or be disconnected — and skipping bytes is not
// among them. A disconnect is visible and recoverable; a gap is neither.
import { OUTPUT, SET_TITLE, SET_PREFS, SET_SIZE } from './protocol.js'

// Enough that a phone stalling through a tunnel for a few seconds rides it out,
// small enough that one dead socket cannot grow into the process's problem.
export const BACKLOG_LIMIT = 4 * 1024 * 1024

// 1013 Try Again Later: the viewer is not wrong, it is behind.
const TOO_FAR_BEHIND = 1013

export class Viewer {
  constructor(ws) {
    this.ws = ws
    this.size = { cols: 0, rows: 0 }
    this.started = false
    // undefined until the snapshot has been taken — output before that is
    // already inside it. An array while the snapshot is in flight. null once
    // this viewer is live.
    this.queue = undefined
  }

  get open() { return this.ws.readyState === this.ws.OPEN }

  send(kind, payload) {
    if (!this.open) return
    this.ws.send(Buffer.concat([Buffer.from([kind]), Buffer.from(payload)]))
  }

  /**
   * Hand this viewer output. Returns false once it has been cut loose.
   *
   * The check is before the write, not after: `bufferedAmount` is what this
   * socket has failed to drain, so a viewer that is already over its limit does
   * not get to make it worse.
   */
  output(bytes) {
    if (!this.open) return false
    if (this.ws.bufferedAmount > BACKLOG_LIMIT) {
      this.ws.close(TOO_FAR_BEHIND, 'too far behind')
      return false
    }
    this.send(OUTPUT, bytes)
    return true
  }

  title(text) { this.send(SET_TITLE, text) }

  prefs(obj) { this.send(SET_PREFS, JSON.stringify(obj)) }

  /** The grid the PTY actually has, which is not always the one this viewer
   *  asked for: the narrowest viewer wins and the rest render smaller. */
  sendSize({ cols, rows }) { this.send(SET_SIZE, JSON.stringify({ columns: cols, rows })) }

  close(code, reason) { if (this.open) this.ws.close(code, reason) }
}
