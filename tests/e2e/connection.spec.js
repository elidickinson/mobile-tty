// Losing and regaining the socket, and picking up a new build.
import { test, expect } from '@playwright/test'
import { spySocket, sentFrames, ready } from './helpers.js'

test('reconnect keeps the screen up, and gets a live one back', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('marker')
  await expect(page.locator('#screen')).toContainText('> marker')

  await spySocket(page)

  // The socket dies but the terminal object outlives it, so the stale screen
  // stays up instead of blanking.
  await page.evaluate(() => window.mtty.conn.ws.close())
  await expect(page.locator('#screen')).toContainText('> marker')

  // What matters is a correct screen afterwards, however it arrives. Here the
  // far side paints by itself, so no nudge is sent — resizing something that is
  // already drawing is what desynchronises its parser.
  await expect(page.locator('#screen')).toContainText('fake-pi ready', { timeout: 15_000 })
  const resizes = (await sentFrames(page)).filter(x => x[0] === '1')
  expect(resizes).toHaveLength(0)

  await page.locator('#screen textarea').pressSequentially('again')
  await expect(page.locator('#screen')).toContainText('> again')
})

test('a current build does not reload, and a newer one is fetched past the cache', async ({ page }) => {
  await ready(page)
  expect(await page.evaluate(() => document.querySelector('meta[name=build]').content)).toMatch(/^[0-9a-z]+$/)

  // Same build served: it must sit still, or a stale cache becomes a loop.
  await page.evaluate(() => window.mtty.checkForNewBuild())
  await page.waitForTimeout(500)
  expect(new URL(page.url()).search).toBe('')

  // Newer build served: go to a URL the cache cannot answer from. `location.reload()`
  // is routinely handed the same stale document, which is why this is a navigation.
  await page.route(page.url(), route =>
    route.fulfill({ contentType: 'text/html', body: '<meta name="build" content="zzz9">' }))
  await Promise.all([
    page.waitForURL(/\?b=zzz9$/),
    page.evaluate(() => window.mtty.checkForNewBuild()),
  ])
})
test('the menu can reload the app, since standalone has no browser chrome', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()

  const navigated = page.waitForNavigation()
  await page.getByRole('button', { name: 'Reload app' }).tap()
  await navigated

  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})

test('a startup failure is reported on screen, not swallowed', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#diag-overlay')).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom', lineno: 42, colno: 7 })))
  await expect(page.locator('#diag-overlay')).toBeVisible()
  await expect(page.locator('#diag-overlay')).toContainText('ERROR — boom')
  await expect(page.locator('#diag-overlay')).toContainText('insets')
})

test('Reconnect before the socket exists does not fault', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: 'Reconnect' }).tap()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect(page.locator('#diag-overlay')).toBeHidden()
})

test('losing the connection is visible without opening anything', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#conn')).toBeHidden()

  // A frozen terminal otherwise looks exactly like a busy one.
  await page.evaluate(() => window.mtty.conn.ws.close())
  await expect(page.locator('#conn')).toBeVisible()
  expect(await page.locator('#conn').getAttribute('aria-label')).toMatch(/disconnected|connecting/)

  await expect(page.locator('#conn')).toBeHidden({ timeout: 10_000 })
})
