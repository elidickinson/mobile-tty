import { WTerm } from '@wterm/dom'
import { TtydConnection } from './transport.js'
import { readViewport, deriveLayout, gridFor, measureCell } from './viewport.js'
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
  app.style.height = `${l.appHeight}px`
  app.style.transform = `translateY(${snap.offsetTop}px)`
  app.style.paddingLeft = `${snap.insetLeft}px`
  app.style.paddingRight = `${snap.insetRight}px`

  // The bar owns the home-indicator inset instead of leaving a gap under it.
  bar.style.height = `${l.keyBarHeight}px`
  bar.style.flexBasis = `${l.keyBarHeight}px`
  bar.style.paddingBottom = `${l.keyBarPadBottom}px`

  toBottom.style.bottom = `${l.keyBarHeight + 10}px`

  sizeScreen()
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

  const naturalW = state.cols * state.cell.width
  screen.style.width = `${naturalW}px`
  screen.style.height = `${boxH / state.scale}px`
  screen.style.transform = `scale(${state.scale})`
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

function fitGrid() {
  const boxH = viewport.clientHeight / state.scale
  const boxW = viewport.clientWidth / state.scale
  const { cols, rows } = gridFor(boxW, boxH, state.cell)
  setGrid(cols, rows)
}

// visualViewport fires a burst during rotation and keyboard animation, and the
// intermediate values are wrong. Act at once, then again once it settles.
let settle = null
function onViewportChange() {
  applyLayout()
  clearTimeout(settle)
  settle = setTimeout(applyLayout, 200)
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
  { label: '⇞', name: 'PageUp', act: () => pageBy(-1), repeat: true },
  { label: '⇟', name: 'PageDown', act: () => pageBy(1), repeat: true },
  { label: '≡', name: 'menu', act: () => { menu.hidden = false } },
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

// ---------------------------------------------------------------- menu

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
    clear: () => term.write('\x1b[H\x1b[2J\x1b[3J'),
  }
  menu.addEventListener('click', e => {
    const act = e.target.dataset?.act
    if (act) acts[act]()
    else if (e.target === menu) menu.hidden = true
  })
}

// ---------------------------------------------------------------- start

async function checkForNewBuild() {
  const html = await fetch(location.pathname, { cache: 'reload' }).then(r => r.text())
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

  buildBar()
  buildMenu()
  setScale(1)

  await term.init()

  screen.addEventListener('scroll', () => {
    const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 8
    toBottom.hidden = atBottom
  })
  toBottom.addEventListener('click', () => { screen.scrollTop = screen.scrollHeight })

  applyLayout()
  fitGrid()
  conn.connect({ cols: state.cols, rows: state.rows })

  checkForNewBuild()

  visualViewport.addEventListener('resize', onViewportChange)
  visualViewport.addEventListener('scroll', onViewportChange)
  window.addEventListener('orientationchange', onViewportChange)
}

main()
