import type { IncomingMessage, ServerResponse } from "node:http";
import { VIN_PROVIDERS, type VinCheckResult } from "@autodom/core/vin";
import { VIN_ARCHIVE_PROVIDERS, type VinArchiveResult } from "@autodom/core/vin-archive";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";

const observationStatuses: Readonly<Record<string, true>> = {
  available: true,
  no_photos: true,
  not_found: true,
  unavailable: true,
  disabled: true,
};

function routeLabel(url: string | undefined): string {
  const query = url?.indexOf("?") ?? -1;
  const path = query < 0 ? url : url?.slice(0, query);
  switch (path) {
    case "/health":
    case "/metrics":
    case "/v1/vin/check":
    case "/v1/vin/archive-photos":
    case "/v1/vin/archive-photo":
      return path;
    default:
      return "unmatched";
  }
}

export class VinMetrics {
  readonly registry = new Registry();
  readonly inFlight: Gauge;
  private readonly requests: Counter<"route" | "method" | "status">;
  private readonly duration: Histogram<"route" | "method" | "status">;
  private readonly observations: Counter<"provider" | "status">;

  constructor(maxInFlight: number) {
    this.registry.setDefaultLabels({ application: "autodom", role: "vin" });
    collectDefaultMetrics({ register: this.registry, prefix: "autodom_" });
    this.requests = new Counter({
      name: "autodom_http_requests_total",
      help: "HTTP requests completed or aborted",
      labelNames: ["route", "method", "status"],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: "autodom_http_request_duration_seconds",
      help: "HTTP request duration until response completion or disconnect",
      labelNames: ["route", "method", "status"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.registry],
    });
    this.inFlight = new Gauge({
      name: "autodom_vin_in_flight",
      help: "Admitted VIN workflows still holding a capacity slot, including cancelled unsettled work",
      registers: [this.registry],
    });
    this.inFlight.set(0);
    new Gauge({
      name: "autodom_vin_max_in_flight",
      help: "Maximum concurrent admitted VIN workflows",
      registers: [this.registry],
    }).set(maxInFlight);
    this.observations = new Counter({
      name: "autodom_vin_provider_observations_total",
      help: "Provider observations in returned VIN results; omitted providers are not counted",
      labelNames: ["provider", "status"],
      registers: [this.registry],
    });
  }

  trackHttp(request: IncomingMessage, response: ServerResponse): void {
    const started = performance.now();
    const route = routeLabel(request.url);
    const method = request.method === "GET" || request.method === "POST" ? request.method : "other";
    const completed = () => {
      response.off("finish", completed);
      response.off("close", completed);
      const status = response.writableFinished ? String(response.statusCode) : "aborted";
      const labels = { route, method, status };
      this.requests.inc(labels);
      this.duration.observe(labels, (performance.now() - started) / 1000);
    };
    response.once("finish", completed);
    response.once("close", completed);
  }

  recordResult(result: VinCheckResult | VinArchiveResult): void {
    if ("sources" in result) {
      for (const observation of result.sources) {
        if (
          VIN_ARCHIVE_PROVIDERS.includes(observation.provider) &&
          Object.hasOwn(observationStatuses, observation.status)
        )
          this.observations.inc({ provider: observation.provider, status: observation.status });
      }
    } else {
      for (const provider of VIN_PROVIDERS) {
        const observation = result[provider];
        if (observation && Object.hasOwn(observationStatuses, observation.status))
          this.observations.inc({ provider, status: observation.status });
      }
    }
  }
}
