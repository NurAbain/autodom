import type { Server } from "node:http";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { Metrics } from "../src/metrics.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      server.closeAllConnections();
      return promise;
    }),
  );
});

async function exporter(
  getMeta: (key: string) => Promise<string | null>,
  role: "bot" | "worker" = "worker",
) {
  const metrics = new Metrics(role, { getMeta }, { monitor_seconds: 300 });
  const server = await metrics.serve(0, async () => true);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return { metrics, url: `http://127.0.0.1:${address.port}/metrics` };
}

function sample(text: string, name: string, source?: string): number | undefined {
  const line = text
    .split("\n")
    .find(
      (line) => line.startsWith(`${name}{`) && (!source || line.includes(`source="${source}"`)),
    );
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : undefined;
}

it("exports page success independently of empty catalogs, error state and disabled sources", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,truecar.com");
  const values: Record<string, string> = {
    "source:mashina.kg:last_success_at": "1700000000.5",
    "source:mashina.kg:catalog_total": "0",
    "source:truecar.com:source_error": "PrivateProviderError secret-data",
    worker_heartbeat: "1700000100",
  };
  const { metrics, url } = await exporter(async (key) => values[key] ?? null);
  metrics.jobs.inc({ source: "mashina.kg", outcome: "completed" });
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(sample(text, "autodom_source_last_success_timestamp_seconds", "mashina.kg")).toBe(
    1700000000.5,
  );
  expect(sample(text, "autodom_source_error", "mashina.kg")).toBe(0);
  expect(sample(text, "autodom_source_last_success_timestamp_seconds", "truecar.com")).toBe(0);
  expect(sample(text, "autodom_source_error", "truecar.com")).toBe(1);
  expect(sample(text, "autodom_source_enabled", "bid.cars")).toBe(0);
  expect(sample(text, "autodom_source_error", "bid.cars")).toBeUndefined();
  expect(sample(text, "autodom_role_heartbeat_timestamp_seconds")).toBe(1700000100);
  expect(sample(text, "autodom_state_collection_success")).toBe(1);
  expect(sample(text, "autodom_collection_jobs_total", "mashina.kg")).toBe(1);
  expect(text).not.toContain("secret-data");
});

it("accepts the exact legacy UTC format but rejects corrupt and future success timestamps", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,truecar.com,bid.cars");
  const values: Record<string, string> = {
    "source:mashina.kg:last_sync_at": "2024-01-02 03:04 UTC",
    "source:truecar.com:last_success_at": "broken",
    "source:truecar.com:last_sync_at": "2024-01-02 03:04 UTC",
    "source:bid.cars:last_success_at": String(Date.now() / 1000 + 86400),
  };
  const { url } = await exporter(async (key) => values[key] ?? null, "bot");
  const text = await (await fetch(url)).text();
  expect(sample(text, "autodom_source_last_success_timestamp_seconds", "mashina.kg")).toBe(
    Date.parse("2024-01-02T03:04:00Z") / 1000,
  );
  expect(sample(text, "autodom_source_last_success_timestamp_seconds", "truecar.com")).toBe(0);
  expect(sample(text, "autodom_source_last_success_timestamp_seconds", "bid.cars")).toBe(0);
  expect(sample(text, "autodom_monitor_timestamp_seconds")).toBe(0);
  expect(sample(text, "autodom_monitor_max_age_seconds")).toBe(600);
});

it("reports metadata errors instead of a healthy fallback", async () => {
  const { url } = await exporter(async () => {
    throw new Error("private database URL");
  });
  const text = await (await fetch(url)).text();
  expect(sample(text, "autodom_state_collection_success")).toBe(0);
  expect(sample(text, "autodom_state_collection_timestamp_seconds")).toBe(0);
  expect(sample(text, "autodom_source_error", "mashina.kg")).toBeUndefined();
  expect(text).not.toContain("private database URL");
});

it("bounds stalled scrapes, retains the in-flight query and never publishes a late partial snapshot", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const release = Promise.withResolvers<string | null>();
  let queries = 0;
  const { url } = await exporter(async () => {
    queries++;
    return release.promise;
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(url).then((response) => response.text())),
    );
    expect(responses.map((text) => sample(text, "autodom_state_collection_success"))).toEqual(
      Array(8).fill(0),
    );
    expect(queries).toBe(1);
    expect(sample(await (await fetch(url)).text(), "autodom_state_collection_success")).toBe(0);
    expect(queries).toBe(1);
    release.resolve("1700000000");
    await immediate();
    const text = await (await fetch(url)).text();
    expect(sample(text, "autodom_state_collection_timestamp_seconds")).toBe(0);
    expect(queries).toBe(1);
  } finally {
    release.resolve(null);
  }
});

it("retains the last complete observation on failure and recovers only after a new successful snapshot", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let failed = false;
  let observed = 1700000000;
  const { url } = await exporter(async (key) => {
    if (failed) throw new Error("Database unavailable");
    return key.endsWith(":last_success_at") ? String(observed) : null;
  });
  const first = await (await fetch(url)).text();
  expect(sample(first, "autodom_source_last_success_timestamp_seconds", "mashina.kg")).toBe(
    observed,
  );
  const collected = sample(first, "autodom_state_collection_timestamp_seconds");
  failed = true;
  clock.mockReturnValue(now + 6000);
  const unavailable = await (await fetch(url)).text();
  expect(sample(unavailable, "autodom_state_collection_success")).toBe(0);
  expect(sample(unavailable, "autodom_state_collection_timestamp_seconds")).toBe(collected);
  expect(sample(unavailable, "autodom_source_last_success_timestamp_seconds", "mashina.kg")).toBe(
    observed,
  );
  failed = false;
  observed += 60;
  clock.mockReturnValue(now + 12000);
  const recovered = await (await fetch(url)).text();
  expect(sample(recovered, "autodom_state_collection_success")).toBe(1);
  expect(sample(recovered, "autodom_state_collection_timestamp_seconds")).toBe(
    (now + 12000) / 1000,
  );
  expect(sample(recovered, "autodom_source_last_success_timestamp_seconds", "mashina.kg")).toBe(
    observed,
  );
});
