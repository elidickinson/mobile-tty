import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveLayout, gridFor, KEY_BAR_H } from '../src/viewport.js'

// Production measures the cell at runtime; this is what the device reported at
// 13px, so the grid math can be checked against the recorded configurations.
const CELL_13PX = { width: 8.04, height: 15.0 }

// The five configurations measured on device; see docs/numbers.md.
const FIXTURES = {
  'safari portrait, kb down': {
    innerWidth: 402, innerHeight: 714, visualWidth: 402, visualHeight: 714, offsetTop: 0,
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0, standalone: false,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'portrait' },
  },
  'safari portrait, kb up': {
    innerWidth: 402, innerHeight: 714, visualWidth: 402, visualHeight: 404, offsetTop: 0,
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0, standalone: false,
    expect: { keyboardHeight: 310, keyboardUp: true, orientation: 'portrait' },
  },
  'standalone portrait, kb down': {
    innerWidth: 402, innerHeight: 812, visualWidth: 402, visualHeight: 812, offsetTop: 0,
    insetTop: 62, insetBottom: 34, insetLeft: 0, insetRight: 0, standalone: true,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'portrait' },
  },
  'standalone portrait, kb up': {
    innerWidth: 402, innerHeight: 812, visualWidth: 402, visualHeight: 498, offsetTop: 0,
    insetTop: 62, insetBottom: 34, insetLeft: 0, insetRight: 0, standalone: true,
    expect: { keyboardHeight: 314, keyboardUp: true, orientation: 'portrait' },
  },
  'standalone landscape, kb down': {
    innerWidth: 874, innerHeight: 402, visualWidth: 874, visualHeight: 402, offsetTop: 0,
    insetTop: 0, insetBottom: 20, insetLeft: 0, insetRight: 0, standalone: true,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'landscape' },
  },
}

for (const [name, f] of Object.entries(FIXTURES)) {
  test(`layout — ${name}`, () => {
    const l = deriveLayout(f)
    assert.equal(l.keyboardHeight, f.expect.keyboardHeight)
    assert.equal(l.keyboardUp, f.expect.keyboardUp)
    assert.equal(l.orientation, f.expect.orientation)

    // Everything the app draws must fit inside the visual viewport, which is
    // by definition the space above the keyboard.
    assert.ok(l.appHeight <= f.visualHeight, 'app is sized from the visual viewport, never innerHeight')
    assert.equal(l.terminal.height + l.keyBarHeight, f.visualHeight, 'no dead space anywhere')
    assert.ok(l.terminal.height > 0)
  })
}

test('the top inset is already excluded from the viewport, so subtracting it would double-count', () => {
  const standalone = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const safari = deriveLayout(FIXTURES['safari portrait, kb down'])
  // Standalone reports a 62pt top inset but its viewport is already 98pt taller
  // than Safari's. Honouring the inset again would erase that win.
  assert.ok(standalone.terminal.height > safari.terminal.height)
  assert.equal(standalone.terminal.top, 0)
})

test('with the keyboard down the bottom inset is reserved, inside the key bar', () => {
  const l = deriveLayout(FIXTURES['standalone portrait, kb down'])
  assert.equal(l.keyBarHeight, KEY_BAR_H + 34)
  assert.equal(l.keyBarPadBottom, 34)
  assert.equal(l.terminal.height, 812 - 34 - KEY_BAR_H)
})

test('with the keyboard up the bottom inset is not reserved — it is over the keyboard', () => {
  const up = deriveLayout(FIXTURES['standalone portrait, kb up'])
  assert.equal(up.keyBarHeight, KEY_BAR_H)
  assert.equal(up.keyBarPadBottom, 0)
  assert.equal(up.terminal.height, 498 - KEY_BAR_H, 'reclaims the 34pt home-indicator inset')

  const rows = Math.floor(up.terminal.height / 15)
  const reserved = Math.floor((498 - 34 - KEY_BAR_H) / 15)
  assert.ok(rows > reserved, 'that is a whole extra row of pi')
})

test('the grid is sized from the layout viewport, so the keyboard never reflows it', () => {
  const down = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const up = deriveLayout(FIXTURES['standalone portrait, kb up'])
  assert.equal(down.stableHeight, up.stableHeight, 'same grid whether the keyboard is up or not')
  assert.equal(up.stableHeight, 812 - 34 - KEY_BAR_H)
  assert.ok(up.stableHeight > up.terminal.height, 'more grid than fits on screen — pan to the rest')
})

test('landscape is worth roughly twice the columns', () => {
  const portrait = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const landscape = deriveLayout(FIXTURES['standalone landscape, kb down'])
  const p = gridFor(portrait.terminal.width, portrait.stableHeight, CELL_13PX)
  const l = gridFor(landscape.terminal.width, landscape.stableHeight, CELL_13PX)
  assert.equal(p.cols, 50)
  assert.equal(l.cols, 108)
  assert.ok(l.rows < p.rows, 'it trades rows for columns')
})

test('offsetTop counts against available height', () => {
  const f = { ...FIXTURES['safari portrait, kb up'], offsetTop: 40, visualHeight: 364 }
  assert.equal(deriveLayout(f).keyboardHeight, 310)
})

test('browser chrome collapsing is not mistaken for a keyboard', () => {
  const f = { ...FIXTURES['safari portrait, kb down'], innerHeight: 780, visualHeight: 714 }
  assert.equal(deriveLayout(f).keyboardUp, false)
})

test('grid math matches the measured device numbers', () => {
  assert.deepEqual(gridFor(402, 714, CELL_13PX), { cols: 50, rows: 47 })
  assert.deepEqual(gridFor(402, 404, CELL_13PX), { cols: 50, rows: 26 })
  assert.deepEqual(gridFor(402, 812, CELL_13PX), { cols: 50, rows: 54 })
  assert.deepEqual(gridFor(402, 498, CELL_13PX), { cols: 50, rows: 33 })
  assert.deepEqual(gridFor(874, 402, CELL_13PX), { cols: 108, rows: 26 })
})

test('grid never collapses below a usable minimum', () => {
  assert.deepEqual(gridFor(1, 1, CELL_13PX), { cols: 20, rows: 4 })
})
