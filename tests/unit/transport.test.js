// Connection behaviour: handshake, queueing, backoff, and the size the server says it has.
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
  return { c, events, timers, sock: () => FakeSocket.last }
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
  const { c, sock, timers } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
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

test('backoff grows on repeated failure and resets once connected', () => {
  const { c, sock, timers } = setup()
  const retry = () => timers.shift().fn()
  const delays = []
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  sock().drop(); delays.push(timers[0].ms); retry()
  sock().drop(); delays.push(timers[0].ms); retry()
  sock().drop(); delays.push(timers[0].ms); retry()
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1])

  sock().open()
  sock().drop()
  assert.equal(timers[0].ms, delays[0], 'a successful connection resets the backoff')
})

test('state changes are reported for the connection indicator', () => {
  const { c, events, sock } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  sock().drop()
  assert.deepEqual(events.state, ['connecting', 'connected', 'disconnected'])
})

test('resize sends the new size and remembers it for the next reconnect', () => {
  const { c, sock, timers } = setup()
  c.connect({ cols: 50, rows: 30 })
  sock().open()
  c.resize(120, 40)
  assert.deepEqual(JSON.parse(text(sock().sent.at(-1)).slice(1)), { columns: 120, rows: 40 })

  sock().drop()
  timers.shift().fn()
  sock().open()
  assert.deepEqual(JSON.parse(text(sock().sent[0])), { AuthToken: '', columns: 120, rows: 40 })
})

test('a resize while disconnected is remembered, not queued', () => {
  const { c, sock } = setup()
  c.resize(50, 30)                   // the initial fit, before the socket exists
  c.connect({ cols: 50, rows: 30 })
  sock().open()

  assert.equal(sock().sent.map(text).filter(b => b[0] === '1').length, 0, 'no resize frame')
  assert.deepEqual(JSON.parse(text(sock().sent[0])), { AuthToken: '', columns: 50, rows: 30 })
})

test('the grid the server reports is passed on, whatever was asked for', () => {
  const sizes = []
  const { c, sock } = setup({ onSize: s => sizes.push(s) })
  c.connect({ cols: 80, rows: 24 })
  sock().open()
  sock().message([0x33, ...new TextEncoder().encode(JSON.stringify({ columns: 50, rows: 48 }))])

  assert.deepEqual(sizes, [{ cols: 50, rows: 48 }])
})
