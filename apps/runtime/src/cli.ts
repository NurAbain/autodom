#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadProxyRoutes, loadSettings, loadToken } from "@autodom/core";
import { ProxyTransport } from "@autodom/sources";
import { backup, importSqlite, restore, Store } from "@autodom/storage";
import { syncPages } from "./collector.js";
import { createLogger } from "./logging.js";
import { runService } from "./service.js";
import { type RuntimeRole, runtimeStatus } from "./status.js";

const HELP = `Autodom: car search and free Telegram monitoring

Usage: pnpm autodom <command> [options]

  run                         Bot, collector, notifications and local snapshots
  bot                         Telegram and notifications only; singleton poller
  worker                      Durable Redis/BullMQ source collection only
  sync [--pages 3]             Bounded collection through mandatory proxies
  status [--role run]          Aggregate counters and per-source state; no user data
  health [--role run]          Exit 0 only with fresh heartbeats and dependencies
  migrate                     Apply guarded PostgreSQL schema migrations
  import-sqlite SNAPSHOT       Import SQLite v1–5 read-only into an EMPTY PostgreSQL DB
  backup DESTINATION          Create a new private consistent NDJSON snapshot
  restore SNAPSHOT             Restore into an EMPTY configured PostgreSQL DB
    [--destination URL]       Explicit new target PostgreSQL URL (prefer environment)

Node 24 and pnpm are required. Configure .env.example and export its values.
AUTODOM_DATABASE_URL and AUTODOM_REDIS_URL must point to Autodom's own backends.
Both SMARTPROXY tiers are required by run/worker/sync; no direct scraping fallback.
Only mashina.kg is enabled by default. Foreign sources require explicit permission
and AUTODOM_APPROVED_SOURCES opt-in. No import or auction cost is invented.
Backups include profiles: keep them private; seven-day local retention is not off-site protection.
Stop the old poller before cutover. This CLI never replaces an existing Telegram webhook.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  process.umask(0o077);
  let store: Store | undefined;
  let logger = createLogger();
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        pages: { type: "string" },
        role: { type: "string" },
        destination: { type: "string" },
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const [command, path, ...extra] = positionals;
    if (
      !command ||
      ![
        "run",
        "bot",
        "worker",
        "sync",
        "status",
        "health",
        "migrate",
        "import-sqlite",
        "backup",
        "restore",
      ].includes(command)
    ) {
      process.stdout.write(HELP);
      return 2;
    }
    if (extra.length || (path && !["import-sqlite", "backup", "restore"].includes(command)))
      throw new Error("Unexpected positional argument");
    if (["import-sqlite", "backup", "restore"].includes(command) && !path)
      throw new Error("A snapshot path is required");
    if (values.pages !== undefined && command !== "sync")
      throw new Error("--pages is only valid for sync");
    if (values.destination !== undefined && command !== "restore")
      throw new Error("--destination is only valid for restore");
    if (values.role !== undefined && !["status", "health"].includes(command))
      throw new Error("--role is only valid for status and health");
    const role = values.role ?? "run";
    if (!["bot", "worker", "run"].includes(role))
      throw new Error("--role must be bot, worker, or run");
    const pageText = values.pages ?? "3";
    const pages = Number(pageText);
    if (
      command === "sync" &&
      (!/^\d+$/u.test(pageText) || !Number.isSafeInteger(pages) || pages < 1 || pages > 10_000)
    ) {
      throw new Error("--pages must be between 1 and 10000");
    }
    const settings = loadSettings();
    const routes = ["run", "worker", "sync"].includes(command) ? loadProxyRoutes() : [];
    const token = ["run", "bot"].includes(command) ? await loadToken() : "";
    if (token) logger = createLogger({ ...process.env, AUTODOM_BOT_TOKEN: token });
    if (command === "restore") {
      if (!path) throw new Error("A snapshot path is required");
      await restore(path, values.destination ?? settings.database_url);
      process.stdout.write(`${JSON.stringify({ restored: true })}\n`);
      return 0;
    }
    store = await Store.open(settings.database_url);
    if (command === "migrate") {
      process.stdout.write('{"migrated":true}\n');
      return 0;
    }
    if (command === "import-sqlite") {
      if (!path) throw new Error("A snapshot path is required");
      process.stdout.write(`${JSON.stringify(await importSqlite(path, store))}\n`);
    } else if (command === "backup") {
      if (!path) throw new Error("A snapshot path is required");
      await backup(store, path);
      process.stdout.write(`${JSON.stringify({ snapshot: resolve(path) })}\n`);
    } else if (command === "status" || command === "health") {
      const status = await runtimeStatus(store, settings, role as RuntimeRole);
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return command === "health" && !status.healthy ? 1 : 0;
    } else if (command === "sync") {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const transport = new ProxyTransport({
        routes,
        dataDir: settings.data_dir,
        requestDelaySeconds: settings.crawl_delay,
        signal: abort.signal,
      });
      try {
        process.stdout.write(
          `${JSON.stringify(await syncPages(store, pages, transport, settings.crawl_delay, abort.signal))}\n`,
        );
      } finally {
        await transport.close();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    } else {
      await runService(store, settings, command as RuntimeRole, routes, token, logger);
    }
    return 0;
  } catch (err) {
    logger.error({ err }, "Autodom command failed");
    return 1;
  } finally {
    await store?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
