#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadBotSettings, loadToken, miniAppUrl } from "@autodom/core";
import { createVinApiLookup, createVinArchivePhotoApiLookup } from "@autodom/core/vin-client";
import { createLogger } from "@autodom/runtime/logging";
import { Store } from "@autodom/storage";
import type { Logger } from "pino";
import { ProductAnalytics } from "./analytics.js";
import {
  loadBotMode,
  loadReportBotUrl,
  telegramIdentity,
  telegramRecipientKey,
} from "./bot-mode.js";
import { Conversation } from "./conversation.js";
import {
  loadCarfaxReportEnabled,
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

Usage: pnpm bot [serve|health|analytics-migrate|payments COMMAND] [--help]

  serve    Telegram polling, notifications, backups and optional Mini App (default)
  health   Probe this process's local metrics /health; no Store or token initialization
  payments Manage explicit inspection offers and refund requests; payments --help
  analytics-migrate Create/update the isolated analytics schema; no Telegram/API calls

AUTODOM_METRICS_PORT defaults to 9901.
Set AUTODOM_MINI_APP_URL to enable the Mini App in this same bot process.
AUTODOM_MINI_APP_HOST defaults to 127.0.0.1; AUTODOM_MINI_APP_PORT defaults to 8080.
Set AUTODOM_VIN_API_URL and AUTODOM_VIN_API_TOKEN to enable remote VIN checks.
Set AUTODOM_OCR_API_URL and AUTODOM_OCR_API_TOKEN to enable GPU photo recognition.
AUTODOM_BOT_MODE=vin limits the bot to VIN and reports (default: full).
AUTODOM_REPORT_BOT_URL delegates full-bot purchases to the separate VIN bot.
AUTODOM_ANALYTICS_KEY enables first-party analytics (same random 32+ character secret in both bots).
Run analytics-migrate once before enabling; unset the key to stop collection.
No parser, worker or proxy configuration is loaded by this command.
Stop the old Telegram poller before cutover; an existing webhook is never replaced.
`;

export async function main(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  process.umask(0o077);
  if (argv[0] === "payments") {
    if (loadReportBotUrl(env)) {
      process.stderr.write("Manage payments in the VIN bot container.\n");
      return 2;
    }
    return runPaymentsCommand(argv.slice(1), env);
  }
  let logger: Logger | undefined;
  let store: Store | undefined;
  let analytics: ProductAnalytics | undefined;
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
    if (extra.length || !["serve", "health", "analytics-migrate"].includes(command)) {
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
    if (command === "analytics-migrate") {
      await ProductAnalytics.migrate(loadBotSettings(env).database_url);
      process.stdout.write("Analytics schema ready; financial schema unchanged.\n");
      return 0;
    }
    logger = createLogger(env);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const settings = loadBotSettings(env);
    const publicUrl = miniAppUrl(env);
    const mode = loadBotMode(env);
    const reportBotUrl = loadReportBotUrl(env);
    if (env.AUTODOM_ANALYTICS_KEY)
      analytics = new ProductAnalytics(settings.database_url, env.AUTODOM_ANALYTICS_KEY, mode);
    const checkVin = createVinApiLookup(env, abort.signal);
    const getVinArchivePhoto = createVinArchivePhotoApiLookup(env, abort.signal);
    const token = await loadToken(env);
    const photoRecognizer = createPhotoRecognizer(token, env, abort.signal);
    logger = createLogger({ ...env, AUTODOM_BOT_TOKEN: token });
    if (!abort.signal.aborted) {
      store = await Store.open(settings.database_url);
      if (!abort.signal.aborted) {
        const conversation = new Conversation(store, {
          seller: new SellerConversation(store),
          ...(analytics ? { analytics } : {}),
        });
        const payments = reportBotUrl
          ? undefined
          : new PaymentService(
              store,
              loadFinikGatewaySettings(env),
              fetch,
              loadVinReportFinikEnabled(env),
              loadVinReportTelegramFinikEnabled(env),
              loadCarfaxReportEnabled(env),
            );
        if (payments && analytics) payments.analytics = analytics;
        const botId = telegramIdentity(token);
        const registerRecipient = reportBotUrl
          ? async (userId: number) => {
              const key = telegramRecipientKey(botId, userId);
              if ((await store!.getMeta(key)) !== "1") await store!.setMeta(key, "1");
            }
          : undefined;
        const bot = createTelegramBot(store, token, {
          conversation,
          mode,
          ...(analytics ? { analytics } : {}),
          ...(reportBotUrl ? { reportBotUrl } : {}),
          ...(payments ? { payments } : {}),
          ...(registerRecipient ? { onPrivateInteraction: registerRecipient } : {}),
          starsEnabled: loadVinReportStarsEnabled(env),
          ...(publicUrl ? { miniAppUrl: publicUrl } : {}),
          ...(checkVin ? { checkVin } : {}),
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
            mode,
            ...(analytics ? { analytics } : {}),
            ...(reportBotUrl ? { reportBotUrl } : {}),
            ...(payments ? { payments } : {}),
            ...(publicUrl ? { miniAppUrl: publicUrl } : {}),
            ...(checkVin ? { checkVin } : {}),
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
      await analytics?.close();
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
