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

export class Mirror {
  constructor({ cols, rows, scrollback = 0 }) {
    this.scrollback = scrollback
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
  }

  write(bytes) { this.term.write(bytes) }

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
