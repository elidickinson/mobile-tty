// The squirm: reading history while output streams in. Two regimes, one
// assertion each — the line under the reader's eye must keep its identity.
// A saturated ring freezes the rendered history (geometry constant, content
// swapped by the entry rebuild); a ring below the cap grows it (appends above
// the reader). The trace's `height` field tells the two apart, `head` says
// whether what the eye sees moved.
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
const parkAndTrace = async (page, at) => {
  await page.waitForTimeout(1200)               // ring rotates ~12 lines first
  await startScrollTrace(page, { parkAt: at })  // first sample beats the 80ms timer
  await page.waitForTimeout(2500)               // rebuild fires ~80ms in, mid-stream
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
  // reader's line by stepping the box up to meet it, so the claim is not that
  // the box never moves but that it moves once, by whole rows, and the line
  // under the eye never changes.
  const heights = trace.map(s => s.height)
  expect(Math.max(...heights)).toBe(Math.min(...heights))
  const rowH = await page.evaluate(() => window.mtty.state.cell.height)
  const steps = []
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].top !== trace[i - 1].top) steps.push(trace[i].top - trace[i - 1].top)
  }
  expect(steps.length).toBeLessThanOrEqual(1)
  for (const step of steps) expect(Math.abs(step % rowH)).toBe(0)   // abs: -340 % 17 is -0
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

test('parking between a write and its render does not snap back to the bottom', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)

  // wterm decides follow-output when the write arrives but acts on it a frame
  // later, so a write that lands while the box is at the bottom holds a
  // "pin this" decision through the moment the reader scrolls up — and its
  // render then yanks the box back down. Reproduce the bracket deliberately:
  // park as soon as a streaming write is seen, inside that frame.
  await page.evaluate(() => {
    const t = window.mtty.term
    const orig = t.write.bind(t)
    window.__writeSeen = false
    t.write = d => { window.__writeSeen = true; return orig(d) }
  })
  await stream(page, 40)
  await page.waitForFunction(() => window.__writeSeen)
  await startScrollTrace(page, { parkAt: 0.3 })
  await page.waitForTimeout(600)
  const trace = await stopScrollTrace(page)

  const dom = await page.evaluate(() => {
    const screen = document.getElementById('screen')
    const rows = [...screen.querySelectorAll('.term-row')]
    const find = n => rows.findIndex(r => r.textContent.trim() === `scrollback line ${n}`)
    const sb = rows.filter(r => r.classList.contains('term-scrollback-row')).length
    return { top: Math.round(screen.scrollTop), sb, n0: find(0), n1: find(1), off0: rows[find(0)]?.offsetTop, off10: rows[find(10)]?.offsetTop }
  })
  console.log('DOM', JSON.stringify(dom), 'firstTop', trace[0].top, 'lastTop', trace[trace.length-1].top)
  expect(max).toBeLessThan(trace[0].top + rowH)   // the box never left the park
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
