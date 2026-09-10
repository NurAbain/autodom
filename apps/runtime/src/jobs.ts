import { type DocumentTransport, enabledSources, RateBook, type Settings } from "@autodom/core";
import { DETAIL_DELAY_SECONDS } from "@autodom/sources";
import type { Store } from "@autodom/storage";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { collectTick } from "./collector.js";
import type { Metrics } from "./metrics.js";

interface SourceJob {
  source: string;
}
export interface CollectionWorkers {
  close(): Promise<void>;
}

export async function startCollectionWorkers(
  store: Store,
  settings: Settings,
  transport: DocumentTransport,
  signal: AbortSignal,
  logger: Logger,
  metrics: Metrics,
): Promise<CollectionWorkers> {
  signal.throwIfAborted();
  const connection = new Redis(settings.redis_url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 10_000,
  });
  connection.on("error", (err: Error) =>
    logger.warn({ err }, "Autodom Redis connection unavailable"),
  );
  const queues: Queue<SourceJob>[] = [];
  const workers: Worker<SourceJob>[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const forced = setTimeout(() => {
        logger.warn(
          "Disconnecting unavailable Redis to finish worker shutdown; unfinished jobs remain recoverable",
        );
        connection.disconnect();
      }, 10_000).unref();
      try {
        await Promise.all(workers.map((worker) => worker.close()));
      } finally {
        try {
          connection.disconnect();
          await Promise.allSettled(queues.map((queue) => queue.waitUntilReady()));
          await Promise.all(queues.map((queue) => queue.close()));
        } finally {
          clearTimeout(forced);
          signal.removeEventListener("abort", onAbort);
        }
      }
    })());
  const onAbort = () => {
    void close().catch((err) => logger.error({ err }, "Collection shutdown failed"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const timeout = setTimeout(() => connection.disconnect(), 10_000);
    try {
      await connection.connect();
    } finally {
      clearTimeout(timeout);
    }
    signal.throwIfAborted();
    const rates = new RateBook(store, transport);
    for (const source of enabledSources()) {
      signal.throwIfAborted();
      const name = `source-${source.id.replace(/\./gu, "-")}`;
      const queue = new Queue<SourceJob>(name, { connection, prefix: "autodom" });
      queue.on("error", (err) =>
        logger.error({ err, source: source.id }, "Collection queue error"),
      );
      queues.push(queue);
      await queue.setGlobalConcurrency(1);
      signal.throwIfAborted();
      const worker = new Worker<SourceJob>(
        name,
        async (job) => {
          if (job.data.source !== source.id || job.name !== "tick")
            throw new Error("Unexpected source job contract");
          try {
            const pause = Math.max(
              await collectTick(store, source, settings, transport, rates, signal),
              source.id === "bid.cars" ? DETAIL_DELAY_SECONDS : 0,
            );
            await worker.rateLimit(Math.ceil(pause * 1000));
            const sourceError = await store.getMeta(`source:${source.id}:source_error`, "");
            metrics.jobs.inc({ source: source.id, outcome: sourceError ? "paused" : "completed" });
            return pause;
          } catch (err) {
            if (!signal.aborted)
              logger.error({ err, source: source.id }, "Source collection job failed");
            metrics.jobs.inc({ source: source.id, outcome: "failed" });
            throw err;
          }
        },
        {
          connection,
          prefix: "autodom",
          concurrency: 1,
          limiter: { max: 1, duration: Math.ceil(settings.crawl_delay * 1000) },
        },
      );
      workers.push(worker);
      worker.on("error", (err) =>
        logger.error({ err, source: source.id }, "Collection worker error"),
      );
      await worker.waitUntilReady();
      signal.throwIfAborted();
      await queue.upsertJobScheduler(
        "catalog-tick",
        { every: Math.ceil(settings.crawl_delay * 1000) },
        {
          name: "tick",
          data: { source: source.id },
          opts: {
            attempts: 3,
            backoff: { type: "fixed", delay: settings.refresh_seconds * 1000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 7 * 86_400, count: 1000 },
          },
        },
      );
      signal.throwIfAborted();
    }
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
