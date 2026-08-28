# Design

Why the thing is shaped this way: what the parts are, what was rejected, and what the platform forced.

## The server

`server/` owns the PTY through node-pty and speaks a five-constant WebSocket protocol, so the client parses it in ~30 lines.

- **One PTY, multiple viewers.** Everyone sees the same stream; ending the server ends the program.
- **A new viewer gets a picture, not a redraw.** An `@xterm/headless` mirror holds the current screen, so joining costs the size of the screen no matter how long the transcript is.
- **One document**, CSS and JS inline. Makes cache management simple. No service worker (they cannot register from `data:` URLs) -- costing offline support, which is meaningless for a terminal.
- **No build step.** esbuild runs inside the request, not into `dist/`. A document built from disk when asked for cannot be stale, and the client can be edited without the restart that would kill pi. ~50 ms, a few times a day.
- **Freshness is the page's job**, since iOS holds the launch document whatever the headers say. A build stamp (a hash of the document, also its ETag) is compared; the page reloads past the cache. `no-cache` rather than `no-store`, so an unchanged client costs a 304.
- **Not dtach or tmux.** dtach drops bytes (on `EAGAIN` it abandons the unwritten tail of a 4096-byte read and never retries -- measured 9.3 MB across 55,989 gaps in a resize storm; `tests/integrity/` is the standing gate against repeating it). tmux takes the outer alternate screen unconditionally, and that screen has no scrollback -- the whole reason for a DOM renderer.

## Renderer: wterm, DOM over canvas

- **`@wterm/dom` renders to the DOM**, so momentum scroll, selection handles and find come free. Canvas renderers would bring their own viewport and scrollbar; here the wterm element is the one scroller.
- **Inlined base64 WASM** -- what survives the single-document constraint. No separate fetch, no MIME to get right.
- **`write(Uint8Array)` hands raw bytes to the parser.** A sequence split across two messages is reassembled by the core; JS never decodes the socket.
- **The renderer owns the screen model, scrollback, painting and key encoding; the server owns none of it.**
- xterm.js was rejected: largest bundle, long-open mobile bugs (#1101, #2403, #1007, #5721).
- **Browser scrollback cap: 1000 lines** -- writing 26,000 lines into the VT core held 1000. The limit is inside its WASM with no option to raise it, which is why the snapshot is fixed at the same number.

The core is a separate choice, since `@wterm/dom` takes any `TerminalCore`. `@wterm/ghostty` is broken at 0.3.3 (WASM trap on grapheme clusters, inert `scrollbackLimit`, 431 KB of uninlined WASM); `ghostty-vt-core` holds the working swap, to retest on a later release.

**Known bug:** a column shrink loses on-screen text with nothing scrolling off -- 192 of 537 characters from 80 to 50 columns, 5 even from 80 to 79. libghostty reflows the same input correctly, the strongest reason to revisit the core. The current core also answers no queries but CPR, so pi's startup probes go unanswered.

## The vendored wterm fork

`vendor/wterm` carries `@wterm/dom` 0.3.4 with local changes confined to the client input path (`input.ts`) and two promoted integration points, imported straight into the bundle and covered by `npm run typecheck`. The design record for the input work is [`docs/plan-ios-input.md`](plan-ios-input.md).

- **The hidden field is a mirror of the PTY's input line, and a diff is the transport.** `flush()` segments field and mirror into graphemes, takes the shared prefix and suffix, and sends the middle as DELs plus inserted text -- so held-backspace repeats, dictation and the emoji keyboard all arrive as exact line edits, and the input and composition events firing in either order cost nothing, the flush being idempotent. A 4096-char cap and a 30s idle keep the mirror bounded; every line change made outside the diff (bar keys, paste, PTY resets) resets it via `resetMirror()`.
- **Unmodified Backspace stands aside when the field is non-empty**, so iOS's native repeat loop drives the deletion and the diff turns it into DEL bytes. Modified Backspace keeps the keydown path: alt+Backspace is esc+DEL (word delete), meta+Backspace kill-line.
- **QuickPath's separator is emulated**: iOS spaces only swipe-scored words, so a swiped single letter -- and whatever is swiped or dictated after it -- arrives glued to the previous word. A letters-only insertion landing against a word character gets its separator spliced in before the diff, on both the input-event and marked-text delivery paths.
- **The field sits sticky at the scrollport's bottom** instead of parked off-screen at the top, so WebKit's reveal-the-caret scroll has nothing to chase and cannot drag a reader to the top of history.
- **Follow-output is decided where the scroller is, not where it was.** wterm latches "was at the bottom" when bytes arrive but renders a frame later, and a latch that outlives the scroll that voided it snaps the box back down mid-flick; the render now re-decides from the box's actual position. `followOutput(on)` re-asserts the latch wterm's scroll handler lowers, and `onAfterPaint` lets the client adjust painted geometry between the paint and wterm's own scroll pinning.

## Input, keyboard, viewport

pi's autocomplete fires *as you type*, directly above its input box, so a client-side composer would break it. Keystrokes stream straight to pi and **pi's own input box stays visible**, costing 5-6 rows. Autocorrect stays off: a *corrected* identifier points the agent at the wrong file, where a typo in prose is inferred straight through (and in fact iOS sent 0 `insertReplacementText` events over 7 typed chars).

The problem is viewport control, not resize policy. pi reflows fine at any size, but the surviving rows go to its own input box and that window cannot be moved.

- **Size from `visualViewport`**, never `height:100%` -- that is the layout viewport and puts the UI under the keyboard.
- **Pin the bottom** on every viewport change; holding `scrollTop` leaves pi's input box below the fold.
- **Insets are asymmetric.** iOS excludes the top one already, and honouring it again costs rows. The bottom one is visible only while the keyboard is down, so the key bar grows to cover it.
- **Standalone** via `apple-mobile-web-app-capable`, worth **+7 rows** over Safari.
- **Bar keys never dismiss the keyboard.** iOS ends editing when DOM focus leaves the hidden input, and a tap's default activation moves focus to the button. Bar buttons are non-focusable and their presses are prevented; `⌨` and the menu blur the input themselves to dismiss on purpose.

## Scrolling and resizing

- **Real scrollback, scrolled natively.** Nothing takes the alternate screen, so terminal scrollback is real history: no copy-mode, no synthesised mouse events, no reader view.
- **Vertical scroll on the terminal element, horizontal pan on the frame** -- neither gesture claims the other.
- **Page keys page the view, not the app**, since pi answers PageUp with `\e[1G\e[?25l`.
- **Follow-output needs no toggle**: wterm sticks to the bottom only when already there.

**Reflow and render scale are separate operations**, conflated by every existing tool into one font-size slider. Reflow is cols/rows and SIGWINCH, via presets plus Fit. Render scale is `transform: scale` over a *pinned* grid, so pi still believes it is on a desktop. No pinch: over an occluding keyboard, on a surface that is already a scroller, it is a bad bargain.

**The grid is sized from the layout viewport**, which ignores the keyboard, so opening the keyboard never reflows pi. Involuntary events never touch the grid; **rotation does**, being deliberate and worth 93 columns against portrait's 50. One refit on the next frame after a change keeps rows from stranding below the fold while insets settle.

**The scroller ends at the last written row.** pi draws its input box after the transcript rather than on the last row, so a keyboard-down-sized grid is mostly empty on a fresh session. Everything that means "the bottom" (the pin, the at-bottom test, wterm's follow-output and scroll-on-keystroke) measures the scroller, hiding the empty rows and anchoring to the bottom of the box -- one correction for every consumer.

## The status strip

pi truncates its footer to the terminal width as it renders, so at phone width the model name is never written to the PTY -- there is no wider copy to recover. The strip captures it at the source instead:

- The `pi-extensions/mtty-footer.ts` extension writes the active model and thinking level to `$MTTY_FOOTER` on change; inert without the variable, so it can be installed globally.
- The server **polls** the file (not fs.watch: the file exists only when the served program is pi, and watching a directory for a file that may never appear means tmp noise), relays it as a FOOTER frame, replays it to a latecomer, stops when the session ends.
- The extension writes by rename, so the poller never sees half a line, and skips writes when nothing changed.
- The strip is one row, under the keys. The home-indicator band absorbs it when there is one (terminal keeps every row); otherwise the bar grows by the strip (terminal gives up one row). The grid never learns about it: the same rule as the keyboard.

## Reconnect and attach

- **The server holds the screen, so attaching costs nothing and prompts nobody.** That matters because pi renders relatively and re-draws its **entire transcript** on SIGWINCH -- measured 12 KB after one turn, +3.3 KB per trivial turn, linear.
- **The snapshot carries the screen plus 1000 lines of scrollback** (~75 KB): pi does not page itself, so scrollback is the only way to read back; 1000 is also the browser core's cap, so a deeper snapshot would reach only `attach` while every phone reconnect paid for lines the browser drops.
- **A drop leaves the stale screen up**, not a blank. Input queues while down; resizes do not, since the handshake carries the size.

`attach` is a client of the same protocol, so the desktop cannot resize the PTY behind the server's back. It acts like a terminal on its own account: raw mode restored on every exit path, pi's and the snapshot's modes undone on the way out, SIGWINCH forwarded, `Ctrl-C`/`Ctrl-Z` passed through, `Ctrl-]` to detach. Its initial snapshot takes over the terminal; later grid changes send the size and let pi's real PTY redraw update it. The detach chord cannot be discovered, so `attach` names it on a cleared screen, holds its hello briefly, and the server sends nothing until the hello -- nothing buffered, nothing lost.

One PTY has one size, and **the narrowest wins**: a desktop showing a phone-width column is legible where the reverse is not. The server picks the size and tells every viewer what it actually is; the common case is free, since the phone is already the narrowest. (Smallest shared grid 20x8, so no viewer shrinks everyone to nothing; 100 ms resize coalescing, so a flapping viewer does not make pi re-render repeatedly; 4 MB backlog cap, then that viewer is disconnected -- never sent a gap.)

Adopting an *already running* pi needs ptrace surgery (`reptyr`), Linux-only, so a restart ends the session and starts a fresh conversation, unless pi is given one to resume.

## Development

- **Editing `server/` needs a restart** (kills the program); **editing the client (`src/`) does not** -- the document is built per request.
- **Tests:** `npm test` (unit, including the snapshot round-trip), `npx playwright test` (WebKit at the device size), `npm run test:integrity` (no viewer is ever sent a gap), `npm run test:smoke` and `npm run test:real-pi` (against real pi, no prompts, no tokens).
- **Philosophy:** anything mechanisable is a pure function; the device verifies the viewport adapter (`tests/unit/viewport.test.js` replays the five on-device configurations at the measured cell size, 8.04x15 at 13px); no visual goldens -- they would churn while the design moves.

The tape: iPhone 6 pro, 402x874 pt @3x. Standalone portrait is 50x54 with the keyboard down, 50x33 up; landscape 93x22. Safari in a tab costs 160 pt of chrome. Keyboard detection: >=100 pt of lost viewport, so collapsing browser chrome does not read as a keyboard.

## Access

Cloudflare tunnel, reusing the pi-phone pattern. Tailscale needs a client on every device; LAN-only defeats the purpose.

**Authentication is a cookie either way.** Safari puts no `Authorization` header on a WebSocket handshake and the page cannot add one, so basic auth would load the page and never connect. Access does it at the edge. `$MTTY_PASSWORD` is the opt-in alternative for a trusted network: a login page and a random in-memory token, invalidated by the restart that has already killed the program. `attach` does the same login rather than bypassing it, since trusting loopback would trust the whole internet through cloudflared. One or the other, not both.

The threat model is narrow on purpose: a page on some other site your browser visits must not get the terminal. That is the only adversary a loopback tool can honestly name -- the server is not claiming to be a public web application -- and the mechanism is chosen for it.

**Origin is checked on the handshake.** Browsers let any page open a WebSocket to any host -- the same-origin policy does not apply and there is no preflight -- so without the check, any page you visit could open `ws://127.0.0.1:7681/ws` and type into pi.

- Matching `Origin` against `Host` is not enough: rebinding gets both to say the same attacker-owned name. Host must be an address (cannot be rebound) or the one name given with `--hostname`. **Declared, never inferred.**
- A request with no Origin is allowed: only browsers send it, `attach` and curl send none, and anything hostile that is not a browser forges headers freely -- refusing it costs real clients and buys nothing.
- Scheme is not compared, so an attacker-controlled http endpoint on the declared hostname could pass a wss:// handshake. That needs a foothold this attacker does not have, and names the real limit of the check.

**An expired or invalidated login leaves an open client wedged**: the socket itself keeps working (auth is handshake-only), but when it drops, the reconnects are refused and the client retries forever with the stale screen up. The fix is the menu's **Reload app**, not a redirect -- the app cannot surface a login the socket no longer lets through.

**Folder switching is not a way to run programs anywhere.** A viewer can ask to respawn the program, but only in a folder the server itself listed (pi history plus the one it started in). The client never sends a path the server didn't offer first.
