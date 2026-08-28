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

  // Backspace with a non-empty field: the native deletion (one press, one
  // grapheme) reaches the diff as a deleteContentBackward input.
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
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: ' world' }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: ' world' }))
  })
  await expect(page.locator('#screen')).toContainText('hello world')
  await expect(page.locator('#screen')).not.toContainText('hello world world')
})

test('an emoji reaches the PTY as one insertion', async ({ page }) => {
  await ready(page)
  await appendField(page, 'a😀')
  await expect(page.locator('#screen')).toContainText('😀')
})
