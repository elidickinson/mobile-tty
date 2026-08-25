# mobile-tty

Access your Pi coding agent (with *all* the features) from a mobile device. Uses a WebSocket-attached PTY to show your whole terminal rather than replacing it with a web chat UI. Should work with many other full-screen TUI apps too.

## Get Started

Install:
```
git clone https://github.com/elidickinson/mobile-tty && cd mobile-tty
npm install
```

Usage:
```
./mobile-tty                             # serves `pi` on 127.0.0.1:7681
./mobile-tty --bind 0.0.0.0 --port 1234  # choose how to bind
./mobile-tty attach                      # join a running mobile-tty session from this terminal
./mobile-tty serve --tunnel              # also run the cloudflare tunnel
./mobile-tty serve bash                  # a program other than `pi`
./mobile-tty pi --model whatever         # flags after the program go to it
```

`--port`, `--bind` and `--hostname` also read `$MTTY_PORT`, `$MTTY_BIND` and `$MTTY_HOSTNAME`.

One PTY; every viewer sees the same screen. The server holds the screen across disconnects, so reopening the page gets it back instantly and closing the last tab kills nothing. Everything runs in the foreground and owns what it starts, so `Ctrl-C` ends the server, the tunnel and the program together. To serve and watch at once, run `serve` in one terminal and `attach` in another; `Ctrl-]` detaches the watching one and leaves the session up.

Loopback by default -- all the tunnel needs. `--bind 0.0.0.0` exposes an unauthenticated terminal on your LAN, so prefer the tunnel. On the phone: **Add to Home Screen** (standalone mode gains ~7 rows over Safari).

Requires node 22+, plus `cloudflared` for the tunnel. macOS gets a prebuilt `node-pty`; on Linux `npm install` compiles it, which wants python and a C++ toolchain. Alt-screen apps (Claude Code, vim) are out of scope. Keystrokes queued while disconnected replay on reconnect.

## The phone UI

- **Key bar**: `⌃ ⇧ ⌥` are sticky (tap, then the next key carries them -- so `⌃ c` = Ctrl-C). Then `esc`, `⇥`, `⌫`, arrows, `⌨` (toggle keyboard), `≡` (menu). Backspace and arrows repeat when held.
- **Status strip**: model and thinking level (`provider/model - max`), which pi's footer truncates at phone width. From a pi extension: `ln -s "$PWD/ext/mtty-footer.ts" ~/.pi/agent/extensions/`.
- **Scrolling**: drag. Away from the bottom, output is *held* rather than drawn, so the page under you never moves; the **↓ N new** button counts what is waiting. Tapping it or typing releases it.
- **Landscape** reflows to full width automatically.
- **Menu** (`≡`): folder switching, Top/Bottom, Paste, grid presets and Fit, zoom (render only), Reconnect, Clear view (local), Reload app, Diagnostics. ⚡ means the socket is down.

## Reach it from anywhere

Auth is always a cookie -- Safari sends no `Authorization` header on WebSocket handshakes, so basic auth cannot work. Use one method or the other, not both.

**Cloudflare Access** (recommended, internet-facing). Given a domain on Cloudflare:

```
cloudflared tunnel login                 # once
./mobile-tty setup pi.example.com        # tunnel, DNS, config, Access login
./mobile-tty serve --tunnel --hostname pi.example.com
```

The server runs with no password here; Access authenticates at the edge, and `setup` verifies a login is really in place.

**`$MTTY_PASSWORD`** (LAN/tailnet): the page becomes a login that mints a cookie; `attach` uses the same password. A single static secret over plain http -- fine on a network you trust.

**`--hostname` is required behind any proxy.** Any web page you visit can open a WebSocket to your loopback, so a socket is refused unless its `Origin` matches where it connected. IPs work as-is; names must be declared via flag or `$MTTY_HOSTNAME`. Miss it and the page loads but never connects (reason on stderr).

Desktop can join too (same URL or `./mobile-tty attach`). One PTY means one size, and **the narrowest viewer wins** -- a phone-width column on desktop is legible; the reverse is not. The server reports the size it picked.

## Switching folders

The menu lists every folder pi has history in (`~/.pi/agent/sessions`, newest first; `$PI_CODING_AGENT_SESSION_DIR` moves the list), plus the one the server itself started in. Tap one for **Start here**, or **Continue here** (pi only -- passes `--continue` to resume that folder's last session).

**Only folders pi has already run in are on that list.** A brand-new project is not reachable from the phone until pi has recorded a conversation there, so run pi in it once from a terminal and it appears at the top. With no terminal to hand, serve a shell instead -- `./mobile-tty serve bash` -- and cd from the phone.

The list is folders, not sessions: **Continue here** always takes the folder's most recent one. To reach any other session in the same folder, use `/resume` inside pi.

Switching **ends the running program** -- the one PTY *is* the session, so every viewer follows. A turn in flight dies with it, and so does a running `bash` tool call. The conversation itself is safe, because pi writes it down as it goes and Continue resumes it, but anything the program had not finished is gone -- so rows confirm before acting. Only folders the server itself listed are honored; that frame is what keeps a socket from becoming a way to run programs anywhere.

Restarting the server starts a fresh pi. Use `./mobile-tty pi --session-id whatever` for one that comes back every time.

## Development

No build step: the client is bundled per page request, so client edits need a reload, not a restart. Server edits need a restart, which kills the program.

```
npm test                # unit, including the snapshot round-trip gate
npm run test:e2e        # WebKit at 402x812 against tests/fixtures/fake-pi.sh
npm run test:integrity  # that no viewer is ever sent a gap
npm run test:smoke      # against real pi; sends no prompts, costs no tokens
```

## Architecture

One node process owns everything. `server/` spawns the program on a real PTY through `node-pty` and every viewer -- phone, desktop tab, `attach` -- is a WebSocket client of it, speaking a protocol of five byte-tagged frames (`server/protocol.js`) that the client parses in about thirty lines.

- **`server/mirror.js`** feeds every output byte into an `@xterm/headless` terminal and serializes it on demand. A joining viewer is handed that snapshot instead of making pi redraw, turning an attach from O(transcript) into O(screen) -- and it is what survives a disconnect.
- **`server/index.js`** is the hub: one grid for all viewers (narrowest wins), fan-out, and folder switching, which respawns the program against a list `server/places.js` built (`server/auth.js` and `origin.js` guard the door; `footer.js` relays the status strip).
- **`server/client.js`** builds the client with esbuild *inside the request* -- JS, CSS and the VT core's WASM inlined into one HTML document, hashed into its own ETag. One file is one thing for the phone's cache to get right, and a document built from disk on demand cannot be stale.
- **`src/app.js`** is the client. `@wterm/dom` renders the terminal into the DOM, so native momentum scroll, selection and find come free and the terminal's own scrollback is the history -- no copy-mode, no alternate screen. Around it: `viewport.js` sizes the grid from `visualViewport` (the keyboard never reflows pi), `ttyd.js` and `transport.js` are the wire, `keys.js` encodes the bar keys.

Why it's built this way, and the measurements behind it: [`docs/design.md`](docs/design.md) and [`docs/numbers.md`](docs/numbers.md).
