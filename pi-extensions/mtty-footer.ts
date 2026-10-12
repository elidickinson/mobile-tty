// Show when pi is running through mobile-tty and report its active model for the status strip.
//
// pi truncates its footer to the terminal width as it renders, so at phone
// width everything past column ~50 was never written to the PTY and no client
// can recover it from the stream. This extension reports the one thing the
// strip wants -- the active model and its thinking level -- and whether
// background subagents are running, which pi's own status does not cover, to
// the socket named by $MTTY_FOOTER, which the mobile-tty server opens for the
// pi it spawns and relays to its clients.
//
// Inert without $MTTY_FOOTER, so installing it globally costs nothing outside
// mobile-tty. A report is one connection carrying one JSON object and closing
// behind it, so there is no framing to keep straight and no half-reported state
// for anyone to read; unchanged state is not reported at all.
//
//   { "provider": "anthropic", "id": "claude-opus-5", "thinking": "max", "subagents": false }
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect } from "node:net";

// pi-subagents' in-process registry is the one surface that answers "is any
// subagent still running", nested ones included. Absent without pi-subagents.
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const SUBAGENT_POLL_MS = 1000;

// Third-party code behind an undocumented slot, called from a timer: a throw
// would take pi down, so one counts as nothing running.
function subagentsRunning(): boolean {
  try {
    return (globalThis as any)[SUBAGENT_MANAGER_KEY]?.hasRunning?.() === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const out = process.env.MTTY_FOOTER;
  if (!out) return;

  let last = "";
  let model = {};
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
  // a ctx kept past its event is stale.
  const write = (ctx?: any, subagents = subagentsRunning()) => {
    if (ctx) model = modelOf(ctx);
    const line = JSON.stringify({ ...model, subagents });
    if (line === last) return;
    // A report is remembered only once it has been taken, so one that failed is
    // free to be sent again on the next change instead of being skipped as a
    // repeat. The error is the report's and not the session's: an extension
    // must not disturb the pi it was installed for over a status line, and
    // connect() can throw as well as emit.
    try {
      const sock = connect(out);
      sock.on("error", () => {});
      sock.on("close", (hadError) => { if (!hadError) last = line; });
      sock.end(`${line}\n`);
    } catch {}
  };

  // Only the TUI session reports for this pi. pi-subagents binds extensions
  // into its in-process subagent sessions too, in print mode, and those would
  // otherwise put the subagent's model on the strip.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("mobile-tty", ctx.ui.theme.fg("accent", "mobile-tty"));
    write(ctx);
    poll ??= setInterval(() => write(), SUBAGENT_POLL_MS);
    poll.unref();
  });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode === "tui") write(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.mode === "tui") write(ctx);
  });
  // The poll stops with the session, so its last word must not be that
  // subagents are running: nothing would come along to take it back.
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    clearInterval(poll);
    poll = undefined;
    write(undefined, false);
  });
}
