// Shared setup for the e2e specs: page readiness, socket spying, and the
// scroll measurements that need a settled baseline.
import { expect } from '@playwright/test'

export const screenText = page => page.locator('#screen').innerText()

/** Rows of the live grid, excluding the scrollback rendered above it. */
export const liveRows = page => page.locator('#screen .term-row:not(.term-scrollback-row)')

/** Record every frame the client puts on the wire, decoded. */
export const spySocket = page => page.evaluate(() => {
  window.__sent = []
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { window.__sent.push(new TextDecoder().decode(d)); return send.call(this, d) }
})
export const sentFrames = page => page.evaluate(() => window.__sent)
export const ready = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect.poll(() => page.evaluate(() => Boolean(window.mtty?.term?.bridge))).toBe(true)
}

export const scrollTop = page => page.evaluate(() => document.getElementById('screen').scrollTop)

export const distanceFromBottom = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  return s.scrollHeight - s.scrollTop - s.clientHeight
})

// The view stays pinned to the bottom while wterm renders, so scrollTop climbs
// until the content stops growing. Every scroll assertion needs that baseline.
export const settled = async page => {
  let last = -1
  await expect.poll(async () => {
    const now = await scrollTop(page)
    const stable = now === last
    last = now
    return stable
  }, { intervals: Array(14).fill(150) }).toBe(true)
  return last
}

export const scrollbackCount = page => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount())

// Push real history above the fold. `/lines` makes the fixture scroll a fixed
// block off the top, so the depth does not depend on the grid or on how many
// keystrokes survive a busy machine.
export const fillScrollback = async page => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines')
  await ta.press('Enter')
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(10)
  return settled(page)
}
