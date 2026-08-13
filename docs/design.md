# Design

Why the thing is shaped this way: what the parts are, what was rejected, and what the platform
forced. Measured values live in `numbers.md`.

## The server

`server/` owns the PTY through node-pty and speaks a five-constant WebSocket protocol, so the
client parses it in ~30 lines.

- **One PTY, N viewers.** The server is the session: everyone sees the same stream, and ending
  the server ends the program. An `@xterm/headless` mirror holds the current screen, so a new
  viewer is sent a picture instead of making pi redraw for one.
- **One document**, CSS and JS inline, so that the cache has a single yes-or-no to get right: a
  stale document is merely old, where one stale module out of a dozen is broken. It also spares
  the phone a five-deep import waterfall on every cold load. No service worker (they cannot
  register from `data:` URLs), costing offline support, which is meaningless for a terminal.
- **No build step.** esbuild runs inside the request, not into a `dist/`. A document built from
  the source on disk when it is asked for cannot be stale, and the client can be edited without
  the restart that would kill pi. ~50 ms, on a route asked for a few times a day.
- **Freshness is the page's job**, since iOS holds the launch document whatever the headers say.
  It compares a build stamp, a hash of the document that is also its ETag, and reloads past the
  cache. `no-cache` rather than `no-store`, so an unchanged client costs a 304.
- **Not dtach or tmux.** dtach drops bytes: on `EAGAIN` it abandons the unwritten tail of a read
  and never retries, and `tests/integrity/` is the standing gate against repeating it. tmux takes
  the outer alternate screen unconditionally, and that screen has no scrollback, which is the
  whole reason for a DOM renderer.

## Renderer: wterm, DOM over canvas

`@wterm/dom` renders to the DOM, so momentum scroll, selection handles and find come free. Its
Zig VT core ships as **inlined base64 WASM**, which is what survives the single-document
constraint, and `write(Uint8Array)` hands raw bytes to the parser, so a sequence split across two
messages is reassembled by the core and JS never decodes the socket. The renderer owns the screen
model, scrollback, painting and key encoding; the server owns none of it.

Canvas renderers bring their own viewport and scrollbar, where layout, zoom and scrolling here
all treat the wterm element as the one scroller. xterm.js also has the largest bundle and
long-open mobile bugs (#1101, #2403, #1007, #5721).

The core is a separate choice, since `@wterm/dom` takes any `TerminalCore`. `@wterm/ghostty` is
broken at 0.3.3 (WASM trap on grapheme clusters, inert `scrollbackLimit`, 431 KB of uninlined
WASM); `ghostty-vt-core` holds the working swap, to retest on a later release.

**Known bug:** a column shrink loses a third to two-thirds of the text on screen with nothing
scrolling off: 192 characters of 537 going from 80 columns to 50, and 5 even going from 80 to
79. libghostty reflows the same input correctly, which is the strongest reason to revisit the
core. It also answers no queries but CPR, so pi's startup probes go unanswered.

## Input, keyboard, viewport

pi's autocomplete fires *as you type*, directly above its input box, so a client-side composer
would break it. Keystrokes stream straight to pi and **pi's own input box stays visible**,
costing 5-6 rows. Autocorrect stays off: a *corrected* identifier points the agent at the wrong
file, where a typo in prose is inferred straight through.

The problem is viewport control, not resize policy. pi reflows fine at any size, but the
surviving rows go to its own input box and that window cannot be moved.

- **Size from `visualViewport`**, never `height:100%`, which is the layout viewport and puts the
  UI under the keyboard.
- **Pin the bottom** on every viewport change; holding `scrollTop` leaves pi's input box below
  the fold.
- **Insets are asymmetric.** iOS excludes the top one already, and honouring it again costs the
  +7 rows standalone buys. The bottom one is inside the viewport only while the keyboard is down,
  so the key bar grows to cover it.
- **Standalone** via `apple-mobile-web-app-capable`, worth +7 rows.
- **Bar keys never dismiss the keyboard.** iOS ends editing when DOM focus leaves the hidden
  input, and a tap's default activation would move focus to the button. Bar buttons are
  non-focusable (`tabindex="-1"`) and their press and tap are prevented, so focus never leaves
  the input and the keyboard stays up. `⌨` and the menu blur the input themselves to dismiss on purpose.

## Scrolling and resizing

Nothing in the stack takes the alternate screen, so the terminal's own scrollback is real history
and is scrolled natively: no copy-mode, no synthesised mouse events, no reader view. Vertical
scroll belongs to the terminal element and horizontal pan to the frame around it, so neither
gesture claims the other. **The page keys page the view, not the app**, since pi answers PageUp
with `\e[1G\e[?25l`. Follow-output needs no toggle, as wterm sticks to the bottom only when it is
already there.

Reflow and render scale are two operations, conflated by every existing tool into one font-size
slider. Reflow is cols/rows and SIGWINCH: presets plus Fit. Render scale is `transform: scale`
over a *pinned* grid, so pi still believes it is on a desktop. No pinch: over an occluding
keyboard, on a surface that is already a scroller, it is a bad bargain.

**The grid is sized from the layout viewport**, which ignores the keyboard, so opening the
keyboard never reflows pi. Involuntary events never touch the grid; **rotation does**, being
deliberate and worth 93 columns against portrait's 50. Insets are unresolved on the first layout
pass, so one refit on the next frame keeps rows from stranding below the fold.

## The status strip

pi truncates its footer to the terminal width as it renders, so at phone width the model name on
the right of it is never written to the PTY — there is no wider copy in the stream to recover. The
strip captures the one thing it shows at the source: the `ext/mtty-footer.ts` pi extension writes
the active model and thinking level (`provider/model - level`) to `$MTTY_FOOTER` whenever either
changes, and the server polls that file and relays it to every viewer as a FOOTER frame, replays it
to a latecomer after its snapshot, and stops watching when the session ends. The extension is inert
without the variable, so it can be installed globally.

Polling rather than fs.watch: the file exists only when the served program is pi, and watching a
directory for a file that may never appear means noise from every other tmp file on the machine.
The extension writes by rename, so the poller never sees a half-written line, and skips writes
themselves when nothing changed.

The strip is one row tall, under the keys inside the key bar. The home-indicator band absorbs it
when there is one — the bar keeps its height, the pad under the keys shrinks by exactly the strip,
and the terminal keeps every row — and where there is no band (keyboard up, Safari with no insets)
the bar grows by the strip and the terminal box gives up one visible row. Either way the grid never
learns about it: the same rule as the keyboard.

## Reconnect and attach

The server holds the screen, so attaching costs nothing and prompts nobody. That matters because
pi renders relatively and re-draws its **entire transcript** on SIGWINCH, a cost that grows with
the conversation. The snapshot carries the screen and 1000 lines above it by default, because pi does
not page itself and scrollback is the only way to read back through a conversation; `--scrollback N`
moves it, though past 1000 lines only `attach` sees the difference. The terminal object outlives
the socket, so a drop leaves the stale screen up rather than blanking; input queues while down,
resizes do not, since the handshake carries the size.

`attach` is a client of the same protocol, so the desktop cannot resize the PTY behind the
server's back. It has to act like a terminal on its own account: raw mode restored on every exit
path, pi's and the snapshot's modes undone on the way out, SIGWINCH forwarded, `Ctrl-C` and
`Ctrl-Z` passed through, `Ctrl-]` to detach. Its initial snapshot takes over the current terminal
and replaces its existing scrollback; later grid changes send the new size and let pi's real PTY
redraw update it instead of replaying another reset. That chord cannot be discovered, so `attach`
names it on a cleared screen and holds its hello back briefly; the server sends nothing until the
hello, so nothing is buffered or lost.

One PTY has one size, and **the narrowest wins**: a desktop showing a phone-width column is
legible where the reverse is not. The server picks and tells every viewer what it actually is,
which makes the common case free, since the phone is already the narrowest.

Adopting an *already running* pi needs ptrace surgery (`reptyr`) and is Linux-only, so a restart
ends the session and starts a fresh conversation, unless pi is given one to resume.

## Development

Editing `server/` needs a restart, which kills the program; editing the client (`src/`) does not,
since the document is built per request. The tests: `npm test` for unit (including the snapshot
round-trip gate), `npx playwright test` for WebKit at the measured device size,
`npm run test:integrity` for the gate that no viewer is ever sent a gap, and `npm run test:smoke`
against real pi, which sends no prompts and costs no tokens. Testing philosophy: anything
mechanisable is a pure function, the device verifies the viewport adapter, everything downstream
is testable without a keyboard, and there is no visual regression because goldens would churn
while the design moves.

## Access

Cloudflare tunnel, reusing the pi-phone pattern. Tailscale needs a client on every device, and
LAN-only defeats the purpose.

**Authentication is a cookie either way.** Safari puts no `Authorization` header on a WebSocket
handshake and the page cannot add one, so basic auth would load the page and never connect.
Access does it at the edge. `$MTTY_PASSWORD` is the opt-in alternative for a network you already
trust: a login page and a random token held in memory, invalidated by the restart that has
already killed the program. `attach` does the same login rather than taking a bypass, since
trusting loopback would trust the whole internet through cloudflared. One or the other, not both.

The threat under examination is narrow: a page in some other site your browser visits must not
get the terminal, not that the server is a web application with a public permission model. That
is the only adversary a loopback tool can honestly name, and the mechanism is chosen for it,
which is why its limits matter less than its fit.

**Origin is checked on the handshake**, which ignores the same-origin policy and has no
preflight: any page you visit could otherwise open `ws://127.0.0.1:7681/ws` and type into pi.
Matching `Origin` against `Host` is not enough, since rebinding gets both to say the same
attacker-owned name, so Host must be an address, which cannot be rebound to, or the one name
given with `--hostname`. Declared, never inferred: a hostname is trustworthy exactly when the
operator asserted it. A request with no Origin is allowed: only browsers send it, `attach` and
curl send none, and anything hostile that is not a browser forges headers freely, so refusing it
costs those clients and buys nothing. Scheme is not compared, so an attacker-controlled http
endpoint on the same declared hostname could pass a wss:// handshake; that needs a foothold the
page-on-another-site threat under examination does not have, and it names the real limit of what
the check can promise.

**An expired or invalidated login leaves an already-open client wedged.** The Open socket itself
keeps working, since auth is checked only at the handshake, but when it drops the reconnect
handshakes are refused and the client retries indefinitely with the stale screen up. The fix is
the menu's **Reload app**, not a redirect: the app cannot be expected to surface a login the
socket no longer lets through.
