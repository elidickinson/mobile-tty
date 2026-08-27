// The field-mirror regime: the hidden field keeps its content, and each
// input event transmits a diff -- inserted text and one DEL per erased
// grapheme. setField() stands in for iOS's real insertions (QuickPath,
// dictation, the emoji keyboard): it sets the value and fires the same input
// event the keyboard would. The field is a 0-height invisible element, so
// everything goes through dispatched events and the global keyboard -- the
// native-deletion path (Backspace with a non-empty field) included.
import { test, expect, ready } from './helpers.js'

const setField = (page, text) =>
  page.evaluate(t => {
    const ta = document.querySelector('#screen textarea')
    ta.value = t
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: t }))
  }, text)

test('field insertions and deletions stream as deltas', async ({ page }) => {
  await ready(page)
  await page.evaluate(() => document.querySelector('#screen textarea').focus())

  await setField(page, 'hello')
  await expect(page.locator('#screen')).toContainText('hello')

  // Appending transmits only the suffix: the mirror knows 'hello' went out.
  await setField(page, 'hello world')
  await expect(page.locator('#screen')).toContainText('hello world')

  // Backspace with a non-empty field: the native deletion (one press, one
  // grapheme) reaches the diff as a deleteContentBackward input.
  await page.keyboard.press('Backspace')
  await expect(page.locator('#screen')).toContainText('hello worl')

  // Full replacement: erases first, then the new text.
  await setField(page, 'abc')
  await expect(page.locator('#screen')).toContainText('> abc')

  // Enter consumes the line and invalidates the mirror; the next field
  // content transmits whole rather than as a shrink of the old line.
  await page.keyboard.press('Enter')
  await expect(page.locator('#screen')).toContainText('ok: 3 chars')
  await setField(page, 'defgh')
  await expect(page.locator('#screen')).toContainText('defgh')
})

test('bar backspace and the field mirror agree', async ({ page }) => {
  await ready(page)
  const setFieldLocal = setField

  await setFieldLocal(page, 'xyz')
  await expect(page.locator('#screen')).toContainText('xyz')

  // The bar's ⌫ sends DEL from outside the field: the mirror must drop, or
  // the next diff would send correction bytes against a line the bar already
  // changed. After it, 'abcd' transmits whole, on top of the surviving 'xy'.
  await page.getByRole('button', { name: 'Backspace', exact: true }).dispatchEvent('pointerdown')
  await expect(page.locator('#screen')).toContainText('xy')
  await setFieldLocal(page, 'abcd')
  await expect(page.locator('#screen')).toContainText('xyabcd')
})

test('an emoji reaches the PTY as one insertion', async ({ page }) => {
  await ready(page)
  await setField(page, 'a😀')
  await expect(page.locator('#screen')).toContainText('😀')
})
