import { createServer, type Server } from "node:http";
import { enabledSources, type RequestOutcome, type Settings, SOURCE_IDS } from "@autodom/core";
import type { Store } from "@autodom/storage";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";

// A timed-out query retains its slot until it actually settles. A new scrape
// cannot enqueue more DB work, and a late query cannot publish a partial snapshot.
function singleFlight<T>(collect: (signal: AbortSignal) => Promise<T>): () => Promise<T> {
  let flight: Promise<T> | undefined;
  let running = false;
  let retryAt = 0;
  return () => {
    if (flight && (running || Date.now() < retryAt)) return flight;
    const abort = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    flight = promise;
    running = true;
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error("Metrics state collection timed out"));
    }, 1_500);
    const settled = () => {
      clearTimeout(timer);
      running = false;
      retryAt = Date.now() + 5_000;
    };
    void Promise.resolve()
      .then(() => collect(abort.signal))
      .then(
        (value) => {
          settled();
          resolve(value);
        },
        (error: unknown) => {
          settled();
          reject(error);
        },
      );
    return promise;
  };
}

function timestamp(value: string | null, now: number): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= now ? parsed : 0;
}

function legacyTimestamp(value: string | null, now: number): number {
  // recordPage used this exact UTC minute format before numeric observations.
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/u.test(value)) return 0;
  const iso = `${value.slice(0, 16).replace(" ", "T")}:00.000Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) return 0;
  return timestamp(String(parsed / 1000), now);
}
export class Metrics {
  readonly registry = new Registry();
  readonly requests: Counter<"source" | "tier" | "outcome">;
  readonly jobs: Counter<"source" | "outcome">;
  readonly jobDuration: Histogram<"source" | "outcome">;
  readonly queueJobs: Gauge<"source" | "state">;
  readonly queueSuccess: Gauge;
  readonly queueTimestamp: Gauge;
  private readonly httpRequests: Counter<"route" | "method" | "status">;
  private readonly httpDuration: Histogram<"route" | "method" | "status">;
  private readonly telegramUpdates: Counter<"outcome">;
  private readonly telegramDuration: Histogram<"outcome">;
  private readonly monitorIterations: Counter<"outcome">;
  private readonly monitorDuration: Histogram<"outcome">;
  private readonly notificationDeliveries: Counter<"outcome">;
  private readonly collectState: () => Promise<void>;
  private readonly stateSuccess: Gauge;
  constructor(
    role: "bot" | "worker" | "run",
    store: Pick<Store, "getMeta">,
    settings: Pick<Settings, "monitor_seconds">,
  ) {
    this.registry.setDefaultLabels({ application: "autodom", role });
    collectDefaultMetrics({ register: this.registry, prefix: "autodom_" });
    this.requests = new Counter({
      name: "autodom_source_requests_total",
      help: "Source request attempts through configured proxies",
      labelNames: ["source", "tier", "outcome"],
      registers: [this.registry],
    });
    this.jobs = new Counter({
      name: "autodom_collection_jobs_total",
      help: "Durable source job outcomes",
      labelNames: ["source", "outcome"],
      registers: [this.registry],
    });
    this.jobDuration = new Histogram({
      name: "autodom_collection_job_duration_seconds",
      help: "Source job execution duration including collection and rate-limit bookkeeping",
      labelNames: ["source", "outcome"],
      buckets: [0.1, 1, 5, 15, 30, 60, 120, 300, 600, 1800],
      registers: [this.registry],
    });
    this.queueJobs = new Gauge({
      name: "autodom_collection_queue_jobs",
      help: "Jobs in the last complete Redis queue snapshot; check collection success and age",
      labelNames: ["source", "state"],
      registers: [this.registry],
    });
    this.queueSuccess = new Gauge({
      name: "autodom_queue_collection_success",
      help: "Whether the latest bounded Redis queue snapshot succeeded (worker role only)",
      registers: [this.registry],
    });
    this.queueTimestamp = new Gauge({
      name: "autodom_queue_collection_timestamp_seconds",
      help: "UNIX timestamp of the last complete Redis queue snapshot (worker role only)",
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: "autodom_http_requests_total",
      help: "Terminal HTTP requests, including clients aborted before response completion",
      labelNames: ["route", "method", "status"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: "autodom_http_request_duration_seconds",
      help: "HTTP request duration until response completion or client abort",
      labelNames: ["route", "method", "status"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.registry],
    });
    this.telegramUpdates = new Counter({
      name: "autodom_telegram_updates_total",
      help: "Telegram updates handled by the polling sink",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.telegramDuration = new Histogram({
      name: "autodom_telegram_update_duration_seconds",
      help: "Telegram update handling duration, excluding polling and admission wait",
      labelNames: ["outcome"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.registry],
    });
    this.monitorIterations = new Counter({
      name: "autodom_monitor_iterations_total",
      help: "Notification monitor iterations; success does not imply a notification was sent",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.monitorDuration = new Histogram({
      name: "autodom_monitor_iteration_duration_seconds",
      help: "Notification monitor iteration duration including retries, excluding interval sleep",
      labelNames: ["outcome"],
      buckets: [0.01, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });
    this.notificationDeliveries = new Counter({
      name: "autodom_notification_deliveries_total",
      help: "Actual notification batch send outcomes; cursor-only changes are not deliveries",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    const gauge = (name: string, help: string) =>
      new Gauge({ name, help, registers: [this.registry] });
    const sourceGauge = (name: string, help: string) =>
      new Gauge({
        name,
        help,
        labelNames: ["source"] as const,
        registers: [this.registry],
      });
    const enabled = sourceGauge(
      "autodom_source_enabled",
      "Operator-enabled collection source (1 enabled, 0 disabled)",
    );
    const lastSuccess = sourceGauge(
      "autodom_source_last_success_timestamp_seconds",
      "Last successful page observation in UNIX seconds; 0 means never observed or invalid metadata",
    );
    const sourceError = sourceGauge(
      "autodom_source_error",
      "Whether the last source attempt recorded an error; independent of catalog size",
    );
    const heartbeat = gauge(
      "autodom_role_heartbeat_timestamp_seconds",
      "Role maintenance heartbeat in UNIX seconds; 0 means unknown or invalid",
    );
    const monitor =
      role === "worker"
        ? undefined
        : gauge(
            "autodom_monitor_timestamp_seconds",
            "Last notification monitor iteration start in UNIX seconds; not delivery success",
          );
    if (monitor)
      gauge("autodom_monitor_max_age_seconds", "Configured maximum monitor heartbeat age").set(
        Math.max(120, settings.monitor_seconds * 2),
      );
    this.stateSuccess = gauge(
      "autodom_state_collection_success",
      "Whether the latest bounded metadata collection succeeded",
    );
    const collectedAt = gauge(
      "autodom_state_collection_timestamp_seconds",
      "UNIX timestamp of the last complete metadata snapshot",
    );
    const sources = enabledSources();
    for (const source of SOURCE_IDS) {
      enabled.set({ source }, sources.some((candidate) => candidate.id === source) ? 1 : 0);
    }
    this.collectState = singleFlight(async (signal) => {
      const read = async (key: string) => {
        signal.throwIfAborted();
        const value = await store.getMeta(key);
        signal.throwIfAborted();
        return value;
      };
      const now = Date.now() / 1000;
      const observed = [];
      for (const source of sources) {
        const prefix = `source:${source.id}:`;
        const numeric = await read(`${prefix}last_success_at`);
        // Only missing new metadata permits legacy fallback; corrupt new values
        // must not disguise lost freshness with an older, plausible date.
        const success =
          numeric === null
            ? legacyTimestamp(await read(`${prefix}last_sync_at`), now)
            : timestamp(numeric, now);
        const error = await read(`${prefix}source_error`);
        observed.push({ source: source.id, success, error: error ? 1 : 0 });
      }
      const beat = timestamp(await read(`${role === "run" ? "runtime" : role}_heartbeat`), now);
      const monitorAt = monitor ? timestamp(await read("last_monitor_at"), now) : 0;
      signal.throwIfAborted();
      for (const observation of observed) {
        lastSuccess.set({ source: observation.source }, observation.success);
        sourceError.set({ source: observation.source }, observation.error);
      }
      heartbeat.set(beat);
      monitor?.set(monitorAt);
      collectedAt.set(Date.now() / 1000);
      this.stateSuccess.set(1);
    });
  }
  recordRequest(outcome: RequestOutcome): void {
    this.requests.inc({ ...outcome });
  }
  recordHttpRequest(observation: {
    route: string;
    method: "GET" | "POST" | "other";
    status: number | "aborted";
    durationSeconds: number;
  }): void {
    const { durationSeconds, ...labels } = observation;
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  recordTelegramUpdate(outcome: "success" | "error", durationSeconds: number): void {
    this.telegramUpdates.inc({ outcome });
    this.telegramDuration.observe({ outcome }, durationSeconds);
  }

  recordMonitorIteration(outcome: "success" | "error" | "aborted", durationSeconds: number): void {
    this.monitorIterations.inc({ outcome });
    this.monitorDuration.observe({ outcome }, durationSeconds);
  }

  recordNotificationDelivery(outcome: "sent" | "blocked" | "retry" | "error"): void {
    this.notificationDeliveries.inc({ outcome });
  }

  async serve(port: number, healthy: () => Promise<boolean>): Promise<Server> {
    const health = singleFlight(healthy);
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "GET") {
          response.writeHead(405).end();
          return;
        }
        if (request.url === "/metrics") {
          try {
            await this.collectState();
          } catch {
            this.stateSuccess.set(0);
          }
          const body = await this.registry.metrics();
          response.writeHead(200, { "Content-Type": this.registry.contentType });
          response.end(body);
        } else if (request.url === "/health") {
          const ok = await health();
          response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ healthy: ok }));
        } else {
          response.writeHead(404).end();
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      });
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
    await promise;
    return server;
  }
}
