// Key-bar names to the bytes a terminal expects.

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

// The order they appear on the bar.
export const KEYS = ['Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End']

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

  if (name in FIXED) return FIXED[name]

  if (name.length === 1) {
    if (ctrl) {
      const code = name.toUpperCase().charCodeAt(0)
      if (code < 0x40 || code > 0x5f) throw new Error(`keys: ${name} has no control code`)
      return String.fromCharCode(code - 0x40)
    }
    return alt ? ESC + name : name
  }

  throw new Error(`keys: unknown key ${name}`)
}
