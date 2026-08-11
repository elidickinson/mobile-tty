# The three concerns, and what actually addresses each

Organised by problem rather than by architecture layer. Measurements below were taken
2026-08-10 against **pi 0.84.1** and Claude Code, running under tmux at various sizes.

## Measured facts that decide the design

| Question | Answer | How |
|---|---|---|
| Does pi use the alternate screen buffer? | **No.** `alternate_on=0` at startup, at idle, and after resize. Same for Claude Code. | `tmux display-message -p '#{alternate_on}'` |
| Does pi accumulate real scrollback? | **Yes.** `capture-pane -S -15` returns clean conversation history, not redraw frames. | `#{history_size}` grew 8 → 41 when shrunk |
| Does pi enable mouse reporting? | **No.** `mouse_any/sgr/button/standard` all 0. | tmux format flags |
| Does pi reflow on SIGWINCH? | **Yes**, and fully repaints. Renders correctly at 50×30, 120×40, 160×50. | `tmux resize-window` |

**The big one is the first.** pi renders to the *normal* buffer, like Claude Code — output
scrolls off naturally and the TUI is really a repainted block at the bottom. Everything
below follows from that.

### Device measurements (iPhone, iOS Safari, 402×874 @3x, via `probe/`)

| Quantity | Measured |
|---|---|
| Safari chrome | **160 pt** (`innerHeight` 714 of 874) |
| Keyboard | **310 pt** (`visualViewport.height` drops 714 → 404) |
| Grid @13px, keyboard down | **50 × 47** (cell 8.04 × 15.00) |
| Grid @13px, keyboard up | **50 × 26** |
| Grid @11px, keyboard up | 59 × 31 |
| `visualViewport.offsetTop` | 0 throughout |

The keyboard costs **21 of 47 rows**. `visualViewport` tracks it correctly on iOS, so the
API is usable — but sizing with `height:100%` puts the UI *under* the keyboard, because
that is the layout viewport (714), not the visual one (404).

Two bugs the probe caught on first contact, both relevant to the real client:

- **Mojibake on box-drawing characters** — no `<meta charset="utf-8">` and no charset in
  the server's `Content-Type`, so iOS Safari fell back to Latin-1 where desktop guessed
  right. pi's UI is box-drawing; declare the charset explicitly.
- **UI under the keyboard** — as above. Drive layout from `visualViewport`.

---

## Concern 1 — the keyboard hides most of the screen

Budget on a ~393×852pt phone: browser chrome ~120pt, OS keyboard ~320pt. Over half the
screen, gone. Ranked by payoff per unit of work:

**Correct diagnosis (from the user, 2026-08-10):** reflow itself is fine — pi redraws
correctly at the smaller size. The problems are that (a) the ~15 surviving rows are spent
on pi's *own* composer and status bar rather than on output, and (b) **you cannot scroll
that window** to look at anything else. So it is a *viewport control* problem, not a
resize-thrash problem.

| Fix | Effect | Cost / cons |
|---|---|---|
| ★ **Scrolling must keep working with the keyboard up.** Terminal is the scroll container (not the page), no auto-snap-to-bottom while scrolled up, plus explicit page/line buttons that work regardless of gesture conflicts. | This is the actual missing capability. Everything else is secondary. | Touch scroll in xterm.js is genuinely weak ([#1007](https://github.com/xtermjs/xterm.js/issues/1007)) — more reason for a DOM renderer, where it is native. Buttons are the gesture-proof fallback. |
| ★ **Anchor the viewport to pi's input box.** Do *not* take input over client-side. | Always correct, no modes. **Measured at 50×15: pi's bottom block costs 5–6 of 15 rows** (input box 3, cwd 1, status 1, spacer), leaving 9 for content. | Only 9 content rows while typing — panning is how you cope, not how you avoid it. |
| ~~Own the composer client-side~~ | Would reclaim those 5–6 rows, ~67% more visible output. | **Rejected.** pi's `/command` and `@file` autocomplete fires *as you type* and renders above its input box — a client composer means pi never sees the keystrokes, so no menu, and the menu's region is exactly what you'd pan away from. Row pressure and needing the box occur in the same moment. |
| ★ **Hidden capture element** — invisible `<textarea>` forwarding keystrokes live | Dictation and explicit autocorrect-off, at zero row cost, without breaking autocomplete. | Must forward deltas faithfully, including dictation landing as a block. |
| ★ **Occlude + pan rather than reflow.** Keep the grid pinned; pan the viewport over the unchanged screen — *the same mechanism as the pinned-grid pan/zoom in concern 3*. | One mechanism for both. The full screen still exists; you choose the slice, and can snap back to the input box. | Anchor must default to the input box, not to an arbitrary offset. |
| **Don't summon the keyboard by default.** Terminal doesn't take focus on tap. | Removes ~320pt for the majority of the session — you are mostly reading. | Needs an obvious summon affordance. |
| **Standalone display mode** meta tag | ~120pt ≈ 8 rows back. | One line, no downside. |
| **Key bar** for approve/cancel/navigate/Ctrl-C | ~50pt instead of ~320pt for the commonest actions. | Doesn't help when typing prose. |
| **Custom on-screen keyboard** | ~150pt instead of ~320pt. | Big build. Deferred. |

**Net:** the fix is viewport control, not resize policy — make the terminal scrollable at
all times, keep pi's input box anchored and visible, and reuse the pan/zoom viewport so
the keyboard just shrinks the window onto an unchanged screen.

## Concern 2 — scrolling back, page up/down

**This turned out to be much easier than assumed, and my earlier answer was wrong.** I had
assumed a full-screen alt-screen TUI, where client scrollback is empty and you need tmux
copy-mode to scroll at all. pi doesn't use the alternate screen, so:

**Drag is not enough, and probably shouldn't be primary.** Drag-scroll competes with text
selection, with iOS edge gestures, and — decisively — **with panning the pinned grid**,
which already claims the drag gesture. It is also poor one-handed: it needs travel across
the screen rather than a fixed thumb-reachable target. So a dedicated control is the main
mechanism, not a fallback.

| Fix | Effect | Cost / cons |
|---|---|---|
| ★ **Velocity nub / hold-and-pull widget.** Fixed thumb-reachable pad; displacement sets scroll *speed*, not distance. Pull slightly to creep a line at a time, further to fly through history; release to stop. | No travel, one-handed, works with the keyboard up, conflicts with nothing. Covers both "nudge one line" and "go back 500 lines" with one control. | Non-standard affordance to learn. Needs a sane response curve and a dead zone. |
| ★ **Make it 2D and it also does the panning.** Horizontal displacement pans across a wide pinned grid; vertical continues past the top edge into scrollback. | Unifies scroll and pan: the viewport is a window over a tall surface — scrollback above, live screen below. No modes, no gesture conflict. | Only worth it if the pinned-grid model lands. |
| ★ **Discrete buttons alongside** — PageUp/PageDown/Home/End, jump-to-bottom | Precise and repeatable where the nub is continuous; immune to gesture capture. Directly answers "send page up/down easily". | Trivial. |
| ★ **Position indicator** — thin rail showing where you are and how much history remains | Continuous scrolling in a terminal is disorienting without it. | Small. |
| ★ **Follow-output toggle** | New output must not yank you down mid-read; needs an obvious way back to live. | Small, genuinely needed. |
| **Touch drag** | Free with a DOM renderer, familiar. | Conflicts as above. Keep as a convenience where it doesn't clash, not as the design. |
| **Scrollbar thumb rail (hold and pull)** | Familiar, position feedback for free. | Thin hit target, awkward at the screen edge one-handed. Weaker than the nub. |
| ~~tmux copy-mode / scroll-to-copy-mode~~ | — | **Not needed.** Only required for true alt-screen apps (vim, htop). |
| ~~Synthesised SGR mouse wheel events~~ | — | **Not needed.** pi doesn't enable mouse reporting; nothing would consume them. |
| ~~`capture-pane` reader view~~ | — | **Not needed.** Cut. |

**Net:** three simple things, no tmux involvement, no copy-mode. If arbitrary TUIs
(vim/htop) are wanted later, add alt-screen detection and switch to copy-mode then.

## Concern 3 — flexible resizing

The core error everyone makes is exposing one "font size" control that conflates two
independent things. Expose both, separately:

| Control | What it does | Pros / cons |
|---|---|---|
| ★ **Grid size** (cols × rows) | Sends ttyd's resize command; pi gets SIGWINCH and reflows. Offer **presets**: Phone 50×30, Desktop 120×40, Wide 160×50 — verified all three render correctly. | Presets beat a fiddly continuous slider: decisive, repeatable, one tap. Reflow is destructive to dense layout at 50 cols, which is why the next row exists. |
| ★ **Render scale** (CSS `transform: scale`) | Pinch to zoom, drag to pan, over a **pinned** grid. pi only learns cols/rows from the PTY, so it believes it is on a desktop and never knows. | The genuine differentiator — only sshx does this and it isn't self-hostable. Cost: panning to read is its own friction. |
| **Orientation** | Landscape gives ~110 cols at readable size for free. | Must *not* trigger a reflow when the grid is pinned. |
| ★ **Never auto-resize** | No refit on keyboard open, browser chrome show/hide, or rotation. Grid changes only on explicit user action. | Half of "resizing is broken" is really "it keeps resizing when I don't want it to". |

**Bonus finding:** because pi fully repaints on SIGWINCH, a **resize nudge** (send N−1 cols,
then N) forces a complete redraw on demand. That is a free, app-agnostic
reconnect-repaint — no tmux keybind, no control mode, no server code.

---

## What this cuts

tmux is no longer needed for scrolling *or* for reconnect repaint (the resize nudge covers
it). It remains useful only for **session persistence** — surviving a ttyd restart or
letting you detach and reattach from the desktop. Keep it for that, but it is now a
convenience rather than load-bearing.
</content>
