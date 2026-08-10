# Design notes

Patterns harvested from the survey, the problems nobody has solved well, and build options.

## Solved patterns worth copying outright

1. **Sticky/toggle modifiers in an accessory row.** Universal across Blink, Termius,
   Termux, mux-pod, mobux, remobi. Tap `Ctrl`, then tap `c`. Blink additionally allows
   *held* Ctrl/Alt for continuous chording. There is no reason to invent here.
2. **Repeat-on-hold for arrow keys** (claude-web-terminal). Non-obvious, badly missed
   when absent.
3. **Two input modes.** A composer/"input bubble" that buys native autocorrect,
   predictive text and dictation — versus direct keystroke streaming for interactive TUI.
   claude-web-terminal ships both (and makes the terminal read-only on mobile so tapping
   never raises the OS keyboard); mux-pod calls the latter "DirectInput". This
   sidesteps xterm.js [#2403](https://github.com/xtermjs/xterm.js/issues/2403), where
   predictive text silently corrupts input.
4. **Touch scroll needs an explicit strategy.** Three incompatible options, and remobi
   makes it configurable for good reason:
   - synthesize SGR mouse wheel events (needs tmux `mouse on`; scrolls the *app*)
   - send PageUp/PageDown (works with app pagers, wrong for alt-screen apps)
   - scroll the client's own scrollback buffer (right for normal screen, meaningless in
     alt-screen)
   Alt-screen state must drive the choice — a full-screen TUI has no client scrollback.
5. **Scroll-to-copy-mode** (webtmux): dragging auto-enters tmux copy mode, giving real
   scrollback in an alt-screen app. Best available answer to "scroll up in pi.dev".
6. **`visualViewport` for keyboard-aware layout.** iOS hides keyboard geometry from CSS
   and offsets the layout viewport; `position: fixed` bars end up under the keyboard. The
   fix is listening to `visualViewport.resize`/`scroll` and positioning via `top` +
   `translateY(-100%)`. Non-negotiable if the OS keyboard is used at all.
7. **tmux underneath.** Not a nicety — it is the reconnect story (see `ttyd-notes.md`).

## Unsolved / weakly solved — the actual opportunity

**1. Decoupling PTY grid size from rendered size.**
Everyone conflates "resize" with "change font size", which changes cols/rows, which sends
SIGWINCH and reflows the TUI. Two genuinely different operations:

- *Reflow*: change cols/rows, TUI relayouts. What fit-addon does.
- *Zoom*: **pin the grid at e.g. 120×40, render it small, pinch/pan the viewport over it.**
  The TUI thinks it's on a desktop; you move a window around it.

Only **sshx** does the second (infinite canvas), and it's not self-hostable. For a
dense TUI on a phone this is likely the single highest-value feature — a 40×20 reflow
destroys pi.dev's layout, whereas panning a 120×40 grid preserves it. Should support
both, explicitly, as separate controls.

**2. A permanent on-screen keyboard.**
The OS keyboard costs ~50% of the viewport, can't do chords, and injects predictive text.
**swell.sh** is the only project that replaced it wholesale (custom swipe-typing keyboard,
gesture Tab-complete, gesture Ctrl-W) — and it's stale, bash-only, Linux-only, with no
F-keys or PageUp/Dn. A modern take on this is wide open. Semi-permanent variant: a compact
always-visible key strip plus an on-demand full keyboard.

**3. Reconnect with replay for non-tmux sessions.**
Server-side ring buffer of recent output + replay on reconnect. tmux gets this for free
via redraw-on-attach; nothing in Architecture A does it. Mosh solved it properly in 2012
and no web terminal has copied it.

**4. iOS Safari specifics.** Hardware-keyboard Ctrl-C reporting keyCode 13
([#5721](https://github.com/xtermjs/xterm.js/issues/5721)), no service worker without a
real static server, rubber-band scroll fighting the terminal.

## Build options

| | Approach | Gets you | Costs |
|---|---|---|---|
| **1** | `ttyd --index custom.html` + tmux, smart client | Key bar, gestures, grid/zoom controls, iOS standalone, reconnect-with-repaint, and (via `tmux -CC`) session/pane UI | Single self-contained HTML file; no service worker, so no offline and no web push |
| **2** | ~~ttyd + sidecar static server proxying `/ws`~~ | — | **Ruled out.** Everything it was wanted for is reachable from client JS — see `ux-principles.md` §6. Pure added process for no gain. |
| **3** | Own server (node-pty / Go) + custom client | Full control: server-side replay buffer, multi-session, web push, gzip/asset pipeline | Own the PTY layer and the ops. Only justified if push or non-tmux replay become requirements |
| **4** | `cli2ssh`/`wish` + Blink/Termius | Reconnect, roaming, mature key bar — all free | Zero UI control; no flexible screen sizing |

**Assessment.** Option 1 is the answer, not just the spike. The sidecar (2) was a false
middle: iOS standalone needs only meta tags, and reconnect-repaint plus session
management are both reachable in-band — the latter via tmux control mode, which is a
structured protocol the client can parse over the same PTY stream. Go to 3 only if web
push or replay for non-tmux sessions turn out to be requirements.

Renderer: **wterm** is the interesting bet — DOM rendering means native momentum scroll,
selection handles, find, and a11y (precisely the mobile problems canvas forces you to
reimplement), and its ~12KB WASM parser makes a far smaller single-file bundle than
xterm.js, which matters because `--index` is served uncompressed. **ghostty-web** is the
API-compatible fallback; xterm.js the conservative one.

## Open questions

- Does pi.dev's TUI tolerate an unusual fixed grid (e.g. 120×40) rendered scaled-down, or
  does it query terminal size and adapt in ways that break the pan model?
- Does pi.dev use the alternate screen buffer? Determines whether client-side scrollback
  exists at all, and therefore the entire scroll strategy.
- Is tmux acceptable in the stack, or does pi.dev need to own the terminal?
- PWA install: required, or is iOS add-to-home-screen (which works from a single HTML
  file) sufficient? This single answer decides option 1 vs 2/3.
</content>
