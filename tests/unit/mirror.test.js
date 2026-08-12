// The snapshot crosses from xterm's serializer into wterm's Zig core, which are
// two independent VT implementations. This is the gate on that boundary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WasmBridge } from '@wterm/core'
import { Mirror } from '../../server/mirror.js'

const COLS = 60
const ROWS = 12

const render = core => Array.from({ length: core.getRows() }, (_, r) =>
  Array.from({ length: core.getCols() }, (_, x) => String.fromCodePoint(core.getCell(r, x).char || 32))
    .join('').trimEnd())

/** Feed `input` to a mirror, restore its snapshot into a fresh core, and return
 *  both screens so a disagreement is visible rather than merely detected. */
const roundTrip = async input => {
  const mirror = new Mirror({ cols: COLS, rows: ROWS })
  mirror.write(Buffer.from(input))
  await mirror.drain()

  const direct = await WasmBridge.load()
  direct.init(COLS, ROWS)
  direct.writeString(input)

  const restored = await WasmBridge.load()
  restored.init(COLS, ROWS)
  restored.writeString(mirror.snapshot())

  return { direct: render(direct), restored: render(restored) }
}

test('a plain screen survives the snapshot', async () => {
  const { direct, restored } = await roundTrip('hello\r\nsecond line\r\n')
  assert.deepEqual(restored, direct)
})

test('colour and attributes survive the snapshot', async () => {
  const { direct, restored } = await roundTrip(
    '\x1b[38;2;155;95;255mpurple\x1b[0m \x1b[1mbold\x1b[0m \x1b[4munder\x1b[0m\r\n')
  assert.deepEqual(restored, direct)
})

test('a box-drawn frame survives the snapshot', async () => {
  const rule = '─'.repeat(COLS - 2)
  const { direct, restored } = await roundTrip(`┌${rule}┐\r\n│ prompt${' '.repeat(COLS - 10)}│\r\n└${rule}┘\r\n`)
  assert.deepEqual(restored, direct)
})

test('the snapshot replaces a screen rather than painting over it', async () => {
  const mirror = new Mirror({ cols: COLS, rows: ROWS })
  mirror.write(Buffer.from('after\r\n'))
  await mirror.drain()

  const core = await WasmBridge.load()
  core.init(COLS, ROWS)
  core.writeString('stale line one\r\nstale line two\r\n')
  core.writeString(mirror.snapshot())

  assert.deepEqual(render(core).filter(Boolean), ['after'])
})

test('the snapshot replaces the history too, rather than stacking under it', async () => {
  const mirror = new Mirror({ cols: COLS, rows: ROWS, scrollback: 100 })
  for (let i = 0; i < 40; i++) mirror.write(Buffer.from(`fresh ${i}\r\n`))
  await mirror.drain()

  // A page that reconnects still holds everything from before it dropped. RIS
  // does not clear saved lines, so without ED 3 the snapshot's history lands
  // underneath the stale history instead of replacing it.
  const core = await WasmBridge.load()
  core.init(COLS, ROWS)
  for (let i = 0; i < 40; i++) core.writeString(`stale ${i}\r\n`)
  const stale = core.getScrollbackCount()
  assert.ok(stale > 10, 'the reconnecting viewer needs history to lose')

  core.writeString(mirror.snapshot())

  const history = Array.from({ length: core.getScrollbackCount() }, (_, i) =>
    Array.from({ length: core.getCols() }, (_, x) =>
      String.fromCodePoint(core.getScrollbackCell(i, x).char || 32)).join('').trim())
  assert.equal(history.filter(l => l.startsWith('stale')).length, 0, 'stale history survived')
  assert.ok(history.filter(l => l.startsWith('fresh')).length > 10, 'fresh history missing')
})
