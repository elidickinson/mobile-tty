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

// Longer than any sequence worth cutting inside, so the search for one is
// bounded rather than walking the whole chunk.
const MAX_TAIL = 128

/** Does the escape sequence starting at `i` finish inside this buffer? */
const terminated = (buf, i) => {
  const kind = buf[i + 1]
  if (kind === undefined) return false
  if (kind === 0x5b) {                                    // CSI: ends 0x40..0x7e
    for (let j = i + 2; j < buf.length; j++) if (buf[j] >= 0x40 && buf[j] <= 0x7e) return true
    return false
  }
  if (kind === 0x5d) {                                    // OSC: ends BEL or ST
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === 0x07) return true
      if (buf[j] === 0x1b && buf[j + 1] === 0x5c) return true
    }
    return false
  }
  if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {   // DCS/SOS/PM/APC: ST
    for (let j = i + 2; j < buf.length; j++) if (buf[j] === 0x1b && buf[j + 1] === 0x5c) return true
    return false
  }
  return true                                             // anything else is a two-byte escape
}

/** Step back off a multi-byte character that the cut would land inside. */
const wholeCharacters = (buf, cut) => {
  let k = cut - 1
  while (k >= 0 && k >= cut - 3 && (buf[k] & 0xc0) === 0x80) k--
  if (k < 0) return cut
  const lead = buf[k]
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1
  return k + width > cut ? k : cut
}

/**
 * How much of `buf` can be parsed without leaving a sequence half-finished.
 *
 * The parser keeps a partial sequence as internal state, and `serialize()` only
 * ever sees committed cells. So a snapshot taken while the parser is mid-
 * character omits its leading byte, and the viewer that receives the rest gets
 * an orphaned tail — a stray `55;95;255m`, which is the corruption this whole
 * server exists to stop.
 */
const completeUpTo = buf => {
  let cut = buf.length
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - MAX_TAIL); i--) {
    if (buf[i] !== 0x1b) continue
    if (!terminated(buf, i)) cut = i
    break
  }
  return wholeCharacters(buf, cut)
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
    const cut = completeUpTo(buf)
    this.pending = Buffer.from(buf.subarray(cut))
    if (cut > 0) this.term.write(buf.subarray(0, cut))
  }

  resize(cols, rows) {
    if (cols === this.term.cols && rows === this.term.rows) return
    this.term.resize(cols, rows)
  }

  get size() { return { cols: this.term.cols, rows: this.term.rows } }

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
