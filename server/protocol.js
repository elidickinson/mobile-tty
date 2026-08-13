// The wire protocol, server side. `src/ttyd.js` is the client's half of this.
// Both ends are ours; the shape is inherited from ttyd so the client did not
// have to change when the server did.

// client -> server
export const INPUT = 0x30        // '0'
export const RESIZE = 0x31       // '1'

// server -> client
export const OUTPUT = 0x30       // '0'
export const SET_TITLE = 0x31    // '1'
export const SET_SIZE = 0x33     // '3'  the grid the PTY actually has
export const FOOTER = 0x34       // '4'  the status-strip line, verbatim from the mtty-footer extension

/**
 * A size off the wire, from either the handshake or a RESIZE frame.
 *
 * The handshake is a bare JSON object with no command byte and must be the first
 * message on the socket; a RESIZE is the same payload behind a prefix. Both
 * reach the PTY, so both get the same scrutiny. Returns null for anything
 * unparseable or unreasonable, which closes that viewer rather than the server.
 */
const decodeDimensions = value => {
  const { columns, rows } = value
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) return null
  // The upper bound is not theatre: the grid is allocated server-side, in the
  // mirror as well as the PTY.
  if (columns < 1 || rows < 1 || columns > 1000 || rows > 1000) return null
  return { cols: columns, rows }
}

export const decodeHandshake = buf => {
  try {
    const value = JSON.parse(buf.toString())
    const size = decodeDimensions(value)
    return size && { ...size, client: value.client }
  } catch {
    return null
  }
}

export const decodeSize = buf => {
  try {
    return decodeDimensions(JSON.parse(buf.toString()))
  } catch {
    return null
  }
}
