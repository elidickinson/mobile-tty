# mobile-tty

Access your Pi coding agent (with *all* the features) from a mobile device. Uses a WebSocket-attached PTY to show your whole terminal rather than replacing it with a web chat UI. Should work with many other full-screen TUI apps too.


<p>
  <img src="docs/screenshot-keyboard.png" width="300" alt="Terminal view with the iOS keyboard up: pi's transcript and own input box above the key bar and status strip">
    &nbsp;
  <img src="docs/screenshot-scrollback.png" width="300" alt="Scrolled back through a transcript, with a ↓ latest button counting new output">
</p>

## How it works

One Node process, the supervisor, holds every session -- one pi (or other program) per session id, kept running in the background once you've joined it, whether or not anyone is looking. Each session is a real terminal (a PTY) of its own, and every viewer -- phone, desktop tab, any number of `attach`es -- is a WebSocket client watching one of them. A session's own grid is one size for everyone watching it: the narrowest viewer's, because a real terminal can only be one width.

Each session also feeds every byte into a second, headless terminal (`server/mirror.js`). That copy does two jobs: a joining viewer is handed a snapshot of it instead of making pi redraw (joining costs one screen, not the transcript), and it survives disconnects -- close the tab, reopen, the screen is back instantly.

The phone renders to the DOM, so the terminal's own scrollback is real history: scrolling, selection and find are the browser's, not reimplemented.

### Limitations

- **No alt-screen apps** (Claude Code, vim). The renderer ignores the alternate screen so scrollback stays real history; apps that switch to it can't render.
- **Reconnecting gets you the last ~1000 lines of scrollback.** The browser core's scrollback is hard-capped at 1000 lines (inside its WASM, not easy to change), so the snapshot matches it. Enough for a few turns back; a long session's history is gone after a reload.
- **The input box is pi's**, costing 5-6 rows; a client-side composer box would be better in some ways but would break pi's autocomplete.
- **iPhone/Safari only**; Android untested.

## Get Started

```
git clone https://github.com/elidickinson/mobile-tty && cd mobile-tty
npm install
./mobile-tty
```

That serves `pi` on http://127.0.0.1:7681. Open it on this machine -- that's your regular pi session in a browser, and every browser tab that opens the URL sees the same session. The server holds the screen across disconnects, so reopening the page gets it back instantly and closing the tab ends nothing, and joining a different session leaves this one running in the background rather than ending it. `Ctrl-C` in the serving terminal ends every session at once. Keystrokes typed while briefly disconnected queue up and replay.

**Then the phone**, which needs a way to reach the machine. On the same wifi:

```
export MTTY_PASSWORD=...    # the page becomes a login
./mobile-tty --lan          # listen on the LAN address
```

and open `http://<your computer's address>:7681` on the phone. From anywhere instead of just home, run it through a Cloudflare tunnel -- see [Reach it from anywhere](#reach-it-from-anywhere). Either way, on the phone: **Add to Home Screen** (standalone mode is worth ~7 rows over Safari).

Optional: install pi extension to print the model at the bottom of the screen (otherwise it is obscured on a narrow phone screen). The extension is only active when pi is run through mobile-tty.
```
pi install "$PWD/pi-extensions/mtty-footer.ts"
```

**Other ways to run it:**

```
./mobile-tty serve bash             # a program other than pi
./mobile-tty pi --model whatever    # arguments after the program go to it
./mobile-tty attach                 # join a session from a second terminal (Ctrl-] detaches)
./mobile-tty attach my-project      # attach straight to a session by name, path or id fragment
./mobile-tty --port 1234            # --bind and --hostname too
./mobile-tty serve --tunnel         # run the tunnel alongside; needs setup first (below)
```

`attach [fragment]` matches case-insensitively against everything that
identifies a session: the **basename of the folder** the pi conversation ran
in (`my-project` for `~/work/my-project`), the **path** of that folder
(`work/my-pro` works), or the **session id**. A fragment that matches several
sessions -- including every older transcript of the same folder, which are
all named alike -- brings up a numbered pick list instead of guessing
(● marks the ones already running):

```
attach: which session?
  1) ● mobile-tty   ~/projects/mobile-tty
  2)   mobile-tty   ~/projects/mobile-tty
>
```

**Only tested on an iPhone** (Safari, and the e2e suite runs WebKit). Android is untested -- reports welcome. Requires node 22+, plus `cloudflared` for the tunnel. macOS gets a prebuilt `node-pty`; on Linux `npm install` compiles it, which wants python and a C++ toolchain. Alt-screen apps (Claude Code, vim) are out of scope.

## The phone UI

- **Key bar**: `⌃ ⇧ ⌥` are sticky (tap, then the next key carries them -- so `⌃ c` = Ctrl-C). Then `esc`, `⇥`, `⌫`, arrows, `⌨` (toggle keyboard), `≡` (menu). Backspace and arrows repeat when held.
- **Status strip** (if the optional extension is installed): model and thinking level (`provider/model - max`), which pi's footer truncates at phone width.
- **Scrolling**: drag. Away from the bottom, output is *held* rather than drawn, so the page under you never moves; the **↓ N new** button counts what is waiting. Tapping it or typing releases it.
- **Landscape** reflows to full width automatically.
- **Menu** (`≡`): the session list, Top/Bottom, Paste, grid presets and Fit, zoom (render only), Reconnect, Clear view (local), Reload app, Diagnostics. ⚡ means the socket is down.

## Sessions

The `≡` menu lists every session pi has a transcript for, newest first, a running one marked ●. Tap one to join it -- if it isn't already running, it's started in the background first; if it is, you're looking at it instantly, exactly as it was left. Joining never ends anything else: leave a session and it keeps running, so the phone, a browser tab and any number of `attach`ed terminals can each be looking at a different one, the same as running pi a few times in different terminals -- except the menu is how you get back to any of them from the phone.

The list is labeled: each row's title is pi's own name for that session (written once it has read your first exchange), falling back to what you first asked there, and each shows how long ago it was last active. A session with no conversation in it yet is labeled by its folder. `attach`'s numbered picker shows the same labels and times, and a fragment matches labels too -- two conversations in one folder are told apart by those, or by their ids.

**New session** at the top of the menu starts a brand-new conversation without any transcript to resume: it offers this server's own folder first (point `--new-dir` elsewhere if you would rather), then every folder a listed session runs in. The session begins immediately in the background and joins like any other; pi writes its transcript on first use and it is a normal row from then on. A session exists in the list either way, transcript or not, until the server holding it stops.

## Reach it from anywhere

Pick one auth method, not both.

**Cloudflare Access** (recommended, internet-facing). Given a domain on Cloudflare:

```
cloudflared tunnel login                 # once
./mobile-tty setup pi.example.com        # tunnel, DNS, config, Access login
./mobile-tty serve --tunnel --hostname pi.example.com
```

The server runs with no password here; Access authenticates at the edge, and `setup` verifies a login is really in place.

**`$MTTY_PASSWORD`** (LAN/tailnet): the page becomes a login that mints a cookie; `attach` uses the same password. A single static secret over plain http -- fine on a network you trust.

**`--hostname` is required behind any proxy.** Any web page you visit can open a WebSocket to your loopback, so a socket is refused unless its `Origin` matches where it connected. IPs work as-is; names must be declared via flag or `$MTTY_HOSTNAME`. Miss it and the page loads but never connects (reason on stderr).

Desktop can join too (same URL, or `./mobile-tty attach [name-or-path]` for a second terminal). Each session's own PTY means one size *for that session*, and **the narrowest viewer of it wins** -- a phone-width column on desktop is legible; the reverse is not. The server reports the size it picked.

## Advanced

- The flags also read env vars: `$MTTY_PORT`, `$MTTY_BIND`, `$MTTY_HOSTNAME`, `$MTTY_THEME`, `$MTTY_NEW_DIR` (and `$MTTY_PASSWORD`, above).
- The session menu is built from pi's history under `~/.pi/agent/sessions`; `$PI_CODING_AGENT_SESSION_DIR` points it elsewhere.
- A folder used for several separate pi conversations offers all of them in the list, not just the newest -- there's no more need to `/resume` inside pi to reach an older one in the same folder.
- **The list itself is capped at the 50 most recent sessions**, not everything pi has ever kept a transcript for -- a working machine's history can be a lot, and nothing needs to read all of it to answer "what have I touched lately." The menu says how many older ones are being left out when there are any. This is a separate limit from the concurrency cap below: it's about what's *listed*, not what's *running*.
- Up to 4 sessions run in the background at once by default; joining a fifth ends whichever one was looked at longest ago to make room.
- Restarting the server ends every session; `./mobile-tty pi --session-id whatever` pins one to come back to.
- No terminal handy to seed a new folder? `./mobile-tty serve bash`, then cd and run pi once.

## Development

No build step: the client is bundled per page request, so client edits need a reload, not a restart. Server edits need a restart, which kills the program.

```
npm test                # unit, including the snapshot round-trip gate
npm run typecheck       # strict tsc over the vendored wterm renderer
npm run test:e2e        # WebKit at 402x812 against tests/fixtures/fake-pi.js
npm run test:integrity  # that no viewer is ever sent a gap
npm run test:smoke      # against real pi; sends no prompts, costs no tokens
npm run test:real-pi    # real pi behind the real server, resized mid-draw
```

## Architecture

One node process, the supervisor, owns the front door; each session it holds is a *second* node process, one per pi (or other program), spawned over a Unix socket rather than a network port. A viewer -- phone, desktop tab, `attach` -- is a WebSocket client of the supervisor, which is a raw pipe into whichever session's socket the connection names (`/ws?session=<id>`); the wire protocol itself (`server/protocol.js`, four byte-tagged frames) is unchanged by that hop and the supervisor never parses it, it just forwards bytes.

- **`server/index.js`** is one session: one PTY, N viewers, one screen, for its whole life -- no switching. `server/mirror.js` feeds every output byte into an `@xterm/headless` terminal and serializes it on demand, so a joining viewer is handed a snapshot instead of making pi redraw, and it is what survives a disconnect (`server/auth.js` and `origin.js` guard the door when a session is reached directly; `footer.js` relays the status strip).
- **`server/supervisor.js`** is the front door: auth, origin-checking and the client HTML build live here once. `GET /places` (`server/places.js` reading pi's own session store) lists every session, running or not; a `/ws` connection is proxied into the right one, spawning it via `server/registry.js` if it is not already up.
- **`server/registry.js`** spawns and tracks the background sessions -- each is `server/cli.js` re-invoked with `--internal-socket`, so it's exactly `server/index.js` bound to a Unix socket instead of a port. Past a cap (4 by default) the least recently joined session is ended to make room for a new one.
- **`server/client.js`** builds the client with esbuild *inside the request* -- JS, CSS and the VT core's WASM inlined into one HTML document, hashed into its own ETag. One file is one thing for the phone's cache to get right, and a document built from disk on demand cannot be stale.
- **`src/app.js`** is the client. `@wterm/dom` -- vendored under `vendor/wterm`, see `docs/plan-ios-input.md` -- renders the terminal into the DOM, so native momentum scroll, selection and find come free and the terminal's own scrollback is the history -- no copy-mode, no alternate screen. The vendored copy is TypeScript imported straight into the bundle, which is why the esbuild build passes `tsconfig.json` and `npm run typecheck` covers it; `@wterm/core`, the WASM VT engine it renders with, stays a pinned npm dependency. Around it: `viewport.js` sizes the grid from `visualViewport` (the keyboard never reflows pi), `ttyd.js` and `transport.js` are the wire, `keys.js` encodes the bar keys.

Why it's built this way: [`docs/design.md`](docs/design.md).
