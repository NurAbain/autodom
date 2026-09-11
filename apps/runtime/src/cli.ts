#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadBotSettings, loadSettings } from "@autodom/core";
import { backup, importSqlite, restore, Store } from "@autodom/storage";
import { createLogger } from "./logging.js";
import { type RuntimeRole, runtimeStatus } from "./status.js";

const HELP = `Autodom: storage administration and aggregate diagnostics

Usage: pnpm autodom <command> [options]

  status [--role run]          Aggregate counters and per-source state; no user data
  health [--role run]          Exit 0 only with fresh heartbeats and dependencies
  migrate                     Apply guarded PostgreSQL schema migrations
  import-sqlite SNAPSHOT       Import SQLite v1–5 read-only into an EMPTY PostgreSQL DB
  backup DESTINATION          Create a new private consistent NDJSON snapshot
  restore SNAPSHOT             Restore into an EMPTY configured PostgreSQL DB
    [--destination URL]       Explicit new target PostgreSQL URL (prefer environment)

Node 24 and pnpm are required. Configure .env.example and export its values.
AUTODOM_DATABASE_URL must point to Autodom's own database.
Worker/aggregate diagnostics also require AUTODOM_REDIS_URL; storage commands do not.
Start the bot and Mini App together with pnpm bot; start parsers with pnpm worker.
Use pnpm worker sync --pages 3 for bounded collection, pnpm worker sources for the offline registry.
Backups include profiles: keep them private; seven-day local retention is not off-site protection.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  process.umask(0o077);
  let store: Store | undefined;
  const logger = createLogger();
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
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
      !["status", "health", "migrate", "import-sqlite", "backup", "restore"].includes(command)
    ) {
      process.stdout.write(HELP);
      return 2;
    }
    if (extra.length || (path && !["import-sqlite", "backup", "restore"].includes(command)))
      throw new Error("Unexpected positional argument");
    if (["import-sqlite", "backup", "restore"].includes(command) && !path)
      throw new Error("A snapshot path is required");
    if (values.destination !== undefined && command !== "restore")
      throw new Error("--destination is only valid for restore");
    if (values.role !== undefined && !["status", "health"].includes(command))
      throw new Error("--role is only valid for status and health");
    const role = values.role ?? "run";
    if (!["bot", "worker", "run"].includes(role))
      throw new Error("--role must be bot, worker, or run");
    const settings =
      ["status", "health"].includes(command) && role !== "bot" ? loadSettings() : loadBotSettings();
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
