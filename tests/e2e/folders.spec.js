// The folder picker. It is the one control here that ends the program you are
// looking at, so what matters is that it never does so on a single stray tap,
// and that when it does act it lands somewhere real.
import { rm } from 'node:fs/promises'
import { test, expect, ready } from './helpers.js'

test.use({ folders: ['alpha', 'beta'] })

const openMenu = async page => {
  await page.locator('#keys button[aria-label="menu"]').click()
  await expect(page.locator('#menu')).toBeVisible()
}

const rows = page => page.locator('#places .place')

test('the menu lists the folders pi has history in, and says which is current', async ({ page }) => {
  await ready(page)
  await openMenu(page)

  await expect.poll(async () => (await page.locator('#places .place-name').allInnerTexts()).sort())
    .toEqual(['alpha', 'beta', 'mobile-tty'])
  // The folder the server started in is offered even with no history of its own.
  await expect(page.locator('#places .place.here .place-name')).toHaveText('mobile-tty')
  await expect(page.locator('#place-now')).toContainText('mobile-tty')
})

test('a row asks before it acts: one tap opens the choice, it does not switch', async ({ page }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(3)

  const alpha = rows(page).filter({ hasText: 'alpha' })
  await expect(alpha.locator('.place-actions')).toBeHidden()

  await alpha.locator('.place-head').click()
  await expect(alpha.locator('.place-actions')).toBeVisible()
  // fake-pi.sh is not pi, so continuing is not offered for it.
  await expect(alpha.locator('.place-actions button')).toHaveText(['Start here'])

  // Nothing was ended by looking.
  await expect(page.locator('#menu')).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')

  // Only one folder is ever asking to be chosen.
  await rows(page).filter({ hasText: 'beta' }).locator('.place-head').click()
  await expect(alpha.locator('.place-actions')).toBeHidden()
})

test('a switch that never lands leaves the menu open and says nothing came back', async ({ page, store }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(3)

  // The folder goes away after the list was built. That is the stale-list race
  // made deterministic: the server will refuse a folder it can no longer offer,
  // and a refusal is silent on the wire — the phone has only the absence of an
  // acknowledgement to go on, which is the whole point of waiting for one.
  await rm(store.at('alpha'), { recursive: true, force: true })

  const alpha = rows(page).filter({ hasText: 'alpha' })
  await alpha.locator('.place-head').click()
  await alpha.getByText('Start here').click()

  await expect(alpha).toHaveClass(/switching/)
  await expect(alpha).toHaveClass(/failed/, { timeout: 10_000 })
  // Still open, still the program that was already running.
  await expect(page.locator('#menu')).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})

test('choosing a folder starts the program there', async ({ page }) => {
  await ready(page)
  await openMenu(page)
  await expect.poll(() => rows(page).count()).toBe(3)

  const alpha = rows(page).filter({ hasText: 'alpha' })
  await alpha.locator('.place-head').click()
  await alpha.getByText('Start here').click()

  await expect(page.locator('#menu')).toBeHidden()
  // The title is the server's word for which folder the session is in.
  await expect.poll(() => page.title()).toContain('/alpha')
  // And the program really is over there: the fixture draws its own cwd, which
  // wraps at this width, so the comparison ignores where the rows break.
  await expect.poll(async () =>
    (await page.locator('#screen').innerText()).replace(/\s+/g, '')).toContain('/alpha')
})
