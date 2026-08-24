// The squirm: reading history while output streams in. Two regimes, one
// assertion each — the line under the reader's eye must keep its identity.
// A saturated ring freezes the rendered history (geometry constant, content
// swapped under it by the rebuild); a ring below the cap grows it (appends
// above the reader). The trace's `height` field tells the two apart, `head`
// says whether what the eye sees moved.
//
// What this cannot cover: iOS flick momentum. Playwright WebKit has no touch
// physics, so the momentum-killing half of the rebuild bug is on-device only;
// both symptoms share the same rebuildScrollback call, so the fix is driven
// from here regardless.
import { test, expect, ready, settled, fillScrollback, startScrollTrace, stopScrollTrace, maxHeadShift } from './helpers.js'

const stream = async (page, lines) => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially(`/stream ${lines}`)
  await ta.press('Enter')
}

// Park mid-stream, the way it happens on the phone: output is already arriving
// when the reader settles on a line. Parking first would saturate-and-freeze
// before any rotation — the rebuild would have nothing to swap, and the test
// would pass with the bug live.
const STREAM_TICK_MS = 100   // the fixture's /stream cadence: one line off the top per tick
const TRACE_MS = 2500

const parkAndTrace = async (page, at) => {
  await page.waitForTimeout(1200)               // ring rotates ~12 lines first
  await startScrollTrace(page, { parkAt: at })  // first sample beats the refresh timer
  await page.waitForTimeout(TRACE_MS)           // several rebuilds land inside the window
  return stopScrollTrace(page)
}

test('a saturated scrollback does not swap content under a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 1200')     // fill the 1000-line ring past its cap
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.4)

  // Preconditions, so a bad park fails as one rather than as NaN arithmetic.
  expect(trace[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Frozen geometry is this regime's signature — it is what makes the content
  // swap invisible to every position-only assertion. The rebuild keeps the
  // reader's line by stepping the box to meet it, so the claim is not that the
  // box never moves but that every move is a whole number of rows and the line
  // under the eye never changes.
  const heights = trace.map(s => s.height)
  expect(Math.max(...heights)).toBe(Math.min(...heights))
  const rowH = await page.evaluate(() => window.mtty.state.cell.height)
  const steps = []
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].top !== trace[i - 1].top) steps.push({ px: trace[i].top - trace[i - 1].top, at: trace[i].t })
  }
  for (const step of steps) expect(Math.abs(step.px % rowH)).toBe(0)   // abs: -340 % 17 is -0

  // Rebuilds repeat while output arrives — that is what keeps history live
  // under the reader instead of leaving a fossil spliced onto the grid — so
  // the window holds several, not one.
  expect(steps.length).toBeGreaterThan(3)

  // The first step is the correction, and it is unbounded on purpose: a frozen
  // render can be a non-contiguous splice, so the reader's line can sit
  // hundreds of rows from where the stale geometry put it. Every step after it
  // is the ring rotating under a still reader, which only ever moves the box
  // up, and never further than the stream has fed in the meantime. A jump
  // there would mean a rebuild landed somewhere else in history.
  for (let i = 1; i < steps.length; i++) {
    const rotated = (steps[i].at - steps[i - 1].at) / STREAM_TICK_MS
    expect(steps[i].px).toBeLessThan(0)
    expect(-steps[i].px / rowH).toBeLessThanOrEqual(rotated + 1)
  }

  expect(maxHeadShift(trace)).toBe(0)
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
  await page.waitForTimeout(900)               // rebuild at +200ms, then ticks
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

test('a growing scrollback does not push content past a parked reader', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 600')      // below the cap: appends, no rotation
  await ta.press('Enter')
  await settled(page)

  await stream(page, 60)
  const trace = await parkAndTrace(page, 0.6)

  expect(trace[0].head).toMatch(/(?:scrollback|stream) line \d+/)

  // Geometry grows here — that is the point of the regime — but the reader's
  // line must stay put, and with nothing rotating there is no step to forgive:
  // the box holds still too.
  expect(trace[trace.length - 1].height).toBeGreaterThan(trace[0].height)
  const tops = trace.map(s => s.top)
  expect(Math.max(...tops)).toBe(Math.min(...tops))
  expect(maxHeadShift(trace)).toBe(0)
})
