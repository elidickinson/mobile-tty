// ttyd's WebSocket protocol: subprotocol `tty` on /ws, first byte is the command.
export const INPUT = '0'
export const RESIZE = '1'
export const PAUSE = '2'
export const RESUME = '3'

export const OUTPUT = '0'
export const SET_TITLE = '1'
export const SET_PREFS = '2'

const enc = new TextEncoder()
const dec = new TextDecoder()

const frame = (cmd, text) => {
  const body = enc.encode(text)
  const out = new Uint8Array(body.length + 1)
  out[0] = cmd.charCodeAt(0)
  out.set(body, 1)
  return out
}

export const encodeInput = text => frame(INPUT, text)

export const encodeResize = (columns, rows) => frame(RESIZE, JSON.stringify({ columns, rows }))

// The handshake is a bare JSON object rather than a prefixed frame, and must be
// the first message on the socket.
export const encodeHandshake = (token, columns, rows) =>
  enc.encode(JSON.stringify({ AuthToken: token, columns, rows }))

/**
 * Split a server message into its command byte and payload.
 *
 * OUTPUT payloads stay as raw bytes: a multi-byte UTF-8 sequence can straddle
 * two WebSocket messages, and decoding each one independently corrupts it. The
 * VT core reassembles them, so nothing here may look at the text.
 */
export function decodeFrame(buffer) {
  const all = new Uint8Array(buffer)
  if (all.length === 0) throw new Error('ttyd: empty message')
  const cmd = String.fromCharCode(all[0])
  const payload = all.subarray(1)
  if (cmd === OUTPUT) return { cmd, payload }
  const text = dec.decode(payload)
  if (cmd === SET_PREFS) return { cmd, text, json: JSON.parse(text) }
  return { cmd, text }
}
