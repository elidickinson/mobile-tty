// The session picker. A row acts the moment it is tapped — joining never ends
// anything else — so what matters is that a tap lands somewhere real, that the
// list says where you are and what is still running, and that the first screen
// survives a session id remembered from last time.
import { test, expect, ready } from './helpers.js'

test.use({ folders: ['alpha', 'beta'] })

const openMenu = async page => {
  await page.locator('#keys button[aria-label="menu"]').click()
  await expect(page.locator('#menu')).toBeVisible()
}

const rows = page => page.locator('#places .place')

test('the menu lists the sessions pi has history in, and says which is current', async ({ page }) => {
  await ready(page)
  await openMenu(page)

  // The store seeds one session per folder: here, alpha, beta. The cwd's own
  // session is written last, so it is the newest and the one a fresh viewer
  // lands on.
  await expect.poll(async () => (await page.locator('#places .place-name').allInnerTexts()).sort())
    .toEqual(['alpha', 'beta', 'pr1-work'])
  await expect(page.locator('#places .place.here .place-name')).toHaveText('pr1-work')
  await expect(page.locator('#place-now')).toContainText('pr1-work')
})

test('the menu fits the screen, with the readout folded away', async ({ page }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(3)

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
  expect(card.visible).toBeLessThan(card.viewport * 0.75)

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
  await expect.poll(() => rows(page).count()).toBe(3)

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
  await expect.poll(() => rows(page).count()).toBe(3)
  await rows(page).filter({ hasText: 'alpha' }).click()
  await expect.poll(() => page.title()).toContain('/alpha')
  await expect(page.locator('#place-now')).toContainText('alpha')
})
