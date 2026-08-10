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

---

## Concern 1 — the keyboard hides most of the screen

Budget on a ~393×852pt phone: browser chrome ~120pt, OS keyboard ~320pt. Over half the
screen, gone. Ranked by payoff per unit of work:

| Fix | Effect | Cost / cons |
|---|---|---|
| **Don't summon the keyboard by default.** Terminal never takes focus on tap; keyboard appears only on a deliberate action. | Removes ~320pt for the majority of the session — you are mostly *reading* agent output, not typing. Biggest single win. | Needs an obvious summon affordance or it feels broken. claude-web-terminal does exactly this. |
| **Standalone display mode** — `<meta name="apple-mobile-web-app-capable" content="yes">` | Recovers ~120pt ≈ 8 rows. | One line. No downside. |
| ★ **Never resize the PTY when the keyboard opens.** Keep cols/rows pinned; let the keyboard *occlude* the bottom of the terminal and scroll the view instead. | This is the fix people actually feel. Default web-terminal behaviour refits on keyboard open, so pi reflows to ~15 rows, then reflows *back* on close — a full repaint and layout change every time you type. | Bottom rows are hidden while typing, so pair with auto-scroll to keep the active region above the keyboard (`visualViewport`). |
| **Key bar instead of keyboard** for non-text actions (approve, cancel, navigate, Ctrl-C) | ~50pt instead of ~320pt for the most common interactions. | Doesn't help when actually typing prose. |
| **Dictation** | No keyboard at all for prose input. | Free with a real `<textarea>`. Useless for jargon. |
| **Custom on-screen keyboard** | ~150pt instead of ~320pt. | Big build, reimplements text entry. Deferred. |

**Net:** default state is a full-screen terminal with no keyboard and a thin key bar. The
keyboard is summoned to type, and when it appears it occludes rather than reflows.

## Concern 2 — scrolling back, page up/down

**This turned out to be much easier than assumed, and my earlier answer was wrong.** I had
assumed a full-screen alt-screen TUI, where client scrollback is empty and you need tmux
copy-mode to scroll at all. pi doesn't use the alternate screen, so:

| Fix | Effect | Cost / cons |
|---|---|---|
| ★ **Client-side scrollback + touch drag** | Just works. The terminal widget's own scrollback holds the real conversation history. With a DOM renderer this is literally native browser scrolling, with momentum and selection handles for free. | None. This is the whole feature. |
| ★ **PageUp / PageDown / Home / End on the key bar** | Scrolls the *viewport*, not sent to pi. Directly answers "send page up/down easily". | Trivial. |
| **Jump-to-bottom button + follow-output toggle** | Once you scroll up you need a way back, and new output shouldn't yank you down mid-read. | Small, and genuinely needed. |
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
