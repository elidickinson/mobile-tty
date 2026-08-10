# mobile-tty

Notes and (eventually) code for a **TUI-friendly mobile web terminal** — a browser client
for driving full-screen terminal apps (pi.dev's TUI in particular) from a phone over a
WebSocket-attached PTY.

This is deliberately a level *below* [pi-phone](../pi-phone) / Happy / Omnara. Those
replace the TUI with a bespoke chat UI. This one keeps the real terminal and fixes the
*mobile terminal* instead — so it works for pi.dev, but equally for vim, htop, lazygit,
or anything else.

## The gap being targeted

Existing web terminals (ttyd, GoTTY, wetty) are desktop tools that happen to load on a
phone. Missing:

- **Flexible screen sizing** — decouple PTY grid size from rendered size; pinch/pan a
  large grid rather than being stuck with a 40x20 terminal.
- **Permanent or semi-permanent on-screen keyboard** — not the OS keyboard eating half
  the viewport, with real modifier support.
- **Scroll affordances** — scrollback drag, PageUp/PageDown, Home/End, jump-to-bottom.
- **Reconnect that isn't a blank screen** — phones lock, switch networks, background tabs.

## Status

Research only. See `docs/`.

- [`docs/landscape.md`](docs/landscape.md) — comprehensive survey of what exists
- [`docs/ttyd-notes.md`](docs/ttyd-notes.md) — ttyd protocol + what `--index` can and can't do
- [`docs/design-notes.md`](docs/design-notes.md) — patterns worth stealing, open problems, build options
- [`docs/ux-principles.md`](docs/ux-principles.md) — UX-first derivation of the architecture
