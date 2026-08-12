# Decisions

Why the thing is shaped this way. Measured values live in `numbers.md`.

## Backend: our own server

`server/` owns the PTY through node-pty and speaks a five-constant WebSocket protocol, so
the client parses it in ~30 lines. It serves **exactly one document**, which is why the
client is a single self-contained file — all CSS and JS inline, no service worker (they
cannot register from `data:` URLs). That costs offline support, meaningless for a terminal,
and web push, which belongs on Pushover anyway.

**No build step.** esbuild runs inside the request rather than into a `dist/`. A document
built from the source on disk at the moment it is asked for cannot be stale, so there is no
staleness to detect and no artifact to invalidate; it also means the client can be edited
without restarting the server, which would kill pi. It costs ~50 ms on a route asked for a
handful of times a day.

**One PTY, N viewers.** The server is the session: every viewer sees the same stream and
writes into the same PTY, and ending the server ends the program. It keeps the current
screen in an `@xterm/headless` mirror so a new viewer is sent a picture instead of making
pi redraw for one.

It replaced ttyd and dtach together. dtach's master reads up to 4096 bytes from the PTY and
writes them to each non-blocking client socket; on `EAGAIN` it abandons the unwritten tail
and never retries. That is silent deletion mid-stream, and it is where corrupt escape
sequences like a stray `55;95;255m` came from — 9.3 MB lost across 55,989 gaps under a
resize storm, measured. `tests/integrity/` is the standing gate against repeating it.

**Not tmux**: tmux 3.7b takes the outer terminal's alternate screen unconditionally —
`alternate-screen off`, `terminal-overrides ',*:smcup@:rmcup@'` and `terminal-features
',*:-alternatescreen'` all leave `\e[?1049h` in the stream. The alternate screen has no
scrollback, which would delete the entire reason for choosing a DOM renderer.

## Renderer: wterm, DOM over canvas

The renderer owns the screen model, scrollback, painting and key encoding — which is to say
it owns all three problems. The server owns none of them.

`@wterm/dom` renders to the DOM, so momentum scroll, selection handles and find come free.
Two properties make it fit: its Zig VT core ships as **inlined base64 WASM**, which is what
survives the single-document constraint, and `write(Uint8Array)` hands raw bytes to the
parser — so a multi-byte sequence split across two WebSocket messages is reassembled by the
core and JS never decodes the socket.

xterm.js and ghostty-web are both canvas. Canvas is not a drop-in here whatever its API
looks like: the layout, zoom and scrolling all treat the wterm element as the one scroller,
and a canvas renderer brings its own viewport and scrollbar instead. xterm.js also has the
largest bundle and long-open mobile bugs (#1101, #2403, #1007, #5721).

### The core is a separate choice from the renderer

`@wterm/dom` takes any `TerminalCore`, so the parser can be swapped without touching the
renderer. `@wterm/ghostty` (libghostty compiled to WASM) is the obvious candidate and does
not work at 0.3.3: it traps the WASM on accumulated grapheme clusters —
`page integrity violation ... MissingGraphemeData`, then `unreachable` — which kills the
terminal outright on a large repaint. Its `scrollbackLimit` is also inert, capping near 792
lines, and its WASM ships as a separate 431 KB file rather than inlined base64, which costs
566 KB against the single-document constraint. Worth re-testing on a release past 0.3.3;
`ghostty-vt-core` holds the working swap.

### Known bug: the core loses text on column shrink

Shrinking columns drops a third to two-thirds of the text on screen, with no scrollback
involved and nothing scrolling off: 80→50 loses 192 characters of 537, 120→40 loses 341, and
even 80→79 loses 5. Fit, every preset and every rotation does this. libghostty reflows the
same input correctly, so this is the strongest reason to revisit the core.

The core also answers almost no queries — CPR, and nothing else. No DA1, DECRQM or
XTGETTCAP, so pi's startup probes go unanswered.

## Input: straight to pi

pi's autocomplete fires *as you type* and renders directly above its input box, so a
client-side composer would break it: pi never sees the keystrokes, and the menu's region is
exactly what a composer-first layout wants to pan away from. Keystrokes stream to pi and
**pi's own input box stays visible**, costing 5–6 rows.

wterm's hidden textarea already sets `autocorrect/autocapitalize/autocomplete=off` and
`spellcheck=false`. Autocorrect is a liability, not a benefit: a *corrected* identifier
silently points the agent at the wrong file, whereas a typo in prose is inferred straight
through.

## Keyboard and viewport

The problem is viewport control, not resize policy: pi reflows fine at any size, but the
surviving rows go to its own input box and that window cannot be moved.

- **Size from `visualViewport`, never `height:100%`** — the latter is the layout viewport
  and puts the UI under the keyboard.
- **Pin the bottom.** On any viewport change, preserve distance-from-bottom. Holding
  `scrollTop` instead leaves the top of the grid on screen with pi's input box below the
  fold.
- **Insets are asymmetric.** iOS already excludes the top inset from the layout viewport;
  honouring it again throws away the +7 rows standalone buys. The bottom inset is inside
  the viewport, and only when the keyboard is down — with it up the home indicator sits
  over the keyboard. The key bar grows to cover it rather than leaving a gap.
- **Standalone** via `apple-mobile-web-app-capable`, worth +7 rows. iOS caches the launch
  document whatever the headers say, so freshness is the page's job, not the cache's: it
  compares a build stamp — a hash of the document, which is also its ETag — and reloads
  itself past the cache. Since that check is what actually works, the header is `no-cache`
  rather than `no-store`, and an unchanged client costs a 304 instead of the whole document.

## Scrolling

pi does not use the alternate screen and nothing in the stack imposes one, so the terminal's own
scrollback holds real history and is scrolled natively. No copy-mode, no synthesised mouse
events, no `capture-pane` reader view. This only holds because the stack keeps the
alternate screen free — the reason tmux is not in it.

Native touch drag is the primary control. Vertical scroll belongs to the terminal element
and horizontal pan to the frame around it, so they are separate native scrollers and
neither gesture claims the other.

**⇈/⇊ page the view, not the app** — pi answers PageUp with `\e[1G\e[?25l` and nothing
else. A **↓ latest** button appears when scrolled away. Follow-output needs no toggle:
wterm sticks to the bottom only when already at the bottom.

## Resizing

Two independent operations, conflated by every existing tool into one font-size slider:

- **Reflow** — cols/rows, SIGWINCH, pi relayouts. Presets plus Fit; one tap, repeatable.
- **Render scale** — CSS `transform: scale` over a *pinned* grid, from menu buttons. pi
  only learns cols/rows from the PTY, so it believes it is on a desktop. No pinch: over an
  occluding keyboard, on a surface that is already a scroller, it is a bad bargain.

**The grid is sized from the layout viewport**, which ignores the keyboard, so opening the
keyboard never reflows pi — only the visible window shrinks. Involuntary events (keyboard,
browser chrome) never touch the grid; **rotation does**, because it is deliberate and
landscape is worth 93 columns against portrait's 50.

The insets are unresolved on the very first layout pass, so the initial fit is short by the
bottom inset and strands rows below the fold. One refit on the next frame fixes it.

## Reconnect

The server holds the screen, so attaching costs nothing and prompts nobody: it sends the
serialized grid and the viewer is live. That matters because making pi repaint is not
cheap — it renders relatively and re-draws its **entire transcript** on SIGWINCH, around
12 KB after one turn and growing linearly, so the old attach paid a redraw proportional to
the whole conversation.

The snapshot carries the screen and 500 lines of history above it. That history is not a
luxury: pi renders inline and does not page itself — PageUp gets `\e[1G\e[?25l` and nothing
else — so the terminal's scrollback is the only way to read back through a conversation.
About 37 KB, against a transcript re-render that starts at 12 KB and grows every turn.
`--scrollback N` moves it, since how far back you want to read is a matter of taste.

The terminal object outlives the socket, so a drop leaves the stale screen up rather than
blanking. Input queues while down; resizes do not, since the handshake carries the size.

## Sharing the session with a desktop

`mobile-tty attach` is a WebSocket client of the same protocol, so the desktop is a viewer
like any other — it gets the snapshot too, and it cannot resize the PTY behind the server's
back. It has to act like a terminal on its own account: raw mode restored on every exit
path, SIGWINCH forwarded, `Ctrl-C` and `Ctrl-Z` passed through rather than acted on, and
`Ctrl-]` to detach.

One PTY still has one size, so viewers cannot each have their own. **The narrowest wins**:
this is meant to be read on a phone, and a desktop showing a phone-width column is legible
where the reverse is not. The server picks the size, tells every viewer what it actually is,
and they render that rather than what they asked for. It also makes the common case free —
the phone is already the narrowest, so nothing resizes.

Adopting an *already running* pi is not possible: reassigning a live process's controlling
terminal needs ptrace surgery (`reptyr`), which is Linux-only. pi has to start under the
server. A restart therefore ends it, which is why the default program is
`pi --session-id mobile-tty` — it comes back to the same conversation.

## Access

Cloudflare tunnel, reusing the pi-phone pattern. Tailscale needs a client on every device;
LAN-only defeats the purpose; public-plus-auth means an authenticated shell on the internet.
