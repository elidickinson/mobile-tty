// Does anything appear, and does it match the PTY it asked for.
import { test, expect } from '@playwright/test'
import { screenText, liveRows, ready } from './helpers.js'

test('renders the TUI with box drawing intact', async ({ page }) => {
  await ready(page)
  const text = await screenText(page)
  // Mojibake here means someone decoded the socket as text; the VT core must
  // see raw bytes so multi-byte characters survive message boundaries.
  expect(text).toContain('┌')
  expect(text).toContain('└')
  expect(text).not.toContain('â')
})

test('the screen still has content a moment after attaching', async ({ page }) => {
  await ready(page)
  // Regression: clearing the nudge's own redraws out of the scrollback with
  // ED 3 blanked the visible grid too, a second after every load.
  await page.waitForTimeout(1200)
  expect(await liveRows(page).count()).toBeGreaterThan(0)
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})

test('the PTY grid matches what the client asked for', async ({ page }) => {
  await ready(page)
  // The first fit waits for the output to go quiet, so this settles rather than
  // being true immediately.
  await expect.poll(async () => {
    const rows = await page.evaluate(() => document.querySelectorAll('#screen .term-row:not(.term-scrollback-row)').length)
    return new RegExp(`\\d+x${rows}`).test(await screenText(page))
  }).toBe(true)
})

test('at phone size the grid fits the viewport, not the layout viewport', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => ({
    app: document.getElementById('app').getBoundingClientRect().height,
    inner: window.innerHeight,
    visual: window.visualViewport.height,
    barBottom: document.getElementById('bar').getBoundingClientRect().bottom,
  }))
  expect(m.app).toBeCloseTo(m.visual, 0)
  expect(m.barBottom).toBeLessThanOrEqual(m.visual + 1)
})
