import type { Server } from "node:http";
import type { ProxyRoute, Settings } from "@autodom/core";
import { maintain } from "@autodom/runtime/maintenance";
import { Metrics } from "@autodom/runtime/metrics";
import { runtimeStatus } from "@autodom/runtime/status";
import { ProxyTransport } from "@autodom/sources";
import type { Store } from "@autodom/storage";
import type { Logger } from "pino";
import { createCatalogRoute } from "./catalog-http.js";
import { type CollectionWorkers, startCollectionWorkers } from "./jobs.js";
import { VehicleCatalog } from "./vehicle-catalog.js";

export async function runWorkerService(
  store: Store,
  settings: Settings,
  routes: readonly ProxyRoute[],
  logger: Logger,
): Promise<void> {
  const port = Number(process.env.AUTODOM_METRICS_PORT ?? "9901");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AUTODOM_METRICS_PORT must be a valid TCP port");
  const abort = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let transport: ProxyTransport | undefined;
  let collectors: CollectionWorkers | undefined;
  let server: Server | undefined;
  let failure: unknown;
  let failed = false;
  const tasks: Promise<void>[] = [];
  const metrics = new Metrics("worker", store, settings);
  try {
    transport = new ProxyTransport({
      routes,
      dataDir: settings.data_dir,
      requestDelaySeconds: settings.crawl_delay,
      signal: abort.signal,
      onRequest: (outcome) => metrics.recordRequest(outcome),
    });
    collectors = await startCollectionWorkers(
      store,
      settings,
      transport,
      abort.signal,
      logger,
      metrics,
    );
    const catalogToken = process.env.AUTODOM_CATALOG_API_TOKEN?.trim();
    const catalogRoute = catalogToken
      ? createCatalogRoute(new VehicleCatalog(transport), catalogToken)
      : undefined;
    server = await metrics.serve(
      port,
      async () => !abort.signal.aborted && (await runtimeStatus(store, settings, "worker")).healthy,
      catalogRoute,
    );
    server.on("error", (error) => abort.abort(error));
    tasks.push(maintain(store, settings, "worker", abort.signal));
    logger.info({ role: "worker", metrics_port: port }, "Autodom service ready");
    const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", () => onAbort(), { once: true });
    await Promise.race([...tasks, aborted]);
    if (!stopping) throw abort.signal.reason ?? new Error("Autodom worker stopped unexpectedly");
  } catch (error) {
    if (!stopping) {
      failure = error;
      failed = true;
    }
  } finally {
    abort.abort();
    try {
      const closing: Promise<void>[] = [];
      if (collectors) closing.push(collectors.close());
      if (transport) closing.push(transport.close());
      if (server) {
        const activeServer = server;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const forced = setTimeout(() => activeServer.closeAllConnections(), 5_000).unref();
        activeServer.close((error) => {
          clearTimeout(forced);
          if (error) reject(error);
          else resolve();
        });
        closing.push(promise);
      }
      const results = await Promise.allSettled(closing);
      await Promise.allSettled(tasks);
      const rejected = results.find((result) => result.status === "rejected");
      if (!failed && rejected?.status === "rejected") {
        failure = rejected.reason;
        failed = true;
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (failed) throw failure;
}
