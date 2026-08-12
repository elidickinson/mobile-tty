// The adapter seam. `readViewport` is the only part that touches the browser;
// everything downstream is pure and testable against the fixtures in
// docs/numbers.md.

export const KEY_BAR_H = 44

// Keys sitting on the bottom edge of the glass are awkward to hit, and the outer
// two run into the display's corner curve. Lift them clear of both.
const BOTTOM_CLEARANCE = 10

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
  // space. When it is down the key bar grows to cover it, keeping its keys clear
  // of the indicator — reserving it below the bar instead just leaves a gap.
  const bottomReserve = s.insetBottom + BOTTOM_CLEARANCE
  const bottomInset = keyboardUp ? 0 : bottomReserve
  const keyBarHeight = KEY_BAR_H + bottomInset

  return {
    keyboardHeight,
    keyboardUp,
    orientation: s.innerWidth > s.innerHeight ? 'landscape' : 'portrait',
    appHeight,
    keyBarHeight,
    keyBarPadBottom: bottomInset,
    // What to size the *grid* from. The layout viewport ignores the keyboard,
    // so the grid stays put when it opens and the visible window just shows
    // less of it — occlude and pan, rather than reflowing pi mid-sentence.
    stableHeight: s.innerHeight - bottomReserve - KEY_BAR_H,
    terminal: {
      width,
      height: appHeight - keyBarHeight,
    },
  }
}

export const gridFor = (width, height, cell) => ({
  cols: Math.max(MIN_COLS, Math.floor(width / cell.width)),
  rows: Math.max(MIN_ROWS, Math.floor(height / cell.height)),
})
