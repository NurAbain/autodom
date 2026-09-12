import { createServer, type Server } from "node:http";
import { enabledSources, type RequestOutcome, type Settings, SOURCE_IDS } from "@autodom/core";
import type { Store } from "@autodom/storage";
import { Counter, collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";

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
