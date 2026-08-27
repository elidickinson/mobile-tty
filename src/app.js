// The client: wires the terminal to the socket, and owns the layout, the key
// bar, the menu and the on-screen diagnostics.
import { WTerm } from '@wterm/dom'
import { WasmBridge } from '@wterm/core'
import { TtydConnection } from './transport.js'
import { readViewport, deriveLayout, gridFor, measureCell, KEY_BAR_H } from './viewport.js'
import { keySequence } from './keys.js'

const $ = id => document.getElementById(id)
const app = $('app')
const viewport = $('viewport')
const stage = $('stage')
const screen = $('screen')
const bar = $('bar')
const keys = $('keys')
const strip = $('strip')
const toBottom = $('to-bottom')
const menu = $('menu')
const places = $('places')
const placeNow = $('place-now')

// iOS keeps its own copy of a home-screen app's launch document despite the
// server's `cache-control: no-cache`. So the page checks for a newer build
// itself. A meta tag survives minification and reads the same from the live DOM
// and from a re-fetched copy.
const buildIdOf = doc => doc.querySelector('meta[name=build]')?.content ?? ''
const BUILD_ID = buildIdOf(document)

// Sequences written to our own terminal, never sent to pi. ED 3 is specified as
// erasing only the saved lines, but this VT core erases the visible grid with
// it — so it is only ever useful alongside ED 2, never on its own.
const CURSOR_HOME = '\x1b[H'        // CUP: cursor to row 1, column 1
const ERASE_SCREEN = '\x1b[2J'      // ED 2: erase the visible grid
const ERASE_SAVED = '\x1b[3J'       // ED 3: erase saved lines, and here the grid too

const MIN_SCALE = 0.4
const MAX_SCALE = 3
const ZOOM_STEP = 1.25
const SETTLE_MS = 200          // viewport values are wrong mid-rotation and mid-keyboard
const REPEAT_AFTER_MS = 400    // hold an arrow this long before it repeats
const REPEAT_EVERY_MS = 60
const PRESETS = [[50, 30], [80, 40], [120, 40], [160, 50]]

const state = {
  fontSize: 13,
  scale: 1,
  cols: 80,
  rows: 24,
  // What we asked the server for. It differs from cols/rows whenever another
  // viewer is narrower, which is what being letterboxed looks like from here.
  wanted: { cols: 80, rows: 24 },
  cell: { width: 8, height: 16 },
  mods: { ctrl: false, alt: false, shift: false },
}

// ---------------------------------------------------------------- terminal

const term = new WTerm(screen, {
  cols: state.cols,
  rows: state.rows,
  autoResize: false,
  cursorBlink: true,
  onData: data => conn.send(withMods(data)),
})

const conn = new TtydConnection({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  socketFactory: (url, protocols) => new WebSocket(url, protocols),
  schedule: (fn, ms) => setTimeout(fn, ms),
  onOutput: bytes => { lastOutput = Date.now(); deliver(bytes) },
  // The title is only restated when the session is (a fresh admission, or a
  // switch to another folder), and the strip belongs to whichever program was
  // running before that. Drop it rather than leave the last one's model and
  // thinking level sitting under a different session; the new one's own line
  // arrives within a poll.
  onTitle: title => { document.title = title; clearFooter(); confirmSwitch(title) },
  onSize: ({ cols, rows }) => { snapshotPending = true; applyServerSize(cols, rows) },
  onFooter: showFooter,
  onPlaces: showPlaces,
  onState: status => {
    // 'connecting' covers reconnectNow (which closes the old socket so its
    // onclose never fires) as well as every ordinary open.
    if (status !== 'connected') dropHeld()
    showConnection(status)
  },
})

/** The menu is hidden by default, so connection state has to live outside it. */
function showConnection(status) {
  if (status === 'disconnected') clearFooter()
  $('menu-state').textContent = `${status} · ${BUILD_ID}`
  const bolt = $('conn')
  bolt.textContent = '⚡'
  bolt.setAttribute('aria-label', status)
  bolt.title = status
  bolt.hidden = status === 'connected'
}

// Diagnostic seam: the e2e suite and the on-device probe read the same shape.
// Published before startup finishes so nothing has to guess when it appears.
window.mtty = { conn, term, state, checkForNewBuild }

// ---------------------------------------------------------------- strip

let footerText = null

/**
 * pi's stats in full, captured by the mtty-footer extension and relayed by the
 * server, but only worth a row in standalone: there the strip sits in the
 * home-indicator band and costs nothing while the keyboard is down. In a
 * Safari tab the band is too small and every row is one visible fewer, so the
 * strip stays hidden there entirely.
 */
function setStripVisibility(visible) {
  if (strip.hidden === !visible) return
  // Where the bar changes size for the strip, that must not move the eye:
  // parked readers keep their position, and a view pinned to the live screen
  // stays pinned (sizeScreen's own bottom-pinning does that).
  const pinned = atBottom()
  const top = screen.scrollTop
  strip.hidden = !visible
  applyLayout()
  if (!pinned) screen.scrollTop = top
}

function clearFooter() {
  footerText = null
  strip.textContent = ''
  setStripVisibility(false)
}

function showFooter(text) {
  // Standalone only. `navigator.standalone` is a stable fact of how the page
  // was opened, so checking it here without storing it is enough. In a Safari
  // tab the strip is never even parsed: it would cost a row for no gain.
  if (!readViewport().standalone) return
  try {
    footerText = JSON.parse(text).text
  } catch (err) {
    // The extension renames the file into place, so a half-written line is a
    // bug in this chain, not noise to swallow.
    return reportFatal(`footer: ${err.message}`)
  }
  strip.textContent = footerText
  setStripVisibility(true)
}

// ---------------------------------------------------------------- layout

/** Size the app to the visual viewport — the space above the keyboard. */
function applyLayout() {
  const snap = readViewport()
  const l = deriveLayout(snap, { stripHeight: strip.hidden ? 0 : state.cell.height })
  app.style.height = `${l.appHeight}px`
  app.style.transform = `translateY(${snap.offsetTop}px)`
  app.style.paddingLeft = `${snap.insetLeft}px`
  app.style.paddingRight = `${snap.insetRight}px`

  // The bar covers the home-indicator inset rather than leaving a gap under it.
  // flex-basis alone sizes a column flex item; `height` would be a third layer
  // saying the same thing, after the CSS var that covers the first paint.
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
  // A whole number of rows. wterm scrolls to the bottom by flooring to a row
  // boundary, so a box that is not a multiple of the row height leaves it parked
  // short of the end — and once that remainder exceeds its own 5px tolerance it
  // stops following output at all. The leftover is under a row of background.
  const rows = Math.floor(boxH / state.scale / state.cell.height)
  screen.style.width = `${naturalW}px`
  screen.style.height = `${rows * state.cell.height}px`
  screen.style.transform = scaled ? `scale(${state.scale})` : ''
  stage.style.width = `${naturalW * state.scale}px`
  stage.style.height = `${boxH}px`

  screen.scrollTop = screen.scrollHeight - screen.clientHeight - Math.max(0, fromBottom)
}

// A resize reaches pi as SIGWINCH and makes it repaint, so it waits for the
// output to stop rather than landing in the middle of one. Our own core is not
// the reason: it holds a partial sequence across a resize and finishes parsing
// it afterwards.
const QUIET_MS = 120
let lastOutput = 0
let pendingGrid = null

function setGrid(cols, rows) {
  pendingGrid = { cols, rows }
  applyPendingGrid()
}

function applyPendingGrid() {
  if (!pendingGrid) return
  clearTimeout(applyPendingGrid.timer)
  const since = Date.now() - lastOutput
  if (since < QUIET_MS) {
    applyPendingGrid.timer = setTimeout(applyPendingGrid, QUIET_MS - since)
    return
  }
  const { cols, rows } = pendingGrid
  pendingGrid = null
  state.wanted = { cols, rows }
  conn.resize(cols, rows)
}

/**
 * Render at the grid the PTY actually has.
 *
 * The server owns the PTY and gives it to the narrowest viewer, so what we ask
 * for and what we get are not always the same. Rendering anything other than
 * the real grid would mean parsing a relative stream drawn for a different
 * width, which is wrong in a way that looks like a layout bug.
 */
// A grid change is followed by a snapshot that replaces the whole buffer, and
// the rendered rows are dropped before it arrives. Reading position therefore
// has to be taken before the resize and put back once wterm has rendered the
// repaint, which it does on a later frame — but a live stream can keep
// growing the buffer forever, so this cannot just wait for it to settle. It
// gives up after a fixed window, and anything that moves the scroll on its
// own terms — a drag, Top/Bottom, the back-to-live button — cancels it.
let stopReading = () => {}
// The share the re-pin in flight is holding the reader at, null when none is.
let readingShare = null

function applyServerSize(cols, rows) {
  if (cols === state.cols && rows === state.rows) return
  // How far up the history the eye is, as a share of the whole — the only
  // measure that survives a reflow, since pixels and rows both change. A
  // resize landing inside another one's reflow reads the emptied DOM as
  // at-bottom and would abandon the reader on the strength of it, so a re-pin
  // already in flight is the honest answer there.
  const share = readingShare ?? (atBottom() || screen.scrollHeight === 0
    ? null
    : (screen.scrollHeight - screen.scrollTop - screen.clientHeight) / screen.scrollHeight)
  state.cols = cols
  state.rows = rows
  term.resize(cols, rows)
  meter?.resize(cols, rows)             // wrapping is width-dependent, so the meter must match
  sizeScreen()
  if (share !== null) keepReading(share)
}

// Long enough for wterm's own repaint to land after a resize; not a promise to
// hold position against output that is still streaming in.
const READING_MS = 600

/** Re-apply the position on every frame until the repaint settles or gives up. */
function keepReading(share) {
  stopReading() // a newer resize, or the user, cancels whatever was running
  // After that cancel, never before it: the outgoing re-pin clears both of
  // these on its way out, and the incoming one needs them set.
  resettling = true
  readingShare = share
  const deadline = performance.now() + READING_MS
  let last = -1
  let frames = 0
  const cancel = () => {
    // A stale cancel firing after a newer resize has already taken over must
    // not clear that newer one's ownership — checked, not assumed, because a
    // resize landing before the next frame calls this twice: once directly,
    // once from its own step's guard.
    if (stopReading === cancel) {
      stopReading = () => {}
      resettling = false
      readingShare = null
    }
    screen.removeEventListener('pointerdown', cancel)
    screen.removeEventListener('wheel', cancel)
  }
  stopReading = cancel
  screen.addEventListener('pointerdown', cancel, { passive: true })
  screen.addEventListener('wheel', cancel, { passive: true })
  const step = () => {
    if (stopReading !== cancel || performance.now() > deadline) { cancel(); return }
    const h = screen.scrollHeight
    screen.scrollTop = h - screen.clientHeight - share * h
    toBottom.hidden = atBottom()
    if (h === last) { if (++frames > 3) { cancel(); return } } else { last = h; frames = 0 }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
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
  }, SETTLE_MS)
}

// ---------------------------------------------------------------- scrolling

/**
 * A row with nothing on it. Blank cells coalesce into one bare `<span>` of
 * spaces, so anything carrying a class or a style — the cursor, a block glyph
 * drawn as a background, a coloured run — is content even where its text is
 * empty.
 */
const rowIsBlank = row => !row.textContent.trim() && !row.querySelector('span[class],span[style]')

/**
 * Hide the empty rows at the foot of the grid, so the scroller ends where the
 * program stopped writing.
 *
 * Everything that means "the bottom" measures the scroller — sizeScreen's pin,
 * atBottom, and wterm's own follow-output and scroll-on-keystroke, which this
 * client does not own. Ending its content at the last written row corrects all
 * of them at once, where a content-aware scroll target here would be undone by
 * the next keystroke.
 */
function trimBlankTail() {
  const rows = term.renderer.rowEls
  let cut = rows.length
  while (cut > 0 && rowIsBlank(rows[cut - 1])) cut--
  for (let i = 0; i < rows.length; i++) {
    const blank = i >= cut
    if (rows[i].hidden !== blank) rows[i].hidden = blank
  }
}

// wterm owns sticking to the bottom: it checks the position before each write,
// re-pins after rendering, and jumps back on a keystroke. This only decides
// whether to offer the way back, and uses wterm's own tolerance so the two
// cannot disagree about whether you are on the live screen.
const AT_BOTTOM_PX = 5
const atBottom = () => screen.scrollHeight - screen.scrollTop - screen.clientHeight < AT_BOTTOM_PX

// Reading beats liveness. Output that arrives while the reader is up in
// history is held back rather than rendered under them: at the ring cap the
// rendered scrollback is a fossil, so a flowing stream reads as history that
// lies next to a grid that moves — the seam this section exists to close.
// Holding pauses the terminal rather than corrupting it: bytes replay in
// order the moment the reader returns to the bottom, and the button that
// offers the way back counts what is waiting.
const HELD_MAX = 4 * 1024 * 1024
const TO_BOTTOM_LABEL = toBottom.textContent
const held = []
let heldBytes = 0
// True across a resize's reflow: term.resize empties the rendered rows, so
// for one turn the scroller is "at the bottom" by geometry alone, and output
// or a flush acting on that would change content under a parked reader. Set
// by keepReading, cleared when its re-pin settles or gives up.
let resettling = false
// An honest "N new" needs a terminal, not byte arithmetic: a repainting
// program emits a newline per rewritten row while scrolling nothing, and
// wrapping emits none while scrolling plenty. A second core, fed the held
// bytes out-of-band, scrolls for real — its scrollback count IS the rows the
// stream would have pushed past the eye. That count pins at the ring cap;
// "1000+" is all a reader that far behind needs to know.
let meter = null
const ED3 = new Uint8Array([0x1b, 0x5b, 0x33, 0x4a])

const labelHeld = () => {
  const n = meter.getScrollbackCount()
  toBottom.textContent = n >= 1000 ? '↓ 1000+ new' : `↓ ${n} new`
}
// The client sends size with its handshake and the server answers with a
// snapshot — and it sends the pair again on resize and folder switch, with
// no connection-state transition to watch for. So a size report is the one
// reliable "snapshot next" signal for this client, and the first output
// after one bypasses the hold: queued behind a parked reader it would leave
// them looking at a stale screen, and at the ring cap it would wipe their
// history on return.
let snapshotPending = false

function flushHeld() {
  if (!held.length) return
  // Shift-per-write, not splice-then-write: a write that throws mid-replay
  // costs the rest of the queue, not the whole of it — and the finally puts
  // the label and the pending grid back whatever happened.
  try {
    while (held.length) {
      const bytes = held.shift()
      heldBytes -= bytes.length
      term.write(bytes)
    }
  } finally {
    meter.writeRaw(ED3)               // scrollback count back to zero
    toBottom.textContent = TO_BOTTOM_LABEL
    applyPendingGrid()
  }
}

/** The hold is dropped, not flushed, on a disconnect: the reconnect snapshot supersedes it. */
function dropHeld() {
  held.length = 0
  heldBytes = 0
  meter.writeRaw(ED3)
  toBottom.textContent = TO_BOTTOM_LABEL
}

function deliver(bytes) {
  if (snapshotPending) {
    snapshotPending = false
    // Everything being held is already inside the snapshot: the server writes
    // its mirror the same bytes it sends us, and serializes it at a boundary
    // behind them. Replaying the hold on top would apply it twice — history
    // gaining lines that were only ever produced once.
    dropHeld()
    term.write(bytes)
    applyPendingGrid()
    // The snapshot reset the core, so the rendered window's keys no longer
    // match the fresh core's counts and the next render redraws it wholesale.
    return
  }
  // The scroll event normally flushes on return to the bottom, but its
  // dispatch can trail the next chunk, and replay order must not depend on
  // that race: whatever is held goes first, always. A resize in flight
  // suspends the at-bottom verdict entirely (see `resettling`).
  const live = atBottom() && !resettling
  if (held.length && live) flushHeld()
  if (live) { term.write(bytes); applyPendingGrid(); return }
  held.push(bytes)
  heldBytes += bytes.length
  meter.writeRaw(bytes)
  // Past the cap this is a memory valve, nothing more: the wave lands where
  // the box stands and the hold resumes with the next chunk. A reader this
  // far ahead of the stream is not reading.
  if (heldBytes > HELD_MAX) flushHeld()
  else labelHeld()
}

function onScroll() {
  const bottom = atBottom() && !resettling
  toBottom.hidden = bottom
  if (bottom) {
    // Landing on the bottom is the reader asking for live again. wterm's own
    // scroll handler clears its follow-output latch on every scroll — its
    // keystroke and pin paths re-set it, but a jump to the bottom lands here
    // first — and at a saturated ring its rotation compensation then walks
    // the box off the bottom a row at a time, silently holding live output.
    // Re-assert the latch so follow-output wins over compensation.
    term._shouldScrollToBottom = true
    flushHeld()
  }
}

// ---------------------------------------------------------------- key bar

// For a letter key, meta is just an ESC prefix, so `esc` then `b` is
// byte-identical to alt+b and there would be nothing this button adds. Arrows
// are the exception: alt+Up is one CSI sequence with a modifier parameter
// (\e[1;3A), not reproducible by sending esc and Up separately — those stay
// two unrelated sequences, and esc alone is a real keystroke on its own (it
// aborts the current task), not a modifier waiting to be paired.
const BAR = [
  { label: '⌃', mod: 'ctrl' },
  { label: '⇧', mod: 'shift' },
  { label: '⌥', mod: 'alt' },
  { label: 'esc', key: 'Escape' },
  { label: '⇥', key: 'Tab' },
  // The software keyboard will not repeat its own backspace: wterm empties the
  // hidden field after every keystroke, so iOS sees nothing left to delete.
  { label: '⌫', key: 'Backspace', repeat: true },
  { label: '←', key: 'Left', repeat: true },
  { label: '↓', key: 'Down', repeat: true },
  { label: '↑', key: 'Up', repeat: true },
  { label: '→', key: 'Right', repeat: true },
  { label: '⌨', name: 'keyboard', cls: 'wide', act: () => toggleKeyboard() },
  { label: '≡', name: 'menu', act: openMenu },
]

const terminalInput = () => screen.querySelector('textarea')

// A bar key must not dismiss the keyboard. iOS ends editing when DOM focus
// leaves the textarea, and a tap's default activation would move focus to the
// button. Bar buttons are non-focusable and their press is prevented, so focus
// never leaves the input and the keyboard stays up.

/** The app's own close-the-keyboard buttons blur the input, deliberately. */
function dismissKeyboard() {
  const input = terminalInput()
  if (document.activeElement === input) input.blur()
}

/**
 * Summon or dismiss the software keyboard without having to find something to
 * tap. iOS only opens it from inside a user gesture, which a pointerdown is.
 */
function toggleKeyboard() {
  if (document.activeElement === terminalInput()) dismissKeyboard()
  else term.focus()
}

/** The keyboard would cover most of the menu, so it goes away first. */
/** Show the readout instead of the menu, or the menu instead of the readout. */
function foldDiag(open) {
  $('diag').hidden = !open
  $('menu-main').hidden = open
  $('diag-caret').textContent = open ? '▾' : '▸'
}

function openMenu() {
  dismissKeyboard()
  // Always on the ordinary view: the menu is mostly the folder switcher now,
  // and opening into last time's diagnostics would be a puzzle.
  foldDiag(false)
  // Asked for on the way in rather than held from last time: pi is used from
  // other terminals too, so the list goes stale between openings.
  conn.askPlaces()
  menu.hidden = false
}

// ---------------------------------------------------------------- folders

/**
 * The folders pi has history in, newest first, as the server found them.
 *
 * Switching ends the program that is running now — there is one PTY, and it is
 * the session. So a row does not act on its own: tapping it opens the two ways
 * to go, which is the confirmation as much as it is the choice. An accidental
 * brush against a list on a phone must not be able to kill a working agent.
 */
function showPlaces({ cwd, resume, places: list }) {
  // The folder in front of you is always in the list, so this cannot miss.
  placeNow.textContent = list.find(place => place.cwd === cwd).path
  clearSwitching()
  places.textContent = ''

  const go = (place, wantResume, row) => {
    clearSwitching()
    row.classList.remove('failed')
    row.classList.add('switching')
    // The menu deliberately stays open. A tap can fail to arrive at all — a
    // sleeping phone, a dropped tunnel — or be refused by the server for a
    // folder that has gone since the list was built, and both look exactly
    // like a slow switch from here. Closing now would call all three a success.
    switching = { path: place.path, row, timer: null }
    if (!conn.switchTo(place.cwd, wantResume)) return void fellSilent()
    switching.timer = setTimeout(fellSilent, SWITCH_ACK_MS)
  }

  for (const place of list) {
    const row = document.createElement('div')
    row.className = place.cwd === cwd ? 'place here' : 'place'

    const name = document.createElement('span')
    name.className = 'place-name'
    name.textContent = place.name
    const path = document.createElement('span')
    path.className = 'place-path'
    path.textContent = place.path

    const head = document.createElement('button')
    head.className = 'place-head'
    head.append(name, path)

    const actions = document.createElement('div')
    actions.className = 'place-actions'
    actions.hidden = true
    actions.append(placeAction('Start here', () => go(place, false, row)))
    // Only where continuing means something. `--continue` is pi's flag, and the
    // server serves whatever program it was given.
    if (resume) actions.append(placeAction('Continue here', () => go(place, true, row)))

    head.addEventListener('click', () => {
      const opening = actions.hidden
      closePlaces()
      actions.hidden = !opening
      row.classList.toggle('open', opening)
    })

    row.append(head, actions)
    places.append(row)
  }
}

// Long enough to cover a real switch — the outgoing program gets a two-second
// grace before it is killed, and the new one has to start after that — so this
// is not a deadline the ordinary case can trip over.
const SWITCH_ACK_MS = 5000

let switching = null

/**
 * The title, restated with the new folder, is the server saying it happened.
 *
 * There is no acknowledgement frame and none is needed: a switch that worked
 * always retitles, and matching the folder we asked for distinguishes it from
 * the retitle a plain reconnection sends.
 */
function confirmSwitch(title) {
  if (!switching || !title.endsWith(`— ${switching.path}`)) return
  clearSwitching()
  menu.hidden = true
}

/**
 * Nothing came back. Not the same as knowing it failed — a switch that is
 * merely slow still lands, and is still believed when it does, because this
 * only marks the row and leaves the wait running.
 */
function fellSilent() {
  switching.row.classList.remove('switching')
  switching.row.classList.add('failed')
}

function clearSwitching() {
  if (!switching) return
  clearTimeout(switching.timer)
  switching.row.classList.remove('switching')
  switching = null
}

/** Collapse every row, so only one folder is ever asking to be chosen. */
function closePlaces() {
  for (const el of places.querySelectorAll('.place-actions')) el.hidden = true
  for (const el of places.querySelectorAll('.place')) el.classList.remove('open')
}

function placeAction(label, act) {
  const button = document.createElement('button')
  button.textContent = label
  button.addEventListener('click', act)
  return button
}

/**
 * Apply a sticky modifier to a key from the software keyboard. Those arrive
 * through wterm rather than the key bar, so without this `⌃` then `c` sends a
 * bare `c` and Ctrl-C is unreachable. Only single characters qualify — a paste
 * or a dictated phrase is not a chord.
 */
function withMods(data) {
  const { ctrl, alt, shift } = state.mods
  if (data.length !== 1) return data
  // Any single key consumes the modifiers, including a lone shift the OS
  // keyboard already applied — otherwise it stays lit and silently lands on
  // whatever bar key comes next.
  clearMods()
  if (!(ctrl || alt)) return data
  return keySequence(data, { ctrl, alt, shift })
}

function sendKey(name) {
  const { ctrl, alt, shift } = state.mods
  // The bar exists before the WASM core finishes loading, and DECCKM is reset
  // by definition until an app sets it — so normal-mode CSI is the answer, not
  // a crash on an early tap.
  const cursorKeysApp = term.bridge?.cursorKeysApp() ?? false
  conn.send(keySequence(name, { ctrl, alt, shift, cursorKeysApp }))
  clearMods()
}

function clearMods() {
  for (const m of Object.keys(state.mods)) state.mods[m] = false
  // Only the modifier keys carry the highlight. `toggle(cls, undefined)` flips
  // rather than removes, so touching the others lit up half the bar.
  for (const b of keys.children) if (b.dataset.mod) b.classList.remove('sticky')
}

function buildBar() {
  for (const item of BAR) {
    const b = document.createElement('button')
    b.textContent = item.label
    b.setAttribute('aria-label', item.name ?? item.key ?? item.mod)
    if (item.label.length > 1) b.classList.add('word')
    if (item.cls) b.classList.add(item.cls)
    // Keeps the terminal's textarea focused. A tap's default activation would
    // move DOM focus to this (focusable) button, and iOS ends editing whenever
    // focus leaves the editable input — that blur is what dismisses the
    // keyboard. So the button drops out of tab order (tabindex=-1) and its
    // default press/click is cancelled, which leaves the textarea focused
    // through the whole gesture.
    b.tabIndex = -1
    b.addEventListener('pointerdown', e => e.preventDefault())
    b.addEventListener('touchstart', e => e.preventDefault(), { passive: false })
    if (item.mod) {
      b.dataset.mod = item.mod
      b.addEventListener('pointerdown', () => {
        state.mods[item.mod] = !state.mods[item.mod]
        b.classList.toggle('sticky', state.mods[item.mod])
      })
    } else {
      bindRepeat(b, item.act ?? (() => sendKey(item.key)), item.repeat)
    }
    keys.appendChild(b)
  }
}

/** Fire on press, and for navigation keys keep firing while held. */
function bindRepeat(btn, fire, repeat) {
  let delay, timer
  const stop = () => { clearTimeout(delay); clearInterval(timer) }
  btn.addEventListener('pointerdown', e => {
    e.preventDefault()
    fire()
    if (repeat) delay = setTimeout(() => { timer = setInterval(fire, REPEAT_EVERY_MS) }, REPEAT_AFTER_MS)
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
    `grid     ${state.cols}x${state.rows} cell ${state.cell.width.toFixed(2)}x${state.cell.height} wtermRow ${term._rowHeight} scale ${state.scale}`,
    `strip    ${footerText ?? 'off'}`,
    `term     ${Math.round(l.terminal.width)}x${Math.round(l.terminal.height)}  stable ${Math.round(l.stableHeight)}`,
    `scroll   top ${screen.scrollTop} of ${screen.scrollHeight} in ${screen.clientHeight}`,
    `sb       ${sb}   domRows ${screen.querySelectorAll('.term-row:not([hidden])').length}   held ${heldBytes}B`,
    `overflow ${getComputedStyle(screen).overflowY}   class ${screen.className}`,
  ].join('\n')
}

function showDiagnostics() { $('diag').textContent = diagnosticText() }

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
  // Wrapped, not passed directly: a listener is handed the click event, which
  // would arrive as the layout argument and throw on l.terminal.
  fit.addEventListener('click', () => fitGrid())
  presets.appendChild(fit)

  const acts = {
    close: () => { menu.hidden = true },
    'zoom-in': () => setScale(state.scale * ZOOM_STEP),
    'zoom-out': () => setScale(state.scale / ZOOM_STEP),
    'zoom-reset': () => setScale(1),
    top: () => { stopReading(); screen.scrollTop = 0; menu.hidden = true },
    bottom: () => { stopReading(); screen.scrollTop = screen.scrollHeight; menu.hidden = true },
    // iOS offers its paste callout on a real, visible field; the terminal's own
    // input is hidden, so there is nothing there to long-press.
    'send-paste': () => {
      const field = $('paste')
      if (!field.value) return
      conn.send(field.value)
      field.value = ''
      menu.hidden = true
    },
    // A view rather than another section. The readout is a dozen lines, and
    // stacked under everything else it fills the screen — while nobody reading
    // it wants the folder list and the grid presets in the way.
    diag: () => {
      foldDiag($('diag').hidden)
      if (!$('diag').hidden) showDiagnostics()
    },
    reconnect: () => conn.reconnectNow(),
    // Local only: pi's own screen is untouched and its next repaint restores
    // it. The hold goes with the old screen — those bytes were drawn against
    // a view that no longer exists.
    'clear-view': () => { dropHeld(); term.write(CURSOR_HOME + ERASE_SCREEN + ERASE_SAVED) },
    // Standalone has no browser chrome, so this is the only way to pick up a
    // new build by hand. Re-fetch past the cache first, or the reload just
    // reinstates the copy iOS is already holding.
    reload: () => location.replace(`${location.pathname}?b=${Date.now().toString(36)}`),
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
  if (!served || served === BUILD_ID) return
  // Go to a URL iOS has no cached copy of. `location.reload()` is routinely
  // served the same stale document, and the id in the query means the page that
  // arrives already matches — so this cannot loop and needs no guard.
  location.replace(`${location.pathname}?b=${served}`)
}

async function main() {
  state.cell = measureCell(state.fontSize)
  // Set on the element, not :root — `.wterm` declares its own defaults, which
  // would win over anything merely inherited.
  screen.style.setProperty('--term-font-size', `${state.fontSize}px`)
  screen.style.setProperty('--term-row-height', `${state.cell.height}px`)

  document.documentElement.style.setProperty('--bar-h', `${KEY_BAR_H}px`)
  strip.style.flexBasis = `${state.cell.height}px`
  buildBar()
  buildMenu()
  $('diag-overlay').addEventListener('click', () => { $('diag-overlay').hidden = true })
  setScale(1)

  await term.init()
  meter = await WasmBridge.load()
  meter.init(state.cols, state.rows)

  // The renderer's state is private to TypeScript only, so reaching into it is
  // safe but not guaranteed. If an upgrade renames any of it these become
  // silent no-ops, which look exactly like the bugs they work around.
  const r = term.renderer
  if (!Array.isArray(r?.rowEls) ||
      typeof r.render !== 'function' ||
      typeof term._doRender !== 'function' ||
      typeof term._shouldScrollToBottom !== 'boolean' ||
      typeof term._isScrolledToBottom !== 'function') {
    throw new Error('wterm renderer internals moved')
  }

  // Between the paint and the re-pin that follows it inside _doRender, which is
  // the only order that works: the pin reads the geometry the trim decides.
  // The viewport argument carries scrollTop/rowHeight/the ring's discarded
  // count — dropping it silently disables the renderer's virtualized
  // scrollback, which then rebuilds every row on every frame.
  const paintOfRecord = r.render.bind(r)
  r.render = (core, viewport) => { paintOfRecord(core, viewport); trimBlankTail() }

  // wterm decides follow-output when a write arrives — latching "was at the
  // bottom" — but acts a frame later, so a write that lands while the reader
  // is still at the bottom holds that decision through the moment they scroll
  // up, and the render then snaps the box back down; mid-flick on a phone. A
  // scroll event cannot void the latch in time (the queued render can beat the
  // event's dispatch), so the render itself re-decides from where the box
  // actually is. The keystroke jump is a different call site and stays as-is.
  const renderOfRecord = term._doRender.bind(term)
  term._doRender = () => {
    if (term._shouldScrollToBottom && !term._isScrolledToBottom()) term._shouldScrollToBottom = false
    renderOfRecord()
  }

  screen.addEventListener('scroll', onScroll)
  toBottom.addEventListener('click', () => { stopReading(); screen.scrollTop = screen.scrollHeight })

  const first = applyLayout()
  orientation = first.orientation
  fitGrid(first)
  // env() insets are not resolved on the first pass, so the first fit is short
  // by the bottom inset and leaves rows permanently below the fold. Refit once
  // the real values are in.
  requestAnimationFrame(() => fitGrid(applyLayout()))
  conn.connect({ cols: state.wanted.cols, rows: state.wanted.rows })

  checkForNewBuild()

  visualViewport.addEventListener('resize', onViewportChange)
  visualViewport.addEventListener('scroll', onViewportChange)
  window.addEventListener('orientationchange', onViewportChange)
}

main().catch(e => reportFatal(`startup: ${e?.message ?? e}`))
