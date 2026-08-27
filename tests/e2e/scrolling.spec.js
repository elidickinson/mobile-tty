// Scrollback: where the view sits, and what is allowed to move it.
import { test, expect, ready, scrollTop, settled, fillScrollback, distanceFromBottom } from './helpers.js'

test('the menu jumps to the top and back to the bottom', async ({ page }) => {
  await ready(page)
  const bottom = await fillScrollback(page)
  expect(bottom).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: 'Top', exact: true }).tap()
  expect(await scrollTop(page)).toBe(0)
  await expect(page.locator('#menu')).toBeHidden()

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: 'Bottom', exact: true }).tap()
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

test('the drawn scrollback is a window that always matches the core', async ({ page }) => {
  await ready(page)

  // The renderer keeps a window of rows around the viewport and keys each
  // row on the ring's absolute line (the discarded count included), so history
  // renders wherever the reader stops and ring rotation cannot freeze the DOM
  // -- the failure mode count-keyed append rendering had. See
  // eli/wterm-scrollback-bug.md. The window is also the perf story: the
  // renderer must not be rebuilding all 1000 rows every frame, which is
  // exactly what a dropped render argument silently buys.
  const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\r\n') + '\r\n'
  await page.evaluate(s => window.mtty.term.write(s), lines('filler', 1200))
  await page.waitForTimeout(500)

  const windowed = () => page.evaluate(() => {
    const b = window.mtty.term.bridge
    const s = document.getElementById('screen')
    const rows = [...s.querySelectorAll('.term-scrollback-row')]
    const topSpacer = s.querySelector('.term-scrollback-spacer')
    const rowH = rows[0].offsetHeight
    // First drawn row's absolute index, from the unrendered span above it.
    const start = Math.round(parseFloat(topSpacer.style.height) / rowH)
    const count = b.getScrollbackCount()
    const coreLine = off => {
      let t = ''
      for (let c = 0; c < b.getScrollbackLineLen(off); c++) t += String.fromCodePoint(b.getScrollbackCell(off, c).char)
      return t.replace(/\s+$/, '')
    }
    const bad = rows.filter((row, j) =>
      row.textContent.replace(/\s+$/, '') !== coreLine(count - 1 - (start + j))).length
    return {
      bad,
      rows: rows.length,
      count,
      first: rows[0].innerText.trim(),
      last: rows[rows.length - 1].innerText.trim(),
      coreNewest: coreLine(0),
    }
  })

  // Top of history: the window hugs the oldest surviving line...
  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect.poll(async () => (await windowed()).first).toMatch(/^filler\d+/)
  expect((await windowed()).bad).toBe(0)
  // ...and it is a window, not the whole buffer. This is the pin for the
  // render(core, viewport) argument: drop it and every one of the 1000 rows
  // is rebuilt on every frame, with no functional symptom until the slowdown.
  expect((await windowed()).rows).toBeLessThan(200)

  // Bottom: the newest line is drawn, and the window moved with the reader.
  await page.evaluate(() => { document.getElementById('screen').scrollTop = document.getElementById('screen').scrollHeight })
  await expect.poll(async () => {
    const w = await windowed()
    return w.last === w.coreNewest && w.bad === 0
  }).toBe(true)

  // Rotation under a parked reader: lines written while the eye is on old
  // history push the survivors up and rotate the ring, and the re-windowed
  // render has to track that — drawn rows keep matching the core they name.
  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect.poll(async () => (await windowed()).first).toMatch(/^filler\d+/)
  await page.evaluate(s => window.mtty.term.write(s), lines('marker', 60))
  await page.waitForTimeout(500)
  const w = await windowed()
  expect(w.bad).toBe(0)
  expect(w.rows).toBeLessThan(200)
  expect(w.first).not.toBe(/^filler214/)   // the oldest survivor moved under the eye
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
