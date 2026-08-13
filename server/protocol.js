// The wire protocol, server side. `src/ttyd.js` is the client's half of this.
// Both ends are ours; the shape is inherited from ttyd so the client did not
// have to change when the server did.

// client -> server
export const INPUT = 0x30        // '0'
export const RESIZE = 0x31       // '1'
export const SWITCH = 0x32       // '2'  end this program and start one in another folder
export const ASK_PLACES = 0x33   // '3'  send the folder list

// server -> client
export const OUTPUT = 0x30       // '0'
export const SET_TITLE = 0x31    // '1'
export const SET_SIZE = 0x33     // '3'  the grid the PTY actually has
export const FOOTER = 0x34       // '4'  the status-strip line, verbatim from the mtty-footer extension
export const PLACES = 0x35       // '5'  the folder list, and which one is current

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

/**
 * A switch request: which folder, and whether to continue its last session.
 *
 * The cwd is not trusted here beyond its shape. It is checked against the
 * folders the server itself found before anything is spawned, because this
 * frame is the one that turns a terminal into a way to start programs
 * elsewhere — see `switchTo` in index.js.
 */
export const decodeSwitch = buf => {
  try {
    const { cwd, resume } = JSON.parse(buf.toString())
    if (typeof cwd !== 'string' || !cwd || typeof resume !== 'boolean') return null
    return { cwd, resume }
  } catch {
    return null
  }
}
