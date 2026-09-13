import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type DocumentOptions,
  type DocumentRequest,
  type DocumentTransport,
  type ProxyRoute,
  type RequestOutcome,
  requireSourceAccess,
  SourceError,
  SourceRateLimited,
} from "@autodom/core";
import { BasicCrawler } from "@crawlee/basic";
import { Configuration, KeyValueStore, Log, LogLevel, RequestList } from "@crawlee/core";
import type { ImpitResponse } from "impit";
import pLimit, { type LimitFunction } from "p-limit";
import { type Dispatcher, fetch, ProxyAgent, type Response } from "undici";
import { DETAIL_DELAY_SECONDS } from "./bidcars.js";
import { type BrowserClient, CloudflareBrowser, REFRESH_COOLDOWN_MS } from "./cloudflare-browser.js";
import { RiskBypass, RiskBypassError } from "./riskbypass.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ORIGINS: Readonly<Record<string, string>> = {
  "mashina.kg": "https://mashina.kg",
  "lalafo.kg": "https://lalafo.kg",
  "encar.com": "https://api.encar.com",
  "truecar.com": "https://www.truecar.com",
  "bid.cars": "https://bid.cars",
  "nbkr.kg": "https://www.nbkr.kg",
};
const LALAFO_CLEARANCE_URL = "https://lalafo.kg/kyrgyzstan/avtomobili-s-probegom";

export interface ProxyTransportOptions {
  routes: readonly ProxyRoute[];
  dataDir: string;
  concurrency?: number;
  requestDelaySeconds?: number;
  signal?: AbortSignal;
  onRequest?: (outcome: RequestOutcome) => void;
  dispatcherFactory?: (route: ProxyRoute, page: number, index: number) => Dispatcher;
  browserClientFactory?: (route: ProxyRoute, page: number, index: number) => BrowserClient;
}

export function retryAfterSeconds(value: string | null, now = Date.now() / 1000): number {
  if (value && /^\d{1,8}$/u.test(value)) return Math.max(60, Number(value));
  const instant = value ? Date.parse(value) / 1000 : Number.NaN;
  return Number.isFinite(instant) ? Math.max(60, Math.trunc(instant - now)) : 300;
}

function nbkrArchiveAllowed(url: URL): boolean {
  const query = url.searchParams;
  if (
    url.pathname !== "/index1.jsp" ||
    query.size !== 9 ||
    query.get("item") !== "1562" ||
    query.get("lang") !== "RUS" ||
    !["15", "25"].includes(query.get("valuta_id") ?? "")
  )
    return false;
  const begin = `${query.get("beg_year")}-${query.get("beg_month")}-${query.get("beg_day")}`;
  const end = `${query.get("end_year")}-${query.get("end_month")}-${query.get("end_day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(begin) || !/^\d{4}-\d{2}-\d{2}$/u.test(end)) return false;
  const first = Date.parse(`${begin}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  return (
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    new Date(first).toISOString().slice(0, 10) === begin &&
    new Date(last).toISOString().slice(0, 10) === end &&
    last >= first &&
    last - first <= 6 * 86400_000
  );
}

function requestUrl(raw: string, options: DocumentOptions): URL {
  if (options.source !== "nbkr.kg") requireSourceAccess(options.source);
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1)
    throw new SourceError("Catalog page must be a positive integer");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError("Invalid source URL");
  }
  if (url.origin !== ORIGINS[options.source] || url.username || url.password || url.hash) {
    throw new SourceError("Source request URL is outside its approved origin");
  }
  for (const [key, value] of Object.entries(options.params ?? {}))
    url.searchParams.set(key, String(value));
  if (
    options.source === "nbkr.kg" &&
    !["/XML/daily.xml", "/XML/weekly.xml"].includes(url.pathname) &&
    !nbkrArchiveAllowed(url)
  ) {
    throw new SourceError("Unknown NBKR feed");
  }
  return url;
}

async function readBody(response: Response | ImpitResponse): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("Source returned an empty response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SourceError("Source response exceeds size limit");
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ProxyTransport implements DocumentTransport {
  readonly #options: ProxyTransportOptions;
  readonly #dispatchers = new Map<string, Dispatcher>();
  readonly #routes: Readonly<Record<string, readonly ProxyRoute[]>>;
  readonly #browserClients = new Map<string, Map<number, BrowserClient>>();
  readonly #browserNextPage = new Map<string, number>();
  readonly #browserUnavailable = new Map<string, Map<number, number>>();
  readonly #preferredBrowserRoute = new Map<string, number>();
  readonly #nextRequest = new Map<string, number>();
  readonly #abort = new AbortController();
  readonly #limit: LimitFunction;
  #riskBypass: RiskBypass | undefined;

  constructor(options: ProxyTransportOptions) {
    if (!options.routes.length)
      throw new SourceError("Scraping requires configured proxies; direct access is disabled");
    if (
      !Number.isInteger(options.concurrency ?? 2) ||
      (options.concurrency ?? 2) < 1 ||
      (options.concurrency ?? 2) > 8
    ) {
      throw new SourceError("Crawler concurrency must be between 1 and 8");
    }
    if (
      !Number.isFinite(options.requestDelaySeconds ?? 2) ||
      (options.requestDelaySeconds ?? 2) < 0
    ) {
      throw new SourceError("Invalid request delay");
    }
    this.#options = options;
    const sharedRoutes = options.routes.filter((route) => route.tier !== "lalafo");
    const lalafoRoutes = options.routes.filter((route) => route.tier === "lalafo");
    this.#routes = Object.fromEntries(
      Object.keys(ORIGINS).map((source) => [
        source,
        source === "lalafo.kg" ? lalafoRoutes : sharedRoutes,
      ]),
    );
    this.#limit = pLimit(options.concurrency ?? 2);
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.all([...this.#dispatchers.values()].map((dispatcher) => dispatcher.close()));
    this.#dispatchers.clear();
    this.#browserClients.clear();
    this.#browserNextPage.clear();
    this.#browserUnavailable.clear();
    this.#preferredBrowserRoute.clear();
  }

  private dispatcher(route: ProxyRoute, page: number, index: number): Dispatcher {
    const endpoint = route.urlFor(page);
    const key = `${index}:${endpoint}`;
    let dispatcher = this.#dispatchers.get(key);
    if (!dispatcher) {
      dispatcher =
        this.#options.dispatcherFactory?.(route, page, index) ??
        new ProxyAgent({ uri: endpoint, token: route.authorization });
      this.#dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  private solver(fallback: ProxyRoute): RiskBypass {
    if (!this.#riskBypass) {
      const route =
        this.#options.routes.find((candidate) => candidate.tier === "datacenter") ?? fallback;
      this.#riskBypass = new RiskBypass({
        apiKey: process.env.RISKBYPASS_API_KEY ?? "",
        dispatcher: this.dispatcher(route, 1, this.#options.routes.indexOf(route)),
      });
    }
    return this.#riskBypass;
  }

  private browserClient(route: ProxyRoute, page: number, index: number, source: string): BrowserClient {
    const key = `${source}:${index}`;
    let clients = this.#browserClients.get(key);
    if (!clients) {
      clients = new Map();
      this.#browserClients.set(key, clients);
    }
    const cached = clients.get(page);
    if (cached) {
      clients.delete(page);
      clients.set(page, cached);
      return cached;
    }
    const client =
      this.#options.browserClientFactory?.(route, page, index) ??
      new CloudflareBrowser(route, page, {
        solve: (url, proxy, signal) => this.solver(route).solve(url, proxy, signal),
      });
    clients.set(page, client);
    // A rotating tier must not evict another tier's established sessions.
    if (clients.size > 16) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
    return client;
  }

  async fetchDocument<T>(
    url: string,
    parse: (text: string) => T,
    options: DocumentOptions,
  ): Promise<T> {
    const results = await this.fetchDocuments([{ url, parse, options }]);
    return results[0] as T;
  }

  async fetchDocuments<T>(requests: readonly DocumentRequest<T>[]): Promise<T[]> {
    if (!requests.length) return [];
    const urls = requests.map((request) => requestUrl(request.url, request.options));
    for (const { options } of requests) {
      if (!this.#routes[options.source]?.length)
        throw new SourceError("Source requires its configured proxy route; direct access is disabled");
    }
    const name = `autodom-${randomUUID()}`;
    const config = new Configuration({
      purgeOnStart: false,
      persistStorage: true,
      defaultKeyValueStoreId: name,
      storageClientOptions: {
        localDataDirectory: join(this.#options.dataDir, "crawlee"),
        persistStorage: true,
      },
    });
    // The batch is immutable and retries belong to the durable source job.
    // A dynamic RequestQueue allocates million-slot caches for every tiny batch.
    const requestList = await Configuration.storage.run(config, () =>
      RequestList.open(
        name,
        urls.map((url, index) => ({
          url: url.href,
          uniqueKey: `${index}:${url.href}`,
          userData: { index },
        })),
      ),
    );
    const abort = new AbortController();
    const results: T[] = new Array(requests.length);
    const completed = new Set<number>();
    let failure: unknown;
    const crawler = new BasicCrawler(
      {
        requestList,
        minConcurrency: 1,
        maxConcurrency: this.#options.concurrency ?? 2,
        maxRequestRetries: 0,
        maxSessionRotations: 0,
        useSessionPool: false,
        // Admission may wait behind other source batches; each HTTP attempt still has a 40s deadline.
        requestHandlerTimeoutSecs: 3600,
        maxRequestsPerCrawl: requests.length,
        log: new Log({ prefix: "AutodomCrawler", level: LogLevel.ERROR }),
        async requestHandler({ request }) {
          const index = Number(request.userData.index);
          const item = requests[index];
          if (!item) throw new SourceError("Unknown scheduled document");
          try {
            results[index] = await transport.#limit(() =>
              transport.fetchThroughRoutes(item, abort.signal),
            );
            completed.add(index);
          } catch (error) {
            failure ??= error;
            abort.abort();
            throw error;
          }
        },
        failedRequestHandler(_context, error) {
          failure ??= error;
          abort.abort();
        },
      },
      config,
    );
    const transport = this;
    try {
      await crawler.run();
      if (failure) throw failure;
      if (completed.size !== requests.length)
        throw new SourceError("Source batch did not complete; refusing partial page");
      return results;
    } finally {
      abort.abort();
      await (await KeyValueStore.open(name, { config })).drop();
    }
  }

  private browserPage(route: ProxyRoute, key: string): number | undefined {
    const count = Math.max(1, route.port_count);
    const unavailable = this.#browserUnavailable.get(key);
    const now = Date.now();
    let page = this.#browserNextPage.get(key) ?? 1;
    for (let checked = 0; checked < count; checked++) {
      const next = (page % count) + 1;
      this.#browserNextPage.set(key, next);
      if ((unavailable?.get(page) ?? 0) <= now) {
        unavailable?.delete(page);
        return page;
      }
      page = next;
    }
    return undefined;
  }

  private async fetchThroughRoutes<T>(
    request: DocumentRequest<T>,
    batchSignal: AbortSignal,
  ): Promise<T> {
    const failures: string[] = [];
    const { options } = request;
    const signals = [this.#abort.signal, batchSignal];
    if (this.#options.signal) signals.push(this.#options.signal);
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const routes = this.#routes[options.source];
    if (!routes?.length)
      throw new SourceError("Source requires its configured proxy route; direct access is disabled");
    const browserRequest = options.source === "bid.cars" || options.source === "lalafo.kg";
    const preferred = browserRequest ? (this.#preferredBrowserRoute.get(options.source) ?? 0) : 0;
    let alternatePorts: Set<number> | undefined;
    // At most one alternate port per tier, only after an unresolved managed challenge.
    for (let offset = 0; offset < routes.length * (browserRequest ? 2 : 1); offset++) {
      const index = (preferred + offset) % routes.length;
      if (offset >= routes.length && !alternatePorts?.has(index)) continue;
      const route = routes[index];
      if (!route) throw new SourceError("Configured proxy route is missing");
      const key = `${options.source}:${index}`;
      const page = browserRequest ? this.browserPage(route, key) : (options.page ?? 1);
      if (page === undefined) {
        failures.push(`${route.tier}: proxy sessions are cooling down`);
        continue;
      }
      let reported = false;
      let challenged = false;
      try {
        const browser = browserRequest
          ? this.browserClient(route, page, index, options.source)
          : undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          const instant = Date.now();
          const start = Math.max(instant, this.#nextRequest.get(options.source) ?? 0);
          const minimumDelay = options.source === "bid.cars" ? DETAIL_DELAY_SECONDS : 0;
          this.#nextRequest.set(
            options.source,
            start + Math.max(minimumDelay, this.#options.requestDelaySeconds ?? 2) * 1000,
          );
          if (start > instant) await delay(start - instant, undefined, { signal });
          reported = false;
          const url = requestUrl(request.url, options);
          const generation = browser?.generation ?? 0;
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError")),
            40_000,
          ).unref();
          try {
            const init = {
              method: options.method ?? "GET",
              headers: {
                ...(browser
                  ? {}
                  : {
                      "User-Agent": "AutodomBot/0.2",
                      Accept: "application/json,text/html,*/*",
                    }),
                ...options.headers,
                ...(options.payload !== undefined ? { "Content-Type": "application/json" } : {}),
              },
              ...(options.payload !== undefined ? { body: JSON.stringify(options.payload) } : {}),
              redirect: "manual" as const,
              signal: AbortSignal.any([signal, deadline.signal]),
            };
            const response = browser
              ? await browser.fetch(url, init)
              : await fetch(url, {
                  ...init,
                  dispatcher: this.dispatcher(route, page, this.#options.routes.indexOf(route)),
                });
            if (browser && response.headers.get("cf-mitigated") === "challenge") {
              challenged = true;
              await response.body?.cancel();
              if (attempt !== 0 || !browser.refresh)
                throw new SourceError("Cloudflare challenge remains unresolved");
              this.#options.onRequest?.({
                source: options.source,
                tier: route.tier,
                outcome: "error",
              });
              reported = true;
            } else {
              if (response.status !== 200) {
                await response.body?.cancel();
                if (response.status === 429)
                  throw new SourceRateLimited(
                    retryAfterSeconds(response.headers.get("retry-after")),
                  );
                throw new SourceError(`${options.source} returned HTTP ${response.status}`);
              }
              const result = request.parse(await readBody(response));
              if (browser) this.#preferredBrowserRoute.set(options.source, index);
              this.#options.onRequest?.({
                source: options.source,
                tier: route.tier,
                outcome: "success",
              });
              return result;
            }
          } finally {
            clearTimeout(timer);
          }
          // Solving has its own bounded deadline; never retain a completed page's 40s timer.
          await browser?.refresh?.(
            options.source === "lalafo.kg" ? new URL(LALAFO_CLEARANCE_URL) : url,
            generation,
            signal,
          );
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SourceRateLimited) {
          this.#options.onRequest?.({
            source: options.source,
            tier: route.tier,
            outcome: "rate_limited",
          });
          throw error;
        }
        if (!reported)
          this.#options.onRequest?.({ source: options.source, tier: route.tier, outcome: "error" });
        if (error instanceof RiskBypassError) throw error;
        if (challenged) {
          let unavailable = this.#browserUnavailable.get(key);
          if (!unavailable) {
            unavailable = new Map();
            this.#browserUnavailable.set(key, unavailable);
          }
          unavailable.set(page, Date.now() + REFRESH_COOLDOWN_MS);
          if (route.port_count > 1) {
            alternatePorts ??= new Set();
            alternatePorts.add(index);
          }
        }
        const reason =
          error instanceof SourceError
            ? error.message
            : error instanceof Error
              ? error.name
              : "RequestError";
        failures.push(`${route.tier}: ${reason}`);
      }
    }
    throw new SourceError(`${options.source}: all proxy routes failed: ${failures.join("; ")}`);
  }
}
