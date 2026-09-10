import type { Server } from "node:http";
import { configureTelegramBot, createTelegramBot, sendReplies } from "@autodom/bot";
import type { ProxyRoute, Settings } from "@autodom/core";
import { ProxyTransport } from "@autodom/sources";
import type { Store } from "@autodom/storage";
import {
  createConcurrentSink,
  createRunner,
  createSource,
  type RunnerHandle,
} from "@grammyjs/runner";
import { type Bot, type BotError, type Context, GrammyError, HttpError } from "grammy";
import type { Update } from "grammy/types";
import pg from "pg";
import type { Logger } from "pino";
import { type CollectionWorkers, startCollectionWorkers } from "./jobs.js";
import { maintain } from "./maintenance.js";
import { Metrics } from "./metrics.js";
import { monitor } from "./monitor.js";
import { type RuntimeRole, runtimeStatus } from "./status.js";

export function startPolling(bot: Bot): RunnerHandle {
  let offset = 0;
  const active = new Set<Promise<void>>();
  const source = createSource<Update>({
    async supply(capacity, signal) {
      for (;;) {
        try {
          const updates = await bot.api.getUpdates(
            {
              offset,
              limit: Math.max(1, Math.min(capacity, 100)),
              timeout: 30,
              allowed_updates: ["message", "callback_query"],
            },
            signal,
          );
          const last = updates.at(-1);
          if (last) offset = last.update_id + 1;
          return updates;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
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
        const task = bot.handleUpdate(update);
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

export async function runService(
  store: Store,
  settings: Settings,
  role: RuntimeRole,
  routes: readonly ProxyRoute[],
  token: string,
  logger: Logger,
): Promise<void> {
  const abort = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lease: pg.Client | undefined;
  let transport: ProxyTransport | undefined;
  let collectors: CollectionWorkers | undefined;
  let runner: RunnerHandle | undefined;
  let server: Server | undefined;
  const tasks: Promise<void>[] = [];
  const metrics = new Metrics(role);
  try {
    let bot: Bot | undefined;
    if (role !== "worker") {
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
        if (!abort.signal.aborted)
          abort.abort(new Error("Telegram polling lease connection closed"));
      });
      await lease.connect();
      const ownership = await lease.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1,$2) AS acquired",
        [0x4155544f, 0x42544c50],
      );
      if (!ownership.rows[0]?.acquired)
        throw new Error("Another Autodom Telegram poller is already running");
      bot = createTelegramBot(store, token);
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
      await configureTelegramBot(bot, abort.signal);
    }
    if (role !== "bot") {
      transport = new ProxyTransport({
        routes,
        dataDir: settings.data_dir,
        requestDelaySeconds: settings.crawl_delay,
        signal: abort.signal,
        onRequest: (outcome) => metrics.recordRequest(outcome),
      });
      collectors = await startCollectionWorkers(
        store,
        settings,
        transport,
        abort.signal,
        logger,
        metrics,
      );
    }
    const port = Number(process.env.AUTODOM_METRICS_PORT ?? "9901");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("AUTODOM_METRICS_PORT must be a valid TCP port");
    server = await metrics.serve(
      port,
      async () => (await runtimeStatus(store, settings, role)).healthy,
    );
    if (bot) {
      const activeBot = bot;
      runner = startPolling(bot);
      const polling = runner.task();
      if (!polling) throw new Error("Telegram polling did not start");
      tasks.push(
        polling.then(() => {
          if (!abort.signal.aborted) throw new Error("Telegram polling stopped unexpectedly");
        }),
      );
      tasks.push(
        monitor(
          store,
          (chatId, replies) => sendReplies(activeBot, chatId, replies),
          settings.monitor_seconds,
          abort.signal,
        ),
      );
      tasks.push(maintain(store, settings, "bot", abort.signal));
    }
    if (role !== "bot") tasks.push(maintain(store, settings, "worker", abort.signal));
    logger.info({ role, metrics_port: port }, "Autodom service ready");
    const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", () => onAbort(), { once: true });
    await Promise.race([...tasks, aborted]);
    if (!stopping) throw abort.signal.reason ?? new Error("Autodom service stopped unexpectedly");
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    abort.abort();
    await runner?.stop();
    await collectors?.close();
    await transport?.close();
    await Promise.allSettled(tasks);
    if (server) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      await promise;
    }
    await lease?.end();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
