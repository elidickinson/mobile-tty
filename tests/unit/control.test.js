// `mobile-tty new`: the caller's cwd reaches POST /start, and the started
// session comes back as what attach needs. fetch is the external boundary —
// everything else here is real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { start } from '../../server/control.js'

const intercept = calls => async (input, init = {}) => {
  const url = String(input instanceof URL ? input : input.url ?? input)
  if (url.endsWith('/places')) {
    return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
  }
  if (url.endsWith('/start')) {
    calls.push({ url, method: 'POST', headers: init.headers, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ id: 'fresh-id' }) }
  }
  throw new Error(`unexpected fetch ${url}`)
}

test('start posts the caller folder and returns what attach needs', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  const realPassword = process.env.MTTY_PASSWORD
  delete process.env.MTTY_PASSWORD
  globalThis.fetch = intercept(calls)
  try {
    const result = await start('ws://127.0.0.1:7681', { cwd: '/work/here' })
    assert.deepEqual(calls, [{
      url: 'http://127.0.0.1:7681/start',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { cwd: '/work/here' },
    }])
    assert.deepEqual(result, { id: 'fresh-id', wsUrl: 'http://127.0.0.1:7681/ws' })
  } finally {
    globalThis.fetch = realFetch
    if (realPassword !== undefined) process.env.MTTY_PASSWORD = realPassword
  }
})
test('start says plainly that the folder does not exist', async () => {
  const realFetch = globalThis.fetch
  const realPassword = process.env.MTTY_PASSWORD
  delete process.env.MTTY_PASSWORD
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : input.url ?? input)
    if (url.endsWith('/places')) {
      return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
    }
    return { ok: false, status: 422, json: async () => ({}) }
  }
  const said = []
  const realError = console.error
  // Block body: the real console.error returns undefined, and start's
  // refusals return whatever console.error returned.
  console.error = line => { said.push(line) }
  try {
    assert.equal(await start('ws://127.0.0.1:7681', { cwd: '/gone' }), undefined)
    assert.deepEqual(said, ['new: no such directory: /gone'])
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
    if (realPassword !== undefined) process.env.MTTY_PASSWORD = realPassword
  }
})
test('start returns nothing when no server answers, so nothing attaches', async () => {
  const realFetch = globalThis.fetch
  const realPassword = process.env.MTTY_PASSWORD
  delete process.env.MTTY_PASSWORD
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const said = []
  const realError = console.error
  console.error = line => { said.push(line) }
  try {
    assert.equal(await start('ws://127.0.0.1:7681', { cwd: '/work/here' }), undefined)
    assert.deepEqual(said, ['server not started; run mobile-tty serve (connects to ws://127.0.0.1:7681)'])
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
    if (realPassword !== undefined) process.env.MTTY_PASSWORD = realPassword
  }
})
