import { WTerm } from '@wterm/dom'
import { TtydConnection } from './transport.js'
import { readViewport, deriveLayout, gridFor, measureCell, KEY_BAR_H } from './viewport.js'
import { keySequence } from './keys.js'

const $ = id => document.getElementById(id)
const app = $('app')
const viewport = $('viewport')
const stage = $('stage')
const screen = $('screen')
const bar = $('bar')
const toBottom = $('to-bottom')
const menu = $('menu')

// iOS keeps its own copy of a home-screen app's launch document however ttyd
// labels it — the served response is already `cache-control: no-store`. So the
// page checks for a newer build itself. A meta tag survives minification and
// reads the same from the live DOM and from a re-fetched copy.
const buildIdOf = doc => doc.querySelector('meta[name=build]')?.content ?? ''
const BUILD_ID = buildIdOf(document)

const MIN_SCALE = 0.4
const MAX_SCALE = 3
const PRESETS = [[50, 30], [80, 40], [120, 40], [160, 50]]

const state = {
  fontSize: 13,
  scale: 1,
  cols: 80,
  rows: 24,
  cell: { width: 8, height: 16 },
  mods: { ctrl: false, alt: false, shift: false },
}

// ---------------------------------------------------------------- terminal

const term = new WTerm(screen, {
  cols: state.cols,
  rows: state.rows,
  autoResize: false,
  cursorBlink: true,
  onData: data => conn.send(data),
})

const conn = new TtydConnection({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  socketFactory: (url, protocols) => new WebSocket(url, protocols),
  schedule: (fn, ms) => setTimeout(fn, ms),
  onOutput: bytes => term.write(bytes),   // raw bytes: the VT core reassembles UTF-8
  onTitle: title => { document.title = title },
  onState: s => { $('menu-state').textContent = `${s} · ${BUILD_ID}` },
})

// Diagnostic seam: the e2e suite and the on-device probe read the same shape.
// Published before startup finishes so nothing has to guess when it appears.
window.mtty = { conn, term, state, snapshot: () => ({ ...deriveLayout(readViewport()), ...state }) }

// ---------------------------------------------------------------- layout

/** Size the app to the visual viewport — the space above the keyboard. */
function applyLayout() {
  const snap = readViewport()
  const l = deriveLayout(snap)
  l.snapshot = snap
  app.style.height = `${l.appHeight}px`
  app.style.transform = `translateY(${snap.offsetTop}px)`
  app.style.paddingLeft = `${snap.insetLeft}px`
  app.style.paddingRight = `${snap.insetRight}px`
  app.style.paddingBottom = '0px'

  // The bar covers the home-indicator inset rather than leaving a gap under it.
  bar.style.height = `${l.keyBarHeight}px`
  bar.style.flexBasis = `${l.keyBarHeight}px`
  bar.style.paddingBottom = `${l.keyBarPadBottom}px`

  toBottom.style.bottom = `${l.keyBarHeight + 10}px`

  sizeScreen()
  return l
}

/**
 * The wterm element is the one scroller: scrollback above, live grid below, and
 * any part of a grid taller than the box reachable by the same gesture. Zoom is
 * a transform, so the PTY grid stays pinned.
 */
function sizeScreen() {
  const boxH = viewport.clientHeight
  if (boxH === 0) return

  // Pin the bottom, not the top. When the keyboard opens the window gets
  // shorter, and holding scrollTop would leave the top of the grid on screen
  // with pi's input box pushed out of sight underneath.
  const fromBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight

  // iOS will not drag-scroll reliably inside a transformed overflow container,
  // and at 100% the transform buys nothing, so leave it off entirely.
  const scaled = state.scale !== 1
  const naturalW = state.cols * state.cell.width
  screen.style.width = `${naturalW}px`
  screen.style.height = `${boxH / state.scale}px`
  screen.style.transform = scaled ? `scale(${state.scale})` : ''
  stage.style.width = `${naturalW * state.scale}px`
  stage.style.height = `${boxH}px`

  screen.scrollTop = screen.scrollHeight - screen.clientHeight - Math.max(0, fromBottom)
}

function setGrid(cols, rows) {
  state.cols = cols
  state.rows = rows
  term.resize(cols, rows)
  conn.resize(cols, rows)
  sizeScreen()
}

function setScale(scale) {
  state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  $('scale-val').textContent = `${Math.round(state.scale * 100)}%`
  sizeScreen()
}

/**
 * Size the grid to the device, not to the moment. Rows come from the layout
 * viewport so the keyboard opening never reflows pi; only what is visible
 * changes.
 */
function fitGrid(l = deriveLayout(readViewport())) {
  // Divided by the scale on purpose: at 80% zoom more grid genuinely fits the
  // same glass, and Fit means fill what you can see.
  const { cols, rows } = gridFor(l.terminal.width / state.scale, l.stableHeight / state.scale, state.cell)
  setGrid(cols, rows)
}

// visualViewport fires a burst during rotation and keyboard animation, and the
// intermediate values are wrong. Act at once, then again once it settles.
let settle = null
let orientation = null   // seeded by the first layout in main()

function onViewportChange() {
  applyLayout()
  clearTimeout(settle)
  settle = setTimeout(() => {
    const l = applyLayout()
    // Rotating is a deliberate act and landscape is worth ~2x the columns, so
    // it refits. The keyboard and browser chrome are not deliberate, and never
    // touch the grid.
    if (l.orientation !== orientation) {
      orientation = l.orientation
      fitGrid(l)
    }
  }, 200)
}

// ---------------------------------------------------------------- key bar

const BAR = [
  { label: '⌃', mod: 'ctrl' },
  { label: '⌥', mod: 'alt' },
  { label: '⇧', mod: 'shift' },
  { label: 'esc', key: 'Escape' },
  { label: '⇥', key: 'Tab' },
  { label: '←', key: 'Left', repeat: true },
  { label: '↓', key: 'Down', repeat: true },
  { label: '↑', key: 'Up', repeat: true },
  { label: '→', key: 'Right', repeat: true },
  // pi answers PageUp/PageDown with a cursor move and nothing else, and history
  // lives in the client's scrollback, so these page the view rather than the app.
  { label: '⇈', name: 'PageUp', act: () => pageBy(-1), repeat: true },
  { label: '⇊', name: 'PageDown', act: () => pageBy(1), repeat: true },
  { label: '≡', name: 'menu', act: () => { showDiagnostics(); menu.hidden = false } },
]

const pageBy = direction => { screen.scrollTop += direction * screen.clientHeight * 0.9 }

function sendKey(name) {
  const { ctrl, alt, shift } = state.mods
  conn.send(keySequence(name, { ctrl, alt, shift, cursorKeysApp: term.bridge.cursorKeysApp() }))
  clearMods()
}

function clearMods() {
  for (const m of Object.keys(state.mods)) state.mods[m] = false
  for (const b of bar.children) b.classList.toggle('sticky', b.dataset.mod && state.mods[b.dataset.mod])
}

function buildBar() {
  for (const item of BAR) {
    const b = document.createElement('button')
    b.textContent = item.label
    b.setAttribute('aria-label', item.name ?? item.key ?? item.mod)
    if (item.name === 'PageUp' || item.name === 'PageDown') b.classList.add('page')
    if (item.mod) {
      b.dataset.mod = item.mod
      b.addEventListener('pointerdown', e => {
        e.preventDefault()
        state.mods[item.mod] = !state.mods[item.mod]
        b.classList.toggle('sticky', state.mods[item.mod])
      })
    } else {
      bindRepeat(b, item.act ?? (() => sendKey(item.key)), item.repeat)
    }
    bar.appendChild(b)
  }
}

/** Fire on press, and for navigation keys keep firing while held. */
function bindRepeat(btn, fire, repeat) {
  let delay, timer
  const stop = () => { clearTimeout(delay); clearInterval(timer) }
  btn.addEventListener('pointerdown', e => {
    e.preventDefault()
    fire()
    if (repeat) delay = setTimeout(() => { timer = setInterval(fire, 60) }, 400)
  })
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop)
}

// ---------------------------------------------------------------- diagnostics

/**
 * A phone shows no stack trace, so a client that dies during startup looks like
 * missing chrome or scrolling that will not scroll — symptoms with no visible
 * cause. Put the error on the screen instead.
 */
function reportFatal(what) {
  const overlay = $('diag-overlay')
  if (!overlay) return
  let detail
  try { detail = diagnosticText() } catch (e) { detail = `diagnostics failed: ${e}` }
  overlay.textContent = `ERROR — ${what}\n\n${detail}`
  overlay.hidden = false
}

window.addEventListener('error', e => reportFatal(`${e.message} @ ${e.lineno}:${e.colno}`))
window.addEventListener('unhandledrejection', e => reportFatal(`unhandled: ${e.reason?.message ?? e.reason}`))

/** On-device readout. The emulator cannot report insets or a real keyboard. */
function diagnosticText() {
  const s = readViewport()
  const l = deriveLayout(s)
  const b = term.bridge
  const sb = b ? `${b.getScrollbackCount()} rows` : 'no core'
  return [
    `build    ${BUILD_ID}   standalone ${s.standalone}`,
    `inner    ${s.innerWidth}x${s.innerHeight}   visual ${Math.round(s.visualWidth)}x${Math.round(s.visualHeight)} @${s.offsetTop}`,
    `insets   t${s.insetTop} r${s.insetRight} b${s.insetBottom} l${s.insetLeft}`,
    `keyboard ${l.keyboardHeight} (up ${l.keyboardUp})   ${l.orientation}`,
    `bar      ${l.keyBarHeight} (pad ${l.keyBarPadBottom})  rect ${JSON.stringify(bar.getBoundingClientRect().toJSON().top)}..${Math.round(bar.getBoundingClientRect().bottom)}`,
    `app      ${Math.round(app.getBoundingClientRect().top)}..${Math.round(app.getBoundingClientRect().bottom)}  screen ${window.screen.width}x${window.screen.height}`,
    `grid     ${state.cols}x${state.rows} cell ${state.cell.width.toFixed(2)}x${state.cell.height} scale ${state.scale}`,
    `term     ${Math.round(l.terminal.width)}x${Math.round(l.terminal.height)}  stable ${Math.round(l.stableHeight)}`,
    `scroll   top ${screen.scrollTop} of ${screen.scrollHeight} in ${screen.clientHeight}`,
    `sb       ${sb}   domRows ${screen.querySelectorAll('.term-row').length}`,
    `overflow ${getComputedStyle(screen).overflowY}   class ${screen.className}`,
  ].join('\n')
}

function showDiagnostics() { $('diag').textContent = diagnosticText() }


function buildMenu() {
  const presets = $('presets')
  for (const [c, r] of PRESETS) {
    const b = document.createElement('button')
    b.textContent = `${c}×${r}`
    b.addEventListener('click', () => setGrid(c, r))
    presets.appendChild(b)
  }
  const fit = document.createElement('button')
  fit.textContent = 'Fit'
  fit.addEventListener('click', fitGrid)
  presets.appendChild(fit)

  const acts = {
    close: () => { menu.hidden = true },
    'zoom-in': () => setScale(state.scale * 1.25),
    'zoom-out': () => setScale(state.scale / 1.25),
    'zoom-reset': () => setScale(1),
    reconnect: () => conn.ws.close(),
    // Local only: pi's own screen is untouched and its next repaint restores it.
    'clear-view': () => term.write('\x1b[H\x1b[2J\x1b[3J'),
    // Standalone has no browser chrome, so this is the only way to pick up a
    // new build by hand. Re-fetch past the cache first, or the reload just
    // reinstates the copy iOS is already holding.
    reload: async () => {
      sessionStorage.removeItem('reloaded')
      await fetch(location.pathname, { cache: 'reload' })
      location.reload()
    },
  }
  menu.addEventListener('click', e => {
    const target = e.target.closest('[data-act]')
    if (target) acts[target.dataset.act]()
    else if (e.target === menu) menu.hidden = true
  })
}

// ---------------------------------------------------------------- start

async function checkForNewBuild() {
  // Best effort: a dropped tunnel is not a client fault, and an unhandled
  // rejection here would paint the error panel over a working terminal.
  const html = await fetch(location.pathname, { cache: 'reload' }).then(r => r.text()).catch(() => '')
  const served = buildIdOf(new DOMParser().parseFromString(html, 'text/html'))
  if (!served || served === BUILD_ID || sessionStorage.getItem('reloaded') === served) return
  sessionStorage.setItem('reloaded', served)   // one reload per served build, never a loop
  location.reload()
}

async function main() {
  state.cell = measureCell(state.fontSize)
  // Set on the element, not :root — `.wterm` declares its own defaults, which
  // would win over anything merely inherited.
  screen.style.setProperty('--term-font-size', `${state.fontSize}px`)
  screen.style.setProperty('--term-row-height', `${state.cell.height}px`)

  document.documentElement.style.setProperty('--bar-h', `${KEY_BAR_H}px`)
  buildBar()
  buildMenu()
  $('diag-overlay').addEventListener('click', () => { $('diag-overlay').hidden = true })
  setScale(1)

  await term.init()

  screen.addEventListener('scroll', () => {
    const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 8
    toBottom.hidden = atBottom
  })
  toBottom.addEventListener('click', () => { screen.scrollTop = screen.scrollHeight })

  const first = applyLayout()
  orientation = first.orientation
  fitGrid(first)
  // env() insets are not resolved on the first pass, so the first fit is short
  // by the bottom inset and leaves rows permanently below the fold. Refit once
  // the real values are in.
  requestAnimationFrame(() => fitGrid(applyLayout()))
  conn.connect({ cols: state.cols, rows: state.rows })

  checkForNewBuild()

  visualViewport.addEventListener('resize', onViewportChange)
  visualViewport.addEventListener('scroll', onViewportChange)
  window.addEventListener('orientationchange', onViewportChange)
}

main().catch(e => reportFatal(`startup: ${e?.message ?? e}`))
