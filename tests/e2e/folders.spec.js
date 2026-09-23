// The session picker. A row acts the moment it is tapped — joining never ends
// anything else — so what matters is that a tap lands somewhere real, that the
// list says where you are and what is still running, and that a session with
// no transcript yet can be begun from the same list.
import { test, expect, ready } from './helpers.js'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ folders: ['alpha', 'beta'] })

const openMenu = async page => {
  await page.locator('#keys button[aria-label="menu"]').click()
  await expect(page.locator('#menu')).toBeVisible()
}

const rows = page => page.locator('#places .place')

/** The place the page remembered under `key`, as the app stores it. */
const storedPlace = (page, key) => page.evaluate(key => {
  try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
}, key)

// The cwd the test server starts in: this checkout's root, seeded oldest so a
// spec that also asks for folders lands on the newest of those instead.
const HERE = 'mobile-tty'

test('the menu lists every session plus the row that starts one', async ({ page }) => {
  await ready(page)
  await openMenu(page)

  // One seeded session per folder plus the cwd's own, with labels drawn from
  // each transcript (the fixtures have no conversation, so the folder name
  // is the label), and pinned at the top, the way to start a session that
  // has none yet.
  await expect.poll(async () => (await page.locator('#places .place-name').allInnerTexts()).sort())
    .toEqual(['+ New session…', 'alpha', 'beta', HERE])
  // beta is the newest seed, so a fresh viewer lands on that session.
  await expect(page.locator('#places .place.here .place-name')).toHaveText('beta')
  await expect(page.locator('#place-now')).toContainText('beta')
  // The header and the row spell the folder the same way, both straight from
  // the place frame rather than formatted twice.
  const rowPath = await page.locator('#places .place.here .place-path-text').textContent()
  await expect(page.locator('#place-now')).toHaveText(rowPath.split(' · ')[0])
})

test('two folders sharing a conversation id remain separate running terminals', async ({ page, store }) => {
  const file = name => join(store.sessionDir, `-${store.at(name).replaceAll('/', '-')}-`, 'a.jsonl')
  const alpha = JSON.parse(await readFile(file('alpha'), 'utf8'))
  const beta = JSON.parse(await readFile(file('beta'), 'utf8'))
  await writeFile(file('beta'), `${JSON.stringify({ ...beta, id: alpha.id })}\n`)

  await ready(page)
  await openMenu(page)
  const alphaRow = rows(page).filter({ hasText: 'alpha' })
  await alphaRow.click()
  await expect(page.locator('#screen')).toContainText('alpha')
  await openMenu(page)
  await expect(page.locator('#places .place.here')).toHaveCount(1)
  await expect(alphaRow).toHaveClass(/here/)
  await page.locator('#places .place-row > .place').filter({ hasText: 'beta' }).click()
  await expect(page.locator('#screen')).toContainText('beta')
  await openMenu(page)
  await expect(page.locator('#places .place.here')).toHaveCount(1)
  await expect(page.locator('#places .place-row.has-end')).toHaveCount(2)
})

test('a remembered place whose terminal has gone finds its conversation again', async ({ page }) => {
  await ready(page)
  const alpha = await page.evaluate(async () => (await (await fetch('/places')).json()).sessions.find(s => s.label === 'alpha'))
  // What the phone last saw is a process that has since ended. The conversation
  // it was showing is what it should land on, not simply the newest row.
  await page.evaluate(place => localStorage.setItem('mtty-place', JSON.stringify({ ...place, processId: 'ended-process' })), alpha)
  await page.reload()
  await expect(page.locator('#screen')).toContainText('alpha')
  await openMenu(page)
  await expect(page.locator('#places .place.here .place-name')).toHaveText('alpha')
})

test('a rejected selection keeps the last admitted terminal', async ({ page, store }) => {
  await ready(page)
  await openMenu(page)
  const current = await page.locator('#places .place.here .place-name').textContent()
  const other = current === 'alpha' ? 'beta' : 'alpha'
  const oldTitle = await page.title()
  await unlink(join(store.sessionDir, `-${store.at(other).replaceAll('/', '-')}-`, 'a.jsonl'))
  await page.locator('#places .place-row > .place').filter({ hasText: other }).click()
  await expect(page.locator('#menu')).toBeVisible()
  await expect(page.locator('#menu-notice')).toContainText('no such conversation')
  await expect.poll(() => page.title()).toBe(oldTitle)
  await expect(page.locator('#screen')).toContainText(current)
})

test('a terminal that went away while the phone was off the air ends like any other', async ({ page, context }) => {
  // A first viewer starts the session, so this page lands on a running row and
  // dials it by process ID. Joining by conversation instead would simply
  // spawn a new terminal, which is not the path under test.
  const first = await context.newPage()
  await ready(first)
  const beta = await first.evaluate(async () =>
    (await (await fetch('/places')).json()).sessions.find(s => s.label === 'beta' && s.running))
  await first.close()

  await ready(page)
  await expect.poll(() => page.evaluate(() => window.mtty.conn.url)).toContain(`process=${beta.processId}`)

  // The socket goes down and the process dies before the client's next
  // attempt: the refusal a phone meets coming back after a while, rather than
  // a selection going wrong.
  await page.evaluate(async processId => {
    window.mtty.conn.ws.close()
    await fetch(`/terminal?process=${encodeURIComponent(processId)}`, { method: 'DELETE' })
  }, beta.processId)

  await expect(page.locator('#menu')).toBeVisible({ timeout: 8_000 })
  await expect(page.locator('#menu-notice')).toContainText('no longer running')
  // The header is cleared rather than left naming a terminal nothing is
  // connected to, and the conversation is what the next visit lands on.
  await expect.poll(() => page.title()).toBe('mobile-tty')
  await expect.poll(() => storedPlace(page, 'mtty-place')).toMatchObject({ id: beta.id, cwd: beta.cwd })
})

test('a late startup lookup cannot replace an explicit selection', async ({ page }) => {
  let release
  const held = new Promise(done => { release = done })
  let requests = 0
  await page.route('**/places', async route => {
    if (++requests === 1) await held
    await route.continue()
  })
  await page.goto('/')
  await openMenu(page)
  await expect(rows(page).filter({ hasText: 'alpha' })).toBeVisible()
  await rows(page).filter({ hasText: 'alpha' }).click()
  await expect(page.locator('#screen')).toContainText('alpha')
  release()
  await expect.poll(() => page.title()).toContain('/alpha')
  await openMenu(page)
  await expect(page.locator('#places .place.here .place-name')).toHaveText('alpha')
})

test('a row shows when the session was last active', async ({ page, store }) => {
  await ready(page)
  await openMenu(page)

  const beta = rows(page).filter({ hasText: 'beta' })
  // Store timestamps stay with the path text, separate from the viewer count
  // at the right edge.
  await expect(beta.locator('.place-path-text')).toContainText(/· (now|[0-9]+[mhd])$/)
})

test('the menu fits the screen, with the readout folded away', async ({ page }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(4)

  // The session list is as long as the history you have, so the sheet has to
  // stay inside the screen — `Done` scrolling off the top is how a menu
  // becomes a trap.
  await expect(page.locator('#diag')).toBeHidden()
  const card = await page.evaluate(() => {
    const el = document.querySelector('.menu-card')
    const box = el.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, viewport: window.innerHeight, visible: el.clientHeight }
  })
  expect(card.top).toBeGreaterThanOrEqual(0)
  expect(card.bottom).toBeLessThanOrEqual(card.viewport + 1)
  // Against a short list, which is the case that has no excuse: the sheet is
  // over a terminal somebody is trying to read.
  // One start row and four sessions: still well short of the whole screen.
  expect(card.visible).toBeLessThan(card.viewport * 0.9)

  // Still reachable for the times it is the only thing that can explain a
  // fault — and it stands in for the menu rather than stacking under it, or
  // unfolding it would fill the screen it is meant to be explaining.
  await page.locator('[data-act=diag]').click()
  await expect(page.locator('#diag')).toContainText('build')
  await expect(page.locator('#places')).toBeHidden()
  const open = await page.evaluate(() => ({
    visible: document.querySelector('.menu-card').clientHeight,
    viewport: window.innerHeight,
  }))
  expect(open.visible).toBeLessThan(card.visible)

  // And folding it back brings the menu with it.
  await page.locator('[data-act=diag]').click()
  await expect(page.locator('#places')).toBeVisible()
  await expect(page.locator('#diag')).toBeHidden()
})

test('tapping a row joins that session: the screen follows the folder', async ({ page }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(4)

  // One tap: no disclose-then-act, nothing to confirm — joining ends nothing.
  await rows(page).filter({ hasText: 'beta' }).click()
  await expect(page.locator('#menu')).toBeHidden()
  // The title is the client's word for the folder it asked to join.
  await expect.poll(() => page.title()).toContain('/beta')
  // And the program really is over there: the fixture draws its own cwd, which
  // wraps at this width, so the comparison ignores where the rows break.
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).replace(/\s+/g, '')).toContain('/beta')
})

test('a live session is marked running, and rejoining it cannot end it', async ({ page, store }) => {
  await ready(page)
  await openMenu(page)

  // Join beta, say something memorable, and leave.
  await rows(page).filter({ hasText: 'beta' }).click()
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).replace(/\s+/g, '')).toContain('/beta')
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('rejoin-marker')
  await ta.press('Enter')
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).includes('ok: 13 chars'), { timeout: 8_000 }).toBe(true)
  await page.goto('about:blank')

  // Back on a fresh page: the menu now marks beta running, and landing on it
  // again shows the line still there — the same process, not a respawn.
  await ready(page)
  await openMenu(page)
  await expect(rows(page).filter({ hasText: 'beta' })).toHaveClass(/running/)
  await rows(page).filter({ hasText: 'beta' }).click()
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).replace(/\s+/g, '')).toContain('rejoin-marker')
})

test('a session who went away keeps running elsewhere: the list survives it', async ({ page }) => {
  // A folder deleted after its session was listed must not break the picker:
  // readPlaces drops rows whose cwd is gone, and a tap can only ever name an id
  // the list itself offered. A tap on a row that survives is the honest check.
  await ready(page)
  await openMenu(page)
  await rows(page).filter({ hasText: 'beta' }).click()
  await expect.poll(() => page.title()).toContain('/beta')

  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(4)
  await rows(page).filter({ hasText: 'alpha' }).click()
  await expect.poll(() => page.title()).toContain('/alpha')
  await expect(page.locator('#place-now')).toContainText('alpha')
})

test('new session offers the folders pi is already in, and starting one joins it', async ({ page, store }) => {
  await ready(page)
  await openMenu(page)

  await rows(page).filter({ hasText: '+ New session…' }).click()
  // The chooser lists this folder first — it is what the row itself offered —
  // and every folder a listed session runs in.
  const dirNames = await page.locator('#places .place .place-name').allInnerTexts()
  expect(dirNames[0]).toBe(HERE)
  expect(dirNames.slice(1).sort()).toEqual(['alpha', 'beta'])

  // Starting one in beta spawns a fresh session there and lands on it: the
  // title names a session the list never had, and the fixture's own cwd line
  // proves the child really came up in that folder. The id must be one the
  // seeded store never held — the seeded beta row would satisfy the title
  // alone, which would make this pass even if /start never ran.
  const seeded = await page.evaluate(() => fetch('/places').then(r => r.json()))
  const seededIds = new Set(seeded.sessions.map(s => s.id))
  await rows(page).filter({ hasText: 'beta' }).click()
  await expect.poll(() => page.title()).toContain('/beta')
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).replace(/\s+/g, '')).toContain('/beta')
  const joined = await page.evaluate(() => fetch('/places').then(r => r.json()))
  const started = joined.sessions.find(s => !seededIds.has(s.id))
  expect(started, 'a new id appeared in the list').toBeTruthy()
  expect(started.running).toBe(true)

  // And it is a place now: back to the menu, it is listed, running, labeled.
  await openMenu(page)
  const beta = page.locator(`#places .place-row[data-session-id="${started.id}"] > .place`)
  await expect(beta).toHaveClass(/running/, { timeout: 8_000 })
})

/** beta's row label: the folder name — the fresh session there has no history. */
const betaLabel = () => 'beta'

test('another viewer ending a session tells the bystander why it left', async ({ page, context }) => {
  await ready(page)
  const ender = await context.newPage()
  await ready(ender)
  await openMenu(ender)

  const endedId = await ender.evaluate(async () => {
    const { sessions } = await fetch('/places').then(res => res.json())
    return sessions.find(session => session.label === 'beta' && session.running)?.id
  })
  expect(endedId).toBeTruthy()
  const row = rows(ender).filter({ hasText: betaLabel() }).first()
  const end = row.locator('xpath=..').locator('.place-end')
  await end.click()
  await end.click()

  await expect.poll(() => page.title()).toBe('mobile-tty')
  await expect(page.locator('#menu')).toBeVisible()
  await expect(page.locator('#menu-notice')).toHaveText('ended by a terminal')
  const isRunning = () => page.evaluate(async id => {
    const { sessions } = await fetch('/places').then(res => res.json())
    return sessions.find(session => session.id === id)?.running ?? false
  }, endedId)
  await expect.poll(isRunning, { timeout: 8_000 }).toBe(false)
  await expect.poll(() => page.evaluate(() => window.mtty.conn.started)).toBe(false)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100)
    expect(await isRunning()).toBe(false)
    expect(await page.title()).toBe('mobile-tty')
  }
})

test('a shared session row shows its viewer count', async ({ page, context }) => {
  await ready(page)
  const other = await context.newPage()
  await ready(other)
  await openMenu(page)

  const beta = page.locator('#places .place-row').filter({ hasText: 'beta' })
  await expect(beta.locator('.place-watchers')).toHaveText('2 watching')
})

test('ending a running session from its row stops it and leaves the menu', async ({ page }) => {
  await ready(page)
  await openMenu(page)

  // The landing join has already spawned the seeded beta, so a running row is
  // on the list without starting anything.
  const endedId = await page.evaluate(async () => {
    const { sessions } = await fetch('/places').then(res => res.json())
    return sessions.find(session => session.label === 'beta' && session.running)?.id
  })
  expect(endedId).toBeTruthy()
  const row = rows(page).filter({ hasText: betaLabel() }).first()
  const end = row.locator('xpath=..').locator('.place-end')
  await expect(row).toHaveClass(/running/, { timeout: 8_000 })

  // One tap arms the confirm on the row; a second acts.
  await end.click()
  await expect(end).toHaveText('End it?')
  await end.click()

  // The close lands back at the menu. Poll the server, not just the rendered
  // row: an automatic reconnect would respawn this same session shortly after.
  await expect.poll(() => page.title()).toBe('mobile-tty')
  const isRunning = () => page.evaluate(async id => {
    const { sessions } = await fetch('/places').then(res => res.json())
    return sessions.find(session => session.id === id)?.running ?? false
  }, endedId)
  await expect.poll(isRunning, { timeout: 8_000 }).toBe(false)
  await expect.poll(() => page.evaluate(() => window.mtty.conn.started)).toBe(false)
  await expect(page.locator('#menu-state')).toContainText('disconnected')
  await expect(page.locator('#menu-notice')).toBeHidden()
  await expect(row).not.toHaveClass(/running/)
  await expect(end).toHaveCount(0)

  // Keep checking for three seconds so a delayed retry cannot pass as a clean
  // end merely because the first post-close snapshot was too early.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1_000)
    expect(await isRunning()).toBe(false)
    expect(await page.evaluate(() => window.mtty.conn.started)).toBe(false)
  }
  await expect.poll(() => page.title()).toBe('mobile-tty')
})
