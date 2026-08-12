# mobile-tty

Drive pi.dev -- or any full-screen terminal app -- from a phone, over a WebSocket-attached PTY. It keeps the real terminal rather than replacing it with a chat UI.

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

It listens on **loopback by default**, because that is all the tunnel needs. `--lan` opens it to the network so a phone on the same wifi can reach `http://<your-ip>:7681/` -- which is an unauthenticated terminal on your network, so prefer the tunnel. **Add to Home Screen** and launch it from there -- standalone mode drops Safari's chrome and is worth about 7 extra rows.

The **server** holds the program: one PTY, and every viewer looks at the same screen. It keeps that screen, so opening the page gets it back instantly instead of making the program redraw, and closing the last tab kills nothing. `attach` joins a server that is already running rather than starting one. To end the session, exit the program or run `down`.

Every command runs in the foreground and owns what it starts, so there is nothing to track between them: `Ctrl-C` on `up` takes the server and the tunnel down together, and leaves the session alone. There is no build step: the server bundles the client when the page is asked for, so an edit needs a reload and nothing else -- notably not a restart, which would kill the program.

`down` ends everything -- server, tunnel, and the program. The default program is `pi --session-id mobile-tty`, so starting again rejoins the same conversation and only work in flight is lost. `up` says on startup whether a login actually stands in front of your hostname, since that is the only thing about the setup you cannot see from this machine.

## Use it

**Key bar**, left to right: `⌃ ⇧` are sticky -- tap one, then the next key you press (including a letter on the software keyboard) carries it, so `⌃` then `c` is Ctrl-C. Then `esc`, `⇥` tab, `⌫` backspace, arrows, `⌨` to summon or dismiss the keyboard, and `≡` for the menu. Backspace and the arrows repeat when held; the software keyboard's own backspace does not, because the field it types into is emptied after every keystroke.

There is no alt key: meta is an ESC prefix, so `esc` then `b` is the same bytes as alt+b.

**Scrolling** is a normal drag. When you scroll away from the live screen a **↓ latest** button appears; typing also jumps you back. New output while you are reading history leaves you where you are.

**Rotate to landscape** for 93 columns instead of 50. The grid never resizes on its own when the keyboard opens -- only the visible window shrinks.

**Menu** (`≡`): **Top** / **Bottom** jump to either end of the scrollback; **Paste** -- long-press the field, paste, then Send, since iOS only offers its callout on a visible field; grid presets and **Fit**; zoom, which is render scale only and leaves the grid alone; **Reconnect**; **Clear view**, local only; **Reload app**, since standalone has no reload button; and a live readout of viewport, insets, grid and scroll state. A ⚡ in the corner means the socket is down, and errors paint a red panel at the top.

## Reach it from anywhere

Authentication is a cookie, either way you do it. Basic auth cannot work at all here: Safari puts no `Authorization` header on a WebSocket handshake and the page cannot add one, so it would load and then never connect.

Cloudflare Access authenticates with a cookie instead, and cookies *are* sent on WebSocket handshakes. Given a domain on Cloudflare:

```
cloudflared tunnel login                 # once, opens a browser
./mobile-tty setup pi.example.com        # tunnel, DNS, config, Access login
./mobile-tty up --hostname pi.example.com   # serve and tunnel together
```

The server runs with no password under this: Access is the authentication, and it happens at Cloudflare's edge before anything reaches the machine. `setup` refuses to call itself done until a login is actually in front of the hostname, and says loudly when there is not one.

For a network you already trust -- a LAN, a tailnet -- `$MTTY_PASSWORD` is the lighter option: set it and the page becomes a login that mints a cookie, with `attach` using the same password. It is a single static secret with no lockout, so make it a generated one, and on `--lan` it crosses plain http in the clear. Access is still the better answer for anything facing the internet; use one or the other, not both.

**`--hostname` is required behind any proxy.** A page on any site you visit can open a WebSocket to your loopback -- nothing in the browser stops it -- so a socket is refused unless its `Origin` is the address it connected to. Addresses work as-is; a name (Cloudflare, MagicDNS, any reverse proxy) has to be declared, by flag or `$MTTY_HOSTNAME`. Miss it and the page loads but never connects, with the reason on stderr.

The desktop can watch or type at the same time, either by opening the same URL or with `./mobile-tty attach`. One PTY means one size, though, and **the narrowest viewer wins** -- this is meant to be read on a phone, and a desktop showing a phone-width column is legible where the reverse is not. The server tells every viewer the size it actually picked.

## Test

```
npm test                # unit, including the snapshot round-trip gate
npm run test:e2e        # WebKit at 402x812 against tests/fixtures/fake-pi.sh
npm run test:integrity  # that no viewer is ever sent a gap
npm run test:smoke      # against real pi; sends no prompts, costs no tokens
```

Anything mechanisable is a pure function; the device verifies the viewport adapter, and everything downstream of it is testable without a keyboard. Not doing visual regression -- goldens would churn while the design moves.

## Picking up a new build

- **Every load** revalidates: the document is `no-cache` with the bundle's hash as its ETag, so an unchanged client costs a 304 instead of 74 KB.
- **On startup** the page refetches past the cache and compares build stamps; a newer one on the server redirects to `?b=<hash>`, a URL iOS has no cached copy of. This is what actually works in standalone, where the launch document is held whatever the headers say.
- **Never mid-session.** A page already open will not notice a new build -- use **Reload app** in the menu.

## Notes

Requires node, plus `cloudflared` for the tunnel. Alternate-screen apps -- Claude Code, vim, htop -- are out of scope for now, and dictation is untested.

Why it is built this way, and the measurements behind it: [`docs/design.md`](docs/design.md) and [`docs/numbers.md`](docs/numbers.md).
