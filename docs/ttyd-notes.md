# ttyd technical notes

Read from `tsl0922/ttyd` `main` on 2026-08-10 (`src/server.h`, `src/protocol.c`,
`src/http.c`, `src/server.c`). This answers "can we get away with just a fancy HTML for
ttyd?"

## WebSocket protocol

Subprotocol: `tty`. Endpoint `/ws` (shifted by `--base-path`). **First byte of every
message is the command.** From `src/server.h`:

```c
// client -> server
#define INPUT           '0'   // '0' + raw bytes to the PTY
#define RESIZE_TERMINAL '1'   // '1' + {"columns":N,"rows":M}
#define PAUSE           '2'   // flow control
#define RESUME          '3'
#define JSON_DATA       '{'   // init/auth: {"AuthToken":"...","columns":N,"rows":M}

// server -> client
#define OUTPUT           '0'  // '0' + raw PTY bytes
#define SET_WINDOW_TITLE '1'  // '1' + title string
#define SET_PREFERENCES  '2'  // '2' + JSON from repeated -t key=value flags
```

On connect the server sends `SET_WINDOW_TITLE` then `SET_PREFERENCES` (`initial_cmds` in
`protocol.c`). Auth is checked on the first `JSON_DATA` message; every other command is
rejected until authenticated.

**This is trivially reimplementable.** A custom client needs ~30 lines: open the WS,
send a `{...}` init frame, `'0'+text` on keypress, `'1'+{"columns","rows"}` on resize,
and feed `'0'`-prefixed frames into the terminal. No ttyd JS is required.

## The `--index` constraint (the important part)

`-I, --index <path>` swaps the served document via `lws_serve_http_file`. But look at
the HTTP handler in `src/http.c`:

```c
if (strcmp(pss->path, endpoints.token) == 0) { ... }   // /token
if (strcmp(pss->path, endpoints.parent) == 0) { ... }  // base-path -> redirect to index
if (strcmp(pss->path, endpoints.index) != 0) {         // everything else: rejected
```

**ttyd serves exactly one document plus `/token`.** There is no static file tree. So:

- A custom client must be **one self-contained HTML file** — all CSS and JS inline, fonts
  and icons as `data:` URIs. (This is what ttyd itself does: `html/template.html` +
  webpack inlines the bundle into `html.h`.)
- **No `manifest.json`, no `sw.js` at a real URL.** Consequences to verify:
  - iOS add-to-home-screen works off `<meta name="apple-mobile-web-app-capable">` alone,
    so basic A2HS is probably fine.
  - Android/Chrome install prompt wants a manifest. `<link rel="manifest" href="data:...">`
    is unreliable-to-unsupported.
  - **Service workers cannot be registered from `data:` or `blob:` URLs, full stop.** So
    no offline shell, no background reconnect, no push. If PWA behavior matters, `--index`
    alone cannot do it.
- Gzip: the built-in index is gzipped when the client accepts it; a `--index` file is
  served raw by `lws_serve_http_file`. A large inlined single-file client ships
  uncompressed unless something in front compresses it.

## What ttyd does not give you regardless of the client

- **No scrollback replay on reconnect.** Reconnecting yields a blank terminal until the
  TUI happens to repaint. On a phone (screen lock, network switch, tab eviction) this is
  the dominant failure mode. This is *the* reason every mobile project in the survey runs
  tmux underneath — reattach forces a full redraw.
- **No session persistence or session list.** One process, one connection.
- **No server-side awareness of tmux.** No pane layout, no window list, no copy-mode
  driving — webtmux had to extend the protocol to get these.

## Practical takeaway

| Want | Enough? |
|---|---|
| Custom key bar, gestures, font/grid controls, scroll buttons, layout | ✅ `ttyd --index custom.html` |
| PWA install + offline + service worker | ❌ needs a real static server |
| Survive disconnects with intact screen | ❌ needs tmux (or a server-side replay buffer) |
| Session list / tmux pane UI / multi-session | ❌ needs a sidecar or a fork |

`ttyd -W -t disableLeaveAlert=true --index custom.html tmux new -A -s pi pi` covers
surprisingly much of the goal. The moment PWA or session management is wanted, a sidecar
that serves static assets and reverse-proxies `/ws` to ttyd is the next step — and at
that point writing the PTY layer directly (`node-pty` is ~20 lines) removes a process
without adding much work.
</content>
