// The connection: framing and reconnect. The server owns the PTY size and says
// what it is, so there are no size games left here.
import { encodeInput, encodeResize, encodeSwitch, encodeAskPlaces, encodeHandshake, decodeFrame, OUTPUT, SET_TITLE, SET_SIZE, FOOTER, PLACES } from './ttyd.js'

const BACKOFF_MIN = 500
const BACKOFF_MAX = 10_000

/**
 * A connection that survives the phone sleeping.
 *
 * The terminal object outlives the socket, so a drop leaves the stale screen
 * visible rather than blanking, and reconnecting replaces it with the screen the
 * server kept.
 */
export class TtydConnection {
  constructor({ url, token = '', socketFactory, schedule, cancel = clearTimeout, onOutput, onTitle, onSize, onFooter, onPlaces, onState }) {
    this.url = url
    this.token = token
    this.socketFactory = socketFactory
    this.schedule = schedule
    this.cancel = cancel
    this.onOutput = onOutput
    this.onTitle = onTitle
    this.onSize = onSize
    this.onFooter = onFooter
    this.onPlaces = onPlaces
    this.onState = onState

    this.cols = 0
    this.rows = 0
    this.ws = null
    this.queue = []
    this.backoff = BACKOFF_MIN
    this.retry = null
    this.started = false
  }

  get connected() { return this.ws?.readyState === 1 }

  connect({ cols, rows }) {
    this.cols = cols
    this.rows = rows
    this.started = true
    this._cancelRetry()
    this._open()
  }

  _cancelRetry() {
    if (!this.retry) return
    this.cancel(this.retry.handle)
    this.retry = null
  }

  _scheduleRetry() {
    this._cancelRetry()
    const retry = {}
    this.retry = retry
    retry.handle = this.schedule(() => {
      if (this.retry !== retry) return
      this.retry = null
      this._open()
    }, this.backoff)
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2)
  }

  reconnectNow() {
    if (!this.started) return
    this._cancelRetry()
    this.backoff = BACKOFF_MIN
    const old = this.ws
    this.ws = null
    if (old && old.readyState !== 3) old.close()
    this._open()
  }

  _open() {
    this.onState?.('connecting')
    const ws = this.socketFactory(this.url, ['tty'])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      // The server holds the screen and sends it on connect, so attaching costs
      // nothing and needs no prompting. It also answers with the grid the PTY
      // actually has, which is not always the one asked for here.
      ws.send(encodeHandshake(this.token, this.cols, this.rows))
      this.backoff = BACKOFF_MIN
      for (const frame of this.queue.splice(0)) ws.send(frame)
      this.onState?.('connected')
    }

    ws.onmessage = ev => {
      if (this.ws !== ws) return
      const f = decodeFrame(ev.data)
      if (f.cmd === OUTPUT) this.onOutput(f.payload)
      else if (f.cmd === SET_TITLE) this.onTitle?.(f.text)
      else if (f.cmd === SET_SIZE) this.onSize?.({ cols: f.json.columns, rows: f.json.rows })
      else if (f.cmd === FOOTER) this.onFooter?.(f.text)
      else if (f.cmd === PLACES) this.onPlaces?.(f.json)
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.onState?.('disconnected')
      this._scheduleRetry()
    }
  }

  send(text) {
    const frame = encodeInput(text)
    if (this.connected) this.ws.send(frame)
    else this.queue.push(frame)
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    // Nothing to send while disconnected: the next attach carries the size in
    // its handshake.
    if (this.connected) this.ws.send(encodeResize(cols, rows))
  }

  // Neither of these is queued while disconnected, unlike input. A folder list
  // is only wanted for the menu that is open now, and a switch that arrived
  // minutes late would end a program its sender had stopped looking at.
  askPlaces() {
    if (this.connected) this.ws.send(encodeAskPlaces())
  }

  /** False when the frame never left: the caller has to say so, not assume. */
  switchTo(cwd, resume) {
    if (!this.connected) return false
    this.ws.send(encodeSwitch(cwd, resume))
    return true
  }
}
