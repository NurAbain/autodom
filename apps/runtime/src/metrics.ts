import { createServer, type Server } from "node:http";
import type { RequestOutcome } from "@autodom/core";
import { Counter, collectDefaultMetrics, Registry } from "@prometheus-io/client";

export class Metrics {
  readonly registry = new Registry();
  readonly requests: Counter<"source" | "tier" | "outcome">;
  readonly jobs: Counter<"source" | "outcome">;
  constructor(role: "bot" | "worker" | "run") {
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
  }
  recordRequest(outcome: RequestOutcome): void {
    this.requests.inc({ ...outcome });
  }
  async serve(port: number, healthy: () => Promise<boolean>): Promise<Server> {
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "GET") {
          response.writeHead(405).end();
          return;
        }
        if (request.url === "/metrics") {
          response.writeHead(200, { "Content-Type": this.registry.contentType });
          response.end(await this.registry.metrics());
        } else if (request.url === "/health") {
          const ok = await healthy();
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
