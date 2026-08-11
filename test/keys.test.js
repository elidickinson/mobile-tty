import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keySequence, KEYS } from '../src/keys.js'

const seq = (name, opts) => keySequence(name, opts)

test('arrows follow DECCKM: normal mode uses CSI, application mode uses SS3', () => {
  assert.equal(seq('Up'), '\x1b[A')
  assert.equal(seq('Up', { cursorKeysApp: true }), '\x1bOA')
  assert.equal(seq('Left', { cursorKeysApp: true }), '\x1bOD')
})

test('paging and editing keys use the tilde forms pi expects', () => {
  assert.equal(seq('PageUp'), '\x1b[5~')
  assert.equal(seq('PageDown'), '\x1b[6~')
  assert.equal(seq('Home'), '\x1b[H')
  assert.equal(seq('End'), '\x1b[F')
})

test('ctrl folds a letter to its control code', () => {
  assert.equal(seq('c', { ctrl: true }), '\x03')
  assert.equal(seq('C', { ctrl: true }), '\x03')
  assert.equal(seq('a', { ctrl: true }), '\x01')
})

test('alt prefixes with ESC', () => {
  assert.equal(seq('b', { alt: true }), '\x1bb')
})

test('ctrl+arrow sends the modifier parameter form', () => {
  assert.equal(seq('Right', { ctrl: true }), '\x1b[1;5C')
  assert.equal(seq('Right', { alt: true }), '\x1b[1;3C')
})

test('shift+tab is back-tab', () => {
  assert.equal(seq('Tab'), '\t')
  assert.equal(seq('Tab', { shift: true }), '\x1b[Z')
})

test('an unknown key name is a programming error, not a silent no-op', () => {
  assert.throws(() => seq('Nope'), /unknown key/i)
})

test('every key on the bar has a definition', () => {
  for (const name of KEYS) assert.equal(typeof seq(name), 'string')
})
