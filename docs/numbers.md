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
  **r62 b20 l62**. The top inset is already excluded from the layout viewport; the others
  are not.
- `innerHeight` seen at **874, 812, 402** mid-rotation, keyboard at **237, 310, 314**.
  Settles ~1 s: debounce, never hardcode.

## Session managers (measured through the client)

| Stack | Alt screen | Client scrollback | Survives reconnect |
|---|---|---|---|
| `ttyd pi` | No | Real | **No** — ttyd kills the child |
| `ttyd tmux new -A pi` | **Yes** (`\e[?1049h`) | **0** | Yes |
| `ttyd dtach -A -r winch pi` | **No** | **Real** | **Yes** |

tmux 3.7b takes the outer alternate screen unconditionally; `alternate-screen off`,
`terminal-overrides ',*:smcup@:rmcup@'` and `terminal-features ',*:-alternatescreen'` all
leave `\e[?1049h` in the stream.

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
- **Reconnect nudge gap:** 120 ms. Zero gap does not repaint.
- **Keyboard detection:** ≥100 pt of lost viewport, so collapsing browser chrome does not
  read as a keyboard.
- **Autocorrect:** 0 `insertReplacementText` events over 7 typed chars.

## ttyd protocol

WebSocket subprotocol `tty`, endpoint `/ws`. First byte of every message is the command.

```c
// client -> server                  // server -> client
#define INPUT           '0'          #define OUTPUT           '0'
#define RESIZE_TERMINAL '1'          #define SET_WINDOW_TITLE '1'
#define PAUSE           '2'          #define SET_PREFERENCES  '2'
#define RESUME          '3'
#define JSON_DATA       '{'
```

`'1'` carries `{"columns":N,"rows":M}`; `'{'` carries `{"AuthToken":"…","columns":N,"rows":M}`
and must arrive first. `--index` serves **one document** (plus `/token`) and skips ttyd's
gzip path.
