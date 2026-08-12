// Against real pi, driven by a deterministic test extension (slash commands
// render fixture output without an agent turn, so no tokens). Each test gets a
// fresh server and pi, so every fixture render starts from an empty scrollback.
import { test, expect } from './helpers.js'

// The widest run of box-drawing dashes on screen — pi's horizontal rules span
// the full width, so this is a cheap read of the columns pi thinks it has.
const ruleWidth = page => page.evaluate(() =>
  Math.max(0, ...[...document.querySelectorAll('#screen .term-row')]
    .map(r => (r.innerText.match(/─+/g) ?? ['']).reduce((a, b) => (b.length > a.length ? b : a), '').length)))

const setGrid = async (page, label, cols) => {
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: label }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  await expect.poll(() => ruleWidth(page)).toBe(cols)
}

// The extension's READY marker is emitted once, at pi startup. The page is
// ready when the client has connected and the server confirmed the grid — the
// same readiness the e2e helpers use.
const pageReady = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => Boolean(window.mtty?.term?.bridge))).toBe(true)
  // The extension emits this once at pi startup, so it is the honest
  // "extension loaded and the TUI is emitting" signal for a fresh pi.
  await expect.poll(() => page.evaluate(() =>
    document.getElementById('screen')?.innerText.includes('MTTY_EXTENSION_READY') ?? false)).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.mtty.state.cols === window.mtty.state.wanted.cols &&
    window.mtty.state.rows === window.mtty.state.wanted.rows)).toBe(true)
}

// The fixture ids in the order they appear, read from the core model. The
// scrollback indexes newest-to-oldest, so walk it backwards, then append the
// live screen. Raw, not deduped: a duplicated or repeated render must fail
// this against allIds, not disappear into a set.
const fixtureIds = page => page.evaluate(() => {
  const t = window.mtty?.term?.bridge
  if (!t) return []
  const cols = t.getCols?.() ?? 0
  const saved = t.getScrollbackCount?.() ?? 0
  const row = (y, isSaved) => {
    const get = isSaved ? t.getScrollbackCell.bind(t) : t.getCell.bind(t)
    return Array.from({ length: cols }, (_, x) => String.fromCodePoint(get(y, x).char || 32)).join('').trimEnd()
  }
  const lines = []
  for (let y = saved - 1; y >= 0; y--) lines.push(row(y, true))
  for (let y = 0; y < t.getRows?.() ?? 0; y++) lines.push(row(y, false))
  return lines.flatMap(line => {
    const m = line.match(/MTTY-LINE-(\d{3})/)
    return m ? [Number(m[1])] : []
  })
})
const allIds = Array.from({ length: 100 }, (_, i) => i)

const typeFixture = async page => {
  // Real keydown dispatch, not value injection: wterm's hidden textarea turns
  // Enter on keydown into \r. Slow the typing: pi's slash palette opens on `/`
  // and its input handler switches to palette mode asynchronously, so chars in
  // the same burst as `/` get echoed into the line but never feed the palette
  // filter, and Enter dismisses the unfiltered palette — pi eats the command.
  // At 50ms a keystroke the palette is installed before the second one lands.
  const ta = page.locator('#screen textarea')
  await ta.focus()
  await page.keyboard.type('/mtty-fixture', { delay: 50 })
  await page.keyboard.press('Enter')
}

// A full marker sweep: the trailing done line is present on screen.
const fixtureComplete = page => page.evaluate(() =>
  document.getElementById('screen')?.innerText.includes('MTTY_FIXTURE_DONE') ?? false)

test('real pi renders and reflows across the grid presets', async ({ page }) => {
  await pageReady(page)

  // A transcript on screen, then move it through every preset. History order
  // must survive each reflow — the exact class fake-pi masked.
  await typeFixture(page)
  await expect.poll(() => fixtureComplete(page)).toBe(true)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)

  await setGrid(page, '120×40', 120)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
  await setGrid(page, '160×50', 160)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
  await setGrid(page, '50×30', 50)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
})

test('pi keeps a real scrollback — nothing in the stack imposes an alternate screen', async ({ page }) => {
  await pageReady(page)

  const alt = await page.evaluate(() => window.mtty.term.bridge.usingAltScreen())
  expect(alt).toBe(false)

  // A tall transcript, then a shrink. Content goes into scrollback rather than
  // being destroyed, and never through an alternate screen.
  await typeFixture(page)
  await expect.poll(() => fixtureComplete(page)).toBe(true)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  await expect.poll(() => ruleWidth(page)).toBe(50)
  // The newest fixture line is still on screen; the rest is history, in order.
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
  const stillAlt = await page.evaluate(() => window.mtty.term.bridge.usingAltScreen())
  expect(stillAlt).toBe(false)
})

test('reconnecting to a running session keeps the whole transcript, in order', async ({ page }) => {
  // The server keeps the screen and scrollback, so a fresh page gets them as a
  // snapshot without pi being asked to repaint. This is the exact path
  // fake-pi masked: history must survive a resize AND a reconnect, in order.
  await pageReady(page)

  await typeFixture(page)
  await expect.poll(() => fixtureComplete(page)).toBe(true)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)

  // Shrink the grid — the operation that used to scramble history.
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  await expect.poll(() => ruleWidth(page)).toBe(50)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)

  // Lose the page, come back. A fresh viewer must get the same ordered history.
  await page.reload()
  await pageReady(page)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
  await expect.poll(() => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount()))
    .toBeGreaterThan(0)
})

// How far up the history the view is, as a share of the whole — the same
// measure the client itself uses to survive a reflow.
const readingShare = page => page.evaluate(() => {
  const el = document.getElementById('screen')
  return (el.scrollHeight - el.scrollTop - el.clientHeight) / el.scrollHeight
})

test('a resize does not dump a reader at the live edge', async ({ page }) => {
  // A grid change replaces the whole rendered buffer, and the DOM collapses to
  // one screen before the resize's snapshot lands. If the reading position is
  // not carried across that gap, the browser resets scrollTop to the top of
  // the shrunk buffer and the app's own bottom-pinning then reads that as
  // "already at the bottom" and leaves it there — every resize dumps whoever
  // is scrolled back into history at the live edge.
  await pageReady(page)
  await typeFixture(page)
  await expect.poll(() => fixtureComplete(page)).toBe(true)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)

  // Somewhere in the middle of history — not the top, not the bottom — so a
  // regression that clamps to either extreme is distinguishable from a
  // genuinely preserved position, not just "technically not at the bottom".
  await page.evaluate(() => {
    const el = document.getElementById('screen')
    el.scrollTop = el.scrollHeight * 0.4
  })
  const before = await readingShare(page)
  expect(before).toBeGreaterThan(0.3)

  await setGrid(page, '120×40', 120)

  // The reader's relative position survives the reflow, within the rounding a
  // coarser row grid introduces — not just "not dumped exactly to the bottom".
  await expect.poll(() => readingShare(page), { timeout: 2_000 })
    .toBeGreaterThan(before - 0.1)
  await expect.poll(() => fixtureIds(page)).toEqual(allIds)
})
