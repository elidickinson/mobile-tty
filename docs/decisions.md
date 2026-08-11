# Decisions

Rationale behind the plan in the README. Measured values live in `numbers.md`.

## Backend: ttyd `--index` + tmux

ttyd is plumbing, not a terminal: it allocates a PTY, pumps raw VT bytes over a WebSocket,
and calls `ioctl` for SIGWINCH. The protocol is five constants (`numbers.md`), so the
client speaks it directly in ~30 lines.

`--index` replaces the entire frontend, but ttyd serves **exactly one document** plus
`/token` — `src/http.c` rejects every other path. So the client must be a single
self-contained file: all CSS and JS inline, assets as `data:` URIs, and no service worker
(they cannot register from `data:` URLs). That costs offline support, which is meaningless
for a terminal, and web push, which belongs on an out-of-band channel like Pushover
anyway.

No sidecar. The two things a static-serving sidecar would buy are both reachable from the
client: iOS standalone mode needs only meta tags, and reconnect repaint is a resize nudge.

tmux earns its place for **session persistence** only — surviving a ttyd restart, and
detach/reattach from the desktop. It is not needed for scrolling or for repaint.

`tmux -CC` control mode would add a session/window/pane UI in-band, but at the cost of
writing an iTerm2-class client that demuxes `%output` per pane. Not worth it for one
session.

## Renderer: DOM over canvas

The renderer owns the screen model, scrollback, painting, and key encoding — which is to
say it owns all three problems. ttyd owns none of them.

**wterm** renders to the DOM, so momentum scroll, selection handles, find and
accessibility come free; its ~12KB WASM parser also keeps the single file small, which
matters because `--index` is served uncompressed. Scrolling is the primary interaction
here, and it is exactly what canvas makes you rebuild.

**ghostty-web** is the fallback: a real libghostty parser with an xterm.js-compatible API,
so it is a drop-in swap. **xterm.js** is the conservative choice but is canvas, has the
largest bundle, and carries long-open mobile bugs (#1101, #2403 predictive text corrupting
input, #1007 touch scroll, #5721 iOS Ctrl-C).

Build against the xterm.js API surface: ghostty-web matches it by design, so only wterm is
a real port.

## Input: straight to pi, with a hidden capture element

pi's autocomplete — `/commands`, `@file` — fires *as you type*, and its menu renders
directly above its input box. A client-side composer would break both: pi never sees the
keystrokes, so no menu appears, and the menu's region is exactly what a composer-first
layout wants to pan away from.

So keystrokes stream to pi and **pi's input box stays visible and anchored**, costing 5–6
rows. Row pressure and the need to see that box arrive at the same moment, so trading one
for the other does not work:

- Keyboard up → typing → pi's box and menus are needed. Pan for context, snap back.
- Keyboard down → reading → full rows, free panning.

The client contributes a *hidden* `<textarea>` that never displays. It exists to make
`autocorrect="off" autocapitalize="off" spellcheck="false"` possible (set on the element;
iOS does not inherit them) and to enable dictation, which cannot work against a terminal
capturing raw keys. Zero row cost.

Autocorrect is a liability, not a benefit: agent prompts are jargon-dense, and a
*corrected* identifier silently points the agent at the wrong file, whereas a typo in prose
is inferred straight through. No custom dictionary or completion engine — speculative
complexity for a guess about what gets retyped.

An optional long-prompt composer, invoked deliberately, can exist for dictating a
paragraph. Not a default, and not a mode reachable by accident.

## Keyboard and viewport

The problem is viewport control, not resize policy: pi reflows correctly at any size, but
the surviving rows go to its own input box and status line, and that window cannot be
moved.

- **Anchor the viewport to pi's input box** by default.
- **Occlude and pan rather than reflow** — keep the grid pinned, let the keyboard cover
  part of it, pan over an unchanged screen. This is the same mechanism as pinned-grid
  pan/zoom, so one control solves both problems.
- **Standalone display mode** via `apple-mobile-web-app-capable`, worth +7 rows.
- **Key bar** for approve/cancel/navigate/Ctrl-C, ~50pt against the keyboard's ~310.
- **Size layout from `visualViewport`**, never `height:100%` — the latter is the layout
  viewport and puts the UI underneath the keyboard. Debounce: nothing here is constant.

A custom on-screen keyboard would reclaim ~160pt more, but it means reimplementing text
entry. Deferred; the key bar covers most of the value.

## Scrolling

pi does not use the alternate screen buffer, so the terminal's own scrollback holds real
conversation history and can simply be scrolled locally. No tmux copy-mode, no synthesised
mouse events (pi enables no mouse reporting), no `capture-pane` reader view.

Treat the nub as a **velocity source** with a pluggable sink. Today the sink is local
scrollback. Alternate-screen apps — Claude Code, vim, htop — have no client scrollback and
would need the velocity routed to PageUp/PageDown or synthesised SGR wheel events instead
(`numbers.md`). That is out of scope for v1, but the framing keeps it a small addition
rather than a rewrite.

Touch drag works but should not be primary — it competes with text selection, iOS edge
gestures, and decisively with **panning the pinned grid**, which already claims the drag
gesture. It is also poor one-handed.

So the primary control is a **velocity nub**: a fixed, thumb-reachable pad where
displacement sets scroll *speed*, not distance. Small pull creeps a line at a time, larger
pull travels fast, release stops. Making it 2D unifies scroll and pan — the viewport
becomes a window over a tall surface, scrollback above and live screen below, with no
modes and no gesture conflict.

Alongside it: discrete PageUp/PageDown/Home/End buttons (precise, and immune to gesture
capture), a position indicator, and a follow-output toggle so new output does not yank you
down mid-read.

## Resizing

Two independent operations, conflated by every existing tool into one font-size slider:

- **Reflow** — change cols/rows, SIGWINCH, pi relayouts. Offered as presets (50×30,
  120×40, 160×50) rather than a continuous slider: one tap, repeatable.
- **Render scale** — CSS `transform: scale` with pinch and pan over a *pinned* grid. pi
  only learns cols/rows from the PTY, so it believes it is on a desktop. Nothing
  self-hostable offers this.

**Landscape is a first-class option**, not an edge case: it yields 108 columns against
portrait's 50, trading rows for columns almost exactly. Since ~50 cols is what wrecks a
dense layout, rotating is a free resize strategy. Rotate for width, pan for the rest.

**Never auto-resize** — not on keyboard, browser chrome, or rotation. Grid changes only on
explicit user action.

## Reconnect

pi fully repaints on SIGWINCH, so a **resize nudge** (send N−1 cols, then N) forces a
complete redraw on demand. That is a free, app-agnostic reconnect repaint needing no tmux
keybind, no control mode, and no server-side replay buffer.

With it: keep the terminal object across reconnects so the stale screen stays visible
rather than blanking, reconnect with backoff, queue input while down, and show connection
state unobtrusively.

## Access

Cloudflare tunnel, reusing the pi-phone pattern — no account needed for quick tunnels, and
a static hostname is available. Tailscale is the private-mesh alternative but needs a
client on every device. LAN-only defeats the purpose; public-plus-auth means hosting an
authenticated shell on the internet.
