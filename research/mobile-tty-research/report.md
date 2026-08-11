# What to borrow: mobile terminal UX across the open-source landscape

Survey of major open-source SSH/mobile-terminal/web-terminal/TUI projects, mapped against
mobile-tty's stack (ttyd `--index` + dtach + wterm DOM renderer, iOS-first, targets pi.dev
main-screen TUI). Four parallel research agents; primary sources cited throughout.

## TL;DR — ranked borrows

| # | Idea | From | Effort | Payoff |
|---|---|---|---|---|
| 1 | **dtach-rev** (dtach fork with 256 KB replay buffer) instead of stock dtach | bmills23/dtach-rev | Small (swap binary, OSC markers in client) | Restores *scrollback* on reconnect — the one thing the resize nudge cannot do |
| 2 | **ttyd PAUSE/RESUME flow control** (watermark-based) | ttyd stock client | Small (transport.js) | PTY floods (pi streaming output) can't wedge a slow phone |
| 3 | **Macro keys + popup-on-swipe-up on the key bar** | Termux extra-keys | Small–medium | One-tap "Ctrl+C", "/compact", "esc :q" etc.; swipe-up popup avoids the long-press/selection collision |
| 4 | **Blink modifier model** (tap = one-shot, long-press = chain/lock) | Blink Shell | Small | A/B against current sticky toggle |
| 5 | **Find in scrollback** — first check if iOS native find-in-page already works over wterm's real DOM | VS Code / xterm search addon | Check, then small–medium | The one scrollback feature mobile-tty lacks |
| 6 | **Visible disconnect banner** + verify `--ping-interval` | Mosh (telltale), ttyd | Small | Phone networks die silently; Mosh's core UX lesson |
| 7 | **Key-event log in diagnostics** | Termux `TERMINAL_VIEW_KEY_LOGGING_ENABLED` | Tiny | On-device IME debugging (the ≡ panel pattern extended) |
| 8 | **Verify wterm handles CSI 2026** (sync output) | pi-tui emits it | Check only | pi repaints are atomic-frame; if wterm ignores 2026, phone shows flicker |
| 9 | **Tap-to-position cursor** (synthetic arrows, mode 2001 / OSC 133) | kitty/iTerm2/Konsole | Large, deferred | Tap the prompt to move the cursor — needs client-side OSC 133 parsing |
| 10 | **OSC 52 clipboard** (read+write) | xterm addon-clipboard | Small | Paste-from-terminal, but Safari gesture restrictions apply — verify need first |

Deliberately **not** worth copying: Mosh's predictive echo (bad for modal TUIs), Mosh
itself (no scrollback, no attach after client restart), tmux `-CC` (maintainers call it
"black magic"), mouse reporting on the primary screen (eats scrollback).

---

## 1. Reconnect, replay, and session persistence

### The gap mobile-tty works around is well understood

dtach "simply loses any output programs make while they are detached"
[lobste.rs](https://lobste.rs/s/ybf4ss/alden_detachable_terminal_sessions). The Lobsters
analysis of alden enumerates the three strategies for output-while-detached:
(1) reprint raw bytes — fine for line programs, terrible for TUIs whose terminal state
changed; (2) emulate a terminal server-side (mosh/tmux/screen) — tmux also keeps
scrollback; (3) forget output, send a redraw on attach (SIGWINCH/Ctrl-L) — "the messy
compromise dtach actually takes" — exactly mobile-tty's nudge
[lobste.rs](https://lobste.rs/s/ybf4ss/alden_detachable_terminal_sessions).

### dtach-rev: the drop-in fix for missing replay

**bmills23/dtach-rev** (2026) is a dtach fork adding a 256 KB circular scrollback buffer
of PTY output, replayed to newly attaching clients and wrapped in
`\033]dtach-rev;replay-start\007` / `...-end\007` OSC markers so clients can distinguish
replay from live output. `-b <size>` flag (0 disables). Motivation is literally
mobile-tty's: "for AI coding assistants running over SSH… losing context on reconnection
is a significant problem." Homebrew tap `bmills23/terminallm`; conflicts with stock dtach
binary [github.com/bmills23/dtach-rev](https://github.com/bmills23/dtach-rev).

Caveat from the same Lobsters thread: raw replay "would work terribly for a TUI if, when
the program is attached, the terminal is in a different state than when detach happened"
[lobste.rs](https://lobste.rs/s/ybf4ss/alden_detachable_terminal_sessions). For pi the
nudge already forces a full repaint after attach, so the sequence replay-then-repaint
should land in a correct state — but this must be verified against real pi, and the OSC
markers let the client clear before replay if needed.

### shpool: the middle path

shpool keeps native scrollback (raw relay like dtach) but "continually maintains an
in-memory render of the terminal state via the shpool_vt100 crate. On reattach, shpool
will use this in-memory render to re-draw the screen" — raw relay during normal operation,
terminal emulation only for repaint
[github.com/shell-pool/shpool](https://github.com/shell-pool/shpool). Heavier than
dtach-rev (a daemon), but the correct architecture if replay quality matters.

### Mosh SSP: the "right" answer, wrong fit

Mosh's server and client each hold a screen snapshot; SSP diffs fast-forward the client,
skipping intermediate frames; diffs carry source/target/throwaway state numbers with
ack-on-failure and prophylactic retransmission; roaming is stateless (newer authentic
datagram rebinds the target IP; heartbeat ≥3 s) [mosh.org](https://mosh.org/),
[USENIX ;login:](https://www.usenix.org/system/files/login/articles/winstein.pdf),
[issue #1087](https://github.com/mobile-shell/mosh/issues/1087).

Why not for mobile-tty:
- **No scrollback**: "synchronizes only the visible state"; Blink's official answer is
  "use tmux or screen" [docs.blink.sh](https://docs.blink.sh/advanced/advanced-mosh),
  [mosh issue #2](https://github.com/mobile-shell/mosh/issues/2). Scrollback is
  mobile-tty's core value proposition.
- **No attach after client restart** — a fresh client cannot join an existing mosh
  session [;login: essay](https://www.usenix.org/system/files/login/articles/winstein.pdf).
- **Predictive echo is dangerous for modal TUIs**: predictions assume line-input echo
  semantics; vi-mode and modal apps get echo-then-rectify, and it briefly reveals typed
  passwords [LWN comments](https://lwn.net/Articles/722923). pi is modal.
- SSP is not standardizable ("not at all extensible… strongly tied to the Mosh codebase"
  — maintainer) [issue #1087](https://github.com/mobile-shell/mosh/issues/1087).
- UDP ports 60000–61000 + SSH bootstrap adds server complexity.

**Borrow the UX, not the protocol**: Mosh warns when the connection is dead instead of
hanging silently — "if your Internet connection drops, Mosh will warn you"
[mosh.org](https://mosh.org/). mobile-tty has the state in the ≡ menu; a visible banner
would match Mosh's behavior.

### tmux -CC: black magic, skip

Control mode (`-CC`) streams `%output` notifications with `capture-pane -p -e` as the
repaint primitive and `pause-after`/`refresh-client -A` flow control
[tmux wiki](https://github.com/tmux/tmux/wiki/Control-Mode). But both George Nachman and
wez describe it as "black magic," "a fundamentally difficult problem" with little
documentation and version-skew pain
[wezterm #4889](https://github.com/wezterm/wezterm/discussions/4889). And it doesn't
resolve the reason mobile-tty rejected tmux (unconditional alternate screen — research
found no source confirming whether -CC over a bare PTY avoids it; flagged UNCERTAIN).

### ET: resumable TCP, not applicable

Byte-level resumable stream (BackedReader/BackedWriter) survives roaming and preserves
native scrollback, but its keepalive scheme (5 s/7 s) proved fragile under churn and it
suffered latency from port scans [eternalterminal.dev](https://eternalterminal.dev/howitworks/),
[issue #120](https://github.com/MisterTea/EternalTerminal/issues/120). Different
transport than ttyd+WebSocket; nothing to borrow beyond "keepalive tolerance."

### dtach/abduco mechanics worth knowing

- dtach's `-r` redraw methods exist because programs differ: 0.6 switched ^L → WINCH,
  0.7 made it configurable and reverted the default to `^L` ("many programs only handle
  one or the other properly") [dtach changelog](https://dtach.sourceforge.net/). `-r winch`
  (mobile-tty's choice) is right for a TUI, but ^L remains the fallback if a target app
  ever ignores SIGWINCH.
- abduco's deltas vs dtach: session list, exit status, read-only sessions (`-r`), and —
  notably — resize requests on shared sessions are only honored from the most-recently
  attached non-read-only client [github.com/martanne/abduco](https://github.com/martanne/abduco).
  Relevant if mobile-tty ever supports a second viewer.

---

## 2. Keyboard and input (key bar)

### Termux extra-keys — the richest prior art, directly applicable

- Config-driven rows; each key is a string or `{key: X, popup: Y}`; **popup keys fire on
  swipe-up, not long-press** (finger moving above the button's top edge), so they don't
  collide with selection's long-press [ExtraKeysView.java](https://raw.githubusercontent.com/termux/termux-app/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysView.java).
- **Macros**: `{key: ESC, popup: {macro: "CTRL f d", display: "tmux exit"}}` —
  space-separated modifier words + keys or literal text; `\n` sends Enter. E.g.
  `{macro: ":q\n", display: "QuickExit"}` [termux.properties](https://raw.githubusercontent.com/termux/termux-tools/master/termux.properties),
  [TerminalExtraKeys.java](https://raw.githubusercontent.com/termux/termux-app/master/termux-shared/src/main/java/com/termux/shared/termux/terminal/io/TerminalExtraKeys.java).
  **This is the single most borrowable input idea for pi**: one-tap Ctrl+C, `/compact`,
  `esc` + `:q`.
- Modifier special buttons have **three states: inactive / one-shot / locked**. Tap
  toggles active; a key event auto-clears it unless locked; **long-press locks**
  (`SpecialButtonsLongHoldRunnable`, after system long-press timeout)
  [ExtraKeysView.java](https://raw.githubusercontent.com/termux/termux-app/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysView.java).
- Repeat-on-hold for a fixed list (arrows, BKSP, DEL, PGUP, PGDN): initial delay =
  system long-press (~400 ms), repeat 80 ms [ExtraKeysView.java](https://raw.githubusercontent.com/termux/termux-app/master/termux-shared/src/main/java/com/termux/shared/termux/extrakeys/ExtraKeysView.java).
  mobile-tty uses 400/60 — same model, fine.
- Known config bug to avoid: each special key (CTRL/ALT/SHIFT/FN) may appear only once
  per definition [Mobile Coding Hub](https://mobile-coding-hub.github.io/termux/customisation/extra_keys/).
- Display glyph sets (`extra-keys-style`: arrows-only/arrows-all/all/none) swap glyphs
  without changing key identity — a cheap customization surface.

### Blink Smart Keys — the other modifier model

Modifiers are tap-toggle one-shot; **long-press-hold (0.3 s) chains** — while held,
modifiers don't auto-release ("Hold a modifier to chain multiple combinations… like
`C-x`, `C-c` in Emacs") [SmartKeysView.m](https://raw.githubusercontent.com/blinksh/blink/main/Frameworks/SmartKeys/smartkeys/SmartKeysView.m).
Selecting ALT swaps the non-modifier section to an alternate set (F-keys/cursor keys)
[SmartKeysView.m](https://raw.githubusercontent.com/blinksh/blink/main/Frameworks/SmartKeys/smartkeys/SmartKeysView.m).
Smart Keys bar only appears with the soft keyboard — hidden for external keyboards
[docs.blink.sh](https://docs.blink.sh/).

### IME/text-input ground truth

- Suppress suggestions with `inputType = TYPE_NULL`; Samsung quirks need the
  VISIBLE_PASSWORD|NO_SUGGESTIONS fallback (`enforce-char-based-input`)
  [TerminalView.java](https://raw.githubusercontent.com/termux/termux-app/master/terminal-view/src/main/java/com/termux/view/TerminalView.java).
  xterm.js maintainers confirm the password-field hack works for Android IMEs but shows a
  password-manager button [xterm.js #5377](https://github.com/xtermjs/xterm.js/issues/5377).
  mobile-tty already relies on wterm's hidden textarea attrs — the xterm #5377 thread
  validates that direction and warns the key handling code is "the ugly duck."
- IME `\n` must become `\r` for terminals [TerminalView.java](https://raw.githubusercontent.com/termux/termux-app/master/terminal-view/src/main/java/com/termux/view/TerminalView.java).
- `enterkeyhint="send"` improves Enter on Android [xterm.js #1101](https://github.com/xtermjs/xterm.js/issues/1101).
- iOS hardware-keyboard arrows only fire keydown when focus is on `document.body`, not
  the hidden textarea (refocus hack) [xterm.js #1101](https://github.com/xtermjs/xterm.js/issues/1101).
- iOS hardware keyboard produces Enter (`keyCode 13`) for Ctrl+C, breaking SIGINT —
  fixed after xterm 6.0 [xterm.js #5721](https://github.com/xtermjs/xterm.js/issues/5721).

### Gestures beyond the key bar

- **a-Shell** (iOS, hterm-based — the closest architectural cousin): configurable
  swipe-to-key (`swipeLeft = {2: '\x1b'}` two-finger ESC, `swipeRight = {2: '\t'}` Tab);
  one-finger horizontal drag emits arrow escapes per character crossed (suppressed when
  `less`/`man` detected); one-finger vertical drag scrolls line-by-line in scrollback or
  moves the cursor when an alternate screen is active; **JS inertial scrolling** with a
  velocity tracker (decay 0.1/s, max 2000 lines/s) [gestures.js](https://raw.githubusercontent.com/holzschu/a-shell/master/gestures.js).
  mobile-tty's native DOM scroll already beats the JS momentum; the swipe→key mapping is
  the borrowable piece.
- **Termius**: user-customizable, reorderable key groups; shake-to-emulate-keys
  (gimmick) [docs.termius.com](https://docs.termius.com/terminal/mobile-terminal).
- **WeTTY** ships optional Ctrl/Esc/Tab/arrow buttons on mobile — independent validation
  of mobile-tty's key bar [term.ts](https://raw.githubusercontent.com/butlerx/wetty/main/src/client/wetty/term.ts).

---

## 3. Scrollback: search, selection, URLs

- **Search**: xterm search addon caps at 1,000 highlighted matches, re-scans with a
  200 ms delayed update on writes/resize, scrolls the active match to mid-viewport;
  locating 72,960 matches ≈ 46–100 ms but the full decoration path took ~6.3 s — chunked
  "visible rows first" is the recommended pattern
  [SearchAddon.ts](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-search/src/SearchAddon.ts),
  [issue #5176](https://github.com/xtermjs/xterm.js/issues/5176). VS Code's UX: Ctrl+F,
  highlight all matches [code.visualstudio.com](https://code.visualstudio.com/docs/terminal/basics#_find).
  **For mobile-tty: first check whether iOS native find-in-page already works over
  wterm's real DOM text nodes — that would be zero code.**
- **Selection**: Termux aborts selection when scrolling past the transcript edge
  [TerminalView.java](https://raw.githubusercontent.com/termux/termux-app/master/terminal-view/src/main/java/com/termux/view/TerminalView.java);
  wterm's DOM gives native handles for free (already the design).
- **URLs**: xterm web-links validates regex matches with the `URL` constructor and opens
  with `window.opener` cleared; desktop activation is Ctrl/Cmd-click gated to prevent
  accidents [WebLinksAddon.ts](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-web-links/src/WebLinksAddon.ts).
  On touch there is no modifier, so **Termux gates tap-to-open behind opt-in, default
  off** (`terminal-onclick-url-open`) [TermuxPropertyConstants.java](https://raw.githubusercontent.com/termux/termux-app/master/termux-shared/src/main/java/com/termux/shared/termux/settings/properties/TermuxPropertyConstants.java).
  If added: opt-in, and long-press (selection) stays the primary gesture.
- **Clipboard**: `navigator.clipboard.writeText` requires transient user activation on
  Safari; reads show a paste UI; `execCommand` is deprecated but is what ttyd's stock
  client uses for auto-copy-on-select
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API),
  [ttyd xterm/index.ts](https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/xterm/index.ts).
  xterm's OSC 52 addon (clipboard read/write) has no execCommand fallback
  [ClipboardAddon.ts](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-clipboard/src/ClipboardAddon.ts).
  Native selection handles on iOS are the primary path; OSC 52 is a maybe.

---

## 4. Rendering and resize

- **DOM renderer direction validated**: xterm.js removed the Canvas addon in 2024 —
  Safari/WebKit got WebGL2 and DOM perf work landed; the current DOM renderer only
  considers the visible viewport, so scrollback depth doesn't affect render cost
  [xterm.js #4779](https://github.com/xtermjs/xterm.js/issues/4779). Historical claims
  that DOM is "much slower" on Safari/iPad refer to the old renderer
  [xterm.js #3271](https://github.com/xtermjs/xterm.js/issues/3271).
- **Fit**: xterm's FitAddon computes cols/rows from the parent and resizes locally; the
  PTY only learns via `onResize` forwarding — ttyd does `ioctl(TIOCSWINSZ)` on the same
  message [FitAddon.ts](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-fit/src/FitAddon.ts),
  [ttyd pty.c](https://raw.githubusercontent.com/tsl0922/ttyd/main/src/pty.c). mobile-tty
  does this. Deliberate divergence: ttyd stock client fits on every window resize;
  mobile-tty fits only on rotation (keyboard never reflows) — the numbers in
  docs/numbers.md back the divergence.
- **In-band resize (mode 2048)**: solves SIGWINCH loss through SSH/multiplexers, but
  support is thin (foot, Ghostty, kitty; not xterm/WezTerm/Windows Terminal)
  [vtdn](https://vtdn.dev/docs/decset/mode2048-in-band-resize/). Irrelevant here — the
  client drives resize directly.
- **Synchronized output (CSI 2026)**: pi-tui emits it ("atomic screen updates, no
  flicker") [pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md).
  Unknown modes degrade cleanly, but mobile terminal support is explicitly unaudited
  [rulesell.com](https://www.rulesell.com/topic/csi-2026-synchronized-output) (aggregator
  source — verify). **Cheap check: does wterm honor 2026?** If not, pi repaints may
  flicker on the phone.

---

## 5. Small screens: what TUIs do (and what pi already does)

- Dominant TUI pattern is a **hard minimum-size gate**, not reflow: btop gates at
  width ≤ 80 / height ≤ 24 [btop #926](https://github.com/aristocratos/btop/issues/926);
  the "minimum size gate" is codified in TUI design skills
  [tui-design skill](https://claudeskills.info/skills/pedronauck/skills/tui-design/).
- lazygit auto-switches to a vertical/stacked layout when small — users like it enough to
  want it forced [lazygit #3036](https://github.com/jesseduffield/lazygit/discussions/3036).
- **pi-tui is already width-responsive**: `visible: (termWidth) => termWidth >= 100`
  callbacks evaluated per frame, overlays default to centered/max-80-cols with margins
  clamped, `TruncatedText` for status lines
  [pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md).
  Nothing client-side needed; the 50-col reality is pi's problem and it handles it.
- **Mouse reporting vs scrollback is THE structural conflict**: "mouse tracking… is
  necessary for apps in alternate screen mode, but hurts usability in regular screen mode
  because it blocks viewport scrollback" [termux-app #4302](https://github.com/termux/termux-app/issues/4302).
  pi-tui encodes the split: mouse is alt-screen-only; the main screen leaves scrollback to
  the terminal [pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md).
  So mobile-tty's native scroll is safe with pi — and any future alt-screen work
  (Claude Code) must revisit this.
- Termux translates one-finger drag to **wheel events, not drag** (precision argument),
  blocking real mouse-drag use [termux-app #1384](https://github.com/termux/termux-app/issues/1384).
- **Tap-to-position cursor**: kitty/iTerm2/Konsole/DomTerm synthesize arrow keys to move
  the cursor to the tapped cell — requires OSC 133 prompt markers so the terminal knows
  where the prompt starts; Ghostty documents the same, with "some weird behavior"
  caveats; mode 2001 (xterm) only works same-line
  [termux-app #4302](https://github.com/termux/termux-app/issues/4302). pi-tui emits OSC
  133 markers ("jump between OSC 133 semantic prompt markers")
  [pi-tui README](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md).
  Future work: parse OSC 133 in the client, tap → synthetic arrows.
- Contour's **passive mouse tracking (`CSI ?2029 h`)** is the proposed fix for
  primary-screen mouse without eating scrollback/selection — adopted by Contour only
  [passive-mouse-tracking.md](https://github.com/contour-terminal/vt-extensions/blob/master/passive-mouse-tracking.md).
  Not useful to mobile-tty (no mouse on iOS), but the right answer if a trackpad-paired
  iPad is ever a target.
- TUI touch experience on phones: "the experience broke down was always the keyboard
  layer, not the TUI layer: glass keyboards do not give you ESC, CTRL, ALT, or arrow keys
  for free" [cosyra.com](https://cosyra.com/guides/tui-apps-on-phone.html) (vendor
  marketing, treat claims as unverified — but this matches mobile-tty's own thesis).

---

## 6. Transport-level cheap wins (ttyd)

- **Flow control exists in the protocol mobile-tty already speaks**: client→server
  `PAUSE` ('2') / `RESUME` ('3'); ttyd's stock client sends high/low-watermark
  pause/resume to stop server PTY reads when the terminal's write buffer accumulates
  [ttyd xterm/index.ts](https://raw.githubusercontent.com/tsl0922/ttyd/main/html/src/components/terminal/xterm/index.ts),
  [ttyd protocol.c](https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c).
  mobile-tty's transport ignores it. On a slow phone with a chatty agent this is the
  difference between lag and wedging.
- **Keepalive**: `--ping-interval` (default 5 s; connection treated as hung 7 s later)
  [ttyd man page](https://github.com/tsl0922/ttyd/blob/main/man/ttyd.man.md). Verify it's
  on; it feeds the "am I connected" telltale.
- **Auth**: `--credential` (Basic) and `--auth-header` (reverse-proxy header → `TTYD_USER`)
  [ttyd protocol.c](https://raw.githubusercontent.com/tsl0922/ttyd/main/src/protocol.c).
  `--auth-header` is the documented Cloudflare Access pattern; mobile-tty's decisions doc
  already names it. Note the stock client re-fetches `/token` before every reconnect —
  mobile-tty's reconnect doesn't (fine while auth-less).
- ttyd kills its child on socket close — why dtach exists; stock client has no replay
  either (it calls `terminal.reset()` on reconnect, wiping the screen; mobile-tty's
  keep-the-terminal design is strictly better).
- Server-side session-resume alternatives (code-server's 3 h reconnect grace + heartbeat
  file) require app code mobile-tty doesn't have — n/a.

---

## 7. Diagnostics

- a-Shell paints a live `gestureStatus` overlay and bridges JS→native logging
  [gestures.js](https://raw.githubusercontent.com/holzschu/a-shell/master/gestures.js) —
  same pattern as mobile-tty's ≡ panel.
- Termux has a compile-time key-logging flag that logs every IME event (`commitText`,
  `deleteSurroundingText`, `finishComposingText`) [TerminalView.java](https://raw.githubusercontent.com/termux/termux-app/master/terminal-view/src/main/java/com/termux/view/TerminalView.java).
  A rolling key-event log in the ≡ panel is the cheap version — the exact thing you need
  when "the keyboard ate my input" on device.
- a-Shell's session-restore bug (large transcript prevented saving the running command;
  fix: save command first, clamp text size) [a-shell #68](https://github.com/holzschu/a-shell/issues/68)
  — relevant only if mobile-tty ever persists state across reloads.

---

## Contradictions / caveats

- **xterm.js DOM performance**: old renderer "much slower on Safari/iPad" (#3271) vs
  current renderer fine after optimization (#4779). Different generations — supports the
  DOM-renderer bet either way.
- **Mosh scrollback over tmux**: ghostty discussion says broken
  [ghostty #4617](https://github.com/ghostty-org/ghostty/discussions/4617) vs
  getmoshi.app claims `set -g mouse on` works
  [getmoshi.app](https://getmoshi.app/articles/fix-mosh-scrollback). Irrelevant to
  mobile-tty (no mosh); noted for completeness.
- **"Termius web"** does not exist — search results are an unrelated project ("Terminus
  Web"); official Termius clients are native only.
- **dtach-plus doesn't exist**; the real scrollback fork is `bmills23/dtach-rev`.
- **Search addon "incremental"** means selection-preserving, not incremental caching —
  terminology clash between typings and perf issue.
- **CSI 2026 support table** (incl. the 150–300 ms timeout figure) is from an aggregator
  page; verify against Parpart's gist before relying
  [gist](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036).
- **Blink Mosh extensions / reboot survival** — App Store claims without mechanism docs;
  low confidence.
- **Cosyra phone-TUI claims** — vendor marketing, no methodology.

## Confidence notes

- **High** (primary sources: raw GitHub files, docs.rs, man pages, official docs):
  Termux extra-keys semantics; Blink SmartKeysView modifier logic; a-Shell gestures;
  dtach `-r` history; ttyd protocol/auth/flow-control; xterm addon behavior; mouse-mode
  wire format; pi-tui capabilities (target app's own README); tmux control mode.
- **Medium**: dtach-rev (new fork, single maintainer, replay-in-TUI caveat untested);
  Mosh UX claims (well documented but multi-year-old measurements); Blink features via
  marketing pages.
- **Low / flagged**: Termius internals (closed source); CSI 2026 support table; Cosyra.

## Gaps not covered

- No direct measurement of wterm's CSI 2026 handling or native find-in-page over wterm
  DOM (both cheap on-device checks).
- No data on how pi itself reflows at 50×33 beyond numbers.md.
- Dictation-through-wterm remains untested (open question in README, still open).

## Agent status

- mobile-ssh-clients (kimi-k3): completed, 4 deep dives + 3 shallow
- session-persistence (deepseek-v4-flash): completed, 15 sources
- tui-touch (opus-5): completed, ~40 sources
- web-terminals (gpt-5.6-sol): completed (replaced an earlier qwen agent that was
  cancelled per user request and produced nothing)
