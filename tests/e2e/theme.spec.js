// The theme follows the server's --theme default, and the menu can flip it per
// device without a restart (which would kill pi). The switch must repaint the
// terminal and the chrome around it, survive a reload, and move the sticky
// marker between the buttons.
import { test, expect, ready } from './helpers.js'

const termColor = page => page.evaluate(() => {
  const s = getComputedStyle(document.getElementById('screen'))
  return {
    bg: s.backgroundColor,
    fg: s.color,
    root: getComputedStyle(document.documentElement).backgroundColor,
    htmlClass: document.documentElement.className,
    themeColor: document.querySelector('meta[name=theme-color]')?.content,
  }
})

const openMenu = page => page.getByRole('button', { name: 'menu' }).tap()

test('the default theme is dark, and the light button flips the whole UI, sticks on reload', async ({ page }) => {
  await ready(page)

  const dark = await termColor(page)
  expect(dark.bg).toBe('rgb(11, 11, 13)')       // --bg
  expect(dark.fg).toBe('rgb(216, 216, 220)')    // --fg
  expect(dark.themeColor).toBe('#0b0b0d')

  await openMenu(page)
  await expect(page.locator('[data-theme="light"]')).toBeVisible()
  // The server default (dark) is the marked choice.
  await expect(page.locator('[data-theme="dark"]')).toHaveClass(/sticky/)
  await page.locator('[data-theme="light"]').tap()

  const light = await termColor(page)
  expect(light.htmlClass).toContain('theme-light')
  expect(light.bg).toBe('rgb(250, 250, 250)')
  expect(light.fg).toBe('rgb(36, 38, 43)')
  expect(light.themeColor).toBe('#fafafa')
  await expect(page.locator('[data-theme="light"]')).toHaveClass(/sticky/)
  await expect(page.locator('[data-theme="dark"]')).not.toHaveClass(/sticky/)

  // The choice is remembered per device, so a reload (which serves the dark
  // default again) still lands light.
  await page.reload()
  await ready(page)
  expect((await termColor(page)).htmlClass).toContain('theme-light')
  expect((await termColor(page)).bg).toBe('rgb(250, 250, 250)')
})
