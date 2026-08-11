// Connection behaviour: handshake, queueing, backoff, and the repaint nudge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtydConnection } from '../../src/transport.js'

class FakeSocket {
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.sent = []
    this.readyState = 0
    FakeSocket.last = this
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  message(bytes) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }) }
  drop() { this.readyState = 3; this.onclose?.() }
}

const text = u => new TextDecoder().decode(u)
const setup = (opts = {}) => {
  const events = { output: [], state: [] }
  const timers = []
  const c = new TtydConnection({
    url: 'ws://x/ws',
    socketFactory: (u, p) => new FakeSocket(u, p),
    schedule: (fn, ms) => timers.push({ fn, ms }),   // no real timers in tests
    onOutput: p => events.output.push(p),
    onState: s => events.state.push(s),
    ...opts,
  })
  // Run everything currently pending, including anything it schedules in turn.
  const flush = () => { while (timers.length) timers.shift().fn() }
  return { c, events, timers, flush, sock: () => FakeSocket.last }
}

test('connects with the tty subprotocol and sends the handshake first', () => {
  const { c, sock } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  assert.deepEqual(sock().protocols, ['tty'])
  assert.deepEqual(JSON.parse(text(sock().sent[0])), { AuthToken: '', columns: 50, rows: 30 })
})

test('output frames arrive as raw bytes', () => {
  const { c, events, sock } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  sock().message([0x30, 0xe2, 0x94, 0x80])
  assert.deepEqual(events.output[0], new Uint8Array([0xe2, 0x94, 0x80]))
})

test('input typed while disconnected is queued and flushed on reconnect', () => {
  const { c, sock, timers, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()                            // drain the attach nudge
  sock().drop()
  const before = sock().sent.length
  c.send('hello')
  assert.equal(sock().sent.length, before, 'nothing goes out on a dead socket')

  timers.shift().fn()                // the scheduled retry
  sock().open()
  const bodies = sock().sent.map(text)
  assert.equal(bodies[0][0], '{', 'handshake still leads')
  assert.ok(bodies.some(b => b === '0hello'))
})

test('reconnect nudges the size N-1 then N to force a full repaint', () => {
  const { c, sock, timers, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()                            // drain the attach nudge
  sock().drop()
  timers.shift().fn()
  sock().open()

  // The two sizes must not land in the same tick, or the app reads the window
  // size once and sees no change.
  const immediate = sock().sent.map(text).filter(b => b[0] === '1')
  assert.equal(immediate.length, 1, 'the second half of the nudge is deferred')
  flush()

  const resizes = sock().sent.map(text).filter(b => b[0] === '1').map(b => JSON.parse(b.slice(1)))
  assert.deepEqual(resizes, [{ columns: 49, rows: 30 }, { columns: 50, rows: 30 }])
})

test('even a first connection nudges — the session outlives the page', () => {
  // dtach keeps the program running with no replay buffer, so a freshly loaded
  // client can attach to an already-running pi and get a blank screen.
  const { c, sock, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()
  const resizes = sock().sent.map(text).filter(b => b[0] === '1').map(b => JSON.parse(b.slice(1)))
  assert.deepEqual(resizes, [{ columns: 49, rows: 30 }, { columns: 50, rows: 30 }])
})

test('a resize while disconnected is not queued — it would collapse the nudge gap', () => {
  const { c, sock, flush } = setup()
  c.resize(50, 30)                   // the initial fit, before the socket exists
  c.connect({ cols: 50, rows: 30 })
  sock().open()

  const immediate = sock().sent.map(text).filter(b => b[0] === '1')
  assert.equal(immediate.length, 1, 'only the first half of the nudge lands in this tick')
  flush()
  const resizes = sock().sent.map(text).filter(b => b[0] === '1').map(b => JSON.parse(b.slice(1)))
  assert.deepEqual(resizes, [{ columns: 49, rows: 30 }, { columns: 50, rows: 30 }])
})

test('backoff grows on repeated failure and resets once connected', () => {
  const { c, sock, timers, flush } = setup()
  const retry = () => timers.shift().fn()
  const delays = []
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()                            // drain the attach nudge
  sock().drop(); delays.push(timers[0].ms); retry()
  sock().drop(); delays.push(timers[0].ms); retry()
  sock().drop(); delays.push(timers[0].ms); retry()
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1])

  sock().open()
  flush()                                 // drain the repaint nudge
  sock().drop()
  assert.equal(timers[0].ms, delays[0], 'a successful connection resets the backoff')
})

test('claimSize takes the shared size back with a real change, not a repeat', () => {
  const { c, sock, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()
  const before = sock().sent.length

  c.claimSize()
  flush()
  const sent = sock().sent.slice(before).map(text).map(b => JSON.parse(b.slice(1)))
  // Repeating 50x30 would leave ttyd's own PTY unchanged and reach nothing.
  assert.deepEqual(sent, [{ columns: 49, rows: 30 }, { columns: 50, rows: 30 }])
})

test('claimSize is silent while disconnected', () => {
  const { c, sock, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()
  sock().drop()
  const before = sock().sent.length

  c.claimSize()
  assert.equal(sock().sent.length, before, 'nothing queued either — the handshake carries the size')
})

test('state changes are reported for the connection indicator', () => {
  const { c, events, sock } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  sock().drop()
  assert.deepEqual(events.state, ['connecting', 'connected', 'disconnected'])
})

test('resize sends the new size and remembers it for the next reconnect', () => {
  const { c, sock, timers, flush } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  flush()                            // drain the attach nudge
  c.resize(120, 40)
  assert.deepEqual(JSON.parse(text(sock().sent.at(-1)).slice(1)), { columns: 120, rows: 40 })

  sock().drop()
  timers.shift().fn()
  sock().open()
  assert.deepEqual(JSON.parse(text(sock().sent[0])), { AuthToken: '', columns: 120, rows: 40 })
})
