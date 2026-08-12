# mobile-tty

Drive pi.dev — or any full-screen terminal app — from a phone, over a WebSocket-attached PTY. It keeps the real terminal rather than replacing it with a chat UI.

## Start it

```
npm install
./mobile-tty                             # build if stale, then serve on :7681
./mobile-tty --lan                       # reachable from the phone over wifi
./mobile-tty attach                      # join the same session from this terminal
./mobile-tty up                          # serve and tunnel, both ending together
./mobile-tty serve bash                  # a different program
./mobile-tty pi --model whatever         # flags after the program go to it
./mobile-tty help                        # all of it
```

It listens on **loopback by default**, because that is all the tunnel needs. `--lan` opens it to the network so a phone on the same wifi can reach `http://<your-ip>:7681/` — which is an unauthenticated terminal on your network, so prefer the tunnel. **Add to Home Screen** and launch it from there — standalone mode drops Safari's chrome and is worth about 7 extra rows.

The **session** holds the program and outlives every command here. `serve` and `attach` each start one if there is not one already, and both are only viewers onto it — so the desktop can attach with nothing else running, and closing the last browser tab kills nothing. To end it, exit the program.

Every command runs in the foreground and owns what it starts, so there is nothing to track between them: `Ctrl-C` on `up` takes the server and the tunnel down together, and leaves the session alone. The build is skipped when `dist/client.html` is newer than `src/` and the lockfile, so a prebuilt copy needs `ttyd` and `dtach` but not node.

`down` ends everything — server, tunnel, and the program — and clears the socket, which is the one piece of state that outlives every command. `up` says on startup whether a login actually stands in front of your hostname, since that is the only thing about the setup you cannot see from this machine.

## Use it

**Key bar**, left to right: `⌃ ⇧` are sticky — tap one, then the next key you press (including a letter on the software keyboard) carries it, so `⌃` then `c` is Ctrl-C. Then `esc`, `⇥` tab, `⌫` backspace, arrows, `⌨` to summon or dismiss the keyboard, and `≡` for the menu. Backspace and the arrows repeat when held; the software keyboard's own backspace does not, because the field it types into is emptied after every keystroke.

There is no alt key: meta is an ESC prefix, so `esc` then `b` is the same bytes as alt+b.

**Scrolling** is a normal drag. When you scroll away from the live screen a **↓ latest** button appears; typing also jumps you back. New output while you are reading history leaves you where you are.

**Rotate to landscape** for 93 columns instead of 50. The grid never resizes on its own when the keyboard opens — only the visible window shrinks.

**Menu** (`≡`): **Top** / **Bottom** jump to either end of the scrollback; **Paste** — long-press the field, paste, then Send, since iOS only offers its callout on a visible field; grid presets and **Fit**; zoom, which is render scale only and leaves the grid alone; **Reconnect**; **Clear view**, local only; **Reload app**, since standalone has no reload button; and a live readout of viewport, insets, grid and scroll state. A ⚡ in the corner means the socket is down, and errors paint a red panel at the top.

## Reach it from anywhere

There is no `--password`, and the fault is not ours: ttyd refuses the WebSocket upgrade without a basic-auth header, and Safari does not put one on a WebSocket handshake ([ttyd#1437](https://github.com/tsl0922/ttyd/issues/1437), open since 2025, fix unmerged). The page loads and the terminal never connects.

Cloudflare Access authenticates with a cookie instead, and cookies *are* sent on WebSocket handshakes. Given a domain on Cloudflare:

```
cloudflared tunnel login                 # once, opens a browser
./mobile-tty setup pi.example.com        # tunnel, DNS, config, Access login
./mobile-tty up                          # serve and tunnel together
```

ttyd runs with no password under this: Access is the authentication, and it happens at Cloudflare's edge before anything reaches the machine. `setup` refuses to call itself done until a login is actually in front of the hostname, and says loudly when there is not one.

The desktop can watch or type at the same time, either by opening the same URL or with `./mobile-tty attach`. One PTY means one size, though: whoever attached or resized last owns it, and **Fit** is how the phone takes it back.

## Test

```
npm test                # 40 unit
npm run test:e2e        # 39 WebKit at 402x812 against tests/fixtures/fake-pi.sh
npm run test:smoke      # 3 against real pi under dtach; sends no prompts, costs no tokens
npm run build           # dist/client.html, one self-contained file
```

Anything mechanisable is a pure function; the device verifies the viewport adapter, and everything downstream of it is testable without a keyboard. Not doing visual regression — goldens would churn while the design moves.

## Notes

Requires `ttyd` and `dtach` (`brew install ttyd dtach`), plus `cloudflared` for the tunnel. Alternate-screen apps — Claude Code, vim, htop — are out of scope for now, and dictation is untested.

Why it is built this way, and the measurements behind it: [`docs/decisions.md`](docs/decisions.md) · [`docs/numbers.md`](docs/numbers.md).
