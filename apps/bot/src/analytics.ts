import { createHmac, randomUUID } from "node:crypto";
import { Counter, Gauge, type Registry } from "@prometheus-io/client";
import pg from "pg";
import {
  ANALYTICS_EVENTS,
  ANALYTICS_OUTCOMES,
  ANALYTICS_REASONS,
  ANALYTICS_STEPS,
  type AnalyticsBot,
  type AnalyticsEvent,
  type AnalyticsRecorder,
  type AnalyticsSurface,
} from "./analytics-contract.js";

const SURFACES = ["telegram", "miniapp", "web", "system"] as const;
const FLOWS = ["report", "buyer", "seller", "navigation"] as const;
const RETENTION_MS = 90 * 86_400_000;
const MAX_ADMITTED = 16;
const REPORT_STAGES = [
  "vin_submitted",
  "vin_completed",
  "report_offered",
  "report_checkout_started",
  "terms_accepted",
  "payment_succeeded",
  "report_delivered",
] as const;
const BUYER_STAGES = ["profile_step", "profile_saved", "search_completed"] as const;
type Window = "1d" | "7d" | "30d";
type Operation = "record" | "forget" | "refresh" | "pool";
type Result =
  | "success"
  | "duplicate"
  | "suppressed"
  | "invalid"
  | "expired"
  | "saturated"
  | "timeout"
  | "closed"
  | "unavailable"
  | "schema_missing";
type Dimensions = { bot: AnalyticsBot; surface: AnalyticsSurface; window: Window };
export interface AnalyticsSnapshot {
  collectedAt: Date;
  events: (Dimensions & { event: string; outcome: string; step: string; value: number })[];
  users: (Dimensions & { value: number })[];
  funnels: (Dimensions & { funnel: "report" | "buyer"; stage: string; value: number })[];
  reasons: (Dimensions & { event: string; outcome: string; reason: string; value: number })[];
}

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const SCHEMA_SQL = `
CREATE TABLE autodom_analytics.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_key text NOT NULL CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  journey_key text NOT NULL CHECK (journey_key ~ '^[0-9a-f]{64}$'),
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  bot text NOT NULL CHECK (bot IN ('vin', 'full')),
  surface text NOT NULL CHECK (surface IN (${sqlList(SURFACES)})),
  flow text NOT NULL CHECK (flow IN (${sqlList(FLOWS)})),
  event text NOT NULL CHECK (event IN (${sqlList(ANALYTICS_EVENTS)})),
  outcome text CHECK (outcome IN (${sqlList(ANALYTICS_OUTCOMES)})),
  step text CHECK (step IN (${sqlList(ANALYTICS_STEPS)})),
  reason text CHECK (reason IN (${sqlList(ANALYTICS_REASONS)})),
  report_kind text CHECK (report_kind IN ('korea', 'carfax')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_time ON autodom_analytics.events (occurred_at);
CREATE INDEX events_actor ON autodom_analytics.events (actor_key);
CREATE INDEX events_journey ON autodom_analytics.events (journey_key, event, occurred_at, id);
CREATE TABLE autodom_analytics.suppressions (
  actor_key text PRIMARY KEY CHECK (actor_key ~ '^[0-9a-f]{64}$'),
  suppressed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`;

const WINDOWS_SQL = `windows(window_name, since) AS (
  VALUES ('1d', $1::timestamptz - interval '1 day'),
         ('7d', $1::timestamptz - interval '7 days'),
         ('30d', $1::timestamptz - interval '30 days')
)`;

// Event time, not insertion order, defines the cohort. JS/ledger timestamps have
// millisecond precision; concurrent writes and replay may reverse equal-time IDs.
function funnelSql(flow: "report" | "buyer", stages: readonly string[]): string {
  const joins = stages
    .slice(1)
    .map((event, index) => {
      const previous = index === 0 ? "s" : `p${index}`;
      return `LEFT JOIN LATERAL (
      SELECT e.occurred_at, e.id FROM autodom_analytics.events e
      WHERE e.journey_key = s.journey_key AND e.flow = '${flow}' AND e.event = '${event}'
        AND e.occurred_at >= ${previous}.occurred_at
        AND e.occurred_at <= $1::timestamptz
        AND (e.outcome IS NULL OR e.outcome IN ('success', 'results', 'available', 'partial'))
        ${flow === "buyer" && event === "search_completed" ? "AND e.outcome = 'results'" : ""}
      ORDER BY e.occurred_at, e.id LIMIT 1
    ) p${index + 1} ON true`;
    })
    .join("\n");
  const counts = stages
    .map((stage, index) => `('${stage}', ${index === 0 ? "s.id" : `p${index}.id`} IS NOT NULL)`)
    .join(", ");
  return `WITH ${WINDOWS_SQL}, starts AS (
    SELECT DISTINCT ON (journey_key) journey_key, bot, surface, occurred_at, id
    FROM autodom_analytics.events
    WHERE flow = '${flow}' AND event = '${stages[0]}'
      AND occurred_at >= $1::timestamptz - interval '90 days' AND occurred_at <= $1::timestamptz
      AND (outcome IS NULL OR outcome IN ('success', 'results', 'available', 'partial'))
    ORDER BY journey_key, occurred_at, id
  )
  SELECT s.bot, s.surface, w.window_name AS "window", '${flow}' AS funnel, stage.name AS stage,
         count(*) FILTER (WHERE stage.reached)::float8 AS value
  FROM starts s JOIN windows w ON s.occurred_at >= w.since
  ${joins}
  CROSS JOIN LATERAL (VALUES ${counts}) stage(name, reached)
  GROUP BY s.bot, s.surface, w.window_name, stage.name`;
}

const REPORT_FUNNEL_SQL = funnelSql("report", REPORT_STAGES);
const BUYER_FUNNEL_SQL = funnelSql("buyer", BUYER_STAGES);

function configuration(databaseUrl: string): void {
  try {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error("Product analytics requires a valid PostgreSQL database URL");
  }
}

function failure(error: unknown): Result {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "3F000" ? "schema_missing" : "unavailable";
}

export class ProductAnalytics implements AnalyticsRecorder {
  private readonly pool: pg.Pool;
  private admitted = 0;
  private closing = false;
  private closingPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private snapshot: AnalyticsSnapshot | undefined;
  private collectionSuccess = false;
  private nextCleanup = 0;
  private privacyBlocked = false;
  private readonly pendingPrivacy = new Set<string>();
  private privacyEpoch = 0;
  private resolveDrain: (() => void) | undefined;
  private readonly diagnostics = new Map<string, number>();
  private metrics:
    | {
        events: Gauge<"bot" | "surface" | "window" | "event" | "outcome" | "step">;
        users: Gauge<"bot" | "surface" | "window">;
        funnels: Gauge<"bot" | "surface" | "window" | "funnel" | "stage">;
        reasons: Gauge<"bot" | "surface" | "window" | "event" | "outcome" | "reason">;
        success: Gauge;
        timestamp: Gauge;
        inFlight: Gauge;
        operations: Counter<"operation" | "result">;
      }
    | undefined;

  constructor(
    databaseUrl: string,
    private readonly secret: string,
    private readonly bot: AnalyticsBot,
  ) {
    configuration(databaseUrl);
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
      throw new Error("Product analytics requires a shared HMAC secret of at least 32 bytes");
    if (bot !== "vin" && bot !== "full")
      throw new Error("Product analytics bot must be vin or full");
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
      idle_in_transaction_session_timeout: 5_000,
      allowExitOnIdle: true,
      application_name: "autodom-product-analytics",
    });
    this.pool.on("error", () => this.diagnose("pool", "unavailable"));
  }

  /** Explicit additive migration, never called by the constructor or refresh. */
  static async migrate(databaseUrl: string): Promise<void> {
    configuration(databaseUrl);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 10_000,
      query_timeout: 12_000,
    });
    pool.on("error", () => {});
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1735289201, 1)");
      await client.query("CREATE SCHEMA IF NOT EXISTS autodom_analytics");
      await client.query(`CREATE TABLE IF NOT EXISTS autodom_analytics.schema_version (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL CHECK (version > 0)
      )`);
      const version = await client.query<{ version: number }>(
        "SELECT version FROM autodom_analytics.schema_version WHERE singleton",
      );
      if (version.rows[0] && version.rows[0].version !== 1) throw new Error("unsupported version");
      if (!version.rows.length) {
        await client.query(SCHEMA_SQL);
        await client.query("INSERT INTO autodom_analytics.schema_version(version) VALUES (1)");
      }
      await client.query("COMMIT");
    } catch {
      throw new Error(
        "Product analytics migration failed: verify database access, schema privileges, and supported schema version (1)",
      );
    } finally {
      if (client) await ProductAnalytics.release(client, true);
      await pool.end();
    }
  }

  private hash(...parts: string[]): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(parts)).digest("hex");
  }

  private diagnose(operation: Operation, result: Result): void {
    const key = `${operation}:${result}`;
    this.diagnostics.set(key, (this.diagnostics.get(key) ?? 0) + 1);
    this.metrics?.operations.inc({ operation, result });
  }

  // pg's client query timeout can reject while its socket is still executing.
  // Destroy and await that socket before relinquishing the admission slot.
  private static async release(client: pg.PoolClient, destroy: boolean): Promise<void> {
    if (!destroy) {
      client.release();
      return;
    }
    try {
      await client.end();
    } finally {
      client.release(true);
    }
  }

  private async respondWithin<T>(
    operation: Operation,
    pending: Promise<T>,
    milliseconds: number,
  ): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            this.diagnose(operation, "timeout");
            resolve(undefined);
          }, milliseconds);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute<T>(
    operation: Operation,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.closing || this.admitted >= MAX_ADMITTED) {
      this.diagnose(operation, this.closing ? "closed" : "saturated");
      return undefined;
    }
    this.admitted++;
    this.metrics?.inFlight.set(this.admitted);
    let client: pg.PoolClient | undefined;
    let destroy = false;
    try {
      client = await this.pool.connect();
      return await work(client);
    } catch (error) {
      destroy = true;
      this.diagnose(operation, failure(error));
      return undefined;
    } finally {
      try {
        if (client) await ProductAnalytics.release(client, destroy);
      } catch {
        this.diagnose(operation, "unavailable");
      }
      this.admitted--;
      this.metrics?.inFlight.set(this.admitted);
      if (this.admitted === 0) this.resolveDrain?.();
    }
  }

  async record(event: AnalyticsEvent): Promise<void> {
    try {
      if (this.privacyBlocked) {
        this.diagnose("record", "suppressed");
        return;
      }
      if (
        !Number.isSafeInteger(event.actorId) ||
        event.actorId <= 0 ||
        !ANALYTICS_EVENTS.includes(event.event) ||
        !SURFACES.includes(event.surface) ||
        !FLOWS.includes(event.flow) ||
        (event.outcome !== undefined && !ANALYTICS_OUTCOMES.includes(event.outcome)) ||
        (event.step !== undefined && !ANALYTICS_STEPS.includes(event.step)) ||
        (event.reason !== undefined && !ANALYTICS_REASONS.includes(event.reason)) ||
        (event.reportKind !== undefined &&
          event.reportKind !== "korea" &&
          event.reportKind !== "carfax") ||
        (event.dedupeKey !== undefined &&
          (typeof event.dedupeKey !== "string" || event.dedupeKey.length > 512))
      ) {
        this.diagnose("record", "invalid");
        return;
      }
      const occurredAt = event.occurredAt ?? new Date();
      if (
        !(occurredAt instanceof Date) ||
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.getTime() > Date.now() + 60_000
      ) {
        this.diagnose("record", "invalid");
        return;
      }
      if (occurredAt.getTime() < Date.now() - RETENTION_MS) {
        this.diagnose("record", "expired");
        return;
      }
      const actor = this.hash("actor", String(event.actorId));
      if (this.pendingPrivacy.has(actor)) {
        this.diagnose("record", "suppressed");
        return;
      }
      const context =
        typeof event.contextKey === "string" && event.contextKey.length <= 64
          ? event.contextKey.trim().toUpperCase()
          : "";
      const journey = this.hash(
        "journey",
        actor,
        event.flow,
        event.flow === "report"
          ? /^[A-HJ-NPR-Z0-9]{17}$/.test(context)
            ? context
            : randomUUID()
          : "",
      );
      const dedupe = this.hash(
        "dedupe",
        actor,
        event.flow,
        event.event,
        event.dedupeKey ?? randomUUID(),
      );
      await this.respondWithin(
        "record",
        this.execute("record", async (client) => {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
            BigInt.asIntN(64, BigInt(`0x${actor.slice(0, 16)}`)).toString(),
          ]);
          const suppressed = await client.query(
            "SELECT 1 FROM autodom_analytics.suppressions WHERE actor_key = $1",
            [actor],
          );
          let result: Result = "suppressed";
          if (!suppressed.rowCount && !this.privacyBlocked && !this.pendingPrivacy.has(actor)) {
            const inserted = await client.query(
              `INSERT INTO autodom_analytics.events
            (actor_key, journey_key, dedupe_key, bot, surface, flow, event, outcome, step, reason, report_kind, occurred_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (dedupe_key) DO NOTHING`,
              [
                actor,
                journey,
                dedupe,
                this.bot,
                event.surface,
                event.flow,
                event.event,
                event.outcome ?? null,
                event.step ?? null,
                event.reason ?? null,
                event.reportKind ?? null,
                occurredAt,
              ],
            );
            result = inserted.rowCount ? "success" : "duplicate";
          }
          await client.query("COMMIT");
          this.diagnose("record", result);
        }),
        150,
      );
    } catch {
      this.diagnose("record", "invalid");
    }
  }

  async forget(actorId: number): Promise<boolean> {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) {
      this.diagnose("forget", "invalid");
      return false;
    }
    const actor = this.hash("actor", String(actorId));
    // Keep local failures suppressed without an unbounded retry queue. Overflow is
    // conservatively fail-closed for this process, never permission to resume capture.
    if (this.pendingPrivacy.size < 1024) this.pendingPrivacy.add(actor);
    else this.privacyBlocked = true;
    this.invalidatePrivacySnapshot();
    const deleted = await this.respondWithin(
      "forget",
      this.execute("forget", async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          BigInt.asIntN(64, BigInt(`0x${actor.slice(0, 16)}`)).toString(),
        ]);
        await client.query(
          "INSERT INTO autodom_analytics.suppressions(actor_key) VALUES ($1) ON CONFLICT DO NOTHING",
          [actor],
        );
        await client.query("DELETE FROM autodom_analytics.events WHERE actor_key = $1", [actor]);
        await client.query("COMMIT");
        this.pendingPrivacy.delete(actor);
        this.invalidatePrivacySnapshot();
        this.diagnose("forget", "success");
        return true;
      }),
      2_000,
    );
    return deleted === true;
  }

  private invalidatePrivacySnapshot(): void {
    this.privacyEpoch++;
    this.snapshot = undefined;
    this.collectionSuccess = false;
    this.publish();
  }

  privacyReady(): boolean {
    return !this.privacyBlocked && this.pendingPrivacy.size === 0;
  }
  getSnapshot(): AnalyticsSnapshot | undefined {
    return this.snapshot;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.collect().finally(() => {
      this.refreshPromise = undefined;
    });
    this.refreshPromise = pending;
    return pending;
  }

  private async collect(): Promise<void> {
    const privacyEpoch = this.privacyEpoch;
    const now = new Date();
    const snapshot = await this.execute("refresh", async (client): Promise<AnalyticsSnapshot> => {
      if (now.getTime() >= this.nextCleanup) {
        const deleted = await client.query(
          `DELETE FROM autodom_analytics.events WHERE id IN (
          SELECT id FROM autodom_analytics.events WHERE occurred_at < $1::timestamptz - interval '90 days'
          ORDER BY occurred_at LIMIT 10000
        )`,
          [now],
        );
        this.nextCleanup = now.getTime() + (deleted.rowCount === 10000 ? 300_000 : 86_400_000);
      }
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const events = await client.query<AnalyticsSnapshot["events"][number]>(
        `WITH ${WINDOWS_SQL}
        SELECT e.bot, e.surface, w.window_name AS "window", e.event, coalesce(e.outcome, 'none') AS outcome,
               coalesce(e.step, 'none') AS step, count(*)::float8 AS value
        FROM autodom_analytics.events e JOIN windows w ON e.occurred_at >= w.since
        WHERE e.occurred_at <= $1::timestamptz GROUP BY e.bot, e.surface, w.window_name, e.event, e.outcome, e.step`,
        [now],
      );
      const users = await client.query<AnalyticsSnapshot["users"][number]>(
        `WITH ${WINDOWS_SQL}
        SELECT e.bot, e.surface, w.window_name AS "window", count(DISTINCT e.actor_key)::float8 AS value
        FROM autodom_analytics.events e JOIN windows w ON e.occurred_at >= w.since
        WHERE e.occurred_at <= $1::timestamptz GROUP BY e.bot, e.surface, w.window_name`,
        [now],
      );
      const reasons = await client.query<AnalyticsSnapshot["reasons"][number]>(
        `WITH ${WINDOWS_SQL}
        SELECT e.bot, e.surface, w.window_name AS "window", e.event, coalesce(e.outcome, 'none') AS outcome, e.reason, count(*)::float8 AS value
        FROM autodom_analytics.events e JOIN windows w ON e.occurred_at >= w.since
        WHERE e.occurred_at <= $1::timestamptz AND e.reason IS NOT NULL
        GROUP BY e.bot, e.surface, w.window_name, e.event, e.outcome, e.reason`,
        [now],
      );
      const report = await client.query<AnalyticsSnapshot["funnels"][number]>(REPORT_FUNNEL_SQL, [
        now,
      ]);
      const buyer = await client.query<AnalyticsSnapshot["funnels"][number]>(BUYER_FUNNEL_SQL, [
        now,
      ]);
      await client.query("COMMIT");
      return {
        collectedAt: now,
        events: events.rows,
        users: users.rows,
        reasons: reasons.rows,
        funnels: [...report.rows, ...buyer.rows],
      };
    });
    this.collectionSuccess =
      snapshot !== undefined && privacyEpoch === this.privacyEpoch && this.privacyReady();
    if (snapshot && this.collectionSuccess) {
      this.snapshot = snapshot;
      this.diagnose("refresh", "success");
    }
    this.publish();
  }

  attachMetrics(registry: Registry): void {
    if (this.metrics) throw new Error("Product analytics metrics are already attached");
    this.metrics = {
      events: new Gauge({
        name: "autodom_product_events",
        help: "Retained product events in a rolling window; check collection success and timestamp",
        labelNames: ["bot", "surface", "window", "event", "outcome", "step"],
        registers: [registry],
      }),
      users: new Gauge({
        name: "autodom_product_active_users",
        help: "Distinct actors per bot and surface, not additive across dimensions",
        labelNames: ["bot", "surface", "window"],
        registers: [registry],
      }),
      funnels: new Gauge({
        name: "autodom_product_funnel",
        help: "Ordered same-journey cohort stage counts, attributed to the starting bot and surface",
        labelNames: ["bot", "surface", "window", "funnel", "stage"],
        registers: [registry],
      }),
      reasons: new Gauge({
        name: "autodom_product_reasons",
        help: "Observed finite reasons, never inferred abandonment reasons",
        labelNames: ["bot", "surface", "window", "event", "outcome", "reason"],
        registers: [registry],
      }),
      success: new Gauge({
        name: "autodom_product_collection_success",
        help: "Whether the latest complete analytics snapshot succeeded; zero means unknown, not zero traffic",
        registers: [registry],
      }),
      timestamp: new Gauge({
        name: "autodom_product_collection_timestamp_seconds",
        help: "UNIX timestamp of the last complete analytics snapshot",
        registers: [registry],
      }),
      inFlight: new Gauge({
        name: "autodom_product_in_flight",
        help: "Admitted analytics operations, bounded to 16 with a separate two-connection pool",
        registers: [registry],
      }),
      operations: new Counter({
        name: "autodom_product_operations_total",
        help: "Bounded analytics diagnostics without error messages or identifiers",
        labelNames: ["operation", "result"],
        registers: [registry],
      }),
    };
    for (const [key, count] of this.diagnostics) {
      const [operation, result] = key.split(":");
      this.metrics.operations.inc({ operation: operation!, result: result! }, count);
    }
    this.metrics.inFlight.set(this.admitted);
    this.publish();
  }

  private publish(): void {
    if (!this.metrics) return;
    const m = this.metrics;
    m.success.set(this.collectionSuccess ? 1 : 0);
    if (!this.snapshot) {
      m.events.reset();
      m.users.reset();
      m.funnels.reset();
      m.reasons.reset();
      m.timestamp.reset();
      return;
    }
    m.timestamp.set(this.snapshot.collectedAt.getTime() / 1000);
    m.events.reset();
    m.users.reset();
    m.funnels.reset();
    m.reasons.reset();
    for (const { value, ...labels } of this.snapshot.events) m.events.set(labels, value);
    for (const { value, ...labels } of this.snapshot.users) m.users.set(labels, value);
    for (const { value, ...labels } of this.snapshot.funnels) m.funnels.set(labels, value);
    for (const { value, ...labels } of this.snapshot.reasons) m.reasons.set(labels, value);
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closingPromise = (async () => {
      if (this.admitted)
        await new Promise<void>((resolve) => {
          this.resolveDrain = resolve;
        });
      await this.pool.end();
    })().catch(() => {
      this.diagnose("pool", "unavailable");
    });
    return this.closingPromise;
  }
}
