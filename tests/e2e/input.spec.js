// Everything that puts bytes on the wire: the key bar, modifiers, paste.
import { test, expect } from '@playwright/test'
import { screenText, spySocket, sentFrames, ready } from './helpers.js'

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
  expect(widths.length).toBe(11)
  expect(Math.min(...widths)).toBeGreaterThan(34)
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
