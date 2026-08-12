// The password is only worth anything if the cookie it mints reaches the
// WebSocket handshake, which is the thing basic auth cannot do.
import { test, expect } from './helpers.js'

test.use({ password: 'hunter2' })

const submit = async (page, password) => {
  await page.fill('input[name=password]', password)
  await page.click('button[type=submit]')
}

test('the terminal is behind the login, and the cookie carries onto the socket', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#screen')).toHaveCount(0)

  await submit(page, 'wrong')
  await expect(page.locator('p')).toHaveText('Not that one.')

  await submit(page, 'hunter2')
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})
