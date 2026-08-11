# Options — consolidated

Single current list. Supersedes earlier versions in this file; reflects the KISS cuts and
the pi 0.84.1 measurements in `concerns.md`. ★ = recommended.

Axes D/E/F map to the three stated concerns.

---

## A. Backend — how the PTY reaches the browser

| Option | Pros | Cons |
|---|---|---|
| ★ **ttyd `--index` + tmux** | Single static binary, zero server code, 5-constant protocol. tmux adds session persistence across a ttyd restart and desktop detach/reattach. | One HTML document, served uncompressed. No service worker → no web push. |
| **ttyd `--index`, no tmux** | Simpler still. Now genuinely viable: the resize-nudge repaint and client-side scrollback removed tmux's two load-bearing jobs. | Lose session persistence — kill ttyd and the session is gone. |
| **ttyd + `tmux -CC`** | Structured session/window/pane UI in-band. | **Much weaker than it looked.** Its main draw was `capture-pane` replay, which the resize nudge makes unnecessary. Now buys only a multi-pane UI, for iTerm2-class client complexity. |
| **Fork ttyd** | Multi-asset serving, gzip, service worker. | C fork to maintain; everything except push is reachable client-side. |
| **Own server** (node-pty / Go) | Web push, asset pipeline, multi-session, auth. | You own PTY handling and ops. Justified only once push is a real requirement. |
| **Adopt an existing project** (claude-web-terminal is already ttyd+tmux) | Starts far ahead on key bar, gestures, PWA. | Inherit their architecture and renderer; none does pinned-grid pan/zoom. |
| **SSH + Blink/Termius** | Reconnect, roaming, mature modifier bar — free today. | Zero UI control. No pinned-grid zoom, no composer. Rules out the point of the project. |

## B. Renderer

The measurements **strengthened** this choice: scrolling is now the primary interaction,
and it is exactly what DOM gives you for free.

| Option | Pros | Cons |
|---|---|---|
| ★ **wterm** | DOM → native momentum scroll, selection handles, find, a11y. ~12KB WASM parser = far smaller single-file bundle (matters, `--index` is uncompressed). Makes tap-to-insert trivial. | Newest, least proven, smallest ecosystem. |
| **ghostty-web** | Real libghostty VT parser. xterm.js-compatible API, so a drop-in swap either way. ~400KB, MIT. | Canvas — you reimplement momentum scroll and selection, the main interactions here. |
| **xterm.js** | Ecosystem, addons, best documented, safest. | Canvas, same as above. Four long-open mobile bugs (#1101, #2403, #1007, #5721). Largest bundle. |

*Hedge:* build against the xterm.js API surface — ghostty-web is compatible by design, so
only wterm is a real port.

## C. Input model

| Option | Pros | Cons |
|---|---|---|
| ★ **Composer + direct-mode toggle + permanent key bar** | Editability, review-before-send, dictation free. Terminal never sees half-typed input. Matches pi's prose-heavy usage. | Two modes; wrong mode at the wrong moment is a papercut. Needs autocorrect explicitly off. |
| **Pure direct keystrokes** | Simplest; correct for any TUI. | Keyboard eats ~40% of screen, no chords, predictive text corrupts input, painful long-prompt editing. |
| **Custom on-screen keyboard** | ~150pt instead of ~320pt, real chords. | Big build, reimplements text entry. Deferred. |

Autocorrect off regardless: `autocorrect="off" autocapitalize="off" spellcheck="false"`,
set on the element (iOS does not inherit). No custom dictionary — cut as speculative.

## D. Keyboard vs viewport → **concern 1**

| Option | Pros | Cons |
|---|---|---|
| ★ **Occlude, never reflow.** Keyboard opening does not resize the PTY; it covers the bottom rows and the view scrolls. | Kills the reflow-thrash you feel every time you type — pi otherwise reflows to ~15 rows and back on every open/close. | Bottom rows hidden while typing; pair with `visualViewport` auto-scroll. |
| ★ **Keyboard not summoned by default.** Terminal doesn't take focus on tap. | Removes ~320pt for most of the session — you are mostly reading. Biggest single win. | Needs an obvious summon affordance or it reads as broken. |
| ★ **Standalone display meta tag** | ~120pt ≈ 8 rows back. | One line, no downside. |
| **Key bar for non-text actions** | ~50pt vs ~320pt for approve/cancel/navigate/Ctrl-C. | Doesn't help when typing prose. |
| **Refit on keyboard open** (what everyone ships) | — | The problem, not a fix. |

## E. Resizing → **concern 3**

| Option | Pros | Cons |
|---|---|---|
| ★ **Grid-size presets** (50×30 / 120×40 / 160×50), all verified against pi | One tap, decisive, repeatable. | Reflow is destructive to dense layout at 50 cols — hence the next row. |
| ★ **Render scale, independent** — CSS `transform: scale` + pinch/pan over a pinned grid | pi never knows; thinks it's on a desktop. The genuine differentiator — only sshx does it, and it isn't self-hostable. | Panning to read is its own friction. |
| ★ **Never auto-resize** — not on keyboard, chrome, or rotation | Half of "resize is broken" is "it resizes when I don't want it to". | Rotation must be handled explicitly. |
| **Continuous font slider only** | Simple, what everyone ships. | Conflates the two operations; ~50 cols wrecks dense layout. |

## F. Scrolling → **concern 2**

pi is **not** alt-screen, which collapses this axis to the easy answers.

| Option | Pros | Cons |
|---|---|---|
| ★ **Client scrollback + touch drag** | Just works; holds real conversation history. Native browser scrolling under a DOM renderer. | None. |
| ★ **PageUp/PageDown/Home/End buttons** | Directly answers "send page up/down easily". Scrolls viewport, not sent to pi. | Trivial. |
| ★ **Jump-to-bottom + follow-output toggle** | Needed once you scroll up, so new output doesn't yank you down mid-read. | Small. |
| ~~tmux copy-mode~~ / ~~SGR mouse synthesis~~ / ~~capture-pane reader~~ | — | **Cut.** All solve an alt-screen problem pi doesn't have. Revisit only for vim/htop. |

## G. Access

| Option | Pros | Cons |
|---|---|---|
| ★ **Cloudflare tunnel** | No account for quick tunnels; static hostname available. Pattern already proven in pi-phone. | Traffic transits Cloudflare; random URLs unless configured. |
| **Tailscale** | True private mesh, nothing public. | Client on every device. |
| **LAN only** | Nothing exposed. | Useless away from home. |
| **Public + auth** | Works anywhere, no client software. | Hosting an authenticated shell on the internet. |

---

## Recommended stack

```
ttyd -W --index client.html tmux new -A -s pi
```

One self-contained `client.html` + a Cloudflare tunnel.

## v1 scope

In:

1. ttyd WS protocol (5 constants) + terminal widget.
2. iOS standalone meta tags.
3. Permanent key bar: sticky modifiers, arrows w/ repeat-on-hold, Tab/Esc, PageUp/Dn/Home/End.
4. Composer + direct toggle, autocorrect off.
5. Grid presets **and** independent pinned-grid pan/zoom. Never auto-resize.
6. Scrollback: touch drag, page buttons, jump-to-bottom.
7. Keyboard occludes rather than reflows; `visualViewport` handling; no rubber-band or
   double-tap zoom.
8. Reconnect: keep the terminal, backoff, resize-nudge (N−1 → N) to force repaint.

Out until there is evidence: custom dictionary; `tmux -CC` and pane UI; custom on-screen
keyboard; own server, service worker, web push (use Pushover out-of-band); voice/TTS,
recording, multi-user; alt-screen handling for arbitrary TUIs.
</content>
