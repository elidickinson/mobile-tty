# Measured numbers

iPhone, screen **402×874 pt @3x**, iOS 2026-08-10, via `probe/`. Cell at 13px monospace:
**8.04 × 15.00 pt**.

## Viewport and grid

| Context | innerH | visualH | keyboard | grid @13px |
|---|---|---|---|---|
| Safari portrait, kb down | 714 | 714 | 0 | 50 × 47 |
| Safari portrait, **kb up** | 714 | 404 | 310 | 50 × 26 |
| Standalone portrait, kb down | 812 | 812 | 0 | 50 × 54 |
| Standalone portrait, **kb up** | 812 | 498 | 314 | **50 × 33** |
| Standalone landscape, kb down | 402 | 402 | 0 | **108 × 26** |

- Safari chrome costs **160 pt** (874 → 714).
- Standalone status inset costs **62 pt** (874 → 812), so standalone is worth **+7 rows**.
- Keyboard costs **310–314 pt** ≈ 21 rows.
- At 11px instead of 13px: 59 cols (31 rows kb-up in Safari).
- Landscape trades rows for cols almost exactly: **108 cols**, near-desktop.

## Safe-area insets

| Context | top / bottom |
|---|---|
| Safari | 0 / 0 |
| Standalone portrait | 62 / 34 |
| Standalone landscape | 0 / 20 |

## Transients — debounce, never hardcode

`innerHeight` observed at **874, 812, 402** during rotation; keyboard at **237, 310, 314**.
Settles ~1 s. `visualViewport.offsetTop` stayed 0 throughout.

## Target apps (under tmux)

**They behave oppositely, and the client must handle both.**

| Property | pi 0.84.1 | Claude Code v2.1.226 |
|---|---|---|
| Alternate screen buffer | **No** | **Yes** |
| Client scrollback | Real (61 lines) | **None** (alt screen) |
| Mouse reporting | None | **SGR** (`mouse_any` + `mouse_sgr`) |
| Own paging | — | Handles **PgUp/PgDn**, and says so |
| Bottom block @50×15 | **5–6 of 15 rows** (box 3, cwd 1, status 1, spacer) | **5 of 15 rows** (box 3, blank, status) |
| SIGWINCH | Reflows and **fully repaints** | Reflows |
| Renders correctly at | 50×30, 120×40, 160×50 | 50×15 upward |

Claude Code enters the alternate screen only once past its trust prompt.

Full repaint on resize means a **resize nudge (N−1 → N) forces a redraw** — a free,
app-agnostic reconnect repaint.

## Accepted constants

- **Nub:** dead zone 14 px; `v = sign(d) · min(((|d|−14)/14)^1.6 · gain, 45)` px/frame;
  **gain 1.0**.
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

`'1'` carries `{"columns":N,"rows":M}`; `'{'` carries
`{"AuthToken":"…","columns":N,"rows":M}` and must arrive before anything else when auth is
enabled. On connect the server sends `SET_WINDOW_TITLE` then `SET_PREFERENCES`.

`--index` serves **one document** (plus `/token`); every other path is rejected. Files
served via `--index` skip ttyd's gzip path.
