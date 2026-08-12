// Does one badly-behaved viewer cost the others their bytes?
//
// A screen can look plausible while whole sequences have been eaten out of the
// middle of it, which is why this counts rather than looks. `npm run test:integrity`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { startStack } from './stack.js'
import { encodeHandshake, encodeResize, decodeFrame, OUTPUT } from '../../src/ttyd.js'

const COLS = 80
const ROWS = 40
const RESIZE_EVERY_MS = 200
// Every second, stop reading for most of it and let the session pile up.
const HOLD_MS = 750
const HOLD_EVERY_MS = 1_000
const DEBT_MS = 2_000       // rogue alone, building a backlog before anyone joins
const ABUSE_MS = 10_000     // long enough that what it is owed fits in no sane buffer
const SETTLE_MS = 2_000     // deferred is not lost, so give it time to arrive
// Two, not one: every extra client is another write the session must complete
// per read, and the loss only shows up once there are enough of them.
const N_VIEWERS = 2

const wait = ms => new Promise(r => setTimeout(r, ms))

/**
 * A viewer, optionally a rogue one.
 *
 * A phone on a terrible connection leaves bytes unread in the kernel, so the
 * abuse has to be pausing the socket itself. A handler that merely dawdles lets
 * the socket drain underneath it and reproduces nothing.
 */
class Viewer {
  constructor(url, { rogue = false } = {}) {
    this.rogue = rogue
    this.bytes = []
    this.timers = []
    this.opened = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, ['tty'])
      this.ws.on('error', reject)
      this.ws.on('open', resolve)
      this.ws.on('message', data => {
        const { cmd, payload } = decodeFrame(data)
        if (cmd === OUTPUT) this.bytes.push(Buffer.from(payload))
      })
    })
  }

  start() {
    this.ws.send(encodeHandshake('', COLS, ROWS))
    if (!this.rogue) return
    let rows = ROWS
    this.timers.push(setInterval(() => {
      rows = rows === ROWS ? ROWS - 1 : ROWS
      this.ws.send(encodeResize(COLS, rows))
    }, RESIZE_EVERY_MS))
    this.timers.push(setInterval(() => {
      this.ws._socket.pause()
      this.timers.push(setTimeout(() => this.ws._socket.resume(), HOLD_MS))
    }, HOLD_EVERY_MS))
  }

  async settle() {
    this.timers.forEach(clearTimeout)
    this.ws._socket.resume()
    await wait(SETTLE_MS)
    this.ws.close()
    return this.bytes
  }
}

/** Sequence numbers missing from the capture. The `S` matters: a number
 *  straddling a frame edge would otherwise be read as two shorter ones. */
const gaps = bytes => {
  const seen = [...Buffer.concat(bytes).toString('latin1').matchAll(/S(\d{9})/g)].map(m => +m[1])
  return seen.flatMap((n, i) => (i > 0 && n !== seen[i - 1] + 1 ? [[seen[i - 1], n]] : []))
}

test('a rogue viewer costs the well-behaved ones nothing', async () => {
  const stack = await startStack({ command: 'tests/fixtures/counter.sh' })
  try {
    const rogue = new Viewer(stack.url, { rogue: true })
    await rogue.opened
    rogue.start()
    await wait(DEBT_MS)

    const viewers = Array.from({ length: N_VIEWERS }, () => new Viewer(stack.url))
    await Promise.all(viewers.map(v => v.opened))
    viewers.forEach(v => v.start())
    await wait(ABUSE_MS)

    await rogue.settle()
    const captures = await Promise.all(viewers.map(v => v.settle()))

    captures.forEach((bytes, i) => {
      const total = bytes.reduce((n, b) => n + b.length, 0)
      const missing = gaps(bytes)
      const lost = missing.reduce((n, [a, b]) => n + (b - a - 1), 0)
      // A dead socket has no gaps either, so the volume is part of the assertion.
      assert.ok(total > 1024 * 1024, `viewer ${i} captured only ${total} bytes`)
      assert.deepEqual(missing, [], `viewer ${i}: ${missing.length} gaps, ${lost} lines lost, of ${total} bytes`)
    })
  } finally { stack.stop() }
})

test('a viewer joining mid-stream gets the screen and then every byte after it', async () => {
  const stack = await startStack({ command: 'tests/fixtures/counter.sh' })
  try {
    // Join repeatedly while the session is at full rate: each snapshot has to
    // split the stream exactly, with nothing lost or repeated at the seam.
    for (let i = 0; i < 5; i++) {
      const viewer = new Viewer(stack.url)
      await viewer.opened
      viewer.start()
      await wait(400)
      const bytes = await viewer.settle()
      const missing = gaps(bytes)
      const total = bytes.reduce((n, b) => n + b.length, 0)
      assert.ok(total > 64 * 1024, `join ${i} captured only ${total} bytes`)
      assert.deepEqual(missing, [], `join ${i}: ${missing.length} seams, of ${total} bytes`)
    }
  } finally { stack.stop() }
})
