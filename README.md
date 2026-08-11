# mobile-tty

A **TUI-friendly mobile web terminal** — a browser client for driving full-screen terminal
apps (pi.dev in particular) from a phone, over a WebSocket-attached PTY.

Deliberately a level *below* pi-phone / Happy / Omnara. Those replace the TUI with a
bespoke chat UI. This keeps the real terminal and fixes the *mobile terminal* instead.

## The three problems

1. **The keyboard hides most of the screen** — 26 usable rows of 47 in Safari.
2. **You can't scroll back**, or page easily.
3. **You can't resize flexibly** — ~50 cols wrecks a dense TUI layout.

## Running it

```
npm install
./serve.sh                 # ttyd -W --index dist/client.html dtach -A <sock> -r winch -z pi
npm test                   # 36 unit tests
npm run test:e2e           # 22 WebKit tests at 402x812 against fixtures/fake-pi.sh
npm run test:smoke         # 3 tests against real pi under dtach; sends no prompts
```

One self-contained `dist/client.html` (~70 KB), developed as ES modules and bundled with
esbuild — the build step exists for testability, since `--index` serves exactly one
document and 404s every other path. Cloudflare tunnel for access. No sidecar, no fork, no
server code.

**dtach, not tmux**, and **wterm** for DOM rendering — see
[`docs/decisions.md`](docs/decisions.md).

## What it does

1. ttyd WS protocol and terminal widget; iOS standalone meta tags (+7 rows).
2. Key bar: sticky modifiers, arrows with repeat-on-hold, Tab/Esc, paging.
3. Input goes straight to pi with its own box visible; autocorrect off.
4. Grid presets and Fit, plus independent render scale. Rotation refits; the keyboard
   never does.
5. Native scrollback drag, ⇈/⇊ to page the view, **↓ latest** when scrolled away.
6. Layout from `visualViewport`, pinned to the bottom so the keyboard cannot hide pi's
   input box.
7. Reconnect: keep the terminal, backoff, resize-nudge to force a repaint.
8. Errors paint a red panel at the top; `≡` carries a live viewport/grid/scroll readout.
   Both exist because a phone shows no stack trace.

Out of scope until there is evidence: custom dictionary; `tmux -CC` and pane UI; custom
on-screen keyboard; own server, service worker, web push; voice/TTS, recording,
multi-user; **alternate-screen support** (Claude Code, vim, htop).

## Testing

The hard parts — iOS keyboard geometry, gesture arbitration, "is the useful part visible"
— resist CI. So: push everything mechanisable into pure functions, keep the platform
unknowns cheap to re-probe on device, and don't build an automation cathedral for one HTML
file.

**The seam:** one adapter turns `visualViewport` plus insets into a layout, and everything
sits downstream of it. The device verifies the adapter; the rest is testable without a
keyboard.

| Layer | What |
|---|---|
| **Unit** | ttyd frame codec; key encoding; viewport math against the five measured configurations; reconnect, backoff and the repaint nudge |
| **Playwright** (WebKit) | e2e on `ttyd --index dist/client.html fixtures/fake-pi.sh` — rendering, key bytes on the wire, paging, rotation refit, bottom pinning, reconnect repaint. The main suite |
| **Real-pi smoke** | Three tests against real pi under dtach: startup screen, reflow across presets, real scrollback, and repaint when a fresh page attaches to a running session. Sends no prompts, so costs no tokens |
| **Manual** | Dictation; scroll and key-bar *feel* against a real terminal |

`fake-pi.sh` reproduces pi's *shape* — bordered input box, cwd line, status line, scrolling
output — plus `/lines` to make scrollback deterministically.

Not doing: visual regression (goldens would churn while the design moves); cloud device
farm unless dictation becomes a blocker.

## Open questions

- Dictation through wterm's hidden textarea — untested.

- Round-trip echo latency through a tunnel.
- Whether `fake-pi.sh` should be replaced by real pi driven by a purpose-built extension.

## Docs

- [`docs/decisions.md`](docs/decisions.md) — why the thing is shaped this way
- [`docs/numbers.md`](docs/numbers.md) — every measured value, one page
