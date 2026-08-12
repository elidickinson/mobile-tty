# Measured numbers

iPhone, screen **402×874 pt @3x**, iOS 2026-08-10. Read live from the `≡` menu.

## Viewport and grid

| Context | innerH | visualH | keyboard | grid @13px |
|---|---|---|---|---|
| Safari portrait, kb down | 714 | 714 | 0 | 50 × 47 |
| Safari portrait, **kb up** | 714 | 404 | 310 | 50 × 26 |
| Standalone portrait, kb down | 812 | 812 | 0 | 50 × 54 |
| Standalone portrait, **kb up** | 812 | 498 | 314 | **50 × 33** |
| Standalone landscape, kb down | 402 | 402 | 0 | **93 × 22** |

- Safari chrome costs **160 pt**; the standalone status inset costs **62 pt**, so
  standalone is worth **+7 rows**. Keyboard costs **310–314 pt** ≈ 21 rows.
- Landscape trades rows for cols: **93**, against portrait's 50. The glass is 874 pt wide
  but iOS reports a 62 pt inset on **both** sides, so only 750 is usable — 15 columns go to
  the notch, and there is no way to tell which side it is actually on.
- Safe-area insets — Safari 0/0/0/0, standalone portrait **t62 b34**, landscape
  **r62 b20 l62**, all measured under `black-translucent`. Standalone now uses an opaque
  status bar (`black`) instead: iOS places the app below it directly rather than
  overlapping and shrinking the layout viewport, so the top inset should read **0**. The
  portrait/landscape rows above need a fresh on-device read to confirm.
- `innerHeight` seen at **874, 812, 402** mid-rotation, keyboard at **237, 310, 314**.
  Settles ~1 s: debounce, never hardcode.

## Session managers (measured through the client)

| Stack | Alt screen | Client scrollback | Survives reconnect |
|---|---|---|---|
| `ttyd pi` | No | Real | **No** — ttyd kills the child |
| `ttyd tmux new -A pi` | **Yes** (`\e[?1049h`) | **0** | Yes |
| `ttyd dtach -A -r winch pi` | **No** | **Real** | **Yes**, and lossy |
| our server | **No** | **Real** | **Yes** |

dtach loses bytes: its master abandons the unwritten tail of a 4096-byte read when a client
socket returns `EAGAIN`. Under a resize storm with three viewers, 9.3 MB across 55,989 gaps.

## pi's rendering (measured)

- **Full-screen clears emitted on its own:** none. Only in response to SIGWINCH.
- **Absolute cursor positioning:** none. It renders relatively (`ESC[nA`, `ESC[nG`, `\r\n`).
- **Cost of one SIGWINCH:** a re-render of the entire transcript — 12 KB after one turn,
  +3.3 KB per trivial turn, linear.
- **Streaming amplification:** 176 KB of frames for 360 bytes of content.
- **Startup preamble, emitted once and never repeated:** `ESC[?2004h` (bracketed paste),
  `ESC[>7u` (kitty keyboard), the title, and the capability queries `ESC[c`, `ESC[?u`,
  `ESC[16t`. A snapshot has to carry it or keys come back differently encoded.

## Target apps

| Property | pi 0.84.1 | Claude Code v2.1.226 |
|---|---|---|
| Alternate screen | No | **Yes** |
| Client scrollback | Real | **None** |
| Mouse reporting | None | **SGR** |
| Own paging | **None** — answers PageUp with `\e[1G\e[?25l` | Handles PgUp/PgDn |
| Bottom block @50×15 | 5–6 of 15 rows | 5 of 15 rows |
| SIGWINCH | Reflows and repaints | Reflows |

They behave oppositely. v1 targets pi; alternate-screen support is deferred.

## Constants

- **Cell at 13px:** **8.04 × 15 pt on device**, 7.83 × 16 in headless WebKit. Measured at
  runtime, never assumed — at 402 pt wide that is the difference between 50 and 51 columns.
- **Key bar:** 44 pt, plus the bottom inset when the keyboard is down.
- **Resize coalescing:** 100 ms, so a viewer flapping its size cannot make pi re-render its
  transcript repeatedly.
- **Viewer backlog cap:** 4 MB of `bufferedAmount`, then that viewer is disconnected. It is
  never sent a gap.
- **Smallest shared grid:** 20x8, so no viewer can shrink everyone to nothing.
- **Snapshot scrollback:** 500 lines by default, about 37 KB — roughly 75 bytes a line. pi
  cannot page itself, so this is the only history a reloaded page gets. Tune it with
  `--scrollback N` or `$MTTY_SCROLLBACK`.
- **Keyboard detection:** ≥100 pt of lost viewport, so collapsing browser chrome does not
  read as a keyboard.
- **Autocorrect:** 0 `insertReplacementText` events over 7 typed chars.

## Wire protocol

WebSocket subprotocol `tty`, endpoint `/ws`. First byte of every message is the command.

```
client -> server            server -> client
INPUT    '0'                OUTPUT     '0'
RESIZE   '1'                SET_TITLE  '1'
                            SET_SIZE   '3'
```

`RESIZE` and `SET_SIZE` carry `{"columns":N,"rows":M}`. The handshake is a bare
`{"AuthToken":"…","columns":N,"rows":M}` with no command byte and must arrive first.

`SET_SIZE` is the grid the PTY actually has, which is not always the one a viewer asked
for: the narrowest viewer wins and the rest render at its size.
