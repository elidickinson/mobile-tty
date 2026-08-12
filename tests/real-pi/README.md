# Real-pi test prototype

Pi citations below are relative to `/Users/esd/projects/pi-my-stuff`.

## Recommendation

Use the real interactive binary with one explicit test extension:

```text
pi -ne --offline --no-session --no-builtin-tools --no-skills \
  --no-prompt-templates --no-themes --no-context-files --no-approve \
  -e tests/real-pi/fixture-extension.ts
```

The cookbook shows the custom-tool contract at `docs/extension-cookbook.md:22-44`; the canonical type is blunt: a registered tool is callable by the LLM (`reference-code/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1250-1253`). There is no public test-side tool invocation. Prompting a model to choose the tool would add cost and nondeterminism, while direct `process.stdout.write()` would bypass Pi's renderer.

Instead, expose a slash command backed by `pi.appendEntry()` and `pi.registerEntryRenderer()`. Commands run before agent processing (`agent-session.ts:1122-1129`) and call their handler directly (`agent-session.ts:1276-1292`). Custom entries stay out of LLM context but render in the transcript (`docs/extensions.md:1440-1445`). This retains the real Pi TUI, PTY bytes, SIGWINCH redraw, mirror, WebSocket protocol, and wterm parser without a provider turn.

The alternatives are worse. Pi evals are model-backed (`packages/evals/README.md:1-5`), require a model (`packages/evals/src/pi-harness.ts:117-120`), call `session.prompt()` (`pi-harness.ts:90-94`), and start extension-free (`pi-harness.ts:165-168`). The internal `createCodingAgentHarness()` can call tool objects directly (`packages/coding-agent/src/server/create-harness.ts:78-158`; `test/server/create-harness.test.ts:148-153`) but has no interactive TUI/PTY/WebSocket/VT stack. `session-backends/sqlite-node` is only persistence/search (`packages/session-backends/sqlite-node/README.md:1-5`).

## Validated registration

Pi 0.84.1 loaded this exact registration:

```ts
pi.registerEntryRenderer<FixtureEntry>(ENTRY_TYPE, (entry) => {
  if (!entry.data) throw new Error("fixture entry has no data");
  return new Text(entry.data.lines.join("\n"), 0, 0);
});

pi.registerTool({
  name: "mtty_fixture",
  label: "Mobile TTY Fixture",
  description: "Render the deterministic mobile-tty terminal fixture",
  parameters: Type.Object({}),
  async execute() {
    appendFixture();
    return {
      content: [{ type: "text", text: `MTTY_FIXTURE_TOOL_ACK lines=${LINE_COUNT}` }],
      details: { lines: LINE_COUNT },
    };
  },
});

pi.registerCommand("mtty-fixture", {
  description: "Render deterministic terminal history without an agent turn",
  async handler() { appendFixture(); },
});
```

The prototype invokes `/mtty-fixture`, not the LLM tool lifecycle. The cookbook documents `session_start` as lifecycle only (`docs/extension-cookbook.md:250-258`). Pi appends an `entry_appended` event (`agent-session.ts:2385-2389`), InteractiveMode requests a render (`interactive-mode.ts:3072-3076`), and TUI defers it to a later tick/timer (`packages/tui/src/tui.ts:765-816`); there is no draw-complete hook. The test therefore waits for markers in real wterm cells plus 300 ms without output.

To expose the exact resize boundary deterministically, the test SIGSTOPs only its scratch Pi after the 80-column fixture is drawn. It shrinks to 50 and admits the late viewer while Pi's SIGWINCH redraw is pending. It then SIGCONTs Pi, waits for the real 50-column redraw and another marker, and compares both viewers again.

## Measured vs inferred

**Measured:** the final prototype passed 5/5 consecutive runs. Extension-ready time was 524-527 ms; test bodies took 2.03-2.09 s. Both viewers matched at 412 mirror-reflowed history rows, then at 301 Pi-redrawn rows, with all 100 records in order. The same test against `e6a789e^` failed at attached-versus-late history equality, proving it catches the regression. All runs used `port: 0`; teardown resumed/killed scratch Pi and removed its temporary agent directory. Port 7681 was not connected to or changed.

**Inferred:** provider token use is zero because non-command input is intercepted, discovery/network startup is disabled, and no agent prompt occurs. This was not network-audited. Remaining dependencies are Pi startup/render scheduling, Pi chrome changes, and a POSIX host with `SIGSTOP`, `SIGCONT`, and `ps`.

## Proposed suite

Keep fake-pi for the bulk suite and add **two real-pi tests total**, behind a separate `test:real-pi` script:

1. `tests/real-pi/resize-reconnect.test.js` -- this node:test prototype: history order/count through 80-to-50 shrink; attached viewer equals a post-resize viewer before and after Pi redraw.
2. `tests/real-pi/browser-reconnect.spec.js` -- one Playwright test through `src/app.js`/`src/transport.js`: shrink, reload/reconnect, then compare the browser core's history digest and visible rows.

The browser test should replace overlapping checks in `tests/smoke/real-pi.spec.js`, not add another similar smoke layer.
