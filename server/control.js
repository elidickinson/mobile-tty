// `mobile-tty sessions` and `mobile-tty end`: read the supervisor's list and
// act on it, over the same login the phone and attach use. A server that is
// not answering is an answer, not an error: say how to start one and leave.

import { createInterface } from 'node:readline/promises'
import { matching, pickFrom, placeRow } from './picker.js'

const baseUrl = url => {
  const target = new URL(url)
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  return target
}

const login = async (url, password) => {
  const response = await fetch(new URL('/login', baseUrl(url)), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  }).catch(() => null)
  if (!response) return null
  const [cookie] = response.headers.getSetCookie()
  if (!cookie) {
    console.error('mobile-tty: $MTTY_PASSWORD was refused')
    return false
  }
  return cookie.split(';')[0]
}

/** The listed sessions and request headers, or null when no server answers. */
const reach = async url => {
  const password = process.env.MTTY_PASSWORD
  const cookie = password ? await login(url, password) : undefined
  if (cookie === null) return null
  if (cookie === false) return { error: true }
  const headers = cookie ? { cookie } : undefined
  const res = await fetch(new URL('/places', baseUrl(url)), { headers }).catch(() => null)
  if (!res) return null
  if (!res.ok) return { status: res.status }
  return { data: await res.json(), headers }
}

/** One question on the terminal, like attach's. */
const ask = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return await rl.question(question) } finally { rl.close() }
}

/** `mobile-tty sessions` — every session the server lists, with ● and a count. */
/** `mobile-tty sessions` — the sessions actually running, with ● and a count.
 *  Transcript history is the picker's business; this is what is live now. */
export async function sessions(url) {
  const result = await reach(url)
  if (!result) return noServer(url)
  if (result.error) return
  if (result.status) return console.error(`could not list sessions (HTTP ${result.status})`)
  const live = result.data.sessions.filter(s => s.running)
  if (live.length === 0) return console.error('nothing is running')
  live.forEach((s, i) => console.log(placeRow(s, i + 1)))
}

/** `mobile-tty end [fragment]` — end a running session for good, confirmed once. */
export async function end(url, { match, yes = false }) {
  const result = await reach(url)
  if (!result) return noServer(url)
  if (result.error) return
  if (result.status) return console.error(`could not list sessions (HTTP ${result.status})`)
  const { data, headers } = result
  const running = data.sessions.filter(s => s.running)
  if (running.length === 0) return console.error('nothing is running')

  let target
  if (match) {
    const hits = matching(running, match)
    if (hits.length === 1) target = hits[0]
    else if (hits.length === 0) {
      console.error(`nothing running matches ${JSON.stringify(match)}`)
      return
    } else {
      console.error('more than one matches:')
      target = await pickFrom(hits, { ask, out: console.error })
    }
  } else if (running.length === 1) {
    target = running[0]
  } else {
    console.error('which session?')
    target = await pickFrom(running, { ask, out: console.error })
  }
  if (!target) return

  if (!yes) {
    const answer = (await ask(`end "${target.label || target.name}"? [y/N] `)).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') return console.error('left it running')
  }
  const res = await fetch(new URL(`/session?id=${encodeURIComponent(target.id)}`, baseUrl(url)), {
    method: 'DELETE',
    headers,
  })
  console.error(res.ok ? `ended: ${target.label || target.name}` : `could not end it (HTTP ${res.status})`)
}

const noServer = url => console.error(`server not started; run mobile-tty serve (connects to ${url})`)
