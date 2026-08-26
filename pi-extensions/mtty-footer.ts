// The status-strip capture: the active model, for mobile-tty.
//
// pi truncates its footer to the terminal width as it renders, so at phone
// width everything past column ~50 was never written to the PTY and no client
// can recover it from the stream. This extension writes the one thing the strip
// wants — the active model and its thinking level — to the file named by
// $MTTY_FOOTER, which the mobile-tty server sets for the pi it spawns and
// relays to its clients.
//
// Inert without $MTTY_FOOTER, so installing it globally costs nothing outside
// mobile-tty. Writes are atomic (write-then-rename) and skipped when nothing
// changed, so the server's poller never sees a half-written line.
//
//   { "ts": 1712345678901, "text": "anthropic/claude-opus-5 - max" }
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renameSync, writeFileSync } from "node:fs";

// Only these events can change the line: the model itself, its thinking level,
// and the first write at startup.
const EVENTS = ["session_start", "model_select", "thinking_level_select"] as const;

export default function (pi: ExtensionAPI) {
  const out = process.env.MTTY_FOOTER;
  if (!out) return;

  let last = "";

  const snapshot = (ctx: any): string => {
    const model = ctx.model;
    if (!model) return "no-model";
    const thinking = model.reasoning ? ` - ${ctx.thinkingLevel ?? "off"}` : "";
    return `${model.provider}/${model.id}${thinking}`;
  };

  const write = (ctx: any) => {
    const text = snapshot(ctx);
    if (text === last) return;
    last = text;
    writeFileSync(`${out}.tmp`, JSON.stringify({ ts: Date.now(), text }));
    renameSync(`${out}.tmp`, out);
  };

  for (const event of EVENTS) pi.on(event as "session_start", (_event, ctx) => write(ctx));
}
