// Key names to the bytes a terminal expects.
//
// A complete table on purpose, not a mirror of the key bar: the bar currently
// reaches only the arrows, Tab and Escape. The rest are here because the
// encodings are the part worth getting right — Home/End are \e[H and \e[F
// rather than \e[1~ and \e[4~, and Delete is \e[3~ rather than \x7f. Keys
// typed on the software keyboard never come through here; wterm encodes those.

const ESC = '\x1b'

// Arrows and Home/End take a different prefix in DECCKM application mode, and
// grow a parameter when modified. The rest are fixed strings.
const CURSOR = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' }

const FIXED = {
  Tab: '\t',
  Escape: ESC,
  Enter: '\r',
  Backspace: '\x7f',
  Delete: `${ESC}[3~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
}

// CSI modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
const modifierParam = ({ shift, alt, ctrl }) => 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)

export function keySequence(name, opts = {}) {
  const { shift = false, alt = false, ctrl = false, cursorKeysApp = false } = opts

  if (name === 'Tab' && shift) return `${ESC}[Z`

  const final = CURSOR[name]
  if (final) {
    const param = modifierParam(opts)
    if (param > 1) return `${ESC}[1;${param}${final}`
    return cursorKeysApp ? `${ESC}O${final}` : `${ESC}[${final}`
  }

  // Meta is an ESC prefix, the same as for a letter — alt+Backspace is
  // delete-word-backwards. Ctrl is absent on purpose: these keys already *are*
  // control codes (Ctrl-I is Tab, Ctrl-[ is Escape), so it has nothing to add
  // without a CSI-u style protocol, which pi does not ask for.
  if (name in FIXED) return alt ? ESC + FIXED[name] : FIXED[name]

  if (name.length === 1) {
    if (ctrl) {
      const code = name.toUpperCase().charCodeAt(0)
      // Only @ through _ have control codes. Terminals send the bare key for
      // everything else — ctrl+1 is '1' — rather than inventing an encoding.
      if (code < 0x40 || code > 0x5f) return name
      return String.fromCharCode(code - 0x40)
    }
    return alt ? ESC + name : name
  }

  throw new Error(`keys: unknown key ${name}`)
}
