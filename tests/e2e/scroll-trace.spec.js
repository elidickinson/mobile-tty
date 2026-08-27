// The squirm: reading history while output streams in. The answer is to
// hold: output that arrives while the reader is parked is buffered, not
// rendered, and replays in order when they return to the bottom. The drawn
// history itself is a window: the renderer keeps only the rows around the
// viewport, re-windowed on every render — including the scroll-driven one,
// so history under the eye is drawn wherever the reader stops.
//
// What this cannot cover: iOS flick momentum. Playwright WebKit has no touch
// physics, so the momentum half of the old scrollback-rebuild bug is
// on-device only.
import { test, expect, ready, settled, fillScrollback, scrollbackCount, startScrollTrace, stopScrollTrace, maxHeadShift } from './helpers.js'

// How many rendered scrollback rows disagree with the core — the fossil
// meter. The renderer keys each drawn row on the ring's absolute line (the
// discarded count included), so the window should match the core at every
// render; a mismatch means DOM and core have diverged. `rows` and `core` are
// asserted alongside `bad` because an empty DOM has nothing to disagree
// with, and a poll would take that for a pass.
const fossilRows = page => page.evaluate(() => {
  const b = window.mtty.term.bridge
  const r = window.mtty.term.renderer
  const rows = [...document.getElementById('screen').querySelectorAll('.term-scrollback-row')]
  // First drawn row's absolute index, straight from the renderer's keying:
  // startKey = discarded + start, and the discarded count it was keyed with
  // is stored beside it. DOM row j is absolute index start + j; core offsets
  // run newest-first.
  const start = r._scrollbackStartKey - r._renderedDiscardedCount
  const count = b.getScrollbackCount()
  const coreLine = off => {
    let t = ''
    const len = b.getScrollbackLineLen(off)
    for (let c = 0; c < len; c++) t += String.fromCodePoint(b.getScrollbackCell(off, c).char)
    return t.replace(/\s+$/, '')
  }
  let bad = 0
  for (let j = 0; j < rows.length; j++) {
    if (rows[j].textContent.replace(/\s+$/, '') !== coreLine(count - 1 - (start + j))) bad++
  }
  return { bad, rows: rows.length, core: count }
})

const stream = async (page, lines) => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially(`/stream ${lines}`)
  await ta.press('Enter')
}

// Park mid-stream, the way it happens on the phone: output is already arriving
// when the reader settles on a line. Parking first would fill the hold before
// any rotation — the test would pass with nothing to hold.
const TRACE_MS = 2500

const parkAndTrace = async (page, at) => {
  await page.waitForTimeout(1200)               // ring rotates ~12 lines first
  await startScrollTrace(page, { parkAt: at })  // the park's re-window render
  await page.waitForTimeout(TRACE_MS)           // the stream is held throughout
  const trace = await stopScrollTrace(page)
  // The re-window lands within a frame or two; a longer all-null run means the
  // eye never got content and every identity assertion would measure nothing.
  expect(trace.findIndex(s => s.head != null)).toBeLessThan(3)
  return trace
}

// The park lands on spacer geometry for a frame or two, until the renderer
// re-windows under the eye; samples before that are honestly null.
const seenSamples = trace => trace.filter(s => s.head)

test('a saturated scrollback holds output rather than swap content under a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')     // fill the 1000-line ring past its cap
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.4)
  const seen = seenSamples(trace)

  // Preconditions, so a bad park fails as one rather than as NaN arithmetic.
  expect(seen.length).toBeGreaterThan(0)
  expect(seen[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Holding output freezes the view for real: nothing is being rendered, so
  // nothing can move — no growth, no steps, no content sliding under the box.
  const heights = trace.map(s => s.height)
  expect(Math.max(...heights)).toBe(Math.min(...heights))
  const rowH = await page.evaluate(() => window.mtty.state.cell.height)
  const steps = []
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].top !== trace[i - 1].top) steps.push(trace[i].top - trace[i - 1].top)
  }
  expect(steps.length).toBe(0)
  expect(maxHeadShift(trace)).toBe(0)

  // The stream fed the whole window and none of it rendered: it is waiting.
  await expect(page.locator('#to-bottom')).toContainText(/\d+ new/)

  // Returning to the bottom replays it, newest last — into the live grid.
  // The poll watches the rows, not the button: the flush resets the label
  // before wterm renders the bytes, so only the DOM proves the replay landed.
  await page.evaluate(() => {
    const screen = document.getElementById('screen')
    screen.scrollTop = screen.scrollHeight
  })
  const newestIn = () => page.evaluate(() => {
    const rows = [...document.getElementById('screen').querySelectorAll('.term-row')].slice(-40)
    return Math.max(...rows.map(r => Number(/(?:scrollback|stream) line (\d+)/.exec(r.textContent)?.[1])).filter(Number.isFinite), 0)
  })
  await expect.poll(newestIn).toBeGreaterThanOrEqual(30)
})

test('a zoomed scroller keeps the reader parked just the same', async ({ page }) => {
  await ready(page)
  // Zoom is a CSS transform on the scroller. scrollTop, scrollHeight and a
  // row's offsetHeight are all layout pixels that the transform does not
  // rescale, so the park and the hold arithmetic hold as-is — this test
  // exists to keep that honest rather than trust the units.
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.locator('[data-act="zoom-out"]').tap()   // 100% -> 80%
  await page.locator('[data-act="close"]').tap()
  await expect.poll(() => page.evaluate(() => window.mtty.state.scale)).toBe(0.8)

  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.4)
  const seen = seenSamples(trace)

  expect(seen.length).toBeGreaterThan(0)
  expect(seen[0].head).toMatch(/(?:scrollback|stream) line \d+/)
  expect(maxHeadShift(trace)).toBe(0)
})

test('a parked reader does not creep with output after the re-window', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  // While parked, the hold means nothing renders; the residual risk is the
  // park's own re-window render moving the box, and WebKit scroll anchoring
  // on later appends. Anchoring is off on the scroller (style.css), so park,
  // let the re-window land, and hold the spot through more output.
  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.3 })
  await page.waitForTimeout(900)
  const trace = await stopScrollTrace(page)

  const rowH = await page.evaluate(() => window.mtty.state.cell.height)
  const max = Math.max(...trace.map(s => s.top))
  expect(max).toBeLessThan(trace[0].top + rowH)   // the box never left the park
})

test('a park inside the write-to-render bracket is not snapped to the bottom', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  // wterm decides follow-output when a write arrives but acts a frame later,
  // so a write that lands while the box is at the bottom holds its decision
  // through the moment the reader scrolls up, and the render yanks them back
  // down. The bracket is real time — park from inside the page in the same
  // timer drain as wterm's own, before its rAF; a round trip from the test
  // would land after the render and test nothing.
  const held = await page.evaluate(() => new Promise(resolve => {
    const screen = document.getElementById('screen')
    const parked = Math.round((screen.scrollHeight - screen.clientHeight) * 0.3)
    const t = window.mtty.term
    t.write('a line that latches the pin\r\n')
    setTimeout(() => {
      screen.scrollTop = parked
      setTimeout(() => resolve(Math.abs(screen.scrollTop - parked) < 5), 350)
    }, 0)
  }))
  expect(held).toBe(true)
})

test('a keystroke while held returns to live rather than type blind', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 600')
  await ta.press('Enter')
  await settled(page)

  // Park until the hold is counting, then type: wterm's own keystroke jump
  // returns the box to the bottom, the hold flushes from there, and the echo
  // renders instead of queueing behind the reader's back.
  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.5 })
  await expect(page.locator('#to-bottom')).toContainText(/\d+ new/)

  await ta.pressSequentially('echo typed-live')
  await expect.poll(() => page.evaluate(() => {
    const screen = document.getElementById('screen')
    return screen.scrollHeight - screen.scrollTop - screen.clientHeight < 5
  })).toBe(true)
  await expect(page.locator('#to-bottom')).toHaveText('↓ latest')
  // fake-pi reads input between stream ticks, so the echo trails the stream.
  await expect.poll(() => page.evaluate(() => {
    const rows = [...document.getElementById('screen').querySelectorAll('.term-row')].slice(-14)
    return rows.map(r => r.textContent).join('\n')
  }), { timeout: 12_000 }).toContain('typed-live')
  await stopScrollTrace(page)
})

test('a reconnect snapshot lands rather than queue behind a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1400')     // saturate: the ring is rotating
  await ta.press('Enter')
  await settled(page)

  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.4 })
  await expect(page.locator('#to-bottom')).toContainText(/\d+ new/)
  await page.waitForTimeout(600)               // the park's re-window render lands

  // Drop the socket from inside, the way a sleep/wake does from outside.
  // The snapshot bypasses the hold (a size report precedes it), and the
  // reset-and-refill it performs moves the renderer's keys — the discarded
  // count returns to zero — so the next render redraws the window wholesale
  // against the fresh core. Queued instead, none of that happens and the
  // reader keeps looking at a screen from before the drop.
  await page.evaluate(() => window.mtty.conn.ws.close())
  // Anchored: "disconnected" contains "connected" as a substring.
  await expect.poll(() => page.locator('#menu-state').textContent(), { timeout: 10_000 }).toMatch(/^connected/)
  await expect.poll(() => fossilRows(page), { timeout: 5_000 }).toMatchObject({ bad: 0, core: 1000 })
  const fr = await fossilRows(page)
  expect(fr.rows).toBeGreaterThan(20)          // the window actually drew...
  expect(fr.rows).toBeLessThan(200)            // ...as a window, not the whole buffer

  // The hold still works after the snapshot: parked means new output counts.
  await expect.poll(() => page.locator('#to-bottom').textContent(), { timeout: 5_000 }).toMatch(/\d+ new/)
  await stopScrollTrace(page)
})

test('rotation keeps the drawn window honest across visits into history', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')
  await ta.press('Enter')
  await settled(page)

  // First visit: the window under the eye matches the core, and is a window.
  await stream(page, 60)
  await startScrollTrace(page, { parkAt: 0.4 })
  await page.waitForTimeout(900)
  await expect.poll(() => fossilRows(page)).toMatchObject({ bad: 0, core: 1000 })
  expect((await fossilRows(page)).rows).toBeLessThan(200)

  // Return to the bottom — the visit ends, the hold flushes, and the ring
  // rotates past what the window showed. Park again: the re-window render
  // must draw the advanced core, not anything stale from the first visit.
  await page.evaluate(() => {
    const screen = document.getElementById('screen')
    screen.scrollTop = screen.scrollHeight
  })
  await expect.poll(() => page.locator('#to-bottom').textContent()).toBe('↓ latest')
  await page.waitForTimeout(600)               // the flush advances the core at the cap
  await startScrollTrace(page, { parkAt: 0.6 })
  await page.waitForTimeout(900)
  await expect.poll(() => fossilRows(page)).toMatchObject({ bad: 0, core: 1000 })
  expect((await fossilRows(page)).rows).toBeLessThan(200)
  await stopScrollTrace(page)
})

test('a resize snapshot does not queue behind a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 600')
  await ta.press('Enter')
  await settled(page)

  // Park with the hold counting, let the stream finish, then change the
  // grid: the server answers every PTY resize with a fresh snapshot, and
  // queued, that snapshot's whole screenful of newlines would land in the
  // meter (and in the hold) — the label jumping by hundreds is the tell.
  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.5 })
  await expect.poll(() => page.locator('#to-bottom').textContent(), { timeout: 12_000 }).toMatch(/↓ (\d+) new/)
  const before = Number(/↓ (\d+) new/.exec(await page.locator('#to-bottom').textContent())?.[1])

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()   // any preset but the current grid
  await page.locator('[data-act="close"]').tap()
  await page.waitForTimeout(1500)

  const after = Number(/↓ (\d+) new/.exec(await page.locator('#to-bottom').textContent())?.[1] ?? '0')
  expect(after).toBeLessThan(before + 100)     // a snapshot is ~600 "lines" if queued
  expect(await page.evaluate(() => window.mtty.state.cols)).toBe(50)
  await stopScrollTrace(page)
})

test('a resize snapshot supersedes the hold rather than being replayed over', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 600')     // under the cap, so a bogus write shows as growth
  await ta.press('Enter')
  await settled(page)

  await stream(page, 25)
  await startScrollTrace(page, { parkAt: 0.5 })
  // Let the stream end before the resize, so the hold has stopped growing and
  // what the snapshot is answering for is settled.
  let last = null
  await expect.poll(async () => {
    const now = await page.locator('#to-bottom').textContent()
    const same = now === last && /\d+ new/.test(now)
    last = now
    return same
  }, { intervals: Array(24).fill(400) }).toBe(true)

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await page.locator('[data-act="close"]').tap()
  await expect.poll(() => page.evaluate(() => window.mtty.state.cols), { timeout: 8_000 }).toBe(50)
  await page.waitForTimeout(1500)              // the snapshot, and fake-pi's own redraw behind it

  // The snapshot is the server's whole screen and history, and the mirror it
  // was serialized from had already been written every byte being held. Kept,
  // the hold replays over the top of itself on the way back down and history
  // gains lines that were only ever produced once; dropped, there is nothing
  // left to replay and the count cannot move. fake-pi's own repaints clear the
  // screen rather than scroll it, so they add no lines either way.
  const lines = await scrollbackCount(page)
  await page.evaluate(() => { const s = document.getElementById('screen'); s.scrollTop = s.scrollHeight })
  await expect.poll(() => page.locator('#to-bottom').isHidden()).toBe(true)
  await page.waitForTimeout(600)
  expect(await scrollbackCount(page)).toBe(lines)
  await stopScrollTrace(page)
})

test('a growing scrollback holds output rather than push past a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 600')      // below the cap: nothing exhausted
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.6)
  const seen = seenSamples(trace)

  expect(seen.length).toBeGreaterThan(0)
  expect(seen[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Below the cap the buffer still grows, but held output does not render:
  // the reader is parked over a terminal that has paused.
  const heights = trace.map(s => s.height)
  expect(Math.max(...heights)).toBe(Math.min(...heights))
  const tops = trace.map(s => s.top)
  expect(Math.max(...tops)).toBe(Math.min(...tops))
  expect(maxHeadShift(trace)).toBe(0)

  await expect(page.locator('#to-bottom')).toContainText(/\d+ new/)

  // The flush lands the held rows: growth resumes, beneath and unseen.
  const before = trace[trace.length - 1].height
  await page.evaluate(() => {
    const screen = document.getElementById('screen')
    screen.scrollTop = screen.scrollHeight
  })
  await expect.poll(() => page.evaluate(() => document.getElementById('screen').scrollHeight)).toBeGreaterThan(before)
})
