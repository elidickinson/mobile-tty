// The screen, kept here so a new viewer does not have to make pi redraw for it.
//
// Making pi redraw is not cheap: it renders relatively and re-renders its whole
// transcript on SIGWINCH, which grows with the conversation — about 12 KB after
// one turn and linear from there. This turns every attach from O(transcript)
// into O(screen).
// Both ship CommonJS with no ESM named exports, so they arrive as one object.
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'

const { Terminal } = headless
const { SerializeAddon } = serialize

// pi sets these once at startup and never again, not even on resize, so a
// viewer restored from a serialized screen alone would have bracketed paste off
// and the wrong key encoding — and would silently send pi differently-encoded
// keys. The snapshot carries them.
const PREAMBLE = '\x1b[?2004h\x1b[>7u'

// Reset first: a reconnecting viewer already has a screen, a cursor, modes and
// scrollback, and serialized VT assumes a fresh terminal and resets nothing.
//
// RIS alone is not enough. It leaves the saved lines alone, so the history below
// would stack underneath whatever the viewer had before it dropped — duplicated
// and out of order. ED 3 is what clears them.
const RESET = '\x1bc\x1b[3J'

const ESC = 0x1b
const BEL = 0x07

// Far larger than any real sequence, including a long OSC title.
const MAX_PENDING = 64 * 1024

/**
 * Index just past the escape sequence starting at `i`, or -1 if it is unfinished.
 *
 * Scanning forward rather than back from the end is what makes this exact: a
 * title longer than any fixed lookbehind, or a sequence whose payload contains
 * another ESC, both defeat a backward search.
 */
const escapeEnd = (buf, i) => {
  const kind = buf[i + 1]
  if (kind === undefined) return -1

  if (kind === 0x5b) {                                     // CSI: params, then 0x40..0x7e
    let j = i + 2
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x3f) j++
    return j < buf.length && buf[j] >= 0x40 && buf[j] <= 0x7e ? j + 1 : -1
  }
  if (kind === 0x5d) {                                     // OSC: ends BEL or ST
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === BEL) return j + 1
      if (buf[j] === ESC && buf[j + 1] === 0x5c) return j + 2
    }
    return -1
  }
  if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {   // DCS/SOS/PM/APC: ST
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === ESC && buf[j + 1] === 0x5c) return j + 2
    }
    return -1
  }
  if (kind >= 0x20 && kind <= 0x2f) {                      // intermediates, then a final
    let j = i + 1
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f) j++
    return j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x7e ? j + 1 : -1
  }
  return i + 2                                             // any other two-byte escape
}

/**
 * How much of `buf` can be parsed without leaving a sequence half-finished.
 *
 * The parser keeps a partial sequence as invisible state, and `serialize()` only
 * ever sees committed cells. So a snapshot taken mid-character omits its leading
 * byte while the viewer still receives the continuation — an orphaned tail like
 * `55;95;255m`, which is the corruption this whole server exists to stop.
 *
 * Every buffer starts on a clean boundary, because this is what decides where
 * the last one ended. That is what lets the scan run forward and be exact.
 */
const completeUpTo = buf => {
  let i = 0
  let clean = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b === ESC) {
      const end = escapeEnd(buf, i)
      if (end === -1) return clean
      i = end
    } else if (b < 0x80) {
      i++
    } else {
      const width = b < 0xc0 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : b < 0xf8 ? 4 : 1
      if (i + width > buf.length) return clean
      i += width
    }
    clean = i
  }
  return clean
}

export class Mirror {
  constructor({ cols, rows, scrollback = 0 }) {
    this.scrollback = scrollback
    // Bytes held back because they do not yet form a complete sequence. They
    // belong to a new viewer after the snapshot, since the screen cannot
    // contain them yet.
    this.pending = Buffer.alloc(0)
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
  }

  write(bytes) {
    const buf = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes)
    // A program that opens a sequence and never closes it would otherwise hold
    // everything after it in memory for ever. Past this, take the parser's word
    // for it: a stream this malformed is already lost, and the mirror recovering
    // beats the server growing without bound.
    const cut = buf.length > MAX_PENDING ? buf.length : completeUpTo(buf)
    this.pending = Buffer.from(buf.subarray(cut))
    if (cut > 0) this.term.write(buf.subarray(0, cut))
  }

  resize(cols, rows) { this.term.resize(cols, rows) }

  /**
   * The screen, and the history above it, as bytes a terminal can apply.
   *
   * The history is not a luxury: pi renders inline and does not page itself, so
   * the terminal's scrollback is the only way to read back through a
   * conversation, and a snapshot without it makes every reload amnesiac.
   */
  snapshot() {
    return RESET + PREAMBLE + this.serializer.serialize({ scrollback: this.scrollback })
  }

  /**
   * Everything written so far has been parsed.
   *
   * `Terminal.write` is asynchronous, so a snapshot taken without draining can
   * miss bytes that are already in the stream — which is the difference between
   * a viewer seeing them twice and not at all.
   */
  drain() { return new Promise(resolve => this.term.write('', resolve)) }
}
