// The ttyd connection: framing, reconnect, and the size games a shared PTY needs.
import { encodeInput, encodeResize, encodeHandshake, decodeFrame, OUTPUT, SET_TITLE } from './ttyd.js'

const QUIET_MS = 250      // long enough that a nudge lands between pi's repaints, not inside one
const BACKOFF_MIN = 500
const BACKOFF_MAX = 10_000
// Long enough that the app has finished reflowing from the first half before
// the second arrives. At 120ms pi laid its input box out against one size and
// left the cursor at another, so typing landed below its own status lines.
const NUDGE_GAP = 500

/**
 * A ttyd connection that survives the phone sleeping.
 *
 * The terminal object outlives the socket, so a drop leaves the stale screen
 * visible rather than blanking. On reconnect the size is nudged N-1 then N:
 * pi fully repaints on SIGWINCH, which gets a correct screen back without any
 * server-side replay buffer.
 */
export class TtydConnection {
  constructor({ url, token = '', socketFactory, schedule, onOutput, onTitle, onState }) {
    this.url = url
    this.token = token
    this.socketFactory = socketFactory
    this.schedule = schedule
    this.onOutput = onOutput
    this.onTitle = onTitle
    this.onState = onState

    this.cols = 0
    this.rows = 0
    this.ws = null
    this.queue = []
    this.backoff = BACKOFF_MIN
    this.lastOutput = 0
    this.everPainted = false
    this.now = () => Date.now()
  }

  get connected() { return this.ws?.readyState === 1 }

  /** Run `fn` once nothing has arrived for a while, and the socket is still ours. */
  whenQuiet(ws, fn) {
    const tick = () => {
      if (this.ws !== ws || ws.readyState !== 1) return
      const since = this.now() - this.lastOutput
      if (since >= QUIET_MS) fn()
      else this.schedule(tick, QUIET_MS - since)
    }
    this.schedule(tick, QUIET_MS)
  }

  connect({ cols, rows }) {
    this.cols = cols
    this.rows = rows
    this._open()
  }

  _open() {
    this.onState?.('connecting')
    const ws = this.socketFactory(this.url, ['tty'])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      // Attaching gives a blank screen with no replay, so the size is nudged to
      // make the app repaint. This runs on *every* attach, not just after a
      // drop: dtach sessions outlive the page, so even a first connection from
      // a freshly loaded client can be landing on an already-running program.
      //
      // The two sizes need a gap between them. Sent back to back, the app reads
      // the window size only after both ioctls have applied, sees the size it
      // already had, and does nothing.
      ws.send(encodeHandshake(this.token, this.cols, this.rows))
      // Nudge only when there is nothing on screen to keep. Reattaching sends
      // no replay, so a fresh page needs it — but on a reconnect the stale
      // screen is better than what a nudge costs: every reflow redraws the whole
      // conversation into scrollback. Rows, not columns: a column change makes
      // the far side rewrap everything, where a row change is only a redraw.
      if (!this.everPainted) {
        this.whenQuiet(ws, () => {
          ws.send(encodeResize(this.cols, this.rows - 1))
          this.schedule(() => {
            if (this.ws === ws && ws.readyState === 1) ws.send(encodeResize(this.cols, this.rows))
          }, NUDGE_GAP)
        })
      }
      this.backoff = BACKOFF_MIN
      for (const frame of this.queue.splice(0)) ws.send(frame)
      this.onState?.('connected')
    }

    ws.onmessage = ev => {
      const f = decodeFrame(ev.data)
      if (f.cmd === OUTPUT) {
        this.lastOutput = this.now()
        this.everPainted = true
        this.onOutput(f.payload)
      }
      else if (f.cmd === SET_TITLE) this.onTitle?.(f.text)
    }

    ws.onclose = () => {
      this.onState?.('disconnected')
      this.schedule(() => this._open(), this.backoff)
      this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2)
    }
  }

  send(text) {
    const frame = encodeInput(text)
    if (this.connected) this.ws.send(frame)
    else this.queue.push(frame)
  }

  /**
   * Take the shared PTY size back. One PTY has one size across every attached
   * client, and whoever set it last owns it — so a desktop `dtach -a` at a
   * different size leaves this client rendering a grid the PTY does not have.
   *
   * Re-sending the same numbers cannot do it: ttyd finds its own PTY unchanged,
   * raises no SIGWINCH, and nothing reaches the session. It takes a real change,
   * which is why this is the nudge and why it costs two redraws — and why it is
   * a deliberate action rather than a poll.
   */
  claimSize() {
    if (!this.connected) return
    this.ws.send(encodeResize(this.cols - 1, this.rows))
    this.schedule(() => {
      if (this.connected) this.ws.send(encodeResize(this.cols, this.rows))
    }, NUDGE_GAP)
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    // Nothing to send while disconnected: the next attach carries the size in
    // its handshake. Queuing it would also flush in the same tick as the
    // repaint nudge and collapse the gap the nudge depends on.
    if (this.connected) this.ws.send(encodeResize(cols, rows))
  }
}
