#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadBotSettings, loadToken, miniAppUrl } from "@autodom/core";
import {
  createVinApiLookup,
  createVinArchiveApiLookup,
  createVinArchivePhotoApiLookup,
} from "@autodom/core/vin-client";
import { createLogger } from "@autodom/runtime/logging";
import { Store } from "@autodom/storage";
import type { Logger } from "pino";
import { Conversation } from "./conversation.js";
import {
  loadFinikGatewaySettings,
  loadVinReportFinikEnabled,
  loadVinReportStarsEnabled,
  loadVinReportTelegramFinikEnabled,
  PaymentService,
} from "./payments.js";
import { runPaymentsCommand } from "./payments-cli.js";
import { SellerConversation } from "./seller-conversation.js";
import { metricsPort, runBotService } from "./service.js";
import { createTelegramBot } from "./telegram.js";
import { createPhotoRecognizer } from "./vin-photo.js";

const HELP = `Autodom Telegram bot and Mini App

Usage: pnpm bot [serve|health|payments COMMAND] [--help]

  serve    Telegram polling, notifications, backups and optional Mini App (default)
  health   Probe this process's local metrics /health; no Store or token initialization
  payments Manage explicit inspection offers and refund requests; payments --help

AUTODOM_METRICS_PORT defaults to 9901.
Set AUTODOM_MINI_APP_URL to enable the Mini App in this same bot process.
AUTODOM_MINI_APP_HOST defaults to 127.0.0.1; AUTODOM_MINI_APP_PORT defaults to 8080.
Set AUTODOM_VIN_API_URL and AUTODOM_VIN_API_TOKEN to enable remote VIN checks.
Set AUTODOM_OCR_API_URL and AUTODOM_OCR_API_TOKEN to enable GPU photo recognition.
No parser, worker or proxy configuration is loaded by this command.
Stop the old Telegram poller before cutover; an existing webhook is never replaced.
`;

export async function main(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  process.umask(0o077);
  if (argv[0] === "payments") return runPaymentsCommand(argv.slice(1), env);
  let logger: Logger | undefined;
  let store: Store | undefined;
  let code = 0;
  let forceExit: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  const stop = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    // Also bounds shutdown while Store.open or a request still owns a connection.
    forceExit = setTimeout(() => {
      process.stderr.write('{"level":"error","msg":"Bot shutdown timed out"}\n');
      process.exit(1);
    }, 10_000);
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const [command = "serve", ...extra] = positionals;
    if (extra.length || !["serve", "health"].includes(command)) {
      process.stderr.write(HELP);
      return 2;
    }
    if (command === "health") {
      let healthy = false;
      try {
        const response = await fetch(`http://127.0.0.1:${metricsPort(env)}/health`, {
          signal: AbortSignal.timeout(4_000),
          redirect: "error",
        });
        const body: unknown = await response.json();
        healthy = !!(
          response.ok &&
          body &&
          typeof body === "object" &&
          "healthy" in body &&
          body.healthy === true
        );
      } catch {
        // Do not expose listener responses or environment values through probe output.
      }
      process.stdout.write(`${JSON.stringify({ role: "bot", healthy })}\n`);
      return healthy ? 0 : 1;
    }
    logger = createLogger(env);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const settings = loadBotSettings(env);
    const publicUrl = miniAppUrl(env);
    const checkVin = createVinApiLookup(env, abort.signal);
    const checkVinArchive = createVinArchiveApiLookup(env, abort.signal);
    const getVinArchivePhoto = createVinArchivePhotoApiLookup(env, abort.signal);
    const token = await loadToken(env);
    const photoRecognizer = createPhotoRecognizer(token, env, abort.signal);
    logger = createLogger({ ...env, AUTODOM_BOT_TOKEN: token });
    if (!abort.signal.aborted) {
      store = await Store.open(settings.database_url);
      if (!abort.signal.aborted) {
        const conversation = new Conversation(store, { seller: new SellerConversation(store) });
        const payments = new PaymentService(
          store,
          loadFinikGatewaySettings(env),
          fetch,
          loadVinReportFinikEnabled(env),
          loadVinReportTelegramFinikEnabled(env),
        );
        const bot = createTelegramBot(store, token, {
          conversation,
          payments,
          starsEnabled: loadVinReportStarsEnabled(env),
          ...(publicUrl ? { miniAppUrl: publicUrl } : {}),
          ...(checkVin ? { checkVin } : {}),
          ...(checkVinArchive ? { checkVinArchive } : {}),
          ...(getVinArchivePhoto ? { getVinArchivePhoto } : {}),
          ...(photoRecognizer ? { photoRecognizer } : {}),
        });
        await runBotService(
          store,
          settings,
          {
            bot,
            token,
            conversation,
            payments,
            ...(publicUrl ? { miniAppUrl: publicUrl } : {}),
            ...(checkVin ? { checkVin } : {}),
            ...(checkVinArchive ? { checkVinArchive } : {}),
            ...(getVinArchivePhoto ? { getVinArchivePhoto } : {}),
            signal: abort.signal,
          },
          logger,
          env,
        );
      }
    }
  } catch (err) {
    if (logger) logger.error({ err }, "Autodom bot command failed");
    else process.stderr.write('{"level":"error","msg":"Autodom bot configuration failed"}\n');
    code = 1;
  } finally {
    try {
      await store?.close();
    } catch (err) {
      if (logger) logger.error({ err }, "Autodom bot Store shutdown failed");
      else process.stderr.write('{"level":"error","msg":"Autodom bot Store shutdown failed"}\n');
      code = 1;
    } finally {
      clearTimeout(forceExit);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
