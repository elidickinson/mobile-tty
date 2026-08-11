import { encodeInput, encodeResize, encodeHandshake, decodeFrame, OUTPUT, SET_TITLE } from './ttyd.js'

const BACKOFF_MIN = 500
const BACKOFF_MAX = 10_000
const NUDGE_GAP = 120

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
    this.everConnected = false
  }

  get connected() { return this.ws?.readyState === 1 }

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
      // Reattaching gives a blank screen with no replay, so the size is nudged
      // to make the app repaint. The two sizes need a gap between them: sent
      // back to back the app can read the window size only after both ioctls
      // and see no change at all.
      ws.send(encodeHandshake(this.token, this.cols, this.rows))
      if (this.everConnected) {
        ws.send(encodeResize(this.cols - 1, this.rows))
        this.schedule(() => {
          if (this.ws === ws && ws.readyState === 1) ws.send(encodeResize(this.cols, this.rows))
        }, NUDGE_GAP)
      }
      this.everConnected = true
      this.backoff = BACKOFF_MIN
      for (const frame of this.queue.splice(0)) ws.send(frame)
      this.onState?.('connected')
    }

    ws.onmessage = ev => {
      const f = decodeFrame(ev.data)
      if (f.cmd === OUTPUT) this.onOutput(f.payload)
      else if (f.cmd === SET_TITLE) this.onTitle?.(f.text)
    }

    ws.onclose = () => {
      this.onState?.('disconnected')
      this.schedule(() => this._open(), this.backoff)
      this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2)
    }
  }

  _write(frame) {
    if (this.connected) this.ws.send(frame)
    else this.queue.push(frame)
  }

  send(text) { this._write(encodeInput(text)) }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this._write(encodeResize(cols, rows))
  }
}
