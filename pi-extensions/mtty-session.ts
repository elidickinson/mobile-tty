// Report the conversation currently open in this pi process. The PTY keeps its
// own identity when /new or /resume replaces the conversation inside it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The canonical transcript path.
 *
 * Pi mints the file and writes its header with the first entry, so at
 * session_start the file itself may not exist yet — the folder it will live in
 * does, and that is what realpath has to resolve. The file is never a symlink,
 * so the folder's real path plus the name is what realpath would answer.
 */
const canonical = (file: string) => join(realpathSync(dirname(file)), basename(file));

export default function (pi: ExtensionAPI) {
  const out = process.env.MTTY_IDENTITY;
  if (!out) return;

  // A transcript another supervised terminal has open is not openable here.
  // Two writers on one transcript are tolerated — pi appends, and this is not
  // worth a lock — but a silent second owner would be a surprise, so the
  // switch is refused rather than the two of them interleaving.
  //
  // Only /resume carries a target; /new has no file yet to collide over.
  pi.on("session_before_switch", (event, ctx) => {
    if (!event.targetSessionFile) return;
    const target = realpathSync(event.targetSessionFile);
    for (const name of readdirSync(dirname(out))) {
      const other = join(dirname(out), name);
      if (!name.endsWith(".identity") || other === out) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(other, "utf8"));
      } catch (err) {
        // A sibling that exited between the listing and this read.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (state.file !== target) continue;
      ctx.ui.notify("That conversation is already open in another terminal", "warning");
      return { cancel: true };
    }
  });

  pi.on("session_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const state = {
      id: ctx.sessionManager.getSessionId(),
      cwd: realpathSync(ctx.sessionManager.getCwd()),
      file: file ? canonical(file) : undefined,
      at: Date.now(),
    };
    writeFileSync(`${out}.tmp`, JSON.stringify(state));
    renameSync(`${out}.tmp`, out);
  });
}
