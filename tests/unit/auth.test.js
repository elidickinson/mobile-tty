// The password stands in front of a shell, so the only interesting questions
// are what it lets through and what it hands out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Auth, loginPage, submittedPassword } from '../../server/auth.js'
import { Readable } from 'node:stream'

const withCookie = value => ({ headers: { cookie: value } })

test('no password configured lets everything through, as before', () => {
  const auth = new Auth(undefined)
  assert.equal(auth.required, false)
  assert.ok(auth.admits({ headers: {} }))
})

test('a granted cookie is admitted and nothing else is', () => {
  const auth = new Auth('hunter2')
  const cookie = auth.grant({ secure: false })
  const token = cookie.split(';')[0]

  assert.ok(auth.admits(withCookie(token)))
  assert.ok(auth.admits(withCookie(`other=1; ${token}; more=2`)), 'among other cookies')
  assert.ok(!auth.admits({ headers: {} }))
  assert.ok(!auth.admits(withCookie('mtty=guessed')))
})

test('tokens are per-grant, so one login is not every login', () => {
  const auth = new Auth('hunter2')
  assert.notEqual(auth.grant({ secure: false }), auth.grant({ secure: false }))
})

test('the cookie is scoped so no other site can cause it to be sent', () => {
  const auth = new Auth('hunter2')
  const cookie = auth.grant({ secure: true })
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Secure/)
  assert.doesNotMatch(auth.grant({ secure: false }), /Secure/, 'plain http would refuse it')
})

test('the password itself is checked, not merely its shape', () => {
  const auth = new Auth('hunter2')
  assert.ok(auth.accepts('hunter2'))
  assert.ok(!auth.accepts('hunter3'))
  assert.ok(!auth.accepts(''))
  assert.ok(!auth.accepts('hunter2 '), 'no trimming')
})

test('an oversized login body is not read into memory', async () => {
  const flood = Readable.from(['password=' + 'x'.repeat(4096)])
  assert.equal(await submittedPassword(flood), null)
})

test('the login page carries no client bundle, only a form', () => {
  assert.match(loginPage(), /<form method="post" action="\/login">/)
  assert.doesNotMatch(loginPage(), /<script/)
  assert.match(loginPage(true), /Not that one/)
})
