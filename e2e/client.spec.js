import { test, expect } from '@playwright/test'

const screenText = page => page.locator('#screen').innerText()

/** Rows of the live grid, excluding the scrollback rendered above it. */
const liveRows = page => page.locator('#screen .term-row:not(.term-scrollback-row)')

/** Record every frame the client puts on the wire, decoded. */
const spySocket = page => page.evaluate(() => {
  window.__sent = []
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { window.__sent.push(new TextDecoder().decode(d)); return send.call(this, d) }
})
const sentFrames = page => page.evaluate(() => window.__sent)
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

test('the screen still has content a moment after attaching', async ({ page }) => {
  await ready(page)
  // Regression: clearing the nudge's own redraws out of the scrollback with
  // ED 3 blanked the visible grid too, a second after every load.
  await page.waitForTimeout(1200)
  expect(await liveRows(page).count()).toBeGreaterThan(0)
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
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
  await spySocket(page)

  await page.getByRole('button', { name: 'Up', exact: true }).tap()
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()

  const log = await sentFrames(page)
  expect(log).toContain('0\x1b[A')
  expect(log.at(-1)).toBe('0\x1b')            // ctrl+Escape is just Escape
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('a grid preset resizes the PTY and the client together', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '120×40' }).tap()
  await expect(page.locator('#screen')).toContainText('120x40')
  expect(await liveRows(page).count()).toBe(40)
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
  const before = await liveRows(page).count()
  await page.getByRole('button', { name: '−' }).tap()
  await expect(page.locator('#scale-val')).toHaveText('80%')
  expect(await liveRows(page).count()).toBe(before)
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

test('the menu jumps to the top and back to the bottom', async ({ page }) => {
  await ready(page)
  const bottom = await fillScrollback(page)
  expect(bottom).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '⤒ Top' }).tap()
  expect(await scrollTop(page)).toBe(0)
  await expect(page.locator('#menu')).toBeHidden()

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '⤓ Bottom' }).tap()
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
})

test('pasted text is sent to the terminal', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()

  // Stands in for the iOS paste callout, which needs a real visible field —
  // the terminal's own input is hidden, so there is nothing to long-press.
  await page.locator('#paste').fill('pasted text')
  await page.getByRole('button', { name: 'Send' }).tap()

  await expect(page.locator('#screen')).toContainText('> pasted text')
  await expect(page.locator('#menu')).toBeHidden()
  expect(await page.locator('#paste').inputValue()).toBe('')
})

test('the key bar keys are big enough to hit', async ({ page }) => {
  await ready(page)
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('#bar button')].map(b => b.getBoundingClientRect().width))
  expect(widths.length).toBe(11)
  expect(Math.min(...widths)).toBeGreaterThan(34)
})

test('output that redraws the bottom block does not shake the view loose', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)

  // pi rewrites its whole bottom block as you type; the fixture does the same.
  const ta = page.locator('#screen textarea')
  for (const word of ['one', 'two', 'three']) {
    await ta.pressSequentially(word)
    await ta.press('Enter')
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
  }
  await expect(page.locator('#to-bottom')).toBeHidden()
})

test('typing jumps back to the live screen', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()

  // Reading history is one mode, typing is another; a keystroke means you want
  // the input box back.
  await page.locator('#screen textarea').pressSequentially('x')
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
})

test('server output while reading history does not yank the view down', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  await page.evaluate(() => { document.getElementById('screen').scrollTop = 0 })
  await expect(page.locator('#to-bottom')).toBeVisible()
  const parked = await scrollTop(page)

  // Straight down the write path, so it is output arriving rather than a
  // keystroke — pi finishing a long answer while you read back over an earlier one.
  await page.evaluate(() => window.mtty.term.write('a line from the server\r\n'))
  await page.waitForTimeout(500)

  expect(await scrollTop(page)).toBe(parked)
  await expect(page.locator('#to-bottom')).toBeVisible()
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

  await spySocket(page)

  // The socket dies but the terminal object outlives it, so the stale screen
  // stays up instead of blanking.
  await page.evaluate(() => window.mtty.conn.ws.close())
  await expect(page.locator('#screen')).toContainText('> marker')

  const resizes = () => sentFrames(page).then(f => f.filter(x => x[0] === '1').map(x => JSON.parse(x.slice(1))))
  await expect.poll(() => resizes().then(r => r.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const nudge = (await resizes()).slice(0, 2)
  expect(nudge[0].columns).toBe(nudge[1].columns - 1)
  expect(nudge[0].rows).toBe(nudge[1].rows)
})

test('the key bar covers the home-indicator inset, leaving no gap beneath it', async ({ page }) => {
  await ready(page)
  await page.addStyleTag({ content: '#safe-probe { padding-bottom: 34px !important; }' })
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
  await page.waitForTimeout(400)

  const m = await page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect()
    const app = document.getElementById('app').getBoundingClientRect()
    const btn = document.querySelector('#bar button').getBoundingClientRect()
    return { barBottom: bar.bottom, appBottom: app.bottom, barHeight: bar.height,
             btnBottom: btn.bottom, btnHeight: btn.height }
  })
  expect(m.barBottom).toBeCloseTo(m.appBottom, 0)             // nothing wasted below it
  expect(m.barHeight).toBeCloseTo(44 + 34, 0)                 // it grew by the inset
  expect(m.btnBottom).toBeLessThanOrEqual(m.appBottom - 33)   // keys clear the indicator
  expect(m.btnHeight).toBeGreaterThan(20)
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
  expect(await page.evaluate(() => sessionStorage.getItem('reloaded'))).toBeNull()
})

test('the document is not scrollable and the terminal claims vertical drags', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    const b = getComputedStyle(document.body)
    return {
      htmlPos: s.position, bodyPos: b.position,
      htmlOverflow: s.overflow, bodyOverflow: b.overflow,
      screenTouch: getComputedStyle(document.getElementById('screen')).touchAction,
      docScrollable: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
    }
  })
  expect(m.screenTouch).toBe('pan-y')
  expect(m.docScrollable).toBeLessThanOrEqual(0)
})

test('a startup failure is reported on screen, not swallowed', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#diag-overlay')).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom', lineno: 42, colno: 7 })))
  await expect(page.locator('#diag-overlay')).toBeVisible()
  await expect(page.locator('#diag-overlay')).toContainText('ERROR — boom')
  await expect(page.locator('#diag-overlay')).toContainText('insets')
})

test('the keyboard key summons and dismisses the input', async ({ page }) => {
  await ready(page)
  const focused = () => page.evaluate(() => document.activeElement === document.querySelector('#screen textarea'))
  await page.evaluate(() => document.querySelector('#screen textarea').blur())
  expect(await focused()).toBe(false)

  await page.getByRole('button', { name: 'keyboard' }).tap()
  expect(await focused()).toBe(true)

  await page.getByRole('button', { name: 'keyboard' }).tap()
  expect(await focused()).toBe(false)
})

test('a sticky modifier reaches keys typed on the software keyboard', async ({ page }) => {
  await ready(page)
  await spySocket(page)

  // These arrive through wterm rather than the key bar, so without the modifier
  // being applied there, Ctrl-C is unreachable from a phone.
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await page.locator('#screen textarea').pressSequentially('c')

  expect(await sentFrames(page)).toContain('0\x03')
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).not.toHaveClass(/sticky/)
})

test('using a modifier leaves the rest of the bar alone', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'ctrl', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'ctrl', exact: true })).toHaveClass(/sticky/)

  await page.locator('#screen textarea').pressSequentially('c')
  expect(await page.locator('#bar button.sticky').count()).toBe(0)
})
