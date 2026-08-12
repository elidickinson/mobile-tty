// The check standing between a hostile tab and a shell: a WebSocket handshake
// ignores the same-origin policy, so any page you visit can open one to a
// terminal on loopback.
import test from 'node:test'
import assert from 'node:assert/strict'
import { originAllowed } from '../../server/origin.js'

const check = (origin, host, hostname) => originAllowed({ origin, host, hostname })

test('a viewer loaded from the address it connects to is allowed', () => {
  assert.ok(check('http://127.0.0.1:7681', '127.0.0.1:7681'))
  assert.ok(check('http://localhost:7681', 'localhost:7681'))
  assert.ok(check('http://[::1]:7681', '[::1]:7681'))
  assert.ok(check('http://192.168.1.4:7681', '192.168.1.4:7681'), '--lan')
})

test('a page on another site is refused', () => {
  assert.ok(!check('http://evil.example', '127.0.0.1:7681'))
  assert.ok(!check('http://127.0.0.1:9999', '127.0.0.1:7681'), 'another port is another origin')
  assert.ok(!check('null', '127.0.0.1:7681'), 'a sandboxed iframe')
})

test('a rebound name is refused even though its Origin matches its Host', () => {
  // Both headers agree here — the attacker owns the name and pointed it at this
  // machine — so agreement is exactly what cannot be the test.
  assert.ok(!check('http://evil.example', 'evil.example'))
})

test('a proxy is trusted only under the name it was declared with', () => {
  assert.ok(check('https://pi.example.com', 'pi.example.com', 'pi.example.com'))
  assert.ok(!check('https://pi.example.com', 'pi.example.com'), 'undeclared')
  assert.ok(!check('https://evil.example', 'evil.example', 'pi.example.com'))
})

test('no Origin means no browser, which is attach and the tests', () => {
  assert.ok(check(undefined, '127.0.0.1:7681'))
})
