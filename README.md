# mobile-tty

A **TUI-friendly mobile web terminal** — a browser client for driving full-screen terminal
apps (pi.dev in particular) from a phone, over a WebSocket-attached PTY.

Deliberately a level *below* [pi-phone](../pi-phone) / Happy / Omnara. Those replace the
TUI with a bespoke chat UI. This keeps the real terminal and fixes the *mobile terminal*
instead, so it works for pi.dev but equally for vim, lazygit, or anything else.

## The three problems

1. **The keyboard hides most of the screen** — 26 usable rows of 47 in Safari with the
   keyboard up.
2. **You can't scroll back**, or send PageUp/PageDown easily.
3. **You can't resize flexibly** — ~50 cols wrecks a dense TUI layout.

## Stack

```
./serve.sh          # ttyd -W --index dist/client.html dtach -A <sock> -r winch -z pi
```

One self-contained `client.html` (~67 KB), developed as ES modules and bundled with
esbuild — the build step exists for testability, since `--index` serves exactly one
document and 404s every other path. Cloudflare tunnel for access, reusing the pi-phone
pattern. No sidecar, no fork, no server code.

**dtach, not tmux.** ttyd kills its child when the socket closes, so something must hold
the PTY. tmux would, but it takes the outer terminal's alternate screen unconditionally,
which leaves the client with no scrollback at all. dtach only holds the PTY. See
[`docs/numbers.md`](docs/numbers.md) for the measurements.

Renderer: **wterm** (`@wterm/dom`) — DOM rendering, so momentum scroll, selection handles
and find come free. Its Zig VT core ships as inlined base64 WASM, which is what makes the
single-document constraint survivable, and `write(Uint8Array)` hands raw bytes to the
parser so UTF-8 never gets split across WebSocket messages in JS.

## v1 scope

1. ttyd WS protocol + terminal widget.
2. iOS standalone meta tags (+7 rows).
3. Permanent key bar: sticky modifiers, arrows with repeat-on-hold, Tab/Esc,
   PageUp/Dn/Home/End.
4. Input goes straight to pi with its own input box visible and anchored; a hidden capture
   element supplies dictation and autocorrect-off.
5. Grid presets **and** independent pinned-grid pan/zoom. Never auto-resize. Landscape
   (108 cols) is a first-class option.
6. Scrolling: native touch drag over the terminal's own scrollback, ⇞/⇟ to page the view,
   and a "↓ latest" button when scrolled away from the live screen.
7. Layout driven by `visualViewport`, debounced. No rubber-band, no double-tap zoom.
8. Reconnect: keep the terminal, backoff, resize-nudge (N−1 → N, 120 ms apart) to force a
   repaint.

Out of scope until there is evidence: custom dictionary; `tmux -CC` and pane UI; custom
on-screen keyboard; own server, service worker, web push (use Pushover out-of-band);
voice/TTS, recording, multi-user; **alternate-screen support** (Claude Code, vim, htop).

## Running it

```
npm install
./serve.sh                 # PORT=7681 by default
npm test                   # 38 unit tests
npm run test:e2e           # 14 WebKit tests at 402x812 against fake-pi.sh
npm run test:smoke         # 2 tests against real pi under dtach; sends no prompts
```

## Build order

1. Platform probe — done, see [`docs/numbers.md`](docs/numbers.md).
2. Adapter seam and pure logic, with unit tests alongside — done.
3. Terminal and ttyd transport against `fake-pi.sh` — done.
4. Key bar, then scrolling, then pan/zoom — done.
5. Reconnect — done.
6. Real-pi smoke test — done. **Device pass — outstanding.**

## Testing

The hard parts — iOS keyboard geometry, gesture arbitration, "is the useful part visible"
— resist CI. So: push everything mechanisable into pure functions, keep the platform
unknowns cheap to re-probe on device, and don't build an automation cathedral for one HTML
file.

**The seam that makes this work:** one adapter converts `visualViewport` plus insets into
`{keyboardHeight, viewportH, orientation, standalone}`, and all layout sits downstream of
it. The device verifies the adapter; everything after it is testable without a keyboard.

| Layer | What | Notes |
|---|---|---|
| **Unit** | ttyd frame codec; key-encoding table; viewport math; reconnect, backoff and the repaint nudge | UTF-8 splitting is no longer a unit concern: raw bytes go straight to the VT core, so the client has nothing to reassemble. It is asserted end to end instead, by checking box-drawing renders. |
| **Viewport fixtures** | The five measured configurations in `docs/numbers.md`, replayed as a parametrized table | Asserts the input line stays above the keyboard, the anchor holds, and insets aren't double-counted. |
| **Playwright** (WebKit) | e2e on `ttyd --index dist/client.html ./fake-pi.sh` — rendering, key bytes on the wire, pan clamping, reconnect repaint, `characterSet === 'UTF-8'`, autocorrect attributes | Fast, deterministic, no tokens. The main suite. |
| **Real-pi smoke** | One test launching **real pi** under tmux: renders the startup screen, input box present, survives resize 50×30 → 120×40 → 160×50 | Catches `fake-pi.sh` drift and pi version changes. Sends no prompts, so costs no tokens. Slow and mildly flaky — one test, outside the main suite. |
| **Device probe** | `probe/` — metrics page that POSTs snapshots to `probe/reports.jsonl` | Re-run on new OS versions or when layout changes. |
| **Manual** | Dictation; nub and scroll *feel* against a real terminal | The un-automatable remainder. |

Fixtures: `fake-pi.sh` reproduces pi's *shape* — bordered input box, cwd line, status line,
scrolling output — plus one recorded real pi session's raw PTY bytes for realistic escape
sequences.

The client's diagnostic overlay should expose the same snapshot shape the probe POSTs, so
device reports and Playwright assertions read one interface.

Not doing: visual regression (goldens would churn while the design moves); cloud device
farm unless dictation becomes a blocker.

## Open questions

- Everything above is verified in WebKit at 402×812. **None of it is verified on a real
  phone yet** — the keyboard, dictation and gesture feel are exactly what the emulator
  cannot tell us.
- Landscape keyboard-up grid — still unmeasured.
- Dictation through wterm's hidden textarea — untested.
- Round-trip echo latency through a tunnel.
- Whether `fake-pi.sh` should be replaced by real pi driven by a purpose-built extension.

## Docs

- [`docs/decisions.md`](docs/decisions.md) — the design decisions and their rationale
- [`docs/numbers.md`](docs/numbers.md) — every measured value, one page
- [`docs/landscape.md`](docs/landscape.md) — survey of prior art
