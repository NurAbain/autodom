import { createHmac, randomUUID } from "node:crypto";
import { Registry } from "@prometheus-io/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { ProductAnalytics } from "../src/analytics.js";
import type { AnalyticsBot, AnalyticsEvent } from "../src/analytics-contract.js";

const SECRET = "analytics-regression-shared-secret-not-production";
const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM82633A004353";
const REPORT = [
  "vin_submitted",
  "vin_completed",
  "report_offered",
  "report_checkout_started",
  "terms_accepted",
  "payment_succeeded",
  "report_delivered",
] as const;
let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Pool;
let database: pg.Pool;
let databaseName: string;
let databaseUrl: string;
const instances: ProductAnalytics[] = [];

function open(bot: AnalyticsBot = "full") {
  const analytics = new ProductAnalytics(databaseUrl, SECRET, bot);
  instances.push(analytics);
  return analytics;
}

async function durableReader() {
  await Promise.all(instances.map((analytics) => analytics.close()));
  const reader = open();
  await reader.refresh();
  return reader;
}

function report(
  actorId: number,
  contextKey: string,
  event: AnalyticsEvent["event"],
  occurredAt: number,
): AnalyticsEvent {
  return {
    actorId,
    contextKey,
    event,
    occurredAt: new Date(occurredAt),
    surface: "telegram",
    flow: "report",
    outcome: "success",
    dedupeKey: randomUUID(),
  };
}

function funnel(analytics: ProductAnalytics, flow: "buyer" | "report", window = "1d") {
  return Object.fromEntries(
    analytics
      .getSnapshot()!
      .funnels.filter(
        (row) =>
          row.funnel === flow &&
          row.window === window &&
          row.bot === "full" &&
          row.surface === "telegram",
      )
      .map((row) => [row.stage, row.value]),
  );
}

beforeAll(async () => {
  let baseUrl = process.env.AUTODOM_TEST_DATABASE_URL;
  if (!baseUrl) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    baseUrl = container.getConnectionUri();
  }
  admin = new pg.Pool({ connectionString: baseUrl });
  // Analytics deliberately owns a fixed, separate schema, so use an isolated DB
  // rather than touching the shared development database or Store migration journal.
  databaseName = `analytics_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const address = new URL(baseUrl);
  address.pathname = `/${databaseName}`;
  databaseUrl = address.toString();
  database = new pg.Pool({ connectionString: databaseUrl });
  await ProductAnalytics.migrate(databaseUrl);
}, 120_000);

beforeEach(async () => {
  await database.query(
    "TRUNCATE autodom_analytics.events, autodom_analytics.suppressions RESTART IDENTITY",
  );
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((analytics) => analytics.close()));
});
afterAll(async () => {
  await database?.end();
  if (admin && databaseName) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin?.end();
  await container?.stop();
});

it("counts ordered same-actor same-VIN cohorts instead of unrelated global conversions", async () => {
  const analytics = open();
  const now = Date.now() - 60_000;
  for (const [index, event] of REPORT.slice(0, 3).entries())
    await analytics.record(report(1, VIN_A, event, now + index * 100));
  // Neither another user nor another VIN can complete actor 1's original journey.
  for (const [index, event] of REPORT.slice(3).entries()) {
    await analytics.record(report(2, VIN_A, event, now + 1_000 + index * 100));
    await analytics.record(report(1, VIN_B, event, now + 1_000 + index * 100));
  }
  // Receipt/reconciliation order differs from actual event chronology.
  for (const [index, event] of [...REPORT.entries()].reverse())
    await analytics.record(report(3, VIN_A, event, now + index * 100));
  await analytics.record(report(4, VIN_A, "vin_submitted", now));
  await analytics.record(report(4, VIN_A, "report_offered", now + 100));
  await analytics.record(report(4, VIN_A, "vin_completed", now + 200));
  for (const [index, event] of REPORT.slice(3).entries())
    await analytics.record(report(4, VIN_A, event, now + 1_000 + index * 100));
  const reader = await durableReader();
  expect(funnel(reader, "report")).toEqual({
    vin_submitted: 3,
    vin_completed: 3,
    report_offered: 2,
    report_checkout_started: 1,
    terms_accepted: 1,
    payment_succeeded: 1,
    report_delivered: 1,
  });
});

it("does not use database insertion order to break millisecond timestamp ties", async () => {
  const analytics = open();
  const now = Date.now() - 1_000;
  // Immediate Mini App completion/offer can share the same JS timestamp, and
  // pool scheduling or ledger replay can insert them in reverse order.
  for (const event of [...REPORT].reverse()) await analytics.record(report(1, VIN_A, event, now));
  const reader = await durableReader();
  expect(funnel(reader, "report")).toEqual(Object.fromEntries(REPORT.map((event) => [event, 1])));
});

it("uses rolling start cohorts and requires a results-bearing buyer search after profile save", async () => {
  const analytics = open();
  const now = Date.now() - 60_000;
  await analytics.record(report(1, VIN_A, "vin_submitted", now - 2 * 86_400_000));
  await analytics.record(report(1, VIN_A, "vin_submitted", now));
  await analytics.record(report(1, VIN_A, "vin_completed", now + 100));
  await analytics.record(report(2, VIN_A, "vin_submitted", now - 31 * 86_400_000));
  await analytics.record(report(2, VIN_A, "vin_completed", now + 100));
  const buyer = async (
    actorId: number,
    event: AnalyticsEvent["event"],
    offset: number,
    outcome: NonNullable<AnalyticsEvent["outcome"]> = "success",
  ) => {
    await analytics.record({
      actorId,
      event,
      surface: "telegram",
      flow: event === "bot_started" ? "navigation" : "buyer",
      outcome,
      occurredAt: new Date(now + offset),
    });
  };
  await buyer(10, "bot_started", 0);
  await buyer(10, "profile_step", 100);
  await buyer(10, "profile_saved", 200);
  await buyer(10, "search_completed", 300, "results");
  await buyer(11, "profile_step", 100);
  await buyer(11, "profile_saved", 200);
  await buyer(11, "search_completed", 300, "empty");
  await buyer(12, "profile_step", 100);
  await buyer(12, "search_completed", 200, "results");
  await buyer(12, "profile_saved", 300);
  await buyer(13, "bot_started", 0);
  await buyer(13, "profile_saved", 200);
  await buyer(13, "search_completed", 300, "results");
  const reader = await durableReader();
  expect(funnel(reader, "report", "1d")).toEqual({});
  expect(funnel(reader, "report", "7d")).toEqual({
    vin_submitted: 1,
    vin_completed: 1,
    report_offered: 0,
    report_checkout_started: 0,
    terms_accepted: 0,
    payment_succeeded: 0,
    report_delivered: 0,
  });
  expect(funnel(reader, "report", "30d")).toEqual(funnel(reader, "report", "7d"));
  expect(funnel(reader, "buyer")).toEqual({
    profile_step: 3,
    profile_saved: 3,
    search_completed: 1,
  });
});

it("deduplicates actor-scoped replays across modes and restarts without persisting raw identifiers", async () => {
  const full = open();
  const vin = open("vin");
  const now = Date.now() - 60_000;
  const event = {
    ...report(981234567, VIN_A, "feedback_submitted", now),
    outcome: "positive" as const,
    reason: "convenience" as const,
    dedupeKey: `feedback:${VIN_A}:positive`,
  };
  await full.record(event);
  await full.close();
  await vin.record({ ...event, surface: "miniapp" });
  await ProductAnalytics.migrate(databaseUrl);
  const restarted = open();
  await restarted.record(event);
  await restarted.record({ ...event, actorId: 981234568 });
  await vin.record(report(981234567, VIN_B, "vin_submitted", now));
  const reader = await durableReader();
  const stored = await database.query("SELECT * FROM autodom_analytics.events ORDER BY id");
  expect(stored.rows.filter((row) => row.event === "feedback_submitted")).toHaveLength(2);
  expect(new Set(stored.rows.map((row) => row.actor_key)).size).toBe(2);
  expect(stored.rows[0].actor_key).toBe(
    stored.rows.find((row) => row.event === "vin_submitted").actor_key,
  );
  const persisted = JSON.stringify(stored.rows);
  for (const sensitive of [VIN_A, VIN_B, "981234567", "981234568", event.dedupeKey, SECRET])
    expect(persisted).not.toContain(sensitive);
  const registry = new Registry();
  reader.attachMetrics(registry);
  const metrics = await registry.metrics();
  for (const sensitive of [
    VIN_A,
    VIN_B,
    "981234567",
    event.dedupeKey,
    SECRET,
    stored.rows[0].actor_key,
  ])
    expect(metrics).not.toContain(sensitive);
  expect(reader.getSnapshot()!.reasons).toContainEqual({
    bot: "full",
    surface: "telegram",
    window: "1d",
    event: "feedback_submitted",
    outcome: "positive",
    reason: "convenience",
    value: 2,
  });
  await expect(
    database.query("UPDATE autodom_analytics.events SET reason = 'raw private free text'"),
  ).rejects.toMatchObject({ code: "23514" });
});

it("purges both modes and permanently suppresses historical ledger and future event replays", async () => {
  const full = open();
  const vin = open("vin");
  const now = Date.now() - 60_000;
  await full.record(report(1, VIN_A, "vin_submitted", now));
  await vin.record(report(1, VIN_A, "payment_succeeded", now + 100));
  await full.record(report(2, VIN_A, "vin_submitted", now));
  expect(await full.forget(1)).toBe(true);
  await full.close();
  const restarted = open();
  await restarted.record(report(1, VIN_B, "vin_submitted", now + 200));
  await vin.record(report(1, VIN_A, "payment_succeeded", now + 100));
  await restarted.record(report(1, VIN_A, "report_delivered", now + 300));
  await restarted.record(report(3, VIN_B, "report_delivered", now));
  await Promise.all([vin.close(), restarted.close()]);
  await database.query(
    "UPDATE autodom_analytics.events SET occurred_at = now() - interval '91 days' WHERE event = 'report_delivered'",
  );
  await database.query(
    "UPDATE autodom_analytics.suppressions SET suppressed_at = now() - interval '100 days'",
  );
  const reader = open();
  await reader.refresh();
  const rows = await database.query("SELECT event FROM autodom_analytics.events");
  expect(rows.rows).toEqual([{ event: "vin_submitted" }]);
  expect(
    (await database.query("SELECT count(*)::int AS count FROM autodom_analytics.suppressions"))
      .rows,
  ).toEqual([{ count: 1 }]);
  expect(await reader.forget(1)).toBe(true);
});

it("bounds fail-open caller latency without releasing unsettled capacity, and never publishes failed refreshes as zeros", async () => {
  const analytics = open();
  const registry = new Registry();
  analytics.attachMetrics(registry);
  const now = Date.now() - 60_000;
  const writer = open();
  await writer.record(report(2, VIN_A, "vin_submitted", now));
  await writer.close();
  await analytics.refresh();
  const snapshot = analytics.getSnapshot();
  const lock = await database.connect();
  const actor = createHmac("sha256", SECRET)
    .update(JSON.stringify(["actor", "1"]))
    .digest("hex");
  const lockKey = BigInt.asIntN(64, BigInt(`0x${actor.slice(0, 16)}`)).toString();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 40 }, () => analytics.record(report(1, VIN_A, "vin_submitted", now))),
    );
    expect(performance.now() - started).toBeLessThan(750);
    const inflight = await registry.getSingleMetric("autodom_product_in_flight")!.get();
    expect(inflight.values[0]!.value).toBe(16);
    const diagnostics = await registry.getSingleMetric("autodom_product_operations_total")!.get();
    expect(
      diagnostics.values.find(
        (row) => row.labels.operation === "record" && row.labels.result === "saturated",
      )!.value,
    ).toBe(24);
    expect(
      diagnostics.values.find(
        (row) => row.labels.operation === "record" && row.labels.result === "timeout",
      )!.value,
    ).toBe(16);
    await analytics.refresh();
    expect(analytics.getSnapshot()).toBe(snapshot);
    const collection = await registry.getSingleMetric("autodom_product_collection_success")!.get();
    expect(collection.values[0]!.value).toBe(0);
    expect(await analytics.forget(1)).toBe(false);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  // Closing drains underlying operations, including those whose callers returned.
  await analytics.close();
  expect(
    (await registry.getSingleMetric("autodom_product_in_flight")!.get()).values[0]!.value,
  ).toBe(0);
  const restarted = open();
  expect(await restarted.forget(1)).toBe(true);
  expect(
    (await database.query("SELECT count(*)::int AS count FROM autodom_analytics.events")).rows,
  ).toEqual([{ count: 1 }]);
});
