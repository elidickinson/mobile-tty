# mobile-tty

Drive pi.dev — or any full-screen terminal app — from a phone, over a WebSocket-attached
PTY. It keeps the real terminal rather than replacing it with a chat UI.

## Start it

```
npm install
./serve.sh                          # serves on :7681, runs pi
PORT=8080 ./serve.sh                # different port
./serve.sh bash                     # run something else
MTTY_SOCKET=/tmp/work.sock ./serve.sh   # a second, independent session
```

Open `http://<your-ip>:7681/` on the phone. **Add to Home Screen** and launch it from there
— standalone mode drops Safari's chrome and is worth about 7 extra rows.

pi keeps running when you close the page; reopening reattaches to the same session.

## Use it

**Key bar**, left to right: `⌃ ⌥ ⇧` are sticky — tap one, then the next key you press
(including a letter on the software keyboard) carries it, so `⌃` then `c` is Ctrl-C. Then
`esc`, `⇥` tab, arrows (hold to repeat), `⇈ ⇊` to page the view, `⌨` to summon or dismiss
the keyboard, and `≡` for the menu.

**Scrolling** is a normal drag. When you scroll away from the live screen a **↓ latest**
button appears; typing also jumps you back. New output while you're reading history leaves
you where you are.

**Rotate to landscape** for 93 columns instead of 50. The grid never resizes on its own when
the keyboard opens — only the visible window shrinks.

**Menu** (`≡`): grid presets and **Fit**, zoom (render scale only — the grid stays put),
**Reconnect**, **Clear view** (local only), **Reload app** (picks up a new build; standalone
has no reload button), and a live readout of viewport, insets, grid and scroll state. Errors
paint a red panel at the top of the screen.

## Watch from the desktop

Attach to the same session while the phone is connected — both can type, both see everything:

```
dtach -a "$TMPDIR/mobile-tty.sock" -r winch
```

`Ctrl-\` detaches and leaves pi running. `Ctrl-C` goes through to pi.

Attaching takes the PTY size, so the phone's grid will be wrong until you tap **Fit**. Sizing
the desktop window to the phone's grid avoids it entirely.

## Test

```
npm test                # 40 unit
npm run test:e2e        # 29 WebKit at 402x812 against fixtures/fake-pi.sh
npm run test:smoke      # 3 against real pi under dtach; sends no prompts, costs no tokens
npm run build           # dist/client.html, one self-contained file
```

## Notes

Requires `ttyd` and `dtach` (`brew install ttyd dtach`). Alternate-screen apps — Claude
Code, vim, htop — are out of scope for now; dictation is untested.

Why it is built this way, and the measurements behind it:
[`docs/decisions.md`](docs/decisions.md) · [`docs/numbers.md`](docs/numbers.md).
