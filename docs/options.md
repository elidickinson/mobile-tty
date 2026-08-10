# Options recap

Every plausible choice on each axis, with the short case for and against. Recommendations
marked ★. Reasoning behind them is in `ux-principles.md` and `design-notes.md`.

---

## A. Backend — how the PTY reaches the browser

| Option | Pros | Cons |
|---|---|---|
| ★ **ttyd `--index` + tmux** | Single static binary, zero server code. Protocol is 5 constants. tmux gives reconnect-redraw and persistence free. Afternoon-sized. | One HTML document only — everything inlined, served uncompressed. No service worker → no web push. |
| **ttyd + `tmux -CC`** (control mode) | Adds session/window/pane UI and `capture-pane` replay, still with no server code. In-band structured protocol. | You're writing an iTerm2-class tmux client: demux `%output` per pane, track notifications. Real complexity. |
| **Fork ttyd** | Multi-asset serving, gzip, service worker, replay buffer — all unblocked. Keeps the solid C/libwebsockets PTY core. | C, and a fork to maintain against upstream. Everything it buys except push is reachable client-side anyway. |
| **Own server** (node-pty / Go) | Total control: replay buffer for non-tmux sessions, web push, asset pipeline, multi-session, auth. | You own PTY handling and ops. Only justified once push or non-tmux replay are real requirements. |
| **Adopt + modify an existing mobile project** (remobi, mobux, claude-web-terminal) | Starts far ahead — key bars, gestures, PWA already done. claude-web-terminal is already ttyd+tmux. | Inherit their architecture and their renderer. None does pinned-grid pan/zoom, the one feature that matters most. |
| **GoTTY** (`sorenisanerd` fork) | Go, easy to hack, same lineage. | No advantage over ttyd; smaller ecosystem. |
| **wetty** | Built-in SSH-to-host mode. | Node runtime, heavier, no mobile story. |
| **VibeTunnel as base** | Already ships ghostty-web, asciinema recording, session list. | Big Swift+Node codebase, Mac-centric, its own web UI to fight. |
| **SSH + native client** (cli2ssh/wish + Blink/Termius) | Reconnect, roaming, predictive echo, mature modifier bar — all free, today. | Zero UI control. No pinned-grid zoom, no composer, no tap-to-insert. Rules out the whole point. |

## B. Renderer

| Option | Pros | Cons |
|---|---|---|
| ★ **wterm** | Renders to DOM → native momentum scroll, selection handles, find, a11y for free. ~12KB WASM parser = far smaller single-file bundle. Makes tap-to-insert natural. | Newest and least proven. Smallest ecosystem. |
| **ghostty-web** | Real libghostty VT parser (correct on exotic sequences, RTL). xterm.js-compatible API, so a drop-in swap either direction. ~400KB, MIT. | Canvas — inherits every canvas mobile problem. No addon ecosystem. |
| **xterm.js** | Ecosystem, addons, VS Code-grade, best-documented. | Canvas: no native selection/scroll/find/a11y. Long-open mobile bugs (#1101, #2403, #1007, #5721). Largest bundle. |
| **hterm** | DOM, mature, powers Secure Shell. | Google-internal cadence, awkward to embed. |
| **DomTerm** | DOM, has a ttyd-like server already. | Niche, idiosyncratic, low activity. |
| **Roll your own DOM renderer** | Exactly the mobile behaviour wanted, minimal bytes. | VT emulation is a deep tarpit. Don't. |

**Hedge:** build against the xterm.js API surface. ghostty-web is API-compatible by
design, so that keeps two of the three live and makes wterm the only real port.

## C. Input model

| Option | Pros | Cons |
|---|---|---|
| ★ **Composer primary + direct-mode toggle** | Editability, review-before-send, dictation. Terminal never sees half-typed input. Matches pi.dev's prose-heavy usage. | Two modes to learn. Wrong mode at the wrong moment is a papercut. Needs autocorrect explicitly disabled. |
| **Pure direct keystrokes** | Simplest. Correct for any TUI, not just pi.dev. | OS keyboard eats ~40% of screen, can't chord, predictive text corrupts input, no dictation, painful long-prompt editing. |
| **Custom on-screen keyboard replacing the OS one entirely** | Reclaims ~200pt of viewport. Real chords. Gesture typing and repo-aware completion possible (swell.sh proved the shape). | Big build. Reimplements text entry — layouts, locales, accessibility. Only prior art is stale and limited. |
| **Permanent key bar + summoned full keyboard** | Cheap in pixels, always-available modifiers/arrows/PageUp. Complements any of the above. | Not sufficient alone for text entry. |

Not mutually exclusive: the recommendation is composer + direct toggle + permanent key
bar, with the custom keyboard as a later experiment.

## D. Screen sizing

| Option | Pros | Cons |
|---|---|---|
| ★ **Both, as separate explicit controls** | Reflow when the TUI adapts well; pan/zoom when it doesn't. Covers every case. | Two concepts to expose without confusing the UI. |
| **Reflow only** (font size → cols/rows) | What every tool does. Simple, one slider. | ~50 cols on a phone wrecks dense TUI layouts. |
| **Pinned grid + pan/zoom only** | TUI thinks it's on a desktop; layout preserved. The genuine differentiator — only sshx does it, and it isn't self-hostable. | Panning to read is its own friction. Bad for output that would reflow fine. |

## E. Access / transport

| Option | Pros | Cons |
|---|---|---|
| **Cloudflare tunnel** | No account needed for quick tunnels; static hostname available. Pattern already proven in pi-phone. | Traffic transits Cloudflare. Random URLs unless configured. |
| **Tailscale** | True private mesh, no public exposure. What claude-web-terminal and remobi assume. | Client required on every device. |
| **LAN only** | Simplest, nothing exposed. | Useless away from home — defeats the purpose. |
| **Public + auth** | Works anywhere, no client software. | You are now hosting an authenticated shell on the internet. Needs real care. |

---

## Recommended stack

```
ttyd -W --index client.html tmux new -A -s pi
```

Single self-contained `client.html`: ttyd's WS protocol, iOS standalone meta tags,
permanent key bar, composer + direct toggle with autocorrect off, pinned-grid pan/zoom
alongside reflow, alt-screen-aware scrolling, reconnect-with-repaint. Cloudflare tunnel
for access, reusing the pi-phone pattern.

Escalate only on evidence: `tmux -CC` if the session/pane UI is genuinely wanted, an own
server if web push or non-tmux replay become requirements.
</content>
