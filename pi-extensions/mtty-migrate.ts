// Move the conversation this pi is running to mobile-tty, in one command.
//
// `/mtty-migrate` hands the conversation to a running mobile-tty server, which
// spawns a supervised pi that resumes the same transcript, and then ends this
// pi. The phone can join it from that moment; the desktop terminal is back at
// its shell, with the command to follow it printed below pi's own resume hint.
//
// Inert when pi already runs under mobile-tty ($MTTY_IDENTITY set): that
// conversation is already on the map, and exiting would only end it.
//
// The server side is the supervisor's `POST /migrate` route, which reuses
// `registry.ensure` -- the same call a phone tap on a saved conversation makes.
// A conversation the server does not list (no transcript yet) is refused, so
// /mtty-migrate never exits pi into nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";

// The supervisor's own defaults: loopback, port 7681, opt-in password. The
// extension runs wherever pi does, so its environment is the one source for
// all three, and origin is not sent -- the server exempts non-browsers.
const serverUrl = () => {
  const port = process.env.MTTY_PORT || "7681";
  return `http://127.0.0.1:${port}`;
};

// The same login the CLI does (server/control.js): form post, first cookie,
// branch for "password set but refused" so the notify can say login refused.
const cookieFor = async (url: string): Promise<string | null | false> => {
  const password = process.env.MTTY_PASSWORD;
  if (!password) return undefined as string | null | false;
  const response = await fetch(new URL("/login", url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  }).catch(() => null);
  if (!response) return null;
  const [cookie] = response.headers.getSetCookie();
  if (!cookie) return false;
  return cookie.split(";")[0];
};

export default function (pi: ExtensionAPI) {
  // The session this pi had open when the command ran. Nothing prints unless
  // a migration actually happened, so the shutdown banner stays honest.
  let migrated: string | null = null;

  pi.registerCommand("mtty-migrate", {
    description: "Move this conversation to mobile-tty and end this pi",
    handler: async (_args, ctx) => {
      if (process.env.MTTY_IDENTITY) {
        ctx.ui.notify("This conversation is already on mobile-tty", "warning");
        return;
      }
      const file = ctx.sessionManager.getSessionFile();
      // Pi mints the transcript file with its first assistant message; until
      // then there is nothing on disk for the server to open.
      if (!file || !existsSync(file)) {
        ctx.ui.notify("Nothing to migrate: this conversation has nothing saved yet", "warning");
        return;
      }
      const id = ctx.sessionManager.getSessionId();
      const cwd = await realpath(ctx.sessionManager.getCwd());

      // A turn in flight is still writing the transcript; the supervised copy
      // must not open it until this pi is done with it.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Finishing this turn, then migrating");
        await ctx.waitForIdle();
      }

      const url = serverUrl();
      const cookie = await cookieFor(url);
      // false: password set but refused. null: no server answered.
      if (cookie === false) {
        ctx.ui.notify("mobile-tty refused $MTTY_PASSWORD", "error");
        return;
      }
      const response = await fetch(new URL("/migrate", url), {
        method: "POST",
        headers: cookie ? { cookie } : undefined,
        body: JSON.stringify({ id, cwd }),
      }).catch(() => null);
      if (!response) {
        ctx.ui.notify(`mobile-tty is not answering on ${url} — start it with: mobile-tty serve`, "error");
        return;
      }
      if (!response.ok) {
        ctx.ui.notify(`mobile-tty refused the migration (HTTP ${response.status})`, "error");
        return;
      }

      migrated = id;
      // Shutdown waits for any pending work; the transcript is already
      // complete, so the supervised copy that opened moments ago is the
      // conversation's only owner from here.
      ctx.ui.notify("Migrating to mobile-tty");
      ctx.shutdown();
    },
  });

  // Fires inside pi's interactive shutdown, after the TUI has stopped and the
  // terminal is restored, right where pi prints "To resume this session: ..." —
  // so the hint lands in clean scrollback above the shell prompt that follows.
  pi.on("session_shutdown", event => {
    if (event.reason !== "quit" || !migrated) return;
    const prefix = migrated.slice(0, 8);
    process.stdout.write(`To follow on this machine:  mobile-tty attach ${prefix}\n`);
  });
}
