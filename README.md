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
ttyd -W --index client.html tmux new -A -s pi
```

One self-contained `client.html`, developed as ES modules and bundled with esbuild — the
build step exists for testability, since `--index` serves exactly one document.
Cloudflare tunnel for access, reusing the pi-phone pattern. No sidecar, no fork, no server
code.

Renderer: **wterm** if it holds up (DOM rendering gives native scroll, selection and find;
a ~12KB parser keeps the bundle small), **ghostty-web** as the API-compatible fallback,
**xterm.js** as the conservative choice. Build against the xterm.js API surface so two of
the three stay swappable.

## v1 scope

1. ttyd WS protocol + terminal widget.
2. iOS standalone meta tags (+7 rows).
3. Permanent key bar: sticky modifiers, arrows with repeat-on-hold, Tab/Esc,
   PageUp/Dn/Home/End.
4. Input goes straight to pi with its own input box visible and anchored; a hidden capture
   element supplies dictation and autocorrect-off.
5. Grid presets **and** independent pinned-grid pan/zoom. Never auto-resize. Landscape
   (108 cols) is a first-class option.
6. Scrolling: velocity nub, discrete buttons, position indicator, follow-output toggle.
   Buffer-aware — local scrollback on the normal screen (pi), PageUp/Dn or SGR wheel
   events on the alternate screen (Claude Code).
7. Layout driven by `visualViewport`, debounced. No rubber-band, no double-tap zoom.
8. Reconnect: keep the terminal, backoff, resize-nudge (N−1 → N) to force a repaint.

Out of scope until there is evidence: custom dictionary; `tmux -CC` and pane UI; custom
on-screen keyboard; own server, service worker, web push (use Pushover out-of-band);
voice/TTS, recording, multi-user.

## Build order

1. Platform probe — done, see [`docs/numbers.md`](docs/numbers.md).
2. Adapter seam and pure logic, with unit tests alongside.
3. Terminal and ttyd transport against `fake-pi.sh`.
4. Key bar, then scrolling, then pan/zoom.
5. Reconnect.
6. Real-pi smoke test and a device pass.

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
| **Unit** | ttyd frame codec; key-encoding table; **UTF-8 reassembly across WS messages**; viewport math; nub curve | UTF-8 is the sharpest real bug: pi's UI is box-drawing, and a multi-byte sequence split across two messages corrupts if each is decoded independently. Split a known string at every offset. |
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

- Does wterm hold up in practice, or does it fall back to ghostty-web?
- Landscape keyboard-up grid — unmeasured.
- Dictation through a hidden capture element — untested.
- Round-trip echo latency through a tunnel.

## Docs

- [`docs/decisions.md`](docs/decisions.md) — the design decisions and their rationale
- [`docs/numbers.md`](docs/numbers.md) — every measured value, one page
- [`docs/landscape.md`](docs/landscape.md) — survey of prior art
</content>
