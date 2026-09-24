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

  await page.getByRole('button', { name: 'Enter', exact: true }).tap()
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()

  const log = await sentFrames(page)
  expect(log).toContain('0\r')
  expect(log.at(-1)).toBe('0\x1b')            // ctrl+Escape is just Escape
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('option sends the real alt-modified sequence, not esc plus the key', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  // alt+Up is one CSI sequence with a modifier parameter, not reproducible by
  // sending Escape and Up as two separate presses. The arrows are on the pad
  // now, and arming alt on the bar leaves the pad open for exactly this.
  await page.getByRole('button', { name: 'arrow pad', exact: true }).tap()
  await page.getByRole('button', { name: 'alt', exact: true }).tap()
  await page.getByRole('button', { name: 'Up', exact: true }).tap()

  const log = await sentFrames(page)
  expect(log.at(-1)).toBe('0\x1b[1;3A')
  await expect(page.getByRole('button', { name: 'alt', exact: true })).not.toHaveClass(/sticky/)
})

/** What opening the pad must not move: the grid, the terminal box, the bar. */
const gridLayout = page => page.evaluate(() => {
  const s = document.getElementById('screen').getBoundingClientRect()
  const b = document.getElementById('bar').getBoundingClientRect()
  return {
    cols: window.mtty.state.cols,
    rows: window.mtty.state.rows,
    screen: [s.top, s.height],
    bar: [b.top, b.height],
  }
})

test('the arrow pad pops over the terminal and taps out of the way', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  const pad = page.locator('#pad')
  await expect(pad).toBeHidden()
  const before = await gridLayout(page)

  await page.getByRole('button', { name: 'arrow pad', exact: true }).tap()
  await expect(pad).toBeVisible()

  // It floats over the terminal rather than taking room from it: the grid and
  // everything around it are exactly where they were.
  expect(await gridLayout(page)).toEqual(before)

  await page.getByRole('button', { name: 'Down', exact: true }).tap()
  expect((await sentFrames(page)).at(-1)).toBe('0\x1b[B')

  // It stays open across presses, and a tap on the terminal dismisses it.
  await expect(pad).toBeVisible()
  await page.locator('#screen').tap()
  await expect(pad).toBeHidden()
})

test('holding a pad arrow repeats it', async ({ page }) => {
  await ready(page)
  await spySocket(page)
  await page.getByRole('button', { name: 'arrow pad', exact: true }).tap()

  // The pad's arrows carry the bar's repeat, and only a held press shows it: a
  // repeat regression would otherwise pass on the tap alone.
  const arrow = page.getByRole('button', { name: 'Right', exact: true })
  const box = await arrow.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(900)
  await page.mouse.up()

  const held = (await sentFrames(page)).filter(f => f === '0\x1b[C')
  expect(held.length).toBeGreaterThan(1)
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
    [...document.querySelectorAll('#keys button')].map(b => b.getBoundingClientRect().width))
  expect(widths.length).toBe(10)
  // The arrows moved to the pad and Enter took their room. 12 equal-width
  // buttons could not clear 34px in a 402px-wide phone (12 * 34 > 402 even
  // with zero gap or padding); the 10 left clear 36px.
  expect(Math.min(...widths)).toBeGreaterThan(36)
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

test('a bar or pad tap never moves focus off the terminal input', async ({ page }) => {
  await ready(page)
  const focused = () => page.evaluate(() => document.activeElement === document.querySelector('#screen textarea'))
  await page.evaluate(() => document.querySelector('#screen textarea').focus())
  expect(await focused()).toBe(true)

  // iOS dismisses the keyboard when a bar tap moves DOM focus to a button
  // (that blur is what ends editing). Every button drops out of tab order and
  // its default press is cancelled, so a tap leaves the textarea as the active
  // element and no blur reaches it.
  const keyButtons = page.locator('#keys button, #pad button')
  expect(await keyButtons.evaluateAll(bs => bs.every(b => b.tabIndex === -1))).toBe(true)

  await page.getByRole('button', { name: 'Enter', exact: true }).tap()
  await expect.poll(() => focused()).toBe(true)

  // The pad's arrows have to hold the keyboard the same way.
  await page.getByRole('button', { name: 'arrow pad', exact: true }).tap()
  await page.getByRole('button', { name: 'Up', exact: true }).tap()
  await expect.poll(() => focused()).toBe(true)
  // The deferred iOS blur, when it happens at all, lands ~40ms after the tap —
  // wait past that window and confirm it never arrived.
  await page.waitForTimeout(150)
  expect(await focused()).toBe(true)
})

test('using a modifier leaves the rest of the bar alone', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).toHaveClass(/sticky/)

  await page.locator('#screen textarea').pressSequentially('c')
  expect(await page.locator('#keys button.sticky').count()).toBe(0)
})

test('a modified arrow is swallowed whole by the terminal app', async ({ page }) => {
  await ready(page)
  // ctrl+Right is \x1b[1;5C — six bytes, not the three of a bare arrow.
  await page.getByRole('button', { name: 'arrow pad', exact: true }).tap()
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
  expect(await page.locator('#keys button.sticky').count()).toBe(0)
})

test('tapping a key before the core loads does not fault', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Enter', exact: true }).tap()   // before init resolves
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
