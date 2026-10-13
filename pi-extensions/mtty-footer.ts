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
//
// The state is read from a live context rather than cached from the events that
// mention it: while its session runs, a context is getters over what pi holds
// now, not a snapshot of the event that handed it over, so the poll re-reads it
// and a change that came with no event is still reported. A context stops
// working once pi has replaced its session, and reading one then throws -- from a
// timer that is an uncaughtException -- so reads are guarded and the context goes
// away with the session. Delivery is best effort: a connection that fails is
// retried on the next tick, but a report some receiver discarded without the
// socket failing is not knowable from here.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connect } from "node:net";

// pi-subagents' in-process registry is the one surface that answers "is any
// subagent still running", nested ones included. Absent without pi-subagents.
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
// How often the live state is re-read and the registry re-checked.
const POLL_MS = 1000;
// How long a change waits before it is reported. A session switch fires several
// within one millisecond -- this session's start, another extension carrying the
// model selection across the switch -- and each uncoalesced one can briefly put a
// state on the strip that pi has already moved past.
const COALESCE_MS = 100;

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
  let session: ExtensionContext | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    clearInterval(poll);
    clearTimeout(settle);
    poll = undefined;
    settle = undefined;
  };

  // The facts rather than the line drawn from them: which client shows this and
  // how wide it is, is not this process's business. No model is reported as no
  // model -- an empty id -- rather than not reported at all: a session that
  // starts without one must clear the strip, not leave the last session's model
  // sitting on it.
  const put = (line: string) => {
    if (line === last) return;
    // A report is remembered as soon as it leaves and forgotten if the connection
    // fails, so one that did not get through is retried on the next tick instead
    // of being skipped as a repeat. The error is the report's and not the
    // session's: an extension must not disturb the pi it was installed for over a
    // status line, and connect() can throw as well as emit.
    try {
      const sock = connect(out);
      sock.on("error", () => { if (last === line) last = ""; });
      sock.end(`${line}\n`);
      last = line;
    } catch {}
  };

  const send = (subagents = subagentsRunning()) => {
    if (!session) return;
    let state: Record<string, unknown>;
    try {
      const model = session.model;
      state = {
        provider: model?.provider ?? "",
        id: model?.id ?? "",
        thinking: model?.reasoning ? (session.thinkingLevel ?? "off") : null,
      };
    } catch {
      stop(); // this context is no longer readable, so there is nothing to report
      return;
    }
    put(JSON.stringify({ ...state, subagents }));
  };

  const report = () => {
    clearTimeout(settle);
    // The armed flag has to go when the arm fires: a poll tick that finds one
    // pending stands down, since the pending report carries this state anyway,
    // and one left standing here would have every later tick stand down too.
    settle = setTimeout(() => { settle = undefined; send(); }, COALESCE_MS);
    settle.unref();
  };

  // Only the TUI session reports for this pi. pi-subagents binds extensions into
  // its in-process subagent sessions too, in print mode, and those would
  // otherwise put the subagent's model on the strip.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    session = ctx;
    // Before anything that can throw: a session that lost its report or its poll
    // because drawing a status line went wrong would stay wrong until the model
    // was changed by hand.
    poll ??= setInterval(() => { if (!settle) send(); }, POLL_MS);
    poll.unref();
    report();
    ctx.ui.setStatus("mobile-tty", ctx.ui.theme.fg("accent", "mobile-tty"));
  });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode === "tui") report();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (ctx.mode === "tui") report();
  });
  // The poll stops with the session, so its last word must not be that subagents
  // are running: pi-subagents aborts them during shutdown, and nothing else would
  // come to take the flag back. Only the flag is taken back, by rewriting the line
  // last issued -- the model in it is what the strip was told, and the session
  // replacing this one reports its own. The rewrite relies on this file's own
  // serialization, which puts subagents last, and on a quote inside an id being
  // escaped, so the trailing key cannot be matched by one.
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    if (last.endsWith('"subagents":true}')) put(last.replace(/"subagents":true\}$/, '"subagents":false}'));
    session = undefined;
  });
}
