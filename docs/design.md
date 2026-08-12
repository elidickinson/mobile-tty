# Design

Why the thing is shaped this way — what the parts are, what was rejected, and what the platform
forced. Measured values live in `numbers.md`.

## The server

`server/` owns the PTY through node-pty and speaks a five-constant WebSocket protocol, so the
client parses it in ~30 lines.

- **One PTY, N viewers.** The server is the session: everyone sees the same stream, and ending
  the server ends the program. An `@xterm/headless` mirror holds the current screen, so a new
  viewer is sent a picture instead of making pi redraw for one.
- **One document**, CSS and JS inline. No service worker — they cannot register from `data:` URLs
  — which costs offline support, meaningless for a terminal.
- **No build step.** esbuild runs inside the request, not into a `dist/`. A document built from
  the source on disk when it is asked for cannot be stale, and the client can be edited without
  the restart that would kill pi. ~50 ms, on a route asked for a few times a day.
- **Freshness is the page's job**, since iOS holds the launch document whatever the headers say.
  It compares a build stamp — a hash of the document, and also its ETag — and reloads past the
  cache. `no-cache` rather than `no-store`, so an unchanged client costs a 304.
- **Not dtach:** on `EAGAIN` its master abandons the unwritten tail of a 4096-byte read and never
  retries, which is where corrupt escape sequences came from. `tests/integrity/` is the gate.
- **Not tmux:** 3.7b takes the outer alternate screen unconditionally, and the alternate screen
  has no scrollback — which would delete the entire reason for a DOM renderer.

## Renderer: wterm, DOM over canvas

`@wterm/dom` renders to the DOM, so momentum scroll, selection handles and find come free. Its
Zig VT core ships as **inlined base64 WASM**, which is what survives the single-document
constraint, and `write(Uint8Array)` hands raw bytes to the parser, so a sequence split across two
messages is reassembled by the core and JS never decodes the socket. The renderer owns the screen
model, scrollback, painting and key encoding; the server owns none of it.

Canvas is not a drop-in whatever the API looks like: layout, zoom and scrolling all treat the
wterm element as the one scroller, and a canvas renderer brings its own viewport and scrollbar.
xterm.js also has the largest bundle and long-open mobile bugs (#1101, #2403, #1007, #5721).

The core is a separate choice — `@wterm/dom` takes any `TerminalCore`. `@wterm/ghostty` is the
obvious candidate and is broken at 0.3.3: it traps the WASM on accumulated grapheme clusters, its
`scrollbackLimit` is inert near 792 lines, and its WASM is a separate 431 KB file rather than
inlined. `ghostty-vt-core` holds the working swap; retest past 0.3.3.

**Known bug:** a column shrink loses a third to two-thirds of the text on screen — 80→50 loses
192 characters of 537, even 80→79 loses 5 — with nothing scrolling off. libghostty reflows the
same input correctly, which is the strongest reason to revisit the core. It also answers no
queries but CPR, so pi's startup probes go unanswered.

## Input, keyboard, viewport

pi's autocomplete fires *as you type*, directly above its input box, so a client-side composer
would break it. Keystrokes stream straight to pi and **pi's own input box stays visible**,
costing 5–6 rows. Autocorrect stays off: a *corrected* identifier points the agent at the wrong
file, where a typo in prose is inferred straight through.

The problem is viewport control, not resize policy — pi reflows fine at any size, but the
surviving rows go to its own input box and that window cannot be moved.

- **Size from `visualViewport`**, never `height:100%`, which is the layout viewport and puts the
  UI under the keyboard.
- **Pin the bottom** on every viewport change; holding `scrollTop` leaves pi's input box below
  the fold.
- **Insets are asymmetric.** iOS excludes the top one already, and honouring it again costs the
  +7 rows standalone buys. The bottom one is inside the viewport only while the keyboard is down,
  so the key bar grows to cover it.
- **Standalone** via `apple-mobile-web-app-capable`, worth +7 rows.

## Scrolling and resizing

Nothing in the stack takes the alternate screen, so the terminal's own scrollback is real history
and is scrolled natively — no copy-mode, no synthesised mouse events, no reader view. Vertical
scroll belongs to the terminal element and horizontal pan to the frame around it, so neither
gesture claims the other. **⇈/⇊ page the view, not the app**: pi answers PageUp with
`\e[1G\e[?25l`. Follow-output needs no toggle, since wterm sticks to the bottom only when it is
already there.

Reflow and render scale are two operations, conflated by every existing tool into one font-size
slider. Reflow is cols/rows and SIGWINCH: presets plus Fit. Render scale is `transform: scale`
over a *pinned* grid, so pi still believes it is on a desktop. No pinch — over an occluding
keyboard, on a surface that is already a scroller, it is a bad bargain.

**The grid is sized from the layout viewport**, which ignores the keyboard, so opening the
keyboard never reflows pi. Involuntary events never touch the grid; **rotation does**, being
deliberate and worth 93 columns against portrait's 50. Insets are unresolved on the first layout
pass, so one refit on the next frame keeps rows from stranding below the fold.

## Reconnect and attach

The server holds the screen, so attaching costs nothing and prompts nobody. That matters because
pi renders relatively and re-draws its **entire transcript** on SIGWINCH, a cost that grows with
the conversation. The snapshot carries the screen and 500 lines above it — pi does not page
itself, so scrollback is the only way to read back through a conversation, and `--scrollback N`
moves it. The terminal object outlives the socket, so a drop leaves the stale screen up rather
than blanking; input queues while down, resizes do not, since the handshake carries the size.

`attach` is a client of the same protocol, so the desktop cannot resize the PTY behind the
server's back. It has to act like a terminal on its own account: raw mode restored on every exit
path, pi's and the snapshot's modes undone on the way out, SIGWINCH forwarded, `Ctrl-C` and
`Ctrl-Z` passed through, `Ctrl-]` to detach. That chord cannot be discovered, so `attach` names
it on a cleared screen and holds its hello back briefly; the server sends nothing until the
hello, so nothing is buffered or lost.

One PTY has one size, and **the narrowest wins** — a desktop showing a phone-width column is
legible where the reverse is not. The server picks and tells every viewer what it actually is,
which makes the common case free, since the phone is already the narrowest.

Adopting an *already running* pi needs ptrace surgery (`reptyr`) and is Linux-only, so a restart
ends the session — hence the default `pi --session-id mobile-tty`.

## Access

Cloudflare tunnel, reusing the pi-phone pattern. Tailscale needs a client on every device;
LAN-only defeats the purpose; public-plus-auth means an authenticated shell on the internet.

**Authentication is a cookie either way.** Safari puts no `Authorization` header on a WebSocket
handshake and the page cannot add one, so basic auth would load the page and never connect.
Access does it at the edge. `$MTTY_PASSWORD` is the opt-in alternative for a network you already
trust: a login page and a random token held in memory, invalidated by the restart that has
already killed the program. `attach` does the same login rather than taking a bypass, since
trusting loopback would trust the whole internet through cloudflared. One or the other, not both.

**Origin is checked on the handshake**, which ignores the same-origin policy and has no
preflight: any page you visit could otherwise open `ws://127.0.0.1:7681/ws` and type into pi.
Matching `Origin` against `Host` is not enough — rebinding gets both to say the same
attacker-owned name — so Host must be an address, which cannot be rebound to, or the one name
given with `--hostname`. Declared, never inferred: a hostname is trustworthy exactly when the
operator asserted it. No Origin is allowed, since only browsers send it and only browsers are
bound by it.
