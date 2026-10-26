import { expect, it } from "vitest";
import type { Store } from "@autodom/storage";
import { runtimeHealth } from "../src/status.js";

const now = Date.now() / 1000;

/** A store whose catalogue scans fail: liveness must not depend on them. */
const store = (heartbeats: Record<string, string>): Store =>
  ({
    getMeta: async (key: string, fallback = "") => heartbeats[key] ?? fallback,
    stats: async () => {
      throw new Error("catalogue scan must not run for a health probe");
    },
    sourceStats: async () => {
      throw new Error("catalogue scan must not run for a health probe");
    },
  }) as unknown as Store;

it("reports the bot healthy without scanning the catalogue", async () => {
  expect(
    await runtimeHealth(
      store({ bot_heartbeat: String(now), last_monitor_at: String(now) }),
      { monitor_seconds: 30 },
      "bot",
    ),
  ).toBe(true);
});

it("reports the bot unhealthy when its heartbeat is stale", async () => {
  expect(
    await runtimeHealth(
      store({ bot_heartbeat: String(now - 600), last_monitor_at: String(now) }),
      { monitor_seconds: 30 },
      "bot",
    ),
  ).toBe(false);
});

it("reports the worker unhealthy without a queue connection", async () => {
  expect(
    await runtimeHealth(store({ worker_heartbeat: String(now) }), { monitor_seconds: 30 }, "worker"),
  ).toBe(false);
});
