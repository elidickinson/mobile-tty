# Decisions

Why the thing is shaped this way. Measured values live in `numbers.md`.

## Backend: ttyd `--index` + dtach

ttyd is plumbing, not a terminal: it allocates a PTY, pumps raw VT bytes over a WebSocket,
and calls `ioctl` for SIGWINCH. The protocol is five constants, so the client speaks it in
~30 lines.

`--index` serves **exactly one document** plus `/token`; every other path is rejected. So
the client is a single self-contained file — all CSS and JS inline, no service worker (they
cannot register from `data:` URLs). That costs offline support, meaningless for a terminal,
and web push, which belongs on Pushover anyway.

ttyd kills its child when the socket closes, so something must hold the PTY or every
reconnect starts a fresh pi. **dtach, not tmux**: tmux 3.7b takes the outer terminal's
alternate screen unconditionally — `alternate-screen off`, `terminal-overrides
',*:smcup@:rmcup@'` and `terminal-features ',*:-alternatescreen'` all leave `\e[?1049h` in
the stream. The alternate screen has no scrollback, which would delete the entire reason
for choosing a DOM renderer. dtach emulates no terminal, so pi's bytes arrive unchanged.

What dtach gives up is tmux's replay buffer; the resize nudge covers exactly that.

## Renderer: wterm, DOM over canvas

The renderer owns the screen model, scrollback, painting and key encoding — which is to say
it owns all three problems. ttyd owns none of them.

`@wterm/dom` renders to the DOM, so momentum scroll, selection handles and find come free.
Two properties make it fit: its Zig VT core ships as **inlined base64 WASM**, which is what
survives the single-document constraint, and `write(Uint8Array)` hands raw bytes to the
parser — so a multi-byte sequence split across two WebSocket messages is reassembled by the
core and JS never decodes the socket.

ghostty-web is the API-compatible fallback. xterm.js is canvas, has the largest bundle, and
carries long-open mobile bugs (#1101, #2403, #1007, #5721).

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
  document regardless of `no-store`, so the page compares a build stamp and reloads itself.

## Scrolling

pi does not use the alternate screen and dtach does not impose one, so the terminal's own
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

Attaching to a dtach session gives a blank screen with no replay, so the size is nudged
N−1 → N to force a repaint — on *every* attach, since a freshly loaded page routinely lands
on a session that has been running for hours. **The two sizes need a gap** (120 ms): sent
back to back, the app reads the window size only after both ioctls, sees the size it
already had, and draws nothing.

The terminal object outlives the socket, so a drop leaves the stale screen up rather than
blanking. Input queues while down; resizes do not — the handshake carries the size, and
queuing it would flush in the same tick as the nudge and collapse the gap.

## Sharing the session with a desktop

`dtach` multiplexes attachers, so the host joins the running session with no change to the
stack:

```
dtach -a "${TMPDIR:-/tmp}/mobile-tty.sock" -r winch
```

Both clients see each other's input and output. What they cannot have is separate sizes:
one PTY has one size, and whoever set it last owns it — an attaching desktop leaves the
phone rendering a grid the PTY no longer has.

Taking it back needs a *real* change. Re-sending the same numbers reaches nothing: ttyd
finds its own PTY unchanged, raises no SIGWINCH, and dtach forwards nothing. So it is the
nudge, it costs two redraws, and it is therefore **Fit** — a deliberate tap — rather than a
poll. Whoever acted last owns the size; Fit is how the phone acts.

Adopting an *already running* pi is not possible: reassigning a live process's controlling
terminal needs ptrace surgery (`reptyr`), which is Linux-only. pi has to start under dtach.

## Access

Cloudflare tunnel, reusing the pi-phone pattern. Tailscale needs a client on every device;
LAN-only defeats the purpose; public-plus-auth means an authenticated shell on the internet.
