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

test('only complete sequences reach the parser', async () => {
  // What is held back is what the parser would keep as invisible state, and so
  // what a snapshot taken at that instant could not contain.
  const cases = [
    ['lone ESC', 'A\x1b', '\x1b'],
    ['incomplete charset', 'A\x1b(', '\x1b('],
    ['complete charset', 'A\x1b(B', ''],
    ['incomplete CSI', 'A\x1b[3', '\x1b[3'],
    ['complete CSI', 'A\x1b[31m', ''],
    ['CSI with intermediate', 'A\x1b[?25l', ''],
    // Longer than any fixed lookbehind would catch, which is why the scan runs
    // forward from a known-clean start rather than back from the end.
    ['unterminated OSC', `A\x1b]0;${'x'.repeat(200)}`, `\x1b]0;${'x'.repeat(200)}`],
    ['OSC ended by BEL', `A\x1b]0;${'x'.repeat(200)}\x07`, ''],
    ['OSC ended by ST', 'A\x1b]0;t\x1b\\', ''],
    ['unterminated DCS', 'A\x1bP1$r', '\x1bP1$r'],
    ['four-byte char, one byte in', '\xf0', '\xf0'],
    ['four-byte char, three bytes in', '\xf0\x9f\x98', '\xf0\x9f\x98'],
    ['four-byte char, whole', '\u{1f600}', ''],
    ['plain text', 'hello world', ''],
  ]

  for (const [name, input, expected] of cases) {
    const mirror = new Mirror({ cols: COLS, rows: ROWS })
    mirror.write(Buffer.from(input, 'latin1'))
    await mirror.drain()
    assert.equal(mirror.pending.toString('latin1'), expected, name)
  }
})

test('a character split across the snapshot is not lost', async () => {
  const mirror = new Mirror({ cols: COLS, rows: ROWS })
  mirror.write(Buffer.from('AAA'))
  mirror.write(Buffer.from([0xe2]))          // U+2500 starts, and the viewer joins here
  await mirror.drain()

  // The parser keeps a half-read character as invisible state, so a snapshot
  // that only serialized cells would drop the leading byte and hand the viewer
  // the orphaned tail.
  const snapshot = mirror.snapshot()
  const held = Buffer.from(mirror.pending)
  const live = Buffer.from([0x94, 0x80])     // ...and completes after admission

  const core = await WasmBridge.load()
  core.init(COLS, ROWS)
  core.writeString(snapshot)
  core.writeRaw(held)
  core.writeRaw(live)

  assert.deepEqual(render(core).filter(Boolean), ['AAA\u2500'])
})

test('an escape sequence split across the snapshot is not rendered as text', async () => {
  const mirror = new Mirror({ cols: COLS, rows: ROWS })
  mirror.write(Buffer.from('AAA'))
  mirror.write(Buffer.from('\x1b[3'))        // SGR starts, and the viewer joins here
  await mirror.drain()

  const snapshot = mirror.snapshot()
  const held = Buffer.from(mirror.pending)

  const core = await WasmBridge.load()
  core.init(COLS, ROWS)
  core.writeString(snapshot)
  core.writeRaw(held)
  core.writeRaw(Buffer.from('1mBBB'))

  const screen = render(core).filter(Boolean)
  assert.deepEqual(screen, ['AAABBB'])
  assert.ok(!screen.join('').includes('1m'), 'the sequence tail printed as text')
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
