// The wire protocol, server side. `src/ttyd.js` is the client's half of this.
// Both ends are ours; the shape is inherited from ttyd so the client did not
// have to change when the server did.

// client -> server
export const INPUT = 0x30        // '0'
export const RESIZE = 0x31       // '1'
export const PAUSE = 0x32        // '2'
export const RESUME = 0x33       // '3'

// server -> client
export const OUTPUT = 0x30       // '0'
export const SET_TITLE = 0x31    // '1'
export const SET_PREFS = 0x32    // '2'

/**
 * The handshake is a bare JSON object rather than a prefixed frame, and must be
 * the first message on the socket. Returns null for anything unparseable, so a
 * malformed one closes a viewer instead of the server.
 */
export const decodeHandshake = buf => {
  try {
    const { columns, rows } = JSON.parse(buf.toString())
    return { cols: Number(columns) || 0, rows: Number(rows) || 0 }
  } catch {
    return null
  }
}

/** A RESIZE payload. Returns null unless both dimensions are sane. */
export const decodeResize = buf => {
  try {
    const { columns, rows } = JSON.parse(buf.toString())
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) return null
    if (columns < 1 || rows < 1 || columns > 1000 || rows > 1000) return null
    return { cols: columns, rows }
  } catch {
    return null
  }
}
