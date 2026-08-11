# Decisions

Rationale behind the plan in the README. Measured values live in `numbers.md`.

## Backend: ttyd `--index` + dtach

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

Session persistence is not optional: ttyd spawns one process per WebSocket connection and
kills it when the socket closes, so without a session manager every reconnect starts a
*fresh* pi.

**dtach**, not tmux. Measured: tmux 3.7b always puts the outer terminal into the alternate
screen on attach (`\e[?1049h`), and neither `alternate-screen off`, `terminal-overrides
',*:smcup@:rmcup@'`, nor `terminal-features ',*:-alternatescreen'` stops it. The alternate
screen has no scrollback, so under tmux the client sees `usingAltScreen() === true` and
`getScrollbackCount() === 0` — which destroys native scrolling, selection and find, the
entire reason for choosing a DOM renderer. Scrolling would have to be routed back through
tmux's own copy-mode via synthesised SGR wheel events.

dtach does one thing: it holds the PTY so the program outlives the socket. It emulates no
terminal, so pi's bytes reach the client unchanged and the alternate screen stays free.
Measured under dtach: `alt: false`, real client scrollback, and pi survives the drop.

What dtach gives up is tmux's replay buffer — reattaching yields a blank screen. The
resize nudge covers exactly that (see Reconnect), which is why it was worth building.

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

pi does not use the alternate screen buffer, and dtach does not impose one, so the
terminal's own scrollback holds real conversation history and can simply be scrolled
locally. No copy-mode, no synthesised mouse events (pi enables no mouse reporting), no
`capture-pane` reader view. This only holds because the stack keeps the alternate screen
free — it is the reason tmux is not in it.

Treat the nub as a **velocity source** with a pluggable sink. Today the sink is local
scrollback. Alternate-screen apps — Claude Code, vim, htop — have no client scrollback and
would need the velocity routed to PageUp/PageDown or synthesised SGR wheel events instead
(`numbers.md`). That is out of scope for v1, but the framing keeps it a small addition
rather than a rewrite.

**Native touch drag is the primary control.** A velocity nub was built first, on the
reasoning that drag would compete with panning the pinned grid. In the built client it does
not: vertical scroll belongs to the terminal element and horizontal pan to the frame around
it, so they are separate native scrollers and the conflict never arises. Tested on device,
the nub earned nothing drag did not already do, so it was removed rather than kept as a
second way to do the same thing.

Alongside drag: **⇞/⇟ page the view**, not the app. pi answers PageUp with `\e[1G\e[?25l`
and nothing else, so forwarding those keys would be dead weight; history lives in the
client's scrollback, which is what wants paging. An app that pages itself would want the
bytes instead — a per-app decision, not a general one.

A **↓ latest** button appears when scrolled away from the live screen. Follow-output needs
no toggle: wterm sticks to the bottom only when already at the bottom, so reading is never
yanked away.

## Resizing

Two independent operations, conflated by every existing tool into one font-size slider:

- **Reflow** — change cols/rows, SIGWINCH, pi relayouts. Offered as presets (50×30,
  120×40, 160×50) rather than a continuous slider: one tap, repeatable.
- **Render scale** — CSS `transform: scale` with pinch and pan over a *pinned* grid. pi
  only learns cols/rows from the PTY, so it believes it is on a desktop. Nothing
  self-hostable offers this.

The insets are not resolved on the very first layout pass, so the initial fit is short by
the bottom inset and leaves rows below the fold. One refit on the next frame fixes it.

**Landscape is a first-class option**, not an edge case: it yields 108 columns against
portrait's 50, trading rows for columns almost exactly. Since ~50 cols is what wrecks a
dense layout, rotating is a free resize strategy. Rotate for width, pan for the rest.

**Resize only on deliberate action.** The keyboard opening and browser chrome collapsing
are involuntary and must never touch the grid — reflowing pi mid-sentence is the thing this
rule exists to prevent. Rotating the phone is deliberate, and landscape is worth roughly
twice the columns, so it refits. Requiring a menu tap for the single biggest win available
was the rule misfiring.

**The grid is sized from the layout viewport, not the visual one.** `innerHeight` ignores
the keyboard, so the grid survives it opening and only the visible window shrinks — which
is the occlude-and-pan model above, arrived at from the other direction. Sizing from the
visual viewport would have baked a keyboard-sized grid in whenever the two interacted.

## Reconnect

pi repaints on SIGWINCH, so a **resize nudge** (send N−1 cols, then N) forces a redraw on
demand. That is a free, app-agnostic reconnect repaint needing no keybind, no control mode,
and no server-side replay buffer — which is what lets dtach replace tmux despite having no
replay buffer of its own.

**The two sizes must not land in the same tick.** Sent back to back, the app reads the
window size only after both ioctls have applied, sees the size it already had, and does
nothing. Measured: with no gap the reattached screen stays blank; with a 120 ms gap pi
repaints.

With it: keep the terminal object across reconnects so the stale screen stays visible
rather than blanking, reconnect with backoff, queue input while down, and show connection
state unobtrusively.

## Access

Cloudflare tunnel, reusing the pi-phone pattern — no account needed for quick tunnels, and
a static hostname is available. Tailscale is the private-mesh alternative but needs a
client on every device. LAN-only defeats the purpose; public-plus-auth means hosting an
authenticated shell on the internet.
