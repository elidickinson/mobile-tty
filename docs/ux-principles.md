# UX principles

Stated priority: **good UX above all**. This document works out what that forces.

The conclusion is that UX requirements, not implementation convenience, should pick the
architecture — and they pick a different one than "start with ttyd" did.

---

## 1. Start from the viewport budget

A phone is not a small desktop terminal. The binding constraint is screen area, and it is
consumed before the terminal gets any.

**Measured on device** (iPhone, iOS Safari, screen 402×874 @3x, 2026-08-10) via
`probe/index.html` — these replace the earlier estimates:

| Quantity | Measured |
|---|---|
| Screen | 402×874 pt |
| `innerHeight` (Safari, chrome visible) | 714 pt → **Safari chrome costs 160 pt** |
| `visualViewport.height`, keyboard up | 404 pt → **keyboard costs 310 pt** |
| Cell at 13px monospace | 8.04 × 15.00 pt |

| Configuration | Cols × rows | Note |
|---|---|---|
| Safari, keyboard **down** | 50 × **47** | measured |
| Safari, keyboard **up** | 50 × **26** | measured — the working case |
| Standalone, keyboard up | 50 × ~33–36 | projected: reclaims most of the 160pt, minus safe-area insets. Unconfirmed. |
| Standalone + compact keyboard (~150pt) | 50 × ~44 | projected |
| At 11px instead of 13px, keyboard up | 59 × 31 | measured |

So the keyboard costs **21 of 47 rows**, and Safari's chrome another ~10. Recovering both
would take the working case from 26 rows to the low 40s — still the biggest single UX
lever, and confirming the standalone number is the cheapest next measurement.

`visualViewport.offsetTop` stayed 0 throughout, and safe-area insets reported 0/0 in
non-standalone Safari.

**Implementation note, learned the hard way in the probe:** sizing the app with
`height:100%` puts the bottom of the UI *underneath* the keyboard, because that is the
*layout* viewport (714) not the visual one (404). Size from `visualViewport.height` and
translate by `offsetTop`, updating on its `resize` and `scroll` events.

Width is untouched by any of this: ~50 cols is narrow for a dense TUI and no viewport
trick fixes it. Only decoupling grid size from render size does (§3).

## 2. Input goes straight to pi; a hidden element captures it

**Superseded — an earlier version of this section made a client-side composer the primary
input. That was wrong**, for the reason in §2.1 below.

Input is streamed to pi as you type, and **pi's own input box stays visible**. The client
contributes a *hidden* `<input>`/`<textarea>` that exists only to capture text properly on
mobile — it is never displayed, and its contents are forwarded as keystrokes.

- **Hidden capture element.** Buys dictation and lets autocorrect be switched off
  explicitly. Costs zero rows, because pi's box provides the visuals.
- **Key bar (permanent).** Modifiers, arrows, Tab/Esc, PageUp/Dn/Home/End. This is the
  answer to "permanent on-screen keyboard" — always visible, cheap in pixels. The full
  keyboard, OS or custom, is summoned rather than resident.
- **Long-prompt composer (optional, explicit).** A real textarea for dictating or editing
  a paragraph, invoked deliberately and dismissed. Not a mode you can be in by accident.

### 2.1 Why the composer cannot be the default

pi's autocomplete — `/commands`, `@file` references — fires **as you type**, and its menu
renders directly above pi's input box. A client-side composer breaks both: pi never
receives the keystrokes, so no menu appears; and the menu's screen region is exactly what
a composer-first layout wants to pan away from.

The row pressure and the need to see pi's box also arrive at the same moment, so trading
one for the other does not work:

- **Keyboard up → you are typing → you need pi's box and its menus.** Accept the ~9
  content rows; pan up with the scroll widget for context and snap back.
- **Keyboard down → you are reading.** Full rows, free panning, input box irrelevant.

Measured at 50×15 (the keyboard-up case): pi's fixed bottom block costs **5–6 of 15 rows**
— 3 for the input box, 1 cwd, 1 status, plus a blank spacer — leaving 9 for content.
Reclaiming those rows would be worth ~67% more visible output, which is why this looked
attractive; the autocomplete breakage is why it isn't.

**Consequence:** anchor the viewport to pi's input box by default. Panning is how you cope
with 9 rows, not something that lets you avoid them — which puts more weight on the scroll
widget (§5) and less on input handling.

### Autocorrect is a liability here, not a benefit

Agent prompts are jargon- and abbreviation-dense — identifiers, flags, paths, branch
names. iOS autocorrect mangles exactly those. The asymmetry is what settles it: a typo in
prose is something the model infers straight through, whereas a *corrected* identifier
silently points the agent at the wrong file. Wrong-but-plausible beats misspelled.

So turn it off, explicitly, on the hidden capture element (iOS does not inherit these from
parents):

```html
<textarea autocorrect="off" autocapitalize="off" spellcheck="false" autocomplete="off">
```

This is the main reason the hidden element exists at all: raw key capture on a canvas
gives you no control over autocorrect, and no dictation.

**Dictation** is the other reason, and it is scoped: good for prose intent ("figure out
why the token refresh is failing"), useless for `kubectl get pods -n kube-system`. It
cannot work against a terminal capturing raw keys, so it needs a real text element
regardless of whether that element is visible.

**Editability and review-before-send** — touch cursor placement, selection handles,
cut/paste, nothing reaching pi until you commit — are real, but they now belong to the
*optional* long-prompt composer, not to the default path. Editing in pi's own box with the
key bar's arrows is the everyday case.

**No custom dictionary or completion engine.** Harvesting identifiers from scrollback and
ranking them is a speculative feature with real complexity; autocorrect-off plus ordinary
typing is the simple answer, and jargon typed literally is jargon typed correctly.

**Tap-to-insert** stays, because it is not a dictionary — tap a word in the output and it
is typed into pi's input box. Against DOM-rendered output that is a click handler plus
word-boundary expansion; against a canvas it would mean glyph hit-testing, which is
another point for wterm in §6. If it turns out fiddly, cut it; nothing depends on it.

## 3. Reflow and zoom are different operations; expose both

The single highest-value differentiator, and near-unsolved outside sshx.

- **Reflow** — change cols/rows, SIGWINCH, TUI relayouts to fit. Correct when the TUI
  adapts gracefully. Destroys dense layouts at ~50 cols.
- **Zoom/pan** — **pin the grid at e.g. 120×40, render it scaled down, pinch and pan a
  viewport across it.** The TUI believes it is on a desktop. You move a window over it.

These must be separate, explicit controls, not one conflated "font size" slider. For a
dense TUI on a phone, zoom/pan is likely the one that makes it genuinely usable, and it is
the feature no self-hostable tool currently offers.

## 4. Reconnect must be invisible

Phones lock, switch networks, and evict background tabs constantly. Coming back to a blank
or dead terminal is the failure that makes people abandon a tool — it outranks every
feature in this document.

Requirements: auto-reconnect with backoff, a **resize nudge (N−1 → N) to force a full
repaint** — measured to work, since pi repaints on SIGWINCH — input queued while
disconnected, and a visible but non-intrusive connection state. A server-side ring buffer
is the heavier alternative and is not needed here. tmux also gets a redraw for free via
redraw-on-attach, which is why every mobile project in the survey leans on tmux.

## 5. Smaller things that are already solved — just implement them

- Sticky/toggle modifiers (tap Ctrl, then c), plus held-modifier for real chords.
- Repeat-on-hold for arrows.
- Scrolling: **measured — pi does not use the alternate screen** (see `concerns.md`), so
  plain client-side scrollback plus PageUp/Dn buttons is the whole answer. No copy-mode,
  no mouse-event synthesis. Add alt-screen detection only if arbitrary TUIs are wanted.
- `visualViewport` listeners for keyboard-aware layout — mandatory whenever the OS
  keyboard can appear.
- Lock the layout: no rubber-band, no double-tap zoom, no accidental pinch on the page.
- Latency/connection indicator.

## 6. No sidecar is needed — a smart client covers it

The two requirements that looked server-side are both reachable from client JS, which
collapses the sidecar option entirely.

**Standalone viewport** — iOS meta tags, single file. No manifest, no service worker. (§1)

**Reconnect with an intact screen** — two tiers, both client-side, both requiring only
that tmux is in the loop:

- *Tier 1, trivial.* Never dispose the terminal object across a WS reconnect, so the
  stale screen stays visible instead of going blank. On reconnect, send a keystroke bound
  in `.tmux.conf` to `refresh-client -S` to force a full repaint. Auto-reconnect with
  backoff, queue input while down. This is a handful of lines and solves the dominant
  mobile failure mode.
- *Tier 2, richer.* Run **tmux control mode** (`tmux -CC`). It turns the single PTY stream
  into a structured text protocol: commands in on stdin, `%begin`/`%end`/`%error` blocks
  back, plus async `%output <pane-id> <data>` and session/window notifications. The client
  can then issue `capture-pane -p -e -J -S -` on reconnect and repaint from real
  scrollback, and drive a genuine session/window/pane UI — all in-band, no server code.
  This is what iTerm2's tmux integration does.

Tier 2's cost is real client complexity: you demux `%output` into per-pane terminals and
effectively write an iTerm2-class tmux client. Start at tier 1; escalate only if the
session/pane UI is actually wanted.

**What genuinely stays out of reach** without a real static server: service workers, hence
no offline shell and **no web push**. Offline is meaningless for a terminal. Push is a
real loss — "pi.dev needs approval" is exactly the notification worth having — but that
belongs on an out-of-band channel anyway (pi-phone already uses Pushover).

One practical wrinkle: `--index` files are served raw, without ttyd's gzip path. A
single file with xterm.js inlined is ~300–400KB uncompressed on first cellular load. This
is a further point in **wterm**'s favour — a ~12KB WASM parser plus a DOM renderer makes a
dramatically smaller self-contained bundle than xterm.js.

---

## What this changes

The architecture is:

```
ttyd -W --index client.html tmux new -A -s pi
```

...where `client.html` is one self-contained file doing all the work: ttyd's five-constant
WS protocol, iOS standalone meta tags, key bar, composer/direct input modes, pan/zoom over
a pinned grid, alt-screen-aware scrolling, and reconnect-with-repaint. No sidecar, no
fork, no server code. Escalate to `tmux -CC` or an own server only if pushed there.

Renderer: this strengthens the case for **wterm**'s DOM rendering over canvas — native
momentum scrolling, selection handles, find, and accessibility are mobile UX problems that
DOM gets for free and canvas forces you to reimplement badly, and its bundle is far
smaller. §2's tap-to-insert adds to this: tapping a path or identifier in the output is
natural against real text nodes and a glyph-hit-testing project against a canvas. The risk
is maturity; **ghostty-web** is the API-compatible fallback and xterm.js the conservative
one.
</content>
