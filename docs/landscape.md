# Landscape survey

Researched 2026-08-10. Scope: getting a full-screen TUI (pi.dev, vim, lazygit) usable
from a phone.

There are four distinct architectures. Most people conflate them.

---

## Architecture A — PTY over WebSocket to a browser terminal

The category ttyd is in. Server allocates a PTY, pipes bytes over WS, browser renders.

| Project | Stack | Notes |
|---|---|---|
| **ttyd** | C, libwebsockets + libuv | Single static binary, actively maintained. `--index` for custom client, `-t` client options, ZMODEM, TLS, basic auth. The de-facto baseline. |
| **GoTTY** (`yudai/gotty`) | Go | The original. Effectively unmaintained; `sorenisanerd/gotty` is the live fork. ttyd is a port of it. |
| **wetty** | Node, xterm.js | Adds SSH-to-host as a first-class mode. Heavier runtime. |
| **shellinabox** | C, own JS terminal | Ancient (pre-xterm.js), own web server. Historical interest only. |
| **DomTerm** / `ldomterm` | C server + DOM-based terminal | Pseudo-fork of ttyd swapping xterm.js for DomTerm. Renders to DOM, so native selection/find. Niche but the DOM idea is now mainstream (see wterm below). |
| **sshx** | Rust, E2EE (Argon2+AES) | Genuinely novel UI: **infinite canvas**, multiple terminals you pan/zoom freely, live multi-user cursors, Mosh-style predictive echo. **Not self-hostable** ("not supported at the moment") — that kills it for us, but the pan/zoom model is the single best idea in this whole survey. |
| **sshwifty / webssh2 / ShellHub** | various | SSH-gateway flavored. Auth/fleet features, not mobile UX. |

## Architecture B — tmux-aware web clients (the mobile crowd)

Same as A but with tmux underneath and tmux-specific UI. **Nearly every serious mobile
attempt lands here**, and that is the most important signal in this research — see
`design-notes.md` for why (reconnect/redraw).

| Project | Stack | Mobile features that matter |
|---|---|---|
| **lhymes/claude-web-terminal** | **ttyd + tmux** + Tailscale, xterm.js | Closest existing thing to the stated goal. Floating **input bubble** (compose with autocorrect/dictation, Enter sends, Shift+Enter newline, persistent history) separate from the terminal; shortcut bar with **Keys mode** (Tab, Esc, arrows w/ repeat-on-hold) and **Tabs mode** (1–9 tmux windows); single-finger scroll; layout locked to screen to kill bounce/zoom; font scales with viewport; PWA add-to-home-screen; ≥769px switches to a desktop toolbar. Terminal is **read-only on mobile** — tapping does not raise the OS keyboard. |
| **remobi** (connorads) | Node + node-pty, xterm.js, no framework, esbuild | tmux/zellij/herdr. **Pinch-to-zoom font 8–32pt**, swipe between windows, two-row customizable toolbar, collapsible command drawer, corner floating buttons, PWA. Touch scroll configurable as **SGR mouse wheel events *or* PageUp/PageDown** — exactly the ambiguity worth getting right. Needs `mouse on` in tmux. No auth (expects Tailscale/CF in front). v0.1. |
| **mobux** (mvhenten) | Rust/axum, frontend embedded in binary | Scrollable **control-key ribbon** (^C, arrows, Tab, Esc). Swipe to rename/kill session, swipe to change window, long-press for tmux commands. Separate **reader view** with synthetic mobile-tuned scrolling + pinch-zoom. Voice input via whisper.cpp/OpenAI; TTS output. Pluggable renderer (xterm.js default, experimental "sterk"). |
| **webtmux** (chrismccord) | Go + gorilla/websocket, xterm.js + Lit | Extends gotty's protocol with tmux message types. **Visual pane-layout sidebar** (tap a pane to focus), window tabs, split/new buttons, and **scroll-to-copy-mode** (scrolling auto-enters tmux copy mode) — a clean fix for mobile scrollback. Young (~18 commits). |
| **tmux-mobile** (DagsHub) | — | Mobile-first tmux web client, Cloudflare tunnel access. |
| **VibeTunnel** | Node/TS server + Swift menubar app, Lit, **ghostty-web** | `vt <cmd>` wrapper allocates a PTY and forwards. asciinema recording of all sessions. Native iOS app (WIP). Responsive but by their own docs "not optimised for smaller screens". Notable mostly for shipping ghostty-web in production. |
| **swell.sh** (wcchoi) | Python + PTY + ptrace, WS | The outlier: a **custom gesture-typing on-screen keyboard** — swipe to type, swipe up from space = Tab-complete, swipe left on backspace = Ctrl-W, plus real shell autocomplete piped from bash-completion and NeoVim APIs. Only project that replaces the OS keyboard outright. Heavily limited (64-bit Linux, bash only, single session, no F-keys/PageUp-Dn, US QWERTY) and stale, but it's the clearest prior art for a permanent on-screen keyboard. |
| **kubestellar/copilot-remote** | React PWA, xterm.js | Copilot CLI oriented. Standard responsive terminal. |

## Architecture C — SSH transport, native mobile client

Skip the browser. Expose the TUI over SSH and let a mature native terminal solve the
keyboard problem for you.

| Project | Notes |
|---|---|
| **cli2ssh** (HoneyLLM) | Wraps any CLI/TUI as an SSH server. Handles PTY + resize correctly. `cli2ssh -c $(which oterm)`. |
| **charmbracelet/wish** | Go framework for SSH-served apps; middleware for auth/PTY/Bubble Tea. What you'd build on for anything custom here. |
| **tmate** | tmux session sharing over SSH, hosted relay. |
| Clients | **Blink Shell** (iOS, Mosh, SmartKeys bar with *continuously pressable* Ctrl/Alt), **Termius** (hotkey bar in reorderable groups of 4; auto-hides on hardware keyboard), **Termux/ConnectBot** (Android extra-keys row). |

**Why this matters:** Blink + Mosh already solves reconnect, roaming, predictive echo,
and the modifier bar — the three hardest problems below. The cost is you don't control
the UI at all, and there's no "flexible screen resizing" beyond font size.

## Architecture D — replace the TUI with a bespoke app

Not what's wanted here, but it's where the market went. Listed so it's not re-researched.

**pi-phone** (yours), **Happy Coder** (open source, TweetNaCl E2EE, iOS/Android/web),
**Omnara**, Conductor, Claudia, Tonkotsu, CodeRemote, YoloCode. All parse agent protocol
and render chat. Better for approve/steer, useless for arbitrary TUIs.

---

## Browser terminal engines

The renderer is now a real decision, not automatic.

| Engine | Approach | Verdict |
|---|---|---|
| **xterm.js** | Canvas/WebGL, TS reimplementation of VT | Default choice, VS Code-grade. Known mobile problems, all long-open: [#1101 mobile support](https://github.com/xtermjs/xterm.js/issues/1101), [#2403 predictive keyboard corrupts input](https://github.com/xtermjs/xterm.js/issues/2403), [#1007 touch scroll should send arrows](https://github.com/xtermjs/xterm.js/issues/1007), [#5721 iOS hardware kbd Ctrl-C sends keyCode 13](https://github.com/xtermjs/xterm.js/issues/5721). Canvas means no native selection/find/a11y. |
| **ghostty-web** (coder) | libghostty compiled to WASM, ~400KB, **xterm.js-compatible API** | Drop-in (`@xterm/xterm` → `ghostty-web`). Real Ghostty VT parser, so RTL/complex scripts/exotic sequences are right. MIT. Actively developed; no addon ecosystem. Shipping in VibeTunnel. |
| **wterm** (Vercel) | **Renders to DOM**; Zig+WASM parser, ~12KB `.wasm` | Native text selection, browser find, accessibility for free — which on mobile also means native touch scrolling and text-selection handles. Supports alt screen, scrollback, 24-bit color, sync output (mode 2026), WS transport. Optional libghostty backend. Newest, least proven. |
| **hterm** | DOM, Chromium's | Powers Secure Shell. Mature but Google-internal cadence. |
| **DomTerm** | DOM | See above. |

For a mobile-first project, **wterm's DOM rendering is strategically interesting**: the
hardest mobile problems (momentum scroll, selection handles, pinch-zoom, a11y) are ones
the browser already solves for DOM and that canvas forces you to reimplement.

---

## Sources

[ttyd](https://github.com/tsl0922/ttyd) ·
[GoTTY](https://github.com/yudai/gotty) ·
[wetty](https://www.x-cmd.com/pkg/wetty/) ·
[DomTerm/ldomterm](https://github.com/tsl0922/ttyd/issues/35) ·
[sshx](https://github.com/ekzhang/sshx) ·
[claude-web-terminal](https://github.com/lhymes/claude-web-terminal) ·
[remobi](https://github.com/connorads/remobi) ·
[mobux](https://github.com/mvhenten/mobux) ·
[webtmux](https://github.com/chrismccord/webtmux) ·
[tmux-mobile](https://github.com/DagsHub/tmux-mobile) ·
[mux-pod](https://github.com/moezakura/mux-pod) ·
[VibeTunnel](https://github.com/amantus-ai/vibetunnel) ·
[swell.sh](https://github.com/wcchoi/swell.sh) ·
[copilot-remote](https://github.com/kubestellar/copilot-remote) ·
[cli2ssh](https://github.com/HoneyLLM/cli2ssh) ·
[charmbracelet/wish](https://github.com/charmbracelet/wish) ·
[Blink Shell docs](https://docs.blink.sh/) ·
[Termius mobile terminal](https://docs.termius.com/terminal/mobile-terminal) ·
[xterm.js](https://github.com/xtermjs/xterm.js/) ·
[ghostty-web](https://github.com/coder/ghostty-web) ·
[wterm](https://wterm.dev/) ·
[Happy](https://happy.engineering/) ·
[Omnara](https://remote.omnara.com/) ·
[mtmux: the modifier key problem](https://mtmux.com/blog/tmux-from-phone) ·
[Safari 13, mobile keyboards, and the VisualViewport API](https://tkte.ch/articles/2019/09/23/safari-13-mobile-keyboards-and-the-visualviewport-api.html)
</content>
