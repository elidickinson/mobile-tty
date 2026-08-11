import { test, expect } from '@playwright/test'

const screenText = page => page.locator('#screen').innerText()
const ready = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
}

test('renders the TUI with box drawing intact', async ({ page }) => {
  await ready(page)
  const text = await screenText(page)
  // Mojibake here means someone decoded the socket as text; the VT core must
  // see raw bytes so multi-byte characters survive message boundaries.
  expect(text).toContain('┌')
  expect(text).toContain('└')
  expect(text).not.toContain('â')
})

test('the PTY grid matches what the client asked for', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => document.querySelectorAll('#screen .term-row:not(.term-scrollback-row)').length)
  const text = await screenText(page)
  expect(text).toMatch(new RegExp(`\\d+x${rows}`))
})

test('at phone size the grid fits the viewport, not the layout viewport', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => ({
    app: document.getElementById('app').getBoundingClientRect().height,
    inner: window.innerHeight,
    visual: window.visualViewport.height,
    barBottom: document.getElementById('bar').getBoundingClientRect().bottom,
  }))
  expect(m.app).toBeCloseTo(m.visual, 0)
  expect(m.barBottom).toBeLessThanOrEqual(m.visual + 1)
})

test('typing reaches the shell and echoes back', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('hello')
  await expect(page.locator('#screen')).toContainText('> hello')

  await page.locator('#screen textarea').press('Enter')
  await expect(page.locator('#screen')).toContainText('ok: 5 chars')
})

test('the hidden input has autocorrect off — a corrected identifier is a wrong file', async ({ page }) => {
  await ready(page)
  const a = await page.locator('#screen textarea').evaluate(t => ({
    autocorrect: t.getAttribute('autocorrect'),
    autocapitalize: t.getAttribute('autocapitalize'),
    spellcheck: t.getAttribute('spellcheck'),
  }))
  expect(a).toEqual({ autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })
})

test('key bar sends the right bytes, and a sticky modifier applies once', async ({ page }) => {
  await ready(page)
  const sent = await page.evaluate(() => {
    const log = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (d) { log.push(new TextDecoder().decode(d)); return orig.call(this, d) }
    window.__sent = log
    return true
  })
  expect(sent).toBe(true)

  await page.getByRole('button', { name: 'Up', exact: true }).tap()
  await page.getByRole('button', { name: 'PageUp', exact: true }).tap()
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()

  const log = await page.evaluate(() => window.__sent)
  expect(log).toContain('0\x1b[A')
  expect(log).toContain('0\x1b[5~')
  expect(log.at(-1)).toBe('0\x1b')            // ctrl+Escape is just Escape
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('a grid preset resizes the PTY and the client together', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '120×40' }).tap()
  await expect(page.locator('#screen')).toContainText('120x40')
  expect(await page.locator('#screen .term-row:not(.term-scrollback-row)').count()).toBe(40)
})

test('a grid wider than the screen pans horizontally rather than reflowing', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '160×50' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  const m = await page.evaluate(() => {
    const v = document.getElementById('viewport')
    return { scrollWidth: v.scrollWidth, clientWidth: v.clientWidth }
  })
  expect(m.scrollWidth).toBeGreaterThan(m.clientWidth)
})

test('zoom changes only the render scale — the PTY grid stays pinned', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  const before = await page.locator('#screen .term-row:not(.term-scrollback-row)').count()
  await page.getByRole('button', { name: '−' }).tap()
  await expect(page.locator('#scale-val')).toHaveText('80%')
  expect(await page.locator('#screen .term-row:not(.term-scrollback-row)').count()).toBe(before)
  expect(await page.locator('#screen').evaluate(e => e.style.transform)).toBe('scale(0.8)')
})

test('the page itself never scrolls — only the terminal does', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => ({
    body: document.body.scrollHeight - window.innerHeight,
    overflow: getComputedStyle(document.body).overflow,
  }))
  expect(m.overflow).toBe('hidden')
  expect(m.body).toBeLessThanOrEqual(0)
})

const scrollTop = page => page.evaluate(() => document.getElementById('screen').scrollTop)

// The view stays pinned to the bottom while wterm renders, so scrollTop climbs
// until the content stops growing. Every scroll assertion needs that baseline.
const settled = async page => {
  let last = -1
  await expect.poll(async () => {
    const now = await scrollTop(page)
    const stable = now === last
    last = now
    return stable
  }, { intervals: [150, 150, 150, 150, 150, 150] }).toBe(true)
  return last
}

// Enough submitted lines to push real history above the fold.
const fillScrollback = async page => {
  const ta = page.locator('#screen textarea')
  for (let i = 0; i < 24; i++) {
    await ta.pressSequentially(`line${i}`)
    await ta.press('Enter')
  }
  await expect.poll(() => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount()))
    .toBeGreaterThan(10)
  return settled(page)
}

test('the nub scrolls back through history and stops when released', async ({ page }) => {
  await ready(page)
  const bottom = await fillScrollback(page)
  expect(bottom).toBeGreaterThan(0)

  // Hold the nub above centre: displacement sets speed, so holding travels.
  const box = await page.locator('#nub').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 4 })
  await page.waitForTimeout(500)
  await page.mouse.up()

  const scrolled = await scrollTop(page)
  expect(scrolled).toBeLessThan(bottom)

  // Release stops it dead — no momentum to fight.
  await page.waitForTimeout(300)
  expect(await scrollTop(page)).toBe(scrolled)
})

test('inside the dead zone the nub does not drift', async ({ page }) => {
  await ready(page)
  const before = await fillScrollback(page)

  const box = await page.locator('#nub').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 8, { steps: 2 })
  await page.waitForTimeout(400)
  await page.mouse.up()

  expect(await scrollTop(page)).toBe(before)
})

test('scrolling up offers a way back to the live screen', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect(page.locator('#to-bottom')).toBeHidden()

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()

  await page.locator('#to-bottom').tap()
  await expect(page.locator('#to-bottom')).toBeHidden()
})

test('reconnect keeps the screen and nudges the size to force a repaint', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('marker')
  await expect(page.locator('#screen')).toContainText('> marker')

  await page.evaluate(() => {
    window.__resizes = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (d) {
      const s = new TextDecoder().decode(d)
      if (s[0] === '1') window.__resizes.push(JSON.parse(s.slice(1)))
      return orig.call(this, d)
    }
  })

  // The socket dies but the terminal object outlives it, so the stale screen
  // stays up instead of blanking.
  await page.evaluate(() => window.mtty.conn.ws.close())
  await expect(page.locator('#screen')).toContainText('> marker')

  await expect.poll(() => page.evaluate(() => window.__resizes?.length ?? 0), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2)
  const nudge = await page.evaluate(() => window.__resizes.slice(0, 2))
  expect(nudge[0].columns).toBe(nudge[1].columns - 1)
  expect(nudge[0].rows).toBe(nudge[1].rows)
})
