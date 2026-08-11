# mobile-tty

A TUI-friendly mobile web terminal: drive pi.dev (or anything full-screen) from a phone
over a WebSocket-attached PTY. A level below pi-phone / Happy / Omnara — those replace the
TUI with a chat UI; this keeps the real terminal and fixes the *mobile terminal*.

It exists to fix three things: the keyboard hides most of the screen, you can't scroll back,
and ~50 columns wrecks a dense layout.

## Run

```
npm install
./serve.sh              # ttyd --index dist/client.html dtach -A <sock> -r winch -z pi
```

Then open it on the phone, or add it to the Home Screen for +7 rows. To watch or type from
the desktop at the same time:

```
dtach -a "$TMPDIR/mobile-tty.sock" -r winch      # Ctrl-\ detaches, Ctrl-C goes to pi
```

## Test

```
npm test                # 40 unit
npm run test:e2e        # 29 WebKit at 402x812 against fixtures/fake-pi.sh
npm run test:smoke      # 3 against real pi under dtach; sends no prompts, costs no tokens
```

Anything mechanisable is a pure function; the device verifies the viewport adapter and
everything downstream of it is testable without a keyboard. Not doing visual regression —
goldens would churn while the design moves.

## Shape

One self-contained `dist/client.html` (~70 KB), bundled by esbuild because ttyd's `--index`
serves exactly one document and 404s everything else. No sidecar, no fork, no server code.

- **dtach, not tmux** — tmux takes the terminal's alternate screen, which zeroes client
  scrollback and would delete the reason for a DOM renderer.
- **wterm** for the terminal — DOM rendering, inlined WASM core, raw bytes in.
- **Errors paint a red panel** at the top and `≡` carries a live readout: a phone shows no
  stack trace, and that blind spot has cost more debugging time than any bug.

Why each of those, and every measured number behind them:
[`docs/decisions.md`](docs/decisions.md) · [`docs/numbers.md`](docs/numbers.md).

## Known gaps

- Dictation is untested; alternate-screen apps (Claude Code, vim) are out of scope.
- One PTY means one size: whoever acted last owns it, and `Fit` is how the phone acts.
- `fake-pi.sh` may be worth replacing with real pi driven by a purpose-built extension.
