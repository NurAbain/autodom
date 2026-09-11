#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadProxyRoutes, loadSettings, sourceCatalog } from "@autodom/core";
import { createLogger } from "@autodom/runtime/logging";
import { ProxyTransport } from "@autodom/sources";
import { Store } from "@autodom/storage";
import type { Logger } from "pino";
import { syncPages } from "./collector.js";
import { runWorkerService } from "./service.js";

const HELP = `Autodom parser worker

Usage: pnpm worker [command] [options]

  serve                       Durable Redis/BullMQ source collection (default)
  health                      Probe this node's local metrics HTTP /health endpoint
  sync [--pages 3]             Bounded collection through mandatory proxies
  sources                     Offline source registry, access evidence and coverage gaps (JSON)

Node 24 and pnpm are required. Configure .env.example and export its values.
AUTODOM_DATABASE_URL and AUTODOM_REDIS_URL must point to Autodom's own backends.
Both SMARTPROXY tiers are required by serve/sync; no direct scraping fallback.
Only mashina.kg is enabled by default. Foreign sources require explicit permission
and AUTODOM_APPROVED_SOURCES opt-in. No import or auction cost is invented.
The sources command needs no database, Redis, Telegram token or proxy; it never contacts providers.
Candidate entries cannot be enabled. Published membership fees are not data-license prices.
Health needs only AUTODOM_METRICS_PORT (default 9901), with a five-second timeout.
This node never starts Telegram or MiniApp and does not require their configuration.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  process.umask(0o077);
  let store: Store | undefined;
  let logger: Logger | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        pages: { type: "string" },
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const [command = "serve", ...extra] = positionals;
    if (!["serve", "health", "sync", "sources"].includes(command)) {
      process.stdout.write(HELP);
      return 2;
    }
    if (extra.length) throw new Error("Unexpected positional argument");
    if (values.pages !== undefined && command !== "sync")
      throw new Error("--pages is only valid for sync");
    if (command === "health") {
      const port = Number(process.env.AUTODOM_METRICS_PORT ?? "9901");
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("AUTODOM_METRICS_PORT must be a valid TCP port");
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      process.stdout.write(`${JSON.stringify(await response.json())}\n`);
      return response.ok ? 0 : 1;
    }
    if (command === "sources") {
      process.stdout.write(`${JSON.stringify(sourceCatalog())}\n`);
      return 0;
    }
    const pageText = values.pages ?? "3";
    const pages = Number(pageText);
    if (
      command === "sync" &&
      (!/^\d+$/u.test(pageText) || !Number.isSafeInteger(pages) || pages < 1 || pages > 10_000)
    ) {
      throw new Error("--pages must be between 1 and 10000");
    }
    logger = createLogger();
    const settings = loadSettings();
    const routes = loadProxyRoutes();
    store = await Store.open(settings.database_url);
    if (command === "sync") {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let transport: ProxyTransport | undefined;
      try {
        transport = new ProxyTransport({
          routes,
          dataDir: settings.data_dir,
          requestDelaySeconds: settings.crawl_delay,
          signal: abort.signal,
        });
        process.stdout.write(
          `${JSON.stringify(await syncPages(store, pages, transport, settings.crawl_delay, abort.signal))}\n`,
        );
      } finally {
        abort.abort();
        try {
          await transport?.close();
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
      }
    } else {
      await runWorkerService(store, settings, routes, logger);
    }
    return 0;
  } catch (err) {
    (logger ?? createLogger({})).error({ err }, "Autodom worker command failed");
    return 1;
  } finally {
    await store?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
