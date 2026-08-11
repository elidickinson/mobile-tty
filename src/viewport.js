// The adapter seam. `readViewport` is the only part that touches the browser;
// everything downstream is pure and testable against the fixtures in
// docs/numbers.md.

export const KEY_BAR_H = 44

const MIN_COLS = 20
const MIN_ROWS = 4

// Below this, a shrinking viewport is browser chrome, not a keyboard.
const KEYBOARD_MIN = 100

// `env(safe-area-inset-*)` cannot be read back through a custom property — it
// stays an unresolved token. Reading it as real padding on a probe element does
// resolve it.
export function readInsets() {
  const s = getComputedStyle(document.getElementById('safe-probe'))
  return {
    insetTop: parseFloat(s.paddingTop),
    insetBottom: parseFloat(s.paddingBottom),
    insetLeft: parseFloat(s.paddingLeft),
    insetRight: parseFloat(s.paddingRight),
  }
}

export function readViewport() {
  const vv = window.visualViewport
  return {
    ...readInsets(),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualWidth: vv.width,
    visualHeight: vv.height,
    offsetTop: vv.offsetTop,
    standalone: window.navigator.standalone === true,
  }
}

/** Cell metrics for the current font, measured rather than assumed. */
export function measureCell(fontSize) {
  const el = document.getElementById('cell-probe')
  el.style.fontSize = `${fontSize}px`
  const r = el.getBoundingClientRect()
  // Row height must be a whole pixel or rows drift out of alignment down the screen.
  return { width: r.width / 10, height: Math.round(r.height) }
}

/**
 * The visual viewport is by definition the space above the keyboard, so the app
 * is sized from it and never from `innerHeight`.
 *
 * Insets are asymmetric: iOS already excludes the top inset from the layout
 * viewport in standalone mode, so honouring it again would throw away the +7
 * rows standalone buys. The bottom inset sits inside the viewport and must be
 * reserved.
 */
export function deriveLayout(s) {
  const keyboardHeight = Math.max(0, Math.round(s.innerHeight - s.visualHeight - s.offsetTop))
  const keyboardUp = keyboardHeight >= KEYBOARD_MIN
  const appHeight = s.visualHeight
  const width = s.visualWidth - s.insetLeft - s.insetRight

  // The home indicator only overlaps the app when the keyboard is down; with the
  // keyboard up it sits over the keyboard, so reserving the inset there is dead
  // space. The bar keeps a fixed height and the app reserves the inset beneath
  // it — letting the bar absorb the inset instead broke its layout on device.
  const bottomInset = keyboardUp ? 0 : s.insetBottom

  return {
    keyboardHeight,
    keyboardUp,
    orientation: s.innerWidth > s.innerHeight ? 'landscape' : 'portrait',
    standalone: s.standalone,
    appHeight,
    keyBarHeight: KEY_BAR_H,
    bottomInset,
    // What to size the *grid* from. The layout viewport ignores the keyboard,
    // so the grid stays put when it opens and the visible window just shows
    // less of it — occlude and pan, rather than reflowing pi mid-sentence.
    stableHeight: s.innerHeight - s.insetBottom - KEY_BAR_H,
    terminal: {
      top: 0,
      left: s.insetLeft,
      width,
      height: appHeight - KEY_BAR_H - bottomInset,
    },
  }
}

export const gridFor = (width, height, cell) => ({
  cols: Math.max(MIN_COLS, Math.floor(width / cell.width)),
  rows: Math.max(MIN_ROWS, Math.floor(height / cell.height)),
})
