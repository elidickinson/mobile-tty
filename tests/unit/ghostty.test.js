import test from 'node:test'
import assert from 'node:assert/strict'
import { createGhosttyCore } from '../ghostty.js'

const screenText = core => Array.from({ length: core.getRows() }, (_, y) =>
  Array.from({ length: core.getCols() }, (_, x) => String.fromCodePoint(core.getCell(y, x).char || 32)).join('')
).join('').replaceAll(' ', '')

test('Ghostty preserves text through a column shrink', async () => {
  const core = await createGhosttyCore()
  core.init(80, 24)
  const text = Array.from({ length: 537 }, (_, i) => String.fromCharCode(33 + i % 94)).join('')
  core.writeString(text)
  core.resize(79, 24)
  assert.equal(screenText(core), text)

  core.resize(50, 24)
  assert.equal(screenText(core), text)

  core.resize(80, 24)
  assert.equal(screenText(core), text)
})

