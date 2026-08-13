// The status strip: the line the mtty-footer extension writes (fake-pi writes
// the same file) is relayed by the server and rendered in its own row, without
// the grid learning about it. The strip is standalone-only, so the test has to
// pretend the page was added to the home screen.
import { test, expect, ready, spySocket, sentFrames } from './helpers.js'

const asStandalone = page => page.addInitScript(() => {
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
})

test('the strip shows the captured line and never resizes the grid', async ({ page }) => {
  await asStandalone(page)
  await ready(page)
  await spySocket(page)

  await expect(page.locator('#strip')).toBeVisible()
  await expect(page.locator('#strip')).toHaveText('fake-pi stats')

  // The strip's row comes out of the terminal box, never the grid: its arrival
  // sent no RESIZE and the wanted grid is untouched.
  const resizes = (await sentFrames(page)).filter(f => f.startsWith('1'))
  expect(resizes).toHaveLength(0)
})
