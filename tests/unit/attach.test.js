// The Ctrl-] detach chord, in both encodings a terminal can be in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDetach } from '../../server/attach.js'

test('raw 0x1d is the detach byte', () => {
  assert.equal(isDetach(Buffer.from([0x1d])), true)
})

test('kitty-encoded Ctrl-] detaches: ] codepoint with the ctrl bit', () => {
  assert.equal(isDetach(Buffer.from('\x1b[93;5u')), true)
  // Shifted and alt chords, and the alternate-key field, are still Ctrl-].
  assert.equal(isDetach(Buffer.from('\x1b[93;6u')), true)
  assert.equal(isDetach(Buffer.from('\x1b[93;7u')), true)
  assert.equal(isDetach(Buffer.from('\x1b[93:125;5u')), true)
})

test('the detach chord inside a larger chunk still detaches', () => {
  assert.equal(isDetach(Buffer.from('abc\x1b[93;5u')), true)
})

test('other keys do not detach', () => {
  assert.equal(isDetach(Buffer.from('\x1b[97;5u')), false)       // Ctrl-A
  assert.equal(isDetach(Buffer.from('\x1b[93;5:3u')), false)     // the key release
  assert.equal(isDetach(Buffer.from('\x1b[93u')), false)         // plain ]
  assert.equal(isDetach(Buffer.from('a')), false)
})
