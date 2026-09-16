import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { BotSettings } from "@autodom/core";
import type { VinLookup } from "@autodom/core/vin";
import type { VinArchiveLookup, VinArchivePhotoLookup } from "@autodom/core/vin-archive";
import { maintain } from "@autodom/runtime/maintenance";
import { Metrics } from "@autodom/runtime/metrics";
import type { Store } from "@autodom/storage";
import {
  createConcurrentSink,
  createRunner,
  createSource,
  type RunnerHandle,
} from "@grammyjs/runner";
import { sql } from "drizzle-orm";
import { type Bot, type BotError, type Context, GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import pg from "pg";
import type { Logger } from "pino";
import type { ProductAnalytics } from "./analytics.js";
import { PaymentAnalytics } from "./analytics-payments.js";
import {
  type BotMode,
  loadFullBotUrl,
  telegramIdentity,
  telegramRecipientKey,
} from "./bot-mode.js";
import type { Conversation } from "./conversation.js";
import { startMiniAppServer } from "./miniapp-server.js";
import { monitor } from "./monitor.js";
import type { PaymentService } from "./payments.js";
import { loadPaymentListenerSettings, startPaymentListener } from "./payments-http.js";
import { type AutodomBot, configureTelegramBot, sendReplies } from "./telegram.js";
import { WebReportAuth } from "./web-report-auth.js";

export function startPolling(
  bot: Bot,
  metrics?: Pick<Metrics, "recordTelegramUpdate">,
  payments?: Pick<PaymentService, "ingestTelegramPayment">,
): RunnerHandle {
  let offset = 0;
  let uncommitted: Update[] | undefined;
  const active = new Set<Promise<void>>();
  const source = createSource<Update>({
    async supply(capacity, signal) {
      for (;;) {
        try {
          const updates =
            uncommitted ??
            (await bot.api.getUpdates(
              {
                offset,
                limit: Math.max(1, Math.min(capacity, 100)),
                timeout: 30,
                allowed_updates: ["message", "callback_query", "pre_checkout_query"],
              },
              signal,
            ));
          // Never send a higher offset until every financial receipt is durable.
          // Retain this batch on storage failure rather than acknowledging or dropping it.
          uncommitted = updates;
          for (const update of updates) {
            if (update.message?.successful_payment || update.message?.refunded_payment) {
              if (!payments) throw new Error("Financial receipt requires the payment ledger");
              await payments.ingestTelegramPayment(update);
            }
          }
          uncommitted = undefined;
          const last = updates.at(-1);
          if (last) offset = last.update_id + 1;
          return updates;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!uncommitted && !(error instanceof GrammyError || error instanceof HttpError))
            throw error;
          if (
            error instanceof GrammyError &&
            (error.error_code === 401 || error.error_code === 409)
          )
            throw error;
          const seconds =
            error instanceof GrammyError && error.error_code === 429
              ? (error.parameters.retry_after ?? 60)
              : 1;
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const onAbort = () => reject(new DOMException("Telegram polling stopped", "AbortError"));
          const timer = setTimeout(resolve, Math.min(Math.max(seconds, 1) * 1000, 2_147_483_647));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
          try {
            await promise;
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        }
      }
    },
  });
  const sink = createConcurrentSink<Update, BotError<Context>>(
    {
      consume(update) {
        const started = performance.now();
        const task = bot.handleUpdate(update).then(
          () => {
            metrics?.recordTelegramUpdate("success", (performance.now() - started) / 1000);
          },
          (error: unknown) => {
            metrics?.recordTelegramUpdate("error", (performance.now() - started) / 1000);
            throw error;
          },
        );
        active.add(task);
        return task.finally(() => {
          active.delete(task);
        });
      },
    },
    async (error) => {
      await bot.errorHandler(error);
    },
    { concurrency: 50 },
  );
  const runner = createRunner(source, sink);
  runner.start();
  return {
    ...runner,
    async stop() {
      try {
        await runner.stop();
      } finally {
        await Promise.allSettled(active);
      }
    },
  };
}

export interface BotServiceContext {
  bot: AutodomBot;
  token: string;
  mode?: BotMode;
  reportBotUrl?: string;
  miniAppUrl?: string;
  assetsDirectory?: string;
  signal?: AbortSignal;
  checkVin?: VinLookup;
  checkVinArchive?: VinArchiveLookup;
  getVinArchivePhoto?: VinArchivePhotoLookup;
  conversation?: Conversation;
  payments?: PaymentService;
  analytics?: ProductAnalytics;
}

export function metricsPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTODOM_METRICS_PORT ?? "9901";
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AUTODOM_METRICS_PORT must be a valid TCP port");
  return port;
}

function miniAppListener(env: NodeJS.ProcessEnv) {
  const rawPort = env.AUTODOM_MINI_APP_PORT ?? "8080";
  const port = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AUTODOM_MINI_APP_PORT must be a valid TCP port");
  const host = env.AUTODOM_MINI_APP_HOST?.trim() ?? "127.0.0.1";
  if (!host || /[\s/?#@]/u.test(host))
    throw new Error("AUTODOM_MINI_APP_HOST must be a hostname or IP address");
  return { host, port };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const drain = setTimeout(() => server.closeAllConnections(), 5_000);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
    await promise;
  } finally {
    clearTimeout(drain);
  }
}

export async function runBotService(
  store: Store,
  settings: BotSettings,
  context: BotServiceContext,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { bot, token, miniAppUrl, mode = "full", reportBotUrl } = context;
  const port = metricsPort(env);
  const listener = miniAppUrl ? miniAppListener(env) : undefined;
  const paymentListener = reportBotUrl ? undefined : loadPaymentListenerSettings(env);
  const fullBotUrl = loadFullBotUrl(env);
  if (paymentListener && !context.payments)
    throw new Error("Payment callback listener requires the payment service");
  const abort = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (context.signal?.aborted) stop();
  else context.signal?.addEventListener("abort", stop, { once: true });
  let lease: pg.Client | undefined;
  let runner: RunnerHandle | undefined;
  let metricsServer: Server | undefined;
  let miniAppServer: Server | undefined;
  let paymentServer: Server | undefined;
  let failure: unknown;
  let failed = false;
  const tasks: Promise<void>[] = [];
  let probe: Promise<boolean> | undefined;
  const ready = async (): Promise<boolean> => {
    if (abort.signal.aborted) return false;
    // Repeated probes must not fill the pool while a database query is stalled.
    probe ??= store.database
      .execute(sql`SELECT 1`)
      .then(
        () => !abort.signal.aborted,
        () => false,
      )
      .finally(() => {
        probe = undefined;
      });
    const { promise: timedOut, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => resolve(false), 1_500);
    try {
      return await Promise.race([probe, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
  const metrics = new Metrics("bot", store, settings);
  context.analytics?.attachMetrics(metrics.registry);
  const paymentAnalytics =
    context.analytics && context.payments
      ? new PaymentAnalytics(settings.database_url, context.analytics, metrics.registry)
      : undefined;
  const watchServer = (server: Server, name: string) => {
    server.on("error", () => abort.abort(new Error(`${name} HTTP listener failed`)));
    server.on("close", () => {
      if (!abort.signal.aborted) abort.abort(new Error(`${name} HTTP listener closed`));
    });
  };
  try {
    abort.signal.throwIfAborted();
    // A separate connection owns the process lease; no ALS context leaks into concurrent handlers.
    lease = new pg.Client({
      connectionString: settings.database_url,
      connectionTimeoutMillis: 10_000,
    });
    lease.on("error", (err) => {
      logger.error({ err }, "Telegram polling lease lost");
      abort.abort(err);
    });
    lease.on("end", () => {
      if (!abort.signal.aborted) abort.abort(new Error("Telegram polling lease connection closed"));
    });
    await lease.connect();
    const ownership = await lease.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [`autodom:telegram:${telegramIdentity(token)}`],
    );
    if (!ownership.rows[0]?.acquired)
      throw new Error("Another Autodom Telegram poller is already running");
    abort.signal.throwIfAborted();
    bot.api.config.use(async (previous, method, payload, signal) => {
      try {
        return await previous(method, payload, signal);
      } catch (err) {
        logger.warn({ err, method }, "Telegram API request failed");
        throw err;
      }
    });
    bot.catch(({ error }) => {
      logger.warn({ err: error }, "Telegram update could not be handled");
    });
    await configureTelegramBot(bot, abort.signal, {
      mode,
      ...(reportBotUrl ? { reportBotUrl } : {}),
    });
    abort.signal.throwIfAborted();
    if (miniAppUrl && listener) {
      if (context.payments)
        bot.webReportAuth = new WebReportAuth(context.payments.ledger, bot.botInfo.username);
      miniAppServer = await startMiniAppServer({
        store,
        token,
        publicUrl: miniAppUrl,
        mode,
        ...(context.analytics ? { analytics: context.analytics } : {}),
        ...(reportBotUrl ? { reportBotUrl } : {}),
        ...(fullBotUrl ? { fullBotUrl } : {}),
        ...listener,
        ...(context.payments ? { payments: context.payments } : {}),
        ...(bot.webReportAuth ? { webReportAuth: bot.webReportAuth } : {}),
        ...(context.assetsDirectory ? { assetsDirectory: context.assetsDirectory } : {}),
        ...(context.checkVin ? { checkVin: context.checkVin } : {}),
        ...(context.checkVinArchive ? { checkVinArchive: context.checkVinArchive } : {}),
        ...(context.getVinArchivePhoto ? { getVinArchivePhoto: context.getVinArchivePhoto } : {}),
        ...(mode === "full" && context.conversation
          ? {
              dialogue: (userId: number, text: string) =>
                store.tryWithLock(`autodom:user:${userId}`, () => {
                  bot.clearVinInput(userId);
                  return context.conversation!.handle(
                    userId,
                    userId,
                    text,
                    "miniapp",
                    randomUUID(),
                  );
                }),
            }
          : {}),
        ready,
        // Request errors can contain private Telegram initData or profile values.
        onError: () => logger.warn("Mini App request failed"),
        onRequest: (observation) => metrics.recordHttpRequest(observation),
      });
      watchServer(miniAppServer, "Mini App");
      abort.signal.throwIfAborted();
    }
    if (paymentListener && context.payments) {
      paymentServer = await startPaymentListener(context.payments, paymentListener);
      watchServer(paymentServer, "Payment events");
      abort.signal.throwIfAborted();
    }
    metricsServer = await metrics.serve(
      port,
      async () =>
        !abort.signal.aborted &&
        !!runner?.isRunning() &&
        (!listener || !!miniAppServer?.listening) &&
        (!paymentListener || !!paymentServer?.listening) &&
        (await ready()),
    );
    watchServer(metricsServer, "Metrics");
    abort.signal.throwIfAborted();
    runner = startPolling(bot, metrics, context.payments);
    const polling = runner.task();
    if (!polling) throw new Error("Telegram polling did not start");
    tasks.push(
      polling.then(() => {
        if (!abort.signal.aborted) throw new Error("Telegram polling stopped unexpectedly");
      }),
    );
    if (mode === "full") {
      const botId = telegramIdentity(token);
      tasks.push(
        monitor(
          store,
          (chatId, replies) => sendReplies(bot, chatId, replies, miniAppUrl ? { miniAppUrl } : {}),
          settings.monitor_seconds,
          abort.signal,
          metrics,
          reportBotUrl
            ? async (userId) => (await store.getMeta(telegramRecipientKey(botId, userId))) === "1"
            : undefined,
        ),
      );
    }
    // One owner retains snapshots and financial notifications for the shared database.
    if (!reportBotUrl) tasks.push(maintain(store, settings, "bot", abort.signal));
    if (context.payments) {
      const payments = context.payments;
      tasks.push(
        (async () => {
          while (!abort.signal.aborted) {
            try {
              await payments.notifyPendingReports();
            } catch (err) {
              logger.warn({ err }, "Paid PDF owner notification deferred");
            }
            if (abort.signal.aborted) break;
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(() => {
                abort.signal.removeEventListener("abort", onAbort);
                resolve();
              }, 30_000);
              abort.signal.addEventListener("abort", onAbort, { once: true });
            });
          }
        })(),
      );
    }
    if (context.analytics) {
      const analytics = context.analytics;
      tasks.push(
        (async () => {
          while (!abort.signal.aborted) {
            await paymentAnalytics?.refresh();
            await analytics.refresh();
            await delay(30_000, undefined, { signal: abort.signal }).catch(() => {});
          }
        })(),
      );
    }
    logger.info(
      { role: "bot", metrics_port: port, ...(listener ? { miniapp_port: listener.port } : {}) },
      "Autodom service ready",
    );
    const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", () => onAbort(), { once: true });
    await Promise.race([...tasks, aborted]);
    if (!stopping) throw abort.signal.reason ?? new Error("Autodom service stopped unexpectedly");
  } catch (error) {
    if (!stopping) {
      failure = error;
      failed = true;
    }
  } finally {
    abort.abort();
    // Start all drains together; a poller failure must not retain listeners or the lease.
    try {
      const drains = await Promise.allSettled([
        runner?.stop(),
        closeServer(miniAppServer),
        closeServer(paymentServer),
        closeServer(metricsServer),
        Promise.allSettled(tasks),
      ]);
      const rejected = drains.find((result) => result.status === "rejected");
      if (!failed && rejected?.status === "rejected") {
        failure = rejected.reason;
        failed = true;
      }
    } finally {
      try {
        await paymentAnalytics?.close();
        await lease?.end();
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        context.signal?.removeEventListener("abort", stop);
      }
    }
  }
  if (failed) throw failure;
}
