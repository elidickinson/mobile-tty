// Geometry: grid sizing, insets, zoom, rotation, and the keyboard.
import { test, expect, liveRows, ready, scrollTop, settled, scrollbackCount, fillScrollback, distanceFromBottom } from './helpers.js'

test('a grid preset resizes the PTY and the client together', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '120×40' }).tap()
  await expect(page.locator('#screen')).toContainText('120x40')
  expect(await liveRows(page).count()).toBe(40)
})

test('a grid wider than the screen pans horizontally rather than reflowing', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '160×50' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  // Resizes wait for the output to go quiet, so this cannot be read at once.
  await expect.poll(() => page.evaluate(() => {
    const v = document.getElementById('viewport')
    return v.scrollWidth - v.clientWidth
  })).toBeGreaterThan(0)
})

test('zoom changes only the render scale — the PTY grid stays pinned', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  const before = await liveRows(page).count()
  await page.getByRole('button', { name: '−' }).tap()
  await expect(page.locator('#scale-val')).toHaveText('80%')
  expect(await liveRows(page).count()).toBe(before)
  expect(await page.locator('#screen').evaluate(e => e.style.transform)).toBe('scale(0.8)')
  await page.getByRole('button', { name: '100%' }).tap()
  expect(await page.locator('#screen').evaluate(e => e.style.transform)).toBe('')
})

test('the page itself never scrolls — only the terminal does', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => ({
    body: document.body.scrollHeight - window.innerHeight,
    overflow: getComputedStyle(document.body).overflow,
  }))
  expect(m.overflow).toBe('hidden')
  expect(m.body).toBeLessThanOrEqual(0)
})

test('a shorter viewport keeps the bottom of the screen in view', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)

  // Standing in for the keyboard opening: the window loses ~310pt and the grid
  // does not reflow, so the bottom rows are what must survive.
  await page.setViewportSize({ width: 402, height: 498 })
  await settled(page)

  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
  const visible = await page.evaluate(() => {
    const s = document.getElementById('screen')
    const rows = [...s.querySelectorAll('.term-row:not(.term-scrollback-row)')].filter(r => r.innerText.trim())
    const last = rows.at(-1).getBoundingClientRect()
    const box = s.getBoundingClientRect()
    return last.bottom <= box.bottom + 2 && last.bottom > box.top
  })
  expect(visible).toBe(true)
})

test('the keyboard opening does not resize the grid', async ({ page }) => {
  await ready(page)
  const before = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])
  await page.setViewportSize({ width: 402, height: 498 })   // same orientation, less room
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])).toEqual(before)
})

test('rotating to landscape refits the grid — that is the whole point of landscape', async ({ page }) => {
  await ready(page)
  const [portraitCols] = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])

  await page.setViewportSize({ width: 874, height: 402 })
  await expect.poll(() => page.evaluate(() => window.mtty.state.cols)).toBeGreaterThan(portraitCols * 1.8)

  const [cols, rows] = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])
  await expect(page.locator('#screen')).toContainText(`${cols}x${rows}`)

  await page.setViewportSize({ width: 402, height: 812 })
  await expect.poll(() => page.evaluate(() => window.mtty.state.cols)).toBe(portraitCols)
})

test('the grid is sized from the layout viewport, so it outlives the keyboard', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => window.mtty.state.rows)
  await page.setViewportSize({ width: 402, height: 498 })
  await page.waitForTimeout(600)

  // More grid than fits: the rest is reachable by scrolling, not by reflowing.
  const m = await page.evaluate(() => {
    const s = document.getElementById('screen')
    return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }
  })
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
  expect(await page.evaluate(() => window.mtty.state.rows)).toBe(rows)
})

// Real pi draws its input box after the transcript, so a fresh session leaves
// the foot of the grid untouched. The fixture pins its box to the last row
// instead, so that shape is written into the terminal directly.
const shortScreen = page => page.evaluate(() =>
  window.mtty.term.write('\x1b[H\x1b[2J\x1b[3J' + 'transcript\r\n'.repeat(8) + '> '))

const gridRows = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  const rows = [...s.querySelectorAll('.term-row:not(.term-scrollback-row)')]
  const shown = rows.filter(r => !r.hidden)
  return {
    total: rows.length,
    shown: shown.length,
    lastBottom: shown.at(-1).getBoundingClientRect().bottom,
    lastTop: shown.at(-1).getBoundingClientRect().top,
    boxTop: s.getBoundingClientRect().top,
    boxBottom: s.getBoundingClientRect().bottom,
  }
})

test('a screen shorter than the grid ends at the key bar, not above a blank tail', async ({ page }) => {
  await ready(page)
  await shortScreen(page)
  await settled(page)

  const m = await gridRows(page)
  expect(m.shown).toBeLessThan(m.total)
  expect(m.lastBottom).toBeCloseTo(m.boxBottom, 0)
})

test('a shorter viewport cannot strand a short screen above the fold', async ({ page }) => {
  await ready(page)
  await shortScreen(page)
  await settled(page)

  await page.setViewportSize({ width: 402, height: 498 })   // the keyboard, near enough
  await settled(page)

  const m = await gridRows(page)
  expect(m.lastTop).toBeGreaterThanOrEqual(m.boxTop - 1)
  expect(m.lastBottom).toBeCloseTo(m.boxBottom, 0)
})

test('the key bar covers the home-indicator inset, leaving no gap beneath it', async ({ page }) => {
  await ready(page)
  await page.addStyleTag({ content: '#safe-probe { padding-bottom: 34px !important; }' })
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
  await page.waitForTimeout(400)

  const m = await page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect()
    const app = document.getElementById('app').getBoundingClientRect()
    const btn = document.querySelector('#bar button').getBoundingClientRect()
    return { barBottom: bar.bottom, appBottom: app.bottom, barHeight: bar.height,
             btnBottom: btn.bottom, btnHeight: btn.height }
  })
  expect(m.barBottom).toBeCloseTo(m.appBottom, 0)             // nothing wasted below it
  expect(m.barHeight).toBeCloseTo(44 + 34 + 10, 0)            // it grew by the inset and the clearance
  expect(m.btnBottom).toBeLessThanOrEqual(m.appBottom - 43)   // keys clear the indicator and the corner
  expect(m.btnHeight).toBeGreaterThan(20)
})
test('the document is not scrollable and the terminal claims vertical drags', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    const b = getComputedStyle(document.body)
    return {
      htmlPos: s.position, bodyPos: b.position,
      htmlOverflow: s.overflow, bodyOverflow: b.overflow,
      screenTouch: getComputedStyle(document.getElementById('screen')).touchAction,
      docScrollable: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
    }
  })
  expect(m.screenTouch).toBe('pan-y')
  expect(m.docScrollable).toBeLessThanOrEqual(0)
})

test('Fit refits rather than throwing the click event at the layout', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await expect.poll(() => page.evaluate(() => window.mtty.state.rows)).toBe(30)

  await page.getByRole('button', { name: 'Fit' }).tap()
  // A listener receives the event as its first argument; passing fitGrid
  // directly made that the layout and threw on l.terminal.
  await expect(page.locator('#diag-overlay')).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.mtty.state.rows)).toBeGreaterThan(30)
})
