// The field-mirror regime: the hidden field keeps its content, and each
// input event transmits a diff -- inserted text and one DEL per erased
// grapheme. Two helpers stand in for the two things iOS can do to the field:
// appendField models a real insertion (QuickPath, dictation, emoji -- text
// arrives at the caret, on top of whatever the field holds), and setField
// models the field being replaced wholesale. Assertions deliberately include
// negative forms: a substring pass is what let the send-and-wipe handler look
// correct for years.
import { test, expect, ready } from './helpers.js'

const appendField = (page, text) =>
  page.evaluate(t => {
    const ta = document.querySelector('#screen textarea')
    ta.value += t
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: t }))
  }, text)

const setField = (page, text) =>
  page.evaluate(t => {
    const ta = document.querySelector('#screen textarea')
    ta.value = t
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: t }))
  }, text)

const emulateIOS = page => page.addInitScript(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
})

const emulateIPadOS = page => page.addInitScript(() => {
  Object.defineProperties(navigator, {
    userAgent: { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
    platform: { configurable: true, value: 'MacIntel' },
    maxTouchPoints: { configurable: true, value: 5 },
  })
})

const emulateAndroid = page => page.addInitScript(() => {
  Object.defineProperties(navigator, {
    userAgent: { configurable: true, value: 'Mozilla/5.0 (Linux; Android 13; Tablet) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    platform: { configurable: true, value: 'Linux armv8l' },
    maxTouchPoints: { configurable: true, value: 10 },
  })
})

const androidType = (page, text) => page.evaluate(value => {
  const ta = document.querySelector('#screen textarea')
  for (const letter of value) {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }))
    ta.value += letter
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: letter, bubbles: true }))
  }
}, text)

const androidBackspace = page => page.evaluate(() => {
  const ta = document.querySelector('#screen textarea')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }))
  ta.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
  }))
})

const androidNativeBackspace = page => page.evaluate(() => {
  const ta = document.querySelector('#screen textarea')
  ta.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward', bubbles: true, cancelable: false,
  }))
  ta.value = ta.value.slice(0, -1)
  ta.setSelectionRange(ta.value.length, ta.value.length)
  ta.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }))
})

test('field insertions and deletions stream as deltas', async ({ page }) => {
  await ready(page)
  await page.evaluate(() => document.querySelector('#screen textarea').focus())

  await appendField(page, 'hello')
  await expect(page.locator('#screen')).toContainText('hello')

  // Appending transmits only the suffix. Sending the whole value instead
  // would double the word on the line.
  await appendField(page, ' world')
  await expect(page.locator('#screen')).toContainText('hello world')
  await expect(page.locator('#screen')).not.toContainText('hellohello')

  // Backspace with a non-empty field shortens the mirror and sends one DEL.
  await page.keyboard.press('Backspace')
  await expect(page.locator('#screen')).toContainText('hello worl')
  await expect(page.locator('#screen')).not.toContainText('hello world')
})

test('Enter consumes the line and invalidates the mirror', async ({ page }) => {
  await ready(page)

  await appendField(page, 'abc')
  await expect(page.locator('#screen')).toContainText('> abc')
  await page.keyboard.press('Enter')
  await expect(page.locator('#screen')).toContainText('ok: 3 chars')

  // The discriminating case: shared prefix. With the mirror reset by Enter,
  // 'abcdef' transmits whole; without it, the diff against the stale 'abc'
  // erases three characters that no longer exist and sends only 'def'.
  await setField(page, 'abcdef')
  await expect(page.locator('#screen')).toContainText('abcdef')
  await expect(page.locator('#screen')).not.toContainText('> def')
})

test('bar backspace and the field mirror agree', async ({ page }) => {
  await ready(page)

  await appendField(page, 'xyz')
  await expect(page.locator('#screen')).toContainText('xyz')

  // The bar's ⌫ sends DEL from outside the field, so the mirror must drop --
  // the field itself is cleared, which is observable, and the next insertion
  // transmits whole on top of the surviving 'xy'.
  await page.getByRole('button', { name: 'Backspace', exact: true }).dispatchEvent('pointerdown')
  await expect(page.locator('#screen')).toContainText('xy')
  expect(await page.locator('#screen textarea').inputValue()).toBe('')
  await appendField(page, 'abcd')
  await expect(page.locator('#screen')).toContainText('xyabcd')
})

test('composition commits exactly once, in either engine order', async ({ page }) => {
  await ready(page)

  // Safari order: compositionend first, then a trailing non-composing input.
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.value = 'hello'
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello' }))
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'hello' }))
  })
  await expect(page.locator('#screen')).toContainText('hello')
  await expect(page.locator('#screen')).not.toContainText('hellohello')

  // Firefox order: the final composing input precedes compositionend. The
  // composing input is ignored, and compositionend's flush carries the commit.
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.value += ' world'
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: ' world', isComposing: true }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: ' world' }))
  })
  await expect(page.locator('#screen')).toContainText('hello world')
  await expect(page.locator('#screen')).not.toContainText('hello world world')
})

test('a swiped single letter gets the separator iOS withholds', async ({ page }) => {
  await emulateIOS(page)
  await ready(page)

  // "I a am" swiped one token at a time: iOS spaces multi-letter words but
  // not single letters, which glues each neighbor to the letter. The engine
  // inserts the missing space in the field before transmitting.
  await appendField(page, 'I')
  await expect(page.locator('#screen')).toContainText('I')
  await appendField(page, 'a')
  await expect(page.locator('#screen')).toContainText('I a')
  await expect(page.locator('#screen')).not.toContainText('Ia')
  await appendField(page, 'am')
  await expect(page.locator('#screen')).toContainText('I a am')
  await expect(page.locator('#screen')).not.toContainText('aam')

  // iOS already spaces multi-letter words; no doubling on top. (The positive
  // assertion discriminates: it cannot match a double-spaced variant.)
  await appendField(page, ' here')
  await expect(page.locator('#screen')).toContainText('I a am here')
})

test('a single letter delivered as marked text gets the separator on iPadOS', async ({ page }) => {
  await emulateIPadOS(page)
  await ready(page)

  // QuickPath may ride the marked-text pathway: the letter arrives as an
  // interim insertion while composing, then commits. The separator is
  // spliced in at composition end, before the diff runs.
  await appendField(page, 'I')
  await expect(page.locator('#screen')).toContainText('I')
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.value += 'a'
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'a', isComposing: true }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'a' }))
  })
  await expect(page.locator('#screen')).toContainText('I a')
  await expect(page.locator('#screen')).not.toContainText('Ia')
})

test('backspace during composition waits for the committed field value', async ({ page }) => {
  await ready(page)
  await appendField(page, 'abc')
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', isComposing: true, bubbles: true, cancelable: true,
    }))
    ta.value = 'ab'
    ta.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward', isComposing: true, bubbles: true,
    }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
  })
  await expect(page.locator('#screen')).toContainText('> ab')
  await expect(page.locator('#screen')).not.toContainText('> abc')
})

test('Android-style input types letters and backspaces without drifting', async ({ page }) => {
  await emulateAndroid(page)
  await ready(page)
  await androidType(page, 'and')
  await expect(page.locator('#screen')).toContainText('> and')
  await expect(page.locator('#screen')).not.toContainText('> a n d')

  // Some Gboard deletions arrive as a cancelable beforeinput without an input.
  await androidBackspace(page)
  await expect(page.locator('#screen')).toContainText('> an')
  await expect(page.locator('#screen')).not.toContainText('> and')

  // Others let the textarea mutate and report the result through input.
  await androidNativeBackspace(page)
  await expect(page.locator('#screen')).toContainText('> a')
  await expect(page.locator('#screen')).not.toContainText('> an')

  // The empty mirror path also sends DEL, then later typing starts in sync.
  await page.getByRole('button', { name: 'Backspace', exact: true }).tap()
  await androidBackspace(page)
  await androidType(page, 'x')
  await expect(page.locator('#screen')).toContainText('> x')
})

test('a committed input releases composition state after a bar key resets the field', async ({ page }) => {
  await ready(page)
  await appendField(page, 'abc')
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.value += 'd'
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'd', isComposing: true }))
  })

  await page.getByRole('button', { name: 'Backspace', exact: true }).tap()
  await expect(page.locator('#screen')).toContainText('> ab')
  await page.evaluate(() => {
    const ta = document.querySelector('#screen textarea')
    ta.value = 'x'
    ta.setSelectionRange(1, 1)
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x' }))
  })
  await expect(page.locator('#screen')).toContainText('> abx')
})

test('an emoji reaches the PTY as one insertion', async ({ page }) => {
  await ready(page)
  await appendField(page, 'a😀')
  await expect(page.locator('#screen')).toContainText('😀')
})
