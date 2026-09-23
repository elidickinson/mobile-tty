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
const DEBT_MS = 1_500       // rogue alone, building a backlog before anyone joins
const ABUSE_MS = 2_500      // the rogue is cut loose well inside this window
const SETTLE_MS = 500       // deferred is not lost, so give it a beat to arrive
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

/** Sequence numbers truly missing from the capture. The `S` matters: a
 *  number straddling a frame edge would otherwise be read as two shorter
 *  ones. A number below the running maximum is a snapshot redraw (a relay
 *  that fell behind and reset replays screen-then-live), not a loss — the
 *  stream splits into runs there, and each run must be contiguous. */
const gaps = bytes => {
  const seen = [...Buffer.concat(bytes).toString('latin1').matchAll(/S(\d{9})/g)].map(m => +m[1])
  const missing = []
  let floor = -1
  for (const n of seen) {
    if (n <= floor) { floor = n; continue } // a reset: the new run starts here
    if (n !== floor + 1 && floor >= 0) missing.push([floor, n])
    floor = n
  }
  return missing
}

// A relative gap-check would read a dropped HEAD as clean — the first number
// seen simply becomes the baseline. The counter starts at 0, so the first
// full read of a stream from its beginning must show it, modulo the very
// first line racing the capture's start.
const firstSeen = bytes => +(Buffer.concat(bytes).toString('latin1').match(/S(\d{9})/)?.[1] ?? -1)

const lastSeen = bytes => {
  const all = [...Buffer.concat(bytes).toString('latin1').matchAll(/S(\d{9})/g)].map(m => +m[1])
  return all[all.length - 1] ?? -1
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
    let priorLast = null
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
      // Seam continuity across joins: the first number this capture saw may
      // trail the last of the previous one (the screen scrolled between), but
      // it must never be a jump BACKWARD — and the very first join, landing
      // on a counter only a beat old, must open near zero rather than at
      // whatever number would flatter a dropped head.
      const first = firstSeen(bytes)
      const last = lastSeen(bytes)
      if (priorLast !== null) assert.ok(first >= priorLast, `join ${i} opened at ${first}, behind the prior capture's ${priorLast}`)
      priorLast = last
      if (i === 0) assert.ok(first < 10_000, `join 0 opened at S${first} — the head of the stream is missing`)
    }
  } finally { stack.stop() }
})
