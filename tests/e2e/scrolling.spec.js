// Scrollback: where the view sits, and what is allowed to move it.
import { test, expect, ready, scrollTop, settled, fillScrollback, distanceFromBottom } from './helpers.js'

test('the menu jumps to the top and back to the bottom', async ({ page }) => {
  await ready(page)
  const bottom = await fillScrollback(page)
  expect(bottom).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '⤒ Top' }).tap()
  expect(await scrollTop(page)).toBe(0)
  await expect(page.locator('#menu')).toBeHidden()

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '⤓ Bottom' }).tap()
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
})

test('output that redraws the bottom block does not shake the view loose', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)

  // pi rewrites its whole bottom block as you type; the fixture does the same.
  const ta = page.locator('#screen textarea')
  for (const word of ['one', 'two', 'three']) {
    await ta.pressSequentially(word)
    await ta.press('Enter')
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
  }
  await expect(page.locator('#to-bottom')).toBeHidden()
})

test('typing jumps back to the live screen', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()

  // Reading history is one mode, typing is another; a keystroke means you want
  // the input box back.
  await page.locator('#screen textarea').pressSequentially('x')
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
})

test('server output while reading history does not yank the view down', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()
  const parked = await scrollTop(page)

  // Straight down the write path, so it is output arriving rather than a
  // keystroke — pi finishing a long answer while you read back over an earlier one.
  await page.evaluate(() => window.mtty.term.write('a line from the server\r\n'))
  await page.waitForTimeout(500)

  expect(await scrollTop(page)).toBe(parked)
  await expect(page.locator('#to-bottom')).toBeVisible()
})

test('scrolling up offers a way back to the live screen', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect(page.locator('#to-bottom')).toBeHidden()

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()

  await page.locator('#to-bottom').tap()
  await expect(page.locator('#to-bottom')).toBeHidden()
})

test('the terminal box is a whole number of rows, so follow-output cannot get stuck', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await page.setViewportSize({ width: 402, height: 498 })   // keyboard up
  await settled(page)

  // wterm scrolls to the bottom by flooring to a row boundary. A box that is not
  // a multiple of the row height leaves it parked short, and past its own 5px
  // tolerance it stops following output entirely.
  const box = await page.evaluate(() => {
    const s = document.getElementById('screen')
    return { client: s.clientHeight, row: window.mtty.state.cell.height }
  })
  expect(box.client % box.row).toBe(0)

  const ta = page.locator('#screen textarea')
  for (const word of ['one', 'two', 'three']) {
    await ta.pressSequentially(word)
    await ta.press('Enter')
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(5)
  }
  await expect(page.locator('#to-bottom')).toBeHidden()
})
