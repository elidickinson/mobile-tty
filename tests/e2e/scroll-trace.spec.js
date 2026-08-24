// The squirm: reading history while output streams in. The answer is to
// hold: output that arrives while the reader is parked is buffered, not
// rendered, and replays in order when they return to the bottom. One rebuild
// per visit unfreezes whatever the ring cap had fossilized before they
// scrolled up; after it, nothing moves — the trace asserts exactly that.
//
// What this cannot cover: iOS flick momentum. Playwright WebKit has no touch
// physics, so the momentum-killing half of the rebuild bug is on-device only;
// both symptoms share the same rebuildScrollback call, so the fix is driven
// from here regardless.
import { test, expect, ready, settled, fillScrollback, scrollbackCount, startScrollTrace, stopScrollTrace, maxHeadShift } from './helpers.js'

// How many rendered scrollback rows no longer match the core — the fossil
// meter. At the ring cap the DOM freezes while the core rotates on, and a
// reset+refill (a snapshot) leaves the count unchanged so nothing redraws;
// only comparing rows to the core catches it. `rows` and `core` are asserted
// alongside `bad` because an empty DOM has nothing to disagree with, and a
// poll would take that for a pass.
const fossilRows = page => page.evaluate(() => {
  const b = window.mtty.term.bridge
  const rows = [...document.getElementById('screen').querySelectorAll('.term-scrollback-row')]
  const coreLine = off => {
    let s = ''
    const len = b.getScrollbackLineLen(off)
    for (let c = 0; c < len; c++) s += String.fromCodePoint(b.getScrollbackCell(off, c).char)
    return s.replace(/\s+$/, '')
  }
  let bad = 0
  // Core offsets run newest-first; DOM rows run oldest-first.
  for (let off = 0; off < rows.length; off++) {
    if (rows[off].textContent.replace(/\s+$/, '') !== coreLine(rows.length - 1 - off)) bad++
  }
  return { bad, rows: rows.length, core: b.getScrollbackCount() }
})

const stream = async (page, lines) => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially(`/stream ${lines}`)
  await ta.press('Enter')
}

// Park mid-stream, the way it happens on the phone: output is already arriving
// when the reader settles on a line. Parking first would saturate-and-freeze
// before any rotation — the rebuild would have nothing to swap, and the test
// would pass with the bug live.
const TRACE_MS = 2500

const parkAndTrace = async (page, at) => {
  await page.waitForTimeout(1200)               // ring rotates ~12 lines first
  await startScrollTrace(page, { parkAt: at })  // first sample beats the refresh timer
  await page.waitForTimeout(TRACE_MS)           // rebuild lands; the stream is held
  return stopScrollTrace(page)
}

test('a saturated scrollback holds output rather than swap content under a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')     // fill the 1000-line ring past its cap
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.4)

  // Preconditions, so a bad park fails as one rather than as NaN arithmetic.
  expect(trace[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Frozen geometry is this regime's signature — it is what made the content
  // swap invisible to every position-only assertion. Holding output freezes
  // it for real: after the rebuild's one correction, nothing is being
  // rendered, so nothing can move.
  const heights = trace.map(s => s.height)
  expect(Math.max(...heights)).toBe(Math.min(...heights))
  const rowH = await page.evaluate(() => window.mtty.state.cell.height)
  const steps = []
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].top !== trace[i - 1].top) steps.push(trace[i].top - trace[i - 1].top)
  }
  // At most one step — the rebuild landing the eye's line, unbounded on
  // purpose because a frozen render can be a non-contiguous splice — and a
  // whole number of rows. A second step would mean output leaked past the
  // hold and moved the box.
  expect(steps.length).toBeLessThanOrEqual(1)
  for (const px of steps) expect(Math.abs(px % rowH)).toBe(0)   // abs: -340 % 17 is -0
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

test('a zoomed scroller keeps the reader through the same rebuild', async ({ page }) => {
  await ready(page)
  // Zoom is a CSS transform on the scroller. scrollTop, scrollHeight and a
  // row's offsetHeight are all layout pixels that the transform does not
  // rescale, so the rebuild's arithmetic holds as-is — this test exists to
  // keep it honest rather than trust the units.
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

  expect(trace[0].head).toMatch(/(?:scrollback|stream) line \d+/)
  expect(maxHeadShift(trace)).toBe(0)
})

test('a parked reader does not creep with output after the rebuild', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  // The rebuild detaches every scrollback row — the engine's scroll anchor
  // included — and WebKit then anchors on a live grid row below the insertion
  // point, so every later history append pushes the anchor down and walks the
  // box with it: one row per line of output, forever. Anchoring is off on the
  // scroller (style.css), so park, let the rebuild fire, and hold the spot
  // through more output.
  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.3 })
  await page.waitForTimeout(900)               // rebuild at +400ms, then held ticks
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
  await ta.pressSequentially('/lines 1400')     // saturate: the fossil regime
  await ta.press('Enter')
  await settled(page)

  await stream(page, 40)
  await startScrollTrace(page, { parkAt: 0.4 })
  await expect(page.locator('#to-bottom')).toContainText(/\d+ new/)
  await page.waitForTimeout(600)               // the visit's rebuild lands first

  // Drop the socket from inside, the way a sleep/wake does from outside.
  // The snapshot bypasses the hold (a size report precedes it), and because
  // it reset-and-refilled the core in one write, nothing redraws on its own
  // — the quiet spell rebuild it re-arms is what actually replaces the
  // fossil rows. Queued instead, none of that happens and the reader keeps
  // looking at a screen from before the drop.
  await page.evaluate(() => window.mtty.conn.ws.close())
  // Anchored: "disconnected" contains "connected" as a substring.
  await expect.poll(() => page.locator('#menu-state').textContent(), { timeout: 10_000 }).toMatch(/^connected/)
  await expect.poll(() => fossilRows(page), { timeout: 5_000 }).toEqual({ bad: 0, rows: 1000, core: 1000 })

  // The hold still works after the snapshot: parked means new output counts.
  await expect.poll(() => page.locator('#to-bottom').textContent(), { timeout: 5_000 }).toMatch(/\d+ new/)
  await stopScrollTrace(page)
})

test('the rebuild re-arms for the next visit into history', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')
  await ta.press('Enter')
  await settled(page)

  // First visit: the rebuild runs, DOM and core agree.
  await stream(page, 60)
  await startScrollTrace(page, { parkAt: 0.4 })
  await page.waitForTimeout(900)
  await expect.poll(() => fossilRows(page)).toEqual({ bad: 0, rows: 1000, core: 1000 })

  // Return to the bottom — the visit ends, the hold flushes, and the ring
  // rotates past what the frozen DOM shows. Park again: without a fresh
  // rebuild the DOM is a fossil against the advanced core, and once per page
  // load would leave it that way forever.
  await page.evaluate(() => {
    const screen = document.getElementById('screen')
    screen.scrollTop = screen.scrollHeight
  })
  await expect.poll(() => page.locator('#to-bottom').textContent()).toBe('↓ latest')
  await page.waitForTimeout(600)               // flush advances the core at the cap
  await startScrollTrace(page, { parkAt: 0.6 })
  await page.waitForTimeout(900)               // the second visit's rebuild
  await expect.poll(() => fossilRows(page)).toEqual({ bad: 0, rows: 1000, core: 1000 })
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
  await ta.pressSequentially('/lines 600')      // below the cap: nothing fossilized
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.6)

  expect(trace[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Below the cap the unfixed behavior appends rows beneath the reader —
  // growth without movement. Held output does not even grow: the reader is
  // parked over a terminal that has paused.
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
