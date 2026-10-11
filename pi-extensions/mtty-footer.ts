// Show when pi is running through mobile-tty and report its active model for the status strip.
//
// pi truncates its footer to the terminal width as it renders, so at phone
// width everything past column ~50 was never written to the PTY and no client
// can recover it from the stream. This extension reports the one thing the
// strip wants -- the active model and its thinking level -- and whether pi is
// working, which drives the tab markers, to the socket named
// by $MTTY_FOOTER, which the mobile-tty server opens for the pi it spawns and
// relays to its clients.
//
// Inert without $MTTY_FOOTER, so installing it globally costs nothing outside
// mobile-tty. A report is one connection carrying one JSON object and closing
// behind it, so there is no framing to keep straight and no half-reported state
// for anyone to read; unchanged state is not reported at all.
//
//   { "provider": "anthropic", "id": "claude-opus-5", "thinking": "max", "working": false }
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect } from "node:net";

// pi-subagents' in-process registry is the one surface that answers "is any
// subagent still running", nested ones included. Absent without pi-subagents.
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const SUBAGENT_POLL_MS = 1000;

// Third-party code behind an undocumented slot, called from a timer: a throw
// would take pi down, so one counts as nothing running.
function subagentsRunning(): boolean {
  const registry = (globalThis as any)[SUBAGENT_MANAGER_KEY];
  try {
    return registry?.hasRunning?.() === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const out = process.env.MTTY_FOOTER;
  if (!out) return;

  let last = "";
  let model = {};
  let turn = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  // The facts rather than the line drawn from them: which client shows this
  // and how wide it is, is not this process's business. No model is reported as
  // no model -- an empty id -- rather than not reported at all: a session that
  // starts without one must clear the strip, not leave the last session's model
  // sitting on it.
  const modelOf = (ctx: any) => ({
    provider: ctx.model?.provider ?? "",
    id: ctx.model?.id ?? "",
    thinking: ctx.model?.reasoning ? (ctx.thinkingLevel ?? "off") : null,
  });

  // The model is cached rather than the ctx: the poll has none of its own, and
  // a ctx kept past its session is stale.
  const write = (ctx?: any) => {
    if (ctx) model = modelOf(ctx);
    // Background subagents can outlive the main turn, so working is either.
    const line = JSON.stringify({ ...model, working: turn || subagentsRunning() });
    if (line === last) return;
    const sock = connect(out);
    // A report is remembered only once it has been taken, so one that failed is
    // free to be sent again on the next change instead of being skipped as a
    // repeat. The error is the report's and not the session's: an extension
    // must not disturb the pi it was installed for over a status line.
    sock.on("error", () => {});
    sock.on("close", (hadError) => { if (!hadError) last = line; });
    sock.end(`${line}\n`);
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("mobile-tty", ctx.ui.theme.fg("accent", "mobile-tty"));
    write(ctx);
    poll ??= setInterval(() => write(), SUBAGENT_POLL_MS);
    poll.unref();
  });
  pi.on("model_select", (_event, ctx) => write(ctx));
  pi.on("thinking_level_select", (_event, ctx) => write(ctx));
  // In-process subagent sessions bind extensions too, outside the TUI; their
  // turns are counted through the registry, not as this pi's own.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    turn = true;
    write(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    turn = false;
    write(ctx);
  });
  pi.on("session_shutdown", () => {
    clearInterval(poll);
    poll = undefined;
  });
}
