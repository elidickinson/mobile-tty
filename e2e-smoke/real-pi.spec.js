import { test, expect } from '@playwright/test'

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

test('real pi renders and reflows across the grid presets', async ({ page }) => {
  await page.goto('/')

  // pi's startup screen: the cwd line and the status line bracket the input box.
  await expect(page.locator('#screen')).toContainText('mobile-tty', { timeout: 60_000 })
  await expect(page.locator('#screen')).toContainText('(auto)')
  expect(await ruleWidth(page)).toBeGreaterThan(40)

  await setGrid(page, '120×40', 120)
  await setGrid(page, '160×50', 160)
  await setGrid(page, '50×30', 50)

  await expect(page.locator('#screen')).toContainText('mobile-tty')
  await expect(page.locator('#screen')).toContainText('(auto)')
})

test('pi keeps a real scrollback — dtach leaves the alternate screen alone', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#screen')).toContainText('mobile-tty', { timeout: 60_000 })

  const alt = await page.evaluate(() => window.mtty.term.bridge.usingAltScreen())
  expect(alt).toBe(false)

  // Shrinking the grid pushes the startup banner into client scrollback rather
  // than destroying it, which is what makes local scrolling the right model.
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  await expect.poll(() => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount()))
    .toBeGreaterThan(0)
})

test('a fresh page attaching to a running session gets a painted screen', async ({ page }) => {
  // dtach has no replay buffer, so this is only ever correct because every
  // attach nudges the size. It cannot be caught against a program the test
  // itself just started.
  await page.goto('/')
  await expect(page.locator('#screen')).toContainText('(auto)', { timeout: 60_000 })

  await page.reload()
  await expect(page.locator('#screen')).toContainText('(auto)')
  await expect(page.locator('#screen')).toContainText('mobile-tty')
})
