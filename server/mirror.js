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
const RESET = '\x1bc'

export class Mirror {
  constructor({ cols, rows }) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
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
   * The current screen as bytes a terminal can apply.
   *
   * Only the visible grid: the client's scrollback is a lossy duplicate of pi's
   * own transcript, and pi is the real record of the conversation.
   */
  snapshot() {
    return RESET + PREAMBLE + this.serializer.serialize({ scrollback: 0 })
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
