#!/usr/bin/env node
// A deterministic content generator with sync markers, NOT a pi emulator. It
// may be simpler than pi, but it must never produce a shape pi cannot produce:
// pi draws its input box inline after the transcript (never pinned to the last
// row of the grid) and redraws promptly on SIGWINCH. Do not add fidelity the
// specs do not consume — a closer lookalike only adds false confidence.
import { renameSync, writeFileSync } from 'node:fs'

const home = process.env.HOME
const where = home && process.cwd().startsWith(home)
  ? `~${process.cwd().slice(home.length)}`
  : process.cwd()
const history = ['fake-pi ready — type and press enter']
let buf = ''

const out = s => process.stdout.write(s)
// Read fresh, never process.stdout.columns/rows: node refreshes those from its
// own SIGWINCH listener, which on macOS can run before the new winsize is
// readable on the slave, leaving them a whole resize behind.
const size = () => process.stdout.getWindowSize()
let drawn = ''

const draw = () => {
  const [cols, rows] = size()
  drawn = `${cols}x${rows}`
  out('\x1b[H\x1b[2J')
  // Transcript, then the input box and status line inline after it: a short
  // transcript leaves the foot of the grid empty.
  const shown = history.slice(-(rows - 4))
  for (const line of shown) out(`${line}\r\n`)
  const bar = '─'.repeat(cols - 2)
  out(`┌${bar}┐\r\n`)
  out(`│ \x1b[36m>\x1b[0m ${buf.padEnd(cols - 5)}│\r\n`)
  out(`└${bar}┘\r\n`)
  out(`\x1b[2m ${where}  ${cols}x${rows}\x1b[0m`)
  // Park the cursor inside the box.
  out(`\x1b[${shown.length + 2};${buf.length + 5}H`)
}

const submit = () => {
  const line = buf
  buf = ''
  if (line === '/quit') {
    out('\x1b[2J\x1b[H')
    process.exit(0)
  } else if (line.startsWith('/lines')) {
    // Scroll real lines off the top so the client accrues scrollback. Each
    // line lands on the bottom row and the newline scrolls the screen; the
    // redraw clears the screen but not the scrollback (no \e[3J), so they
    // survive above the fold. A count past 1000 saturates the client's ring,
    // where history stops appending and starts rotating.
    const n = parseInt(line.slice(6), 10) || 80
    out(`\x1b[${size()[1]};1H`)
    for (let i = 0; i < n; i++) out(`scrollback line ${i}\r\n`)
  } else if (line.startsWith('/stream')) {
    // A line every 100ms: the shape of pi writing a long answer. Each line is
    // a real newline on the bottom row, so the screen genuinely scrolls and
    // the top of the transcript lands in the client's scrollback — that
    // rotation under a reader is the point. draw() then repaints the tail and
    // the input box, as pi does after appending.
    const n = parseInt(line.slice(7), 10) || 40
    let i = 0
    const timer = setInterval(() => {
      history.push(`stream line ${i}`)
      out(`\x1b[${size()[1]};1Hstream line ${i}\r\n`)
      draw()
      if (++i >= n) clearInterval(timer)
    }, 100)
  } else {
    history.push(`> ${line}`, `ok: ${line.length} chars`)
  }
}

// The status strip, once: what the mtty-footer pi extension writes on the real
// program, so the e2e suite can see the strip without pi. Written by rename,
// as the extension does, so the server's poller never sees a half-written line.
if (process.env.MTTY_FOOTER) {
  writeFileSync(`${process.env.MTTY_FOOTER}.tmp`,
    `{"ts":${Math.floor(Date.now() / 1000)},"text":"fake-pi stats"}\n`)
  renameSync(`${process.env.MTTY_FOOTER}.tmp`, process.env.MTTY_FOOTER)
}

let esc = 0   // 0 none, 1 after ESC, 2 inside a CSI/SS3 sequence
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const ch of data.toString()) {
    // Escape sequences vary in length — \e[A is three bytes, \e[1;5C is six —
    // so swallow up to the final byte instead of counting a fixed number.
    if (esc === 1) { esc = ch === '[' || ch === 'O' ? 2 : 0; continue }
    if (esc === 2) { if (/[A-Za-z@~]/.test(ch)) esc = 0; continue }
    if (ch === '\r' || ch === '\n') submit()
    else if (ch === '\x7f') buf = buf.slice(0, -1)
    else if (ch === '\x1b') esc = 1
    else buf += ch
  }
  draw()
})
// The PTY master closing is how the parent's death arrives here.
process.stdin.on('end', () => process.exit(0))
// macOS delivers SIGWINCH a beat before the new winsize is readable on the
// slave, so drawing straight from the handler paints the old grid. Wait for
// the size to actually change (sub-millisecond); the deadline covers a resize
// to the size already drawn.
process.on('SIGWINCH', () => {
  const deadline = Date.now() + 200
  const tick = () => {
    const [cols, rows] = size()
    if (`${cols}x${rows}` !== drawn || Date.now() > deadline) draw()
    else setImmediate(tick)
  }
  tick()
})

draw()
