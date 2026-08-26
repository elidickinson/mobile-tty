# Real-pi tests

The bulk suite runs against `tests/fixtures/fake-pi.js`; these put the real interactive pi behind the real server and prove the whole stack -- PTY bytes, SIGWINCH redraw, mirror, WebSocket protocol, wterm -- survives a resize with viewers attached.

Run with `npm run test:real-pi`. Uses port 0 and never touches 7681; teardown kills the scratch pi. Needs a POSIX host (SIGSTOP/SIGCONT/ps).

## The suite

- `resize-reconnect.test.js` -- history order and count through an 80-to-50 shrink; an attached viewer equals a viewer admitted after the resize, both before and after pi's redraw.

A browser-level counterpart (Playwright through `src/app.js`: reload, reconnect, compare history digests) was planned to replace the overlapping checks in `tests/smoke/real-pi.spec.js`; not written yet.

## How it draws without an agent turn

pi is launched as

```
pi -ne --offline --no-session --no-builtin-tools --no-skills \
  --no-prompt-templates --no-themes --no-context-files --no-approve \
  -e tests/real-pi/fixture-extension.ts
```

`fixture-extension.ts` registers a `/mtty-fixture` slash command backed by `pi.appendEntry()` and `pi.registerEntryRenderer()`. Slash commands run before agent processing, and custom entries render in the transcript without entering the LLM context -- so the transcript gets real TUI bytes through pi's own renderer with no provider turn. The alternatives lose: prompting a model to call a tool adds cost and nondeterminism; a plain `process.stdout.write` from the extension bypasses pi's renderer.

pi has no draw-complete hook, so the test waits for markers in real wterm cells plus 300 ms of quiet output.

To hit the exact resize boundary, the test SIGSTOPs its scratch pi after the 80-column fixture is drawn, shrinks to 50, admits the late viewer while pi's redraw is pending, SIGCONTs, and compares viewers again.

## What is verified vs assumed

Verified on pi 0.84.1: 5/5 consecutive passes, and the same test against the pre-fix tree fails at attached-vs-late history equality, so it catches the regression it guards. Zero token use is inferred (nothing model-backed is reachable under these flags), not network-audited. Remaining hazards: pi's startup and render scheduling, pi chrome changes.
