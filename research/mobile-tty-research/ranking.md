# Ranking: what to actually borrow

Judged against mobile-tty's real pain, not generic terminal-UX merit. Effort S/M/L, risk
low/med/high, and the one check that comes first.

## Ranked

**1. Macro keys for pi actions** — S / low. Survey #3, promoted.
`/compact`, `/clear`, `esc`, `^C` are 8–10 taps on glass hiding the screen. `BAR` is already
a declarative array, so a macro is one more field (`send: '/compact\r'`). Skip Termux's
swipe-up popup and the config file: put macros in the `≡` sheet, which already exists and
costs no bar real estate or new gesture. Hardcode four; do not build a customization
surface. *First step:* list the four pi actions you actually retype on the phone.

**2. Disconnect telltale, and decide the queued-input policy** — S / low. Survey #6, promoted.
Connection state is only visible if you open `≡`. Worse, `transport.js:82` queues keystrokes
while down and flushes them on attach — into a pi that has moved on. That is a correctness
bug, not a polish item, and the survey missed it. Show a banner; decide whether the queue
flushes or drops. *First step:* pull the plug mid-typing and watch where the bytes land.

**3. dtach-rev replay buffer** — M / high. Survey #1, demoted.
The only thing that restores *scrollback* lost while detached, and the nudge cannot. But:
the repo is real and 0 stars, single author, untouched for five months, and it is the
process holding your session. And it does not solve the duplicate problem — reconnect after
a 5 s blip re-appends 256 KB you already have, while the OSC markers' clear-before-replay
throws away the deeper local history you had. Pick one policy ("scrollback *is* the server
buffer") and accept the cap. *First step:* build it, hold a real pi session for a week, and
confirm replay-then-nudge lands in a correct state.

**4. PAUSE/RESUME flow control** — S / med. Survey #2, held with a gate.
Free in the protocol, but wterm's `write()` returns `void` (`wterm.d.ts:51`) — no completion
callback, so there is no true backpressure signal and you would invent a proxy. Classic
"out of scope until there is evidence." *First step:* `cat` a huge file and see whether the
phone actually wedges. If it doesn't, close this.

**5. Find in scrollback** — M / med. Survey #5, demoted; its premise is wrong.
Native find-in-page does not exist in standalone mode, which is the mode this app runs in
(+7 rows). So "zero code" is not on the table. The good news: wterm keeps *every* scrollback
row as real DOM (`renderer.js:369`), not virtualized, so a homegrown search is
`querySelectorAll('.term-row')` + textContent + scrollIntoView — genuinely small. *First
step:* confirm standalone has no find UI, then decide if you want it enough to own it.

**6. Key-event log in `≡`** — S / low. Survey #7, held.
Little standalone value; it is the instrument you need for the open dictation question.
Build it when you test dictation, not before.

**7. Tap-to-position cursor via OSC 133** — L / high. Survey #9, held at the bottom.
pi emits the markers, but this is client-side OSC parsing plus synthetic arrows for a few
lines of input box. Defer.

### Not worth it

- **Blink long-press-to-lock modifiers** (survey #4) — no evidence anyone needs a *locked*
  Ctrl in pi; adds a gesture and a third state to win an A/B nobody asked for.
- **OSC 52 clipboard** (survey #10) — native selection handles already cover copy, and
  Safari gates the rest. No evidence pi even emits it.
- **CSI 2026** (survey #8) — **already done**: wterm implements synchronized output with a
  1000 ms timeout fallback (`wterm.js:213`), and renders on a debounce + rAF regardless.
  Nothing to check, nothing to build.
- **Tap-to-open URLs** — opt-in config surface for a gesture long-press already handles.
- **Termux swipe-up popup keys, a-Shell swipe-to-key** — second gestures on a surface where
  scroll arbitration is already settled. Don't reopen it.
- **Mosh / tmux -CC / ET / shpool** — the survey is right, and for the right reasons.

## Build order

1. Probe day, no code: flood test (#4), standalone find-in-page (#5), disconnect-mid-typing
   (#2). Three of the seven items resolve or die here.
2. Macros in `≡` (#1) — the biggest daily win per line of code.
3. Disconnect banner + queue policy (#2).
4. dtach-rev on a throwaway session in parallel with the above; promote only if it survives a
   week. Never make it the default before that.
5. Whatever the probes proved you need — and nothing else.

**Do not:** add a config file or key-bar customization; add a second bar row; touch flow
control before seeing a wedge; build search before confirming standalone has no find; adopt
dtach-rev on faith; write any OSC 133 code this quarter.

## Where I disagree with the survey

- Its #1 (dtach-rev) is ranked on payoff with the maintenance risk in a footnote, and it
  never notices that replay *duplicates* scrollback on a short blip — the common case on a
  phone.
- Its #5 (find) assumes native find-in-page is available. Standalone mode has no browser
  chrome. The workaround is easier than the survey thinks, but it is not free.
- Its #8 (CSI 2026) was answerable in `node_modules` rather than on a device.
- Its #4 (Blink modifiers) is an A/B with no hypothesis; macros are the input win.
- It missed the queued-input-on-reconnect hazard, which is the only actual bug on this list.
