// Everything that puts bytes on the wire: the key bar, modifiers, paste.
import { test, expect, screenText, spySocket, sentFrames, ready } from './helpers.js'

test('typing reaches the shell and echoes back', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('hello')
  await expect(page.locator('#screen')).toContainText('> hello')

  await page.locator('#screen textarea').press('Enter')
  await expect(page.locator('#screen')).toContainText('ok: 5 chars')
})

test('the hidden input has autocorrect off — a corrected identifier is a wrong file', async ({ page }) => {
  await ready(page)
  const a = await page.locator('#screen textarea').evaluate(t => ({
    autocorrect: t.getAttribute('autocorrect'),
    autocapitalize: t.getAttribute('autocapitalize'),
    spellcheck: t.getAttribute('spellcheck'),
  }))
  expect(a).toEqual({ autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })
})

test('key bar sends the right bytes, and a sticky modifier applies once', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  await page.getByRole('button', { name: 'Up', exact: true }).tap()
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()

  const log = await sentFrames(page)
  expect(log).toContain('0\x1b[A')
  expect(log.at(-1)).toBe('0\x1b')            // ctrl+Escape is just Escape
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('option sends the real alt-modified sequence, not esc plus the key', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  // alt+Up is one CSI sequence with a modifier parameter, not reproducible by
  // sending Escape and Up as two separate presses.
  await page.getByRole('button', { name: 'alt', exact: true }).tap()
  await page.getByRole('button', { name: 'Up', exact: true }).tap()

  const log = await sentFrames(page)
  expect(log.at(-1)).toBe('0\x1b[1;3A')
  await expect(page.getByRole('button', { name: 'alt', exact: true })).not.toHaveClass(/sticky/)
})

test('pasted text is sent to the terminal', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()

  // Stands in for the iOS paste callout, which needs a real visible field —
  // the terminal's own input is hidden, so there is nothing to long-press.
  await page.locator('#paste').fill('pasted text')
  await page.getByRole('button', { name: 'Send' }).tap()

  await expect(page.locator('#screen')).toContainText('> pasted text')
  await expect(page.locator('#menu')).toBeHidden()
  expect(await page.locator('#paste').inputValue()).toBe('')
})

test('the key bar keys are big enough to hit', async ({ page }) => {
  await ready(page)
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('#bar button')].map(b => b.getBoundingClientRect().width))
  expect(widths.length).toBe(12)
  // 12 equal-width buttons cannot all clear 34px in a 402px-wide phone (12 * 34
  // > 402 even with zero gap or padding) — the floor moved down with the count.
  expect(Math.min(...widths)).toBeGreaterThan(30)
})

test('the keyboard key summons and dismisses the input', async ({ page }) => {
  await ready(page)
  const focused = () => page.evaluate(() => document.activeElement === document.querySelector('#screen textarea'))
  await page.evaluate(() => document.querySelector('#screen textarea').blur())
  expect(await focused()).toBe(false)

  await page.getByRole('button', { name: 'keyboard' }).tap()
  expect(await focused()).toBe(true)

  await page.getByRole('button', { name: 'keyboard' }).tap()
  expect(await focused()).toBe(false)
})

test('a sticky modifier reaches keys typed on the software keyboard', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  // These arrive through wterm rather than the key bar, so without the modifier
  // being applied there, Ctrl-C is unreachable from a phone.
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.locator('#screen textarea').pressSequentially('c')

  expect(await sentFrames(page)).toContain('0\x03')
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('using a modifier leaves the rest of the bar alone', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).toHaveClass(/sticky/)

  await page.locator('#screen textarea').pressSequentially('c')
  expect(await page.locator('#bar button.sticky').count()).toBe(0)
})

test('a modified arrow is swallowed whole by the terminal app', async ({ page }) => {
  await ready(page)
  // ctrl+Right is \x1b[1;5C — six bytes, not the three of a bare arrow.
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Right', exact: true }).tap()
  await page.waitForTimeout(400)

  await page.locator('#screen textarea').pressSequentially('ok')
  await expect(page.locator('#screen')).toContainText('> ok')
  expect(await screenText(page)).not.toContain(';5C')
})

test('a lone shift does not stay armed after a letter', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'shift', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'shift', exact: true })).toHaveClass(/sticky/)

  await page.locator('#screen textarea').pressSequentially('a')
  expect(await page.locator('#bar button.sticky').count()).toBe(0)
})

test('tapping a key before the core loads does not fault', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Up', exact: true }).tap()   // before init resolves
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect(page.locator('#diag-overlay')).toBeHidden()
})

test('backspace is on the bar and repeats when held', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('abcdefgh')
  await expect(page.locator('#screen')).toContainText('> abcdefgh')

  const key = page.getByRole('button', { name: 'Backspace', exact: true })
  await key.tap()
  await expect(page.locator('#screen')).toContainText('> abcdefg')

  // Held, it should eat several more rather than one per tap.
  const box = await key.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(900)
  await page.mouse.up()
  await expect(page.locator('#screen')).not.toContainText('> abcde')
})

test('opening the menu puts the keyboard away', async ({ page }) => {
  await ready(page)
  const focused = () => page.evaluate(() => document.activeElement === document.querySelector('#screen textarea'))
  await page.evaluate(() => document.querySelector('#screen textarea').blur())
  await page.getByRole('button', { name: 'keyboard' }).tap()
  expect(await focused()).toBe(true)

  // It would otherwise cover most of what it just opened.
  await page.getByRole('button', { name: 'menu' }).tap()
  await expect(page.locator('#menu')).toBeVisible()
  expect(await focused()).toBe(false)
})
