# Testing strategy

## Why the obvious approach fails

The deliverable is one HTML file whose hardest behaviours are (a) **iOS Safari keyboard
and viewport geometry**, (b) **touch gesture arbitration**, and (c) **"is the useful part
of the screen visible"** — which is perceptual. None of those are reachable from CI. There
is no headless browser with a real on-screen keyboard, and no assertion for "feels right".

So the strategy is not "write tests for the app". It is: **push everything mechanisable
down into pure functions, make the platform unknowns cheap to probe on a real device, and
don't build a browser-automation cathedral for a single HTML file.**

## Structure the code so it can be tested at all

The single-file `--index` constraint is a testing problem: you cannot import a module out
of one inlined blob. So **develop as ES modules and bundle to a single file with esbuild**
for deployment. The build step exists for testability first, convenience second. (remobi
does exactly this — TypeScript + DOM API, no framework, esbuild on deploy.)

That keeps the interesting logic importable and browser-free.

---

## Layer 1 — pure functions (highest value per unit of effort)

Everything below is a pure function with no DOM. This is where the real algorithmic
content lives, and where bugs are silent rather than obvious.

| Unit | Why it earns a test |
|---|---|
| **ttyd frame codec** — `'0'+data`, `'1'+{cols,rows}`, `'{'`+auth; decode `'0'/'1'/'2'` | Byte-level mistakes fail silently and confusingly. |
| **Key encoding table** — button/keypress → bytes (`ArrowUp`→`\e[A`, `Ctrl-C`→`\x03`, `PageUp`→`\e[5~`, sticky-modifier composition) | A pure map, easy to get subtly wrong, silent when wrong. Table-driven, one concise test. |
| **UTF-8 reassembly across WS messages** | **The sharpest real bug here.** pi's UI is box-drawing characters; a multi-byte sequence split across two WebSocket messages corrupts the display if each message is decoded independently. Feed a known string split at every byte offset and assert it reassembles. |
| **Viewport math** — grid size + scale + viewport dims → visible row/col window, clamping, anchor-to-input-box | Where pan/zoom bugs live: off-by-one, panning past the edge, anchor drift after resize. |
| **Scroll nub response curve** — displacement → velocity | Assert dead zone, monotonicity, clamped maximum. Cheap, and the difference between usable and infuriating. |

That's five focused test files. Per the project's testing philosophy: critical paths, no
coverage target, no testing of libraries.

## Layer 2 — deterministic fixtures instead of live pi

Testing against real pi is nondeterministic and costs tokens. Two fixtures remove that:

- **`fake-pi.sh`** — a tiny script drawing the same *shape* as pi: bordered input box,
  cwd line, status line, scrolling output above. Deterministic, free, and it exercises
  everything that matters for anchoring, row accounting, and reflow. Use it for nearly all
  integration work.
- **Recorded real output** — capture one genuine pi session's raw PTY bytes
  (`tmux pipe-pane`, or `script`) and replay it as a fixture. Gives realistic escape
  sequences, box-drawing, colours and repaint patterns with zero flakiness or cost.

Together these cover "does it render pi correctly" without ever launching pi in a test.

## Layer 3 — Playwright

The right tool, and a real upgrade on Chrome emulation: Playwright ships a **WebKit**
build, so you are testing the same engine family as Safari rather than Chrome pretending.
`devices['iPhone 15']` supplies viewport, DPR, touch flags and user agent. There is
already a `playwright.config.js` precedent in `pi-mobile`.

**End-to-end is fully available** — spawn `ttyd --index dist/client.html ./fake-pi.sh` in
a fixture and drive the real thing. Deterministic, no tokens, no live pi.

Worth automating:

- terminal renders the recorded fixture to the expected screen model
- key bar buttons put the right bytes on the wire (assert against a stub PTY)
- grid presets and rotation via `setViewportSize`; pan clamping at grid edges
- **reconnect repaint** — kill ttyd or drop the socket, then assert the resize nudge
  (N−1 → N) produces a full repaint. Mechanisable, and it is the failure that would make
  you abandon the tool
- autocorrect attributes present on the capture element; anchor holds after resize

### The seam that makes Playwright useful

Playwright's WebKit has **no software keyboard**, so `visualViewport` never shrinks and
the single most important behaviour is invisible to it. The fix is architectural, not a
tooling choice:

> Do not read `visualViewport` throughout the layout code. Put one adapter behind a
> `{keyboardHeight, viewportH, orientation, standalone}` state object.

Then the untestable surface shrinks to that adapter:

- **Device probe** verifies the adapter reports correct values on real iOS.
- **Playwright** injects synthetic values and tests *all* the layout logic — keyboard
  open/close, rotation, standalone vs Safari — with no keyboard required.

Apply the same split to gestures: separate `raw touch events → gesture intent` from
`gesture intent → viewport change`. Playwright tests the second exhaustively and the first
partially.

### Still out of reach

Momentum scroll feel, dictation, iOS-specific quirks, and real multi-touch pinch (awkward
in WebKit). Playwright's WebKit is not iOS Safari — it will give confident, wrong answers
about iOS bugs.

If device testing becomes the bottleneck, a cloud device farm (BrowserStack/Sauce) can
drive **real** iOS Safari with a real software keyboard. Slow, costs money, and clumsy for
gesture work — but it is the only automated path to the keyboard behaviour.

### Screenshots

Skip visual regression for now — the design is still moving and goldens would churn. Once
layout stabilises, the deterministic `fake-pi.sh` fixture makes `toHaveScreenshot()`
genuinely viable, because the rendered output is fully reproducible. Revisit then.

## Layer 4 — the real device, made cheap

This is where the product is actually decided, so make it fast to repeat rather than
thorough.

**Build a diagnostic overlay into the client** (toggle in a corner). Live-display:

- `visualViewport` height/offset vs `innerHeight`, and the derived keyboard height
- safe-area insets, standalone-mode flag, orientation
- current grid cols×rows, render scale, computed **content rows visible**
- scroll offset, scrollback length, follow-output state
- WS state, last reconnect cause, round-trip latency

Then device "testing" is: open, do the thing, read the numbers. This converts every
question in this project from argument into measurement — and it is the same overlay that
answers the open probe questions below.

**Short manual checklist**, run per device/OS version, phrased as measurables:

1. Keyboard up: how many content rows remain? (expect ~9 at 50×15)
2. Keyboard up: can you scroll, with nub and with buttons?
3. Rotate with keyboard up — does the grid stay pinned and the anchor hold?
4. Lock the phone 60s, unlock — does the screen repaint intact?
5. Switch WiFi→cellular — same.
6. Dictate a sentence — does it arrive uncorrupted, with autocorrect off?
7. `/` and `@` — do pi's menus appear and remain visible?
8. Pan to the far corner of a 160×50 grid and back to the input box.

## Front-load the platform unknowns

**Do this before writing the real client.** The highest-risk assumptions are all platform
behaviours that could force a redesign, and a throwaway probe answers them in an hour:

- What does `visualViewport` actually report on keyboard open — in Safari vs standalone?
- Does a scroll container keep working normally while the keyboard is up?
- Does a fixed-position touch nub conflict with page scrolling or iOS edge gestures?
- Does dictation into a *hidden* textarea produce usable input events?
- What happens to layout on rotation with the keyboard up?
- Does `autocorrect="off"` hold in practice on the current iOS?

Answers here are worth more than any amount of test coverage on code that may not survive.

## What not to test

- The renderer library (wterm/xterm.js/ghostty-web) and ttyd — dependencies.
- Exact pixel rendering or screenshot diffs — high maintenance, low signal, and the design
  is still moving.
- Every escape sequence — that is the renderer's job, and the recorded fixture covers the
  ones pi actually emits.
- Live pi in automated tests — nondeterministic and costs tokens.

## Sequence

1. Probe page on the real phone → answers the platform unknowns.
2. Layer 1 unit tests alongside the logic as it is written.
3. `fake-pi.sh` + recorded fixture → integration without pi.
4. Diagnostic overlay early, since it doubles as the device test harness.
5. A handful of `br` checks for reconnect and key encoding.
6. Manual checklist per device, only on changes that touch layout or input.
</content>
