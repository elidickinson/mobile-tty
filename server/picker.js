// Furniture the terminal clients share for choosing a session: how a row is
// written, how a name-or-path fragment matches one, and the paged numbered
// prompt. The list this shows is exactly what the phone's menu shows, since
// both read `GET /places`.
import { createInterface } from 'node:readline/promises'

// A url the supervisor answers over http: the same endpoint is reached by ws,
// wss, http and https depending on how the caller was told about it.
export const baseUrl = url => {
  const target = new URL(url)
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  return target
}

// How many rows one page shows. Everything past it is one `more` away rather
// than one long wall of text.
export const PICK_ROWS = 10

/** One question on the terminal. Ctrl-C answers with a blank rather than
 *  the unhandled AbortError readline raises: a prompt you get out of is a
 *  prompt that heard "no", which a blank already means to every caller. */
export const ask = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return await rl.question(question) }
  catch (err) { if (err.code === 'ABORT_ERR') return ''; throw err }
  finally { rl.close() }
}

/** `3m`, `2h`, `5d` — the same reading of last-active the menu shows. */
export const ago = at => {
  if (!at) return ''
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${s / 60 | 0}m`
  if (s < 86400) return `${s / 3600 | 0}h`
  return `${s / 86400 | 0}d`
}

/** One row of any listing: numbered when given an index, marked ● when the
 *  session is running, with its viewer count when available. */
export const placeRow = (s, i) =>
  `  ${i ? `${i}) ` : '   '}${s.running ? '●' : ' '} ${(s.label || s.name).slice(0, 60).padEnd(60)}  ${s.path}` +
  (s.viewers == null ? '' : `  ${s.viewers} watching`) +
  (s.unread ? ' unread' : '') +
  `  ${ago(s.at)}`

/** The rows a name-or-path fragment picks out. Empty string matches nothing
 *  rather than everything: a filter that means "all" is spelled by leaving
 *  the argument off, not by passing a blank one. */
export const matching = (sessions, fragment) =>
  fragment
    ? sessions.filter(s => `${s.label || ''} ${s.name} ${s.path} ${s.id}`.toLowerCase().includes(fragment.toLowerCase()))
    : []

/** Bare decimal digit strings are indices; other numeric literals are invalid,
 *  and nonnumeric text remains a fragment. Zero is parsed for caller validation. */
export const indexArgument = arg => {
  if (typeof arg !== 'string') return null
  if (/^\d+$/.test(arg)) return Number(arg)
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(arg) ? Number.NaN : null
}

/**
 * The one running session to act on: a bare number over the list as given, a
 * fragment naming exactly one, the only row there is, or a numbered prompt
 * when none of those answers it. Says why when there is no match at all.
 */
export const pickTarget = async (rows, match, prompt = 'which session?') => {
  const index = indexArgument(match)
  if (index !== null) {
    if (!Number.isSafeInteger(index) || index < 1 || index > rows.length) {
      console.error(`no running session numbered ${match}`)
      return null
    }
    return rows[index - 1]
  }
  if (match) {
    const hits = matching(rows, match)
    if (hits.length === 1) return hits[0]
    if (hits.length === 0) {
      console.error(`nothing running matches ${JSON.stringify(match)}`)
      return null
    }
    console.error('more than one matches:')
    return await pickFrom(hits, { ask, out: console.error })
  }
  if (rows.length === 1) return rows[0]
  console.error(prompt)
  return await pickFrom(rows, { ask, out: console.error })
}

/**
 * The move a full pool forces: end one running session so the refused action
 * can go through. Offers what is up in the order the server gives them up,
 * confirms the choice, and asks for it to be ended. True once a terminal is
 * gone, false when nothing was picked, confirmed or ended.
 */
export const endOne = async (url, headers, confirm = ask) => {
  const res = await fetch(new URL('/places?running=1', baseUrl(url)), { headers }).catch(() => null)
  if (!res) {
    console.error('could not reach the server')
    return false
  }
  if (!res.ok) {
    console.error(`could not list sessions (HTTP ${res.status})`)
    return false
  }
  const { sessions } = await res.json()
  if (sessions.length === 0) {
    console.error('nothing is running to end')
    return false
  }
  const target = await pickTarget(sessions, null, 'which session to end?')
  if (!target) {
    console.error('left it running')
    return false
  }
  const answer = (await confirm(`end "${target.label || target.name}"? [y/N] `)).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes') {
    console.error('left it running')
    return false
  }
  const del = await fetch(new URL(`/terminal?process=${encodeURIComponent(target.processId)}`, baseUrl(url)), {
    method: 'DELETE',
    headers,
  }).catch(() => null)
  if (!del) {
    console.error('could not reach the server')
    return false
  }
  if (!del.ok && del.status !== 404) {
    console.error(`could not end it (HTTP ${del.status})`)
    return false
  }
  console.error(`ended: ${target.label || target.name}`)
  return true
}

/**
 * The numbered prompt, ten rows at a time. Numbers stay global across pages,
 * so `7` means the same thing however many `more`s came before it. Answers:
 * a number on the list, `more` for the next page, anything else a refusal.
 * Returns the chosen session, or null when the answer was none of these.
 */
export const pickFrom = async (candidates, { ask, out }) => {
  let from = 0
  for (;;) {
    const page = candidates.slice(from, from + PICK_ROWS)
    page.forEach((s, k) => out(placeRow(s, from + k + 1)))
    const more = candidates.length - from - page.length
    if (more > 0) out(`  ... ${more} more (type 'more' to continue)`)
    const answer = (await ask('> ')).trim()
    if (answer === 'more') {
      if (more === 0) { out('no more sessions'); return null }
      from += page.length
      continue
    }
    const pick = Number(answer)
    const choice = Number.isInteger(pick) ? candidates[pick - 1] : undefined
    if (!choice) { out('no such number on the list'); return null }
    return choice
  }
}
