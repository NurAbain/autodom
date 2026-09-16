#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import type { Messenger, OutreachSource } from "./contracts.js";
import { LalafoMessenger } from "./lalafo.js";
import { loginLalafoSession } from "./lalafo-session.js";
import { MashinaMessenger } from "./mashina.js";
import { startOutreachServer } from "./server.js";

const HELP = `Autodom marketplace outreach (independent admin + durable queue)

pnpm outreach serve          Start admin and worker; sends disabled by default
pnpm outreach health         Check local HTTP/DB readiness without credentials
pnpm outreach check-mashina  Read-only authenticated HTTP + websocket check; no messages
pnpm outreach check-lalafo   Read-only authenticated profile + chat check; no messages
pnpm outreach login-lalafo   Establish a private ISP-bound session; no messages

Required for serve:
  AUTODOM_DATABASE_URL                 Existing Autodom catalog PostgreSQL
  AUTODOM_OUTREACH_ADMIN_USER          Admin HTTP Basic username
  AUTODOM_OUTREACH_ADMIN_PASSWORD      8+ characters; prefer a unique generated password
  AUTODOM_OUTREACH_ORIGIN              Exact browser origin, HTTPS behind your reverse proxy
Optional:
  AUTODOM_OUTREACH_HOST                127.0.0.1 by default; keep service private
  AUTODOM_OUTREACH_PORT                8092 by default
  AUTODOM_OUTREACH_SEND_ENABLED        false by default; true permits explicitly started campaigns
  AUTODOM_OUTREACH_MASHINA_SESSION_FILE Private JSON {"accessToken":"..."}, mode 0600
  AUTODOM_OUTREACH_LALAFO_SESSION_FILE  Private Lalafo session JSON, mode 0600

Required only for login-lalafo (never needed in the web admin):
  AUTODOM_OUTREACH_LALAFO_PHONE / AUTODOM_OUTREACH_LALAFO_PASSWORD
  SMARTPROXY_LALAFO_ENDPOINT / SMARTPROXY_LALAFO_USERNAME / SMARTPROXY_LALAFO_PASSWORD
  RISKBYPASS_API_KEY                   Existing clearance provider; capture may consume credit
  AUTODOM_OUTREACH_CHROME_PATH         Local Chrome executable; not bundled in the service image
  AUTODOM_OUTREACH_CHROME_NO_SANDBOX   Optional true only for an isolated trusted runtime
Login uses an isolated temporary browser, writes the session file (not the password),
then removes its browser profile. Run on the operator host and mount the resulting session.

No password, session, or Telegram token belongs in git. An expired session pauses
campaigns; replace the private session file and explicitly resume after inspection.
Mashina uses its observed first-party web protocol, not a documented partner API.
Lalafo uses an ISP-bound browser session; renew it with login-lalafo after expiry,
then explicitly resume. Its photo and text are two messages; partial delivery is unknown.
Cold offers can violate platform rules and cause account bans; slow sending is not
permission. Admin must confirm each campaign. Source-wide pacing, seller dedup and
suppression persist in autodom_outreach schema. Existing catalog is read-only.
Pause/cancel prevents new sends; already in-flight sends may finish. Unknown outcomes
are never retried automatically. Service performs no real sends during checks.
`;

export async function main(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  process.umask(0o077);
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    console.log(HELP);
    return 0;
  }
  const command = argv[0] ?? "serve";
  if (
    argv.length > 1 ||
    !["serve", "health", "check-mashina", "check-lalafo", "login-lalafo"].includes(command)
  ) {
    console.error(HELP);
    return 2;
  }
  let pool: pg.Pool | undefined;
  try {
    if (command === "login-lalafo") {
      const path = env.AUTODOM_OUTREACH_LALAFO_SESSION_FILE;
      if (!path) throw new Error("Configure private Lalafo session path");
      await loginLalafoSession(path, env);
      console.log(JSON.stringify({ source: "lalafo.kg", sessionSaved: true, messagesSent: 0 }));
      return 0;
    }
    const port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.AUTODOM_OUTREACH_PORT ?? "8092");
    const host = env.AUTODOM_OUTREACH_HOST ?? "127.0.0.1";
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error("Invalid bind host");
    if (command === "health") {
      const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host;
      const response = await fetch(`http://${probeHost}:${port}/health`, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      return response.ok ? 0 : 1;
    }
    const messengers = new Map<OutreachSource, Messenger>();
    if (env.AUTODOM_OUTREACH_MASHINA_SESSION_FILE)
      messengers.set("mashina.kg", new MashinaMessenger(env.AUTODOM_OUTREACH_MASHINA_SESSION_FILE));
    if (env.AUTODOM_OUTREACH_LALAFO_SESSION_FILE)
      messengers.set("lalafo.kg", new LalafoMessenger(env.AUTODOM_OUTREACH_LALAFO_SESSION_FILE));
    if (command === "check-mashina" || command === "check-lalafo") {
      const source = command === "check-mashina" ? "mashina.kg" : "lalafo.kg";
      const result = await messengers.get(source)?.check();
      console.log(
        JSON.stringify(result ?? { source, ready: false, message: "Session file not configured" }),
      );
      return result?.ready ? 0 : 1;
    }
    const sendEnabled =
      z.enum(["true", "false"]).parse(env.AUTODOM_OUTREACH_SEND_ENABLED ?? "false") === "true";
    const databaseUrl = z.string().url().parse(env.AUTODOM_DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
      throw new Error("PostgreSQL required");
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15_000,
      application_name: "autodom-outreach",
    });
    pool.on("error", () => console.error("Outreach database connection interrupted."));
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    const runtime = await startOutreachServer({
      host,
      port,
      origin: env.AUTODOM_OUTREACH_ORIGIN ?? `http://127.0.0.1:${port}`,
      username: env.AUTODOM_OUTREACH_ADMIN_USER ?? "",
      password: env.AUTODOM_OUTREACH_ADMIN_PASSWORD ?? "",
      pool,
      messengers,
      sendEnabled,
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    runtime.server.once("error", stopped.reject);
    console.log(JSON.stringify({ service: "autodom-outreach", ready: true, sendEnabled }));
    try {
      await stopped.promise;
    } finally {
      try {
        await runtime.close();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
    return 0;
  } catch (error) {
    // loginLalafoSession replaces provider/browser errors with credential-free stage messages.
    console.error(
      command === "login-lalafo" && error instanceof Error
        ? error.message
        : "Outreach command failed. Check private configuration/database/network; use --help. No credentials are logged.",
    );
    return 1;
  } finally {
    await pool?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
