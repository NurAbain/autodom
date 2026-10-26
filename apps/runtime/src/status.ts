import { type Settings, type SourceStatus, sourceStatus } from "@autodom/core";
import type { Store, StoreStats } from "@autodom/storage";
import { Redis } from "ioredis";

export type RuntimeRole = "bot" | "worker" | "run";
export interface RuntimeStatus extends StoreStats {
  healthy: boolean;
  sources: SourceStatus[];
  telegram_error: string | null;
  last_backup_at: string | null;
}

/**
 * Liveness of the service. It reads only the heartbeats and the queue connection, so
 * it stays fast enough for a health probe: the catalogue scans below count every
 * listing and take seconds once the catalogue grows.
 */
export async function runtimeHealth(
  store: Store,
  settings: Pick<Settings, "monitor_seconds"> & { redis_url?: string },
  role: RuntimeRole = "run",
): Promise<boolean> {
  const now = Date.now() / 1000;
  const [bot, worker, monitor] = await Promise.all([
    store.getMeta("bot_heartbeat", "0"),
    store.getMeta("worker_heartbeat", "0"),
    store.getMeta("last_monitor_at", "0"),
  ]);
  const botFresh = 0 <= now - Number(bot) && now - Number(bot) <= 120;
  const workerFresh = 0 <= now - Number(worker) && now - Number(worker) <= 120;
  const monitorFresh =
    0 <= now - Number(monitor) &&
    now - Number(monitor) <= Math.max(120, settings.monitor_seconds * 2);
  let redisReady = true;
  if (role !== "bot" && !settings.redis_url) {
    redisReady = false;
  } else if (role !== "bot" && settings.redis_url) {
    const redis = new Redis(settings.redis_url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      redisReady = (await redis.ping()) === "PONG";
    } catch {
      redisReady = false;
    } finally {
      redis.disconnect();
    }
  }
  return (
    (role === "worker" || (botFresh && monitorFresh)) &&
    (role === "bot" || (workerFresh && redisReady))
  );
}

export async function runtimeStatus(
  store: Store,
  settings: Pick<Settings, "monitor_seconds"> & { redis_url?: string },
  role: RuntimeRole = "run",
): Promise<RuntimeStatus> {
  const [telegramError, lastBackup, stats, sources] = await Promise.all([
    store.getMeta("telegram_error", ""),
    store.getMeta("last_backup_at"),
    store.stats(),
    sourceStatus(store),
  ]);
  return {
    ...stats,
    healthy: await runtimeHealth(store, settings, role),
    sources,
    telegram_error: telegramError,
    last_backup_at: lastBackup,
  };
}
