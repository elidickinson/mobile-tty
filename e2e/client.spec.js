import { test, expect } from '@playwright/test'

const screenText = page => page.locator('#screen').innerText()
const ready = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect.poll(() => page.evaluate(() => Boolean(window.mtty?.term?.bridge))).toBe(true)
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
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()

  const log = await page.evaluate(() => window.__sent)
  expect(log).toContain('0\x1b[A')
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
  await page.getByRole('button', { name: '100%' }).tap()
  expect(await page.locator('#screen').evaluate(e => e.style.transform)).toBe('')
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
  }, { intervals: Array(14).fill(150) }).toBe(true)
  return last
}

const scrollbackCount = page => page.evaluate(() => window.mtty.term.bridge.getScrollbackCount())

// Push real history above the fold. `/lines` makes the fixture scroll a fixed
// block off the top, so the depth does not depend on the grid or on how many
// keystrokes survive a busy machine.
const fillScrollback = async page => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines')
  await ta.press('Enter')
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(10)
  return settled(page)
}

test('the paging keys scroll the view, since pi does not page itself', async ({ page }) => {
  await ready(page)
  const bottom = await fillScrollback(page)

  await page.evaluate(() => {
    window.__sent = []
    const o = WebSocket.prototype.send
    WebSocket.prototype.send = function (d) { window.__sent.push(new TextDecoder().decode(d)); return o.call(this, d) }
  })

  await page.getByRole('button', { name: 'PageUp', exact: true }).tap()
  await page.waitForTimeout(200)
  const up = await scrollTop(page)
  expect(up).toBeLessThan(bottom)

  // pi answers PageUp with a bare cursor move, so sending it would do nothing.
  expect(await page.evaluate(() => window.__sent)).not.toContain('0\x1b[5~')

  await page.getByRole('button', { name: 'PageDown', exact: true }).tap()
  await page.waitForTimeout(200)
  expect(await scrollTop(page)).toBeGreaterThan(up)
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

const distanceFromBottom = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  return s.scrollHeight - s.scrollTop - s.clientHeight
})

test('a shorter viewport keeps the bottom of the screen in view', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)

  // Standing in for the keyboard opening: the window loses ~310pt and the grid
  // does not reflow, so the bottom rows are what must survive.
  await page.setViewportSize({ width: 402, height: 498 })
  await settled(page)

  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
  const visible = await page.evaluate(() => {
    const s = document.getElementById('screen')
    const rows = [...s.querySelectorAll('.term-row:not(.term-scrollback-row)')].filter(r => r.innerText.trim())
    const last = rows.at(-1).getBoundingClientRect()
    const box = s.getBoundingClientRect()
    return last.bottom <= box.bottom + 2 && last.bottom > box.top
  })
  expect(visible).toBe(true)
})

test('the keyboard opening does not resize the grid', async ({ page }) => {
  await ready(page)
  const before = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])
  await page.setViewportSize({ width: 402, height: 498 })   // same orientation, less room
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])).toEqual(before)
})

test('rotating to landscape refits the grid — that is the whole point of landscape', async ({ page }) => {
  await ready(page)
  const [portraitCols] = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])

  await page.setViewportSize({ width: 874, height: 402 })
  await expect.poll(() => page.evaluate(() => window.mtty.state.cols)).toBeGreaterThan(portraitCols * 1.8)

  const [cols, rows] = await page.evaluate(() => [window.mtty.state.cols, window.mtty.state.rows])
  await expect(page.locator('#screen')).toContainText(`${cols}x${rows}`)

  await page.setViewportSize({ width: 402, height: 812 })
  await expect.poll(() => page.evaluate(() => window.mtty.state.cols)).toBe(portraitCols)
})

test('the grid is sized from the layout viewport, so it outlives the keyboard', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => window.mtty.state.rows)
  await page.setViewportSize({ width: 402, height: 498 })
  await page.waitForTimeout(600)

  // More grid than fits: the rest is reachable by scrolling, not by reflowing.
  const m = await page.evaluate(() => {
    const s = document.getElementById('screen')
    return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }
  })
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
  expect(await page.evaluate(() => window.mtty.state.rows)).toBe(rows)
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

test('the key bar absorbs the home-indicator inset, leaving no gap beneath it', async ({ page }) => {
  await ready(page)
  await page.addStyleTag({ content: '#safe-probe { padding-bottom: 34px !important; }' })
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
  await page.waitForTimeout(400)

  const m = await page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect()
    const app = document.getElementById('app').getBoundingClientRect()
    const btn = document.querySelector('#bar button').getBoundingClientRect()
    return { barBottom: bar.bottom, appBottom: app.bottom, barHeight: bar.height, btnBottom: btn.bottom }
  })
  expect(m.barBottom).toBeCloseTo(m.appBottom, 0)      // no dead space under the bar
  expect(m.barHeight).toBeCloseTo(44 + 34, 0)          // it grew by the inset
  expect(m.btnBottom).toBeLessThanOrEqual(m.appBottom - 33)  // keys stay clear of the indicator
})

test('the client reloads itself when the server serves a newer build', async ({ page }) => {
  await ready(page)
  const shipped = await page.evaluate(() => document.querySelector('meta[name=build]').content)
  expect(shipped).toMatch(/^[0-9a-z]+$/)

  // Same build served: it must not reload, or a stale cache becomes a loop.
  const reloads = []
  page.on('framenavigated', f => reloads.push(f.url()))
  await page.evaluate(() => window.mtty && null)
  await page.waitForTimeout(1000)
  expect(reloads).toHaveLength(0)
})

test('the menu can reload the app, since standalone has no browser chrome', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()

  const navigated = page.waitForNavigation()
  await page.getByRole('button', { name: 'Reload app' }).tap()
  await navigated

  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  expect(await page.evaluate(() => sessionStorage.getItem('reloaded'))).toBeNull()
})
