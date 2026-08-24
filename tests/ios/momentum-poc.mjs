// Proof-of-concept: real iOS touch physics against mobile-tty in Simulator Safari.
// Appium XCUITest drives real gestures through UIKit; the page is sampled
// fire-and-forget (sync execute installs an interval that only appends to an
// array; Node polls it). No in-page waiting, no executeAsync — see README.md.
import { remote } from 'webdriverio'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const UDID = process.env.MTTY_SIM_UDID ?? 'E9AABE3B-1541-49AF-83F4-7921C902F5E8'
const BASE_URL = process.env.MTTY_URL ?? 'http://127.0.0.1:8199/'
const APPIUM = { hostname: '127.0.0.1', port: 4723, logLevel: 'error' }
const MODE = process.argv[2] ?? 'all' // momentum | wedge | all

// A native tap at (x, y) maps to the page's (x, y-62) on iPhone 17 Pro / iOS
// 26.5 with Safari's address bar tucked. map-touches.mjs re-measures it.
const CHROME_TOP = 62
const SAMPLE_MS = 20

const caps = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:udid': UDID,
  'appium:bundleId': 'com.apple.mobilesafari',
  'appium:noReset': true,
}

// --- page-side bits (run via sync execute) -------------------------------------

const installSampler = () => {
  const s = document.getElementById('screen')
  clearInterval(window.__iv)
  window.__trace = []
  window.__scrollCount = 0
  window.__t0 = performance.now()
  s.addEventListener('scroll', () => window.__scrollCount++, { passive: true })
  window.__iv = setInterval(() => window.__trace.push({
    t: Math.round(performance.now() - window.__t0),
    top: Math.round(s.scrollTop),
  }), 20)
  return true
}

const clearSampler = () => { clearInterval(window.__iv); return window.__trace.length }

// --- session plumbing ------------------------------------------------------------

const connect = async () => {
  execSync(`xcrun simctl openurl ${UDID} '${BASE_URL}'`)
  const b = await remote({ ...APPIUM, capabilities: caps })
  for (let i = 0; i < 30; i++) {
    for (const c of await b.getContexts()) {
      if (!/WEBVIEW/.test(c)) continue
      try {
        await b.switchContext(c)
        if (await b.execute(() => Boolean(window.mtty?.term?.bridge)).catch(() => false)) {
          b.webContext = c
          return b
        }
      } catch { /* another tab */ }
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('no WEBVIEW context for the app page')
}

const inWeb = (b, fn) => b.switchContext(b.webContext).then(fn)
const inNative = (b, fn) => b.switchContext('NATIVE_APP').then(fn)

const dismissKeyboard = async (b) => {
  await inNative(b, async () => {
    const kb = (await b.$$('-ios class chain:**/XCUIElementTypeButton[`name == "keyboard"`]'))[0]
    const osk = (await b.$$('-ios class chain:**/XCUIElementTypeButton[`name == "A"`]')).length > 0
    if (osk && kb) { await kb.click(); await new Promise(r => setTimeout(r, 900)) }
  })
}

// Typing goes through the OSK into the focused textarea -> WebSocket -> fake-pi.
const typeCommand = async (b, cmd) => {
  await inWeb(b, () => b.execute(() => { document.getElementById('screen').querySelector('textarea').focus() }))
  await inNative(b, async () => {
    const tv = (await b.$$('-ios class chain:**/XCUIElementTypeTextView'))[0]
    await tv.addValue(cmd + '\n')
  })
}

const screenRect = (b) => inWeb(b, () => b.execute(() => {
  const e = document.getElementById('screen').getBoundingClientRect()
  return { x: e.x, y: e.y, w: e.width, h: e.height }
}))

/** Flick up into history: full-length stroke, 60ms, via XCUITest pointer actions. */
const flickUp = async (b, { duration = 60, from = 0.72, to = 0.10 } = {}) => {
  const r = await screenRect(b)
  const cx = Math.round(r.x + r.w / 2)
  const y0 = Math.round(r.y + r.h * from + CHROME_TOP)
  const y1 = Math.round(r.y + r.h * to + CHROME_TOP)
  await inNative(b, async () => {
    await b.performActions([{ type: 'pointer', id: 'f', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: cx, y: y0 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration, x: cx, y: y1 },
        { type: 'pointerUp', button: 0 },
      ] }])
    await b.releaseActions()
  })
}

const settle = ms => new Promise(r => setTimeout(r, ms))

/**
 * Poll the page-side trace until the tail FLAT_COUNT samples are all equal
 * (settled) or deadline. Returns on movement events as they appear so callers
 * can act mid-deceleration (the wedge case).
 */
const pollTrace = async (b, { flat = 12, deadlineMs = 20_000, onMove } = {}) => {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    const tail = await inWeb(b, () => b.execute(() => (window.__trace ?? []).slice(-12).map(s => s.top)))
    if (onMove && tail.length >= 2 && tail.at(-1) !== tail[0]) { onMove(); onMove = null }
    // Settled = recent band span under 2px (the app writes +/-1px sand grains).
    if (tail.length >= flat && Math.max(...tail) - Math.min(...tail) < 2) return 'settled'
    await settle(250)
  }
  return 'deadline'
}

const pullTrace = (b) => inWeb(b, () => b.execute(() => {
  const t = window.__trace
  window.__trace = null
  return { trace: t, scrollEvents: window.__scrollCount }
}))

const summarize = (name, { trace, scrollEvents }) => {
  const tops = trace.map(s => s.top)
  const distinct = new Set(tops).size
  const deltas = []
  for (let i = 1; i < tops.length; i++) if (tops[i] !== tops[i-1]) deltas.push(tops[i] - tops[i-1])
  const early = Math.abs(deltas[0] ?? 0)
  const late = Math.abs(deltas.at(-1) ?? 0)
  const decel = deltas.length > 6 && early > late && late <= 2
  console.log(`[${name}] samples=${trace.length} span=${trace.at(-1)?.t - trace[0]?.t}ms ` +
    `distinctTops=${distinct} deltas=${deltas.length} earlyGap=${early} lateGap=${late} scrollEvents=${scrollEvents}`)
  console.log(`  tops: ${tops.join(',')}`)
  console.log(`  velocity curve (per ${SAMPLE_MS}ms sample): ${deltas.join(',')}`)
  return { distinct, deltas: deltas.length, earlyGap: early, lateGap: late, decel, tops }
}

// --- scenarios ----------------------------------------------------------------------

const runMomentum = async (b) => {
  console.log('=== momentum flick ===')
  await dismissKeyboard(b)
  await inWeb(b, () => b.execute(() => { const s = document.getElementById('screen'); s.scrollTop = s.scrollTop - 2400 }))
  await settle(300)
  await inWeb(b, () => b.execute(installSampler))
  await flickUp(b)
  const end = await pollTrace(b)
  await settle(400)
  const out = await pullTrace(b)
  const r = summarize('momentum', out)
  const verdict = r.decel && r.distinct > 25
    ? 'MOMENTUM CONFIRMED: decelerating velocity curve after release'
    : r.distinct > 8 ? 'movement saw but not a smooth decel' : 'no movement'
  console.log(`poll ended: ${end}; verdict: ${verdict}\n`)
  return { scenario: 'momentum', ...r, scrollEvents: out.scrollEvents, verdict, trace: out.trace }
}

const runWedge = async (b) => {
  console.log('=== wedge: programmatic scrollTop write mid-deceleration ===')
  await dismissKeyboard(b)
  await inWeb(b, () => b.execute(() => { const s = document.getElementById('screen'); s.scrollTop = s.scrollTop - 2400 }))
  await settle(300)
  await inWeb(b, () => b.execute(installSampler))
  await flickUp(b)
  // One shot: as soon as the trace shows movement, fire a same-turn
  // read-write-read. The UIKit decelerator, if live and touch-frozen, clamps
  // or steals the write; the trace afterwards shows what happened.
  let write = null
  const end = await pollTrace(b, { onMove: () => {
    write = inWeb(b, () => b.execute(() => {
      const s = document.getElementById('screen')
      const before = Math.round(s.scrollTop)
      s.scrollTop = s.scrollTop - 1
      return { before, after: Math.round(s.scrollTop), atT: Math.round(performance.now() - window.__t0) }
    }))
  } })
  const wr = await write
  await settle(400)
  const out = await pullTrace(b)
  const r = summarize('wedge', out)
  if (wr == null) console.log('write never fired (no movement observed)')
  const changed = wr && Math.abs(wr.after - wr.before) >= 1
  // Did ANY gesture land after the write window? Re-test responsiveness.
  const before = await inWeb(b, () => b.execute(() => Math.round(document.getElementById('screen').scrollTop)))
  await flickUp(b, { duration: 300, from: 0.72, to: 0.40 }) // slow, deliberate drag
  await settle(800)
  const after = await inWeb(b, () => b.execute(() => Math.round(document.getElementById('screen').scrollTop)))
  const responsive = before !== after
  console.log(`write: ${JSON.stringify(wr)} tookEffect=${changed}`)
  console.log(`post-write drag: ${before} -> ${after}  scrollerResponsive=${responsive}`)
  const verdict = wr == null ? 'no movement to write into'
    : !responsive ? 'WEDGED: scroller ignores gestures after programmatic write mid-momentum'
    : changed ? 'write landed mid-momentum, scroller stays responsive'
    : 'write clamped; scroller stays responsive'
  console.log(`poll ended: ${end}; verdict: ${verdict}\n`)
  return { scenario: 'wedge', write: wr, scrollEvents: out.scrollEvents, responsive, verdict }
}

// --- main ----------------------------------------------------------------------------

const b = await connect()
console.log('connected\n')
await inWeb(b, () => b.execute(() => location.reload()))
await settle(1800)
for (let i = 0; i < 40; i++) {
  const ok = await inWeb(b, () => b.execute(() =>
    Boolean(window.mtty?.term?.bridge) && document.querySelectorAll('#screen .term-row').length > 0))
  if (ok) break
  await settle(500)
}
await dismissKeyboard(b)
await typeCommand(b, '/lines 400')
await settle(1200)
await dismissKeyboard(b)

const results = { url: BASE_URL, sim: UDID, ts: new Date().toISOString() }
if (MODE === 'momentum' || MODE === 'all') results.momentum = await runMomentum(b)
if (MODE === 'wedge' || MODE === 'all') results.wedge = await runWedge(b)

await inWeb(b, () => b.execute(() => clearInterval(window.__iv))).catch(() => {})
await b.deleteSession()
const out = new URL('./trace-results.json', import.meta.url).pathname
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`results written to ${out}`)
