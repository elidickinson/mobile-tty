import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INPUT, RESIZE, OUTPUT, SET_TITLE, SET_PREFS, encodeInput, encodeResize, encodeHandshake, decodeFrame } from '../../src/ttyd.js'

const bytes = a => new Uint8Array(a)
const str = u => new TextDecoder().decode(u)

test('encodeInput prefixes INPUT and encodes UTF-8', () => {
  const out = encodeInput('a→')
  assert.equal(String.fromCharCode(out[0]), INPUT)
  assert.deepEqual(out.slice(1), bytes([0x61, 0xe2, 0x86, 0x92]))
})

test('encodeResize carries columns and rows as JSON', () => {
  const out = encodeResize(120, 40)
  assert.equal(String.fromCharCode(out[0]), RESIZE)
  assert.deepEqual(JSON.parse(str(out.slice(1))), { columns: 120, rows: 40 })
})

test('handshake is a bare JSON object, not a prefixed frame', () => {
  const out = encodeHandshake('tok', 50, 30)
  assert.equal(String.fromCharCode(out[0]), '{')
  assert.deepEqual(JSON.parse(str(out)), { AuthToken: 'tok', columns: 50, rows: 30 })
})

test('decodeFrame splits command byte from raw payload without decoding it', () => {
  // A 3-byte box-drawing char after the command byte must survive as bytes.
  const raw = bytes([0x30, 0xe2, 0x94, 0x80])
  const f = decodeFrame(raw.buffer)
  assert.equal(f.cmd, OUTPUT)
  assert.ok(f.payload instanceof Uint8Array, 'payload stays bytes so the VT core reassembles UTF-8')
  assert.deepEqual(f.payload, bytes([0xe2, 0x94, 0x80]))
})

test('decodeFrame reads title and preference frames as text', () => {
  const enc = new TextEncoder()
  assert.equal(decodeFrame(enc.encode('1pi').buffer).cmd, SET_TITLE)
  assert.equal(decodeFrame(enc.encode('1pi').buffer).text, 'pi')
  assert.deepEqual(decodeFrame(enc.encode('2{"a":1}').buffer).json, { a: 1 })
  assert.equal(decodeFrame(enc.encode('2{"a":1}').buffer).cmd, SET_PREFS)
})

test('decodeFrame on an empty message is a programming error', () => {
  assert.throws(() => decodeFrame(new ArrayBuffer(0)), /empty/)
})
