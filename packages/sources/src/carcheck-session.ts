import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ENCAR_DISCOVERY_ORIGIN,
  type ProxyRoute,
  SourceError,
  SourceRateLimited,
} from "@autodom/core";
import type { ImpitResponse } from "impit";
import { type Dispatcher, ProxyAgent, Response } from "undici";
import {
  type BrowserClient,
  CloudflareBrowser,
  REFRESH_COOLDOWN_MS,
} from "./cloudflare-browser.js";
import { abortable, readBody, retryAfterSeconds } from "./http-response.js";
import { RiskBypass } from "./riskbypass.js";

export interface CarcheckSessionOptions {
  routes: readonly ProxyRoute[];
  apiKey: string;
  signal?: AbortSignal;
  requestDelaySeconds?: number;
  browserClientFactory?: (
    route: ProxyRoute,
    page: number,
    index: number,
    affinity: string,
  ) => BrowserClient;
  dispatcherFactory?: (route: ProxyRoute) => Dispatcher;
}

function challenged(response: Response | ImpitResponse, body = ""): boolean {
  return (
    response.headers.get("cf-mitigated") === "challenge" ||
    [401, 403, 407, 419].includes(response.status) ||
    /<title[^>]*>\s*(?:just a moment|attention required)|\/cdn-cgi\/challenge-platform\/|cf-chl-|challenge-form/iu.test(
      body,
    )
  );
}

/** One Carcheck-only gateway, solved user agent and cookie jar; never shared with Lalafo. */
export class CarcheckSession {
  readonly #options: CarcheckSessionOptions;
  readonly #route: ProxyRoute;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #active = new Set<Promise<unknown>>();
  readonly #queue = new Set<() => void>();
  #client: BrowserClient | undefined;
  #capture: Promise<void> | undefined;
  #challengeUrl: URL | undefined;
  #control: Dispatcher | undefined;
  #solver: RiskBypass | undefined;
  #retryAt = 0;
  #pausedUntil = 0;
  #nextRequest = 0;
  #page: number;
  #refreshTimer: NodeJS.Timeout | undefined;

  constructor(options: CarcheckSessionOptions) {
    const route = options.routes.find((candidate) => candidate.tier === "residential");
    if (!route || !options.routes.some((candidate) => candidate.tier === "datacenter"))
      throw new SourceError("Carcheck requires dedicated ISP and datacenter control routes");
    if (!options.apiKey.trim() && !options.browserClientFactory)
      throw new SourceError("Carcheck requires an explicit clearance solver API key");
    if (
      !Number.isFinite(options.requestDelaySeconds ?? 2) ||
      (options.requestDelaySeconds ?? 2) < 0
    )
      throw new SourceError("Carcheck request delay must be non-negative");
    this.#options = options;
    this.#route = route;
    this.#page = Number.parseInt(randomUUID().slice(0, 8), 16) % Math.max(1, route.port_count);
    this.#signal = AbortSignal.any([
      this.#abort.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
  }

  start(): void {
    if (this.#signal.aborted || this.#client || this.#capture || Date.now() < this.#retryAt) return;
    if (this.#challengeUrl) this.#retryAt = Date.now() + REFRESH_COOLDOWN_MS;
    const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(300_000)]);
    this.#capture = this.#warmup(signal)
      .catch(() => {
        // A failed paid capture never causes an automatic periodic retry.
        this.#retryAt = Math.max(this.#retryAt, Date.now() + REFRESH_COOLDOWN_MS);
      })
      .finally(() => {
        this.#capture = undefined;
      });
  }

  async fetch(url: URL, signal: AbortSignal): Promise<Response | ImpitResponse> {
    if (
      url.origin !== ENCAR_DISCOVERY_ORIGIN ||
      !/^\/auto\/[A-HJ-NPR-Z0-9]{17}$/u.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new SourceError("Carcheck request is outside the approved free lookup paths");
    const combined = AbortSignal.any([signal, this.#signal]);
    const task = this.#fetch(url, combined).catch((error: unknown) => {
      if (combined.aborted) throw new SourceError("Carcheck request was interrupted");
      if (error instanceof SourceRateLimited) throw error;
      // Neither native errors nor caller abort reasons may expose proxy credentials.
      throw new SourceError("Carcheck discovery is unavailable");
    });
    this.#active.add(task);
    try {
      return await task;
    } finally {
      this.#active.delete(task);
    }
  }

  async close(): Promise<void> {
    this.#abort.abort();
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    await Promise.allSettled([...this.#active, ...(this.#capture ? [this.#capture] : [])]);
    this.#client = undefined;
    try {
      await this.#control?.close();
    } catch {
      throw new SourceError("Carcheck control shutdown failed");
    }
  }

  #notPaused(): void {
    const remaining = this.#pausedUntil - Date.now();
    if (remaining > 0) throw new SourceRateLimited(Math.ceil(remaining / 1000));
  }

  async #warmup(signal: AbortSignal): Promise<void> {
    this.#notPaused();
    const affinity = randomUUID();
    this.#page = (this.#page % Math.max(1, this.#route.port_count)) + 1;
    const client =
      this.#options.browserClientFactory?.(
        this.#route,
        this.#page,
        this.#options.routes.indexOf(this.#route),
        affinity,
      ) ??
      new CloudflareBrowser(
        this.#route,
        this.#page,
        {
          solve: (url, proxy, solveSignal) => {
            if (!this.#solver) {
              const route = this.#options.routes.find(
                (candidate) => candidate.tier === "datacenter",
              );
              if (!route) throw new SourceError("Carcheck control route is unavailable");
              this.#control =
                this.#options.dispatcherFactory?.(route) ??
                new ProxyAgent({ uri: route.urlFor(1), token: route.authorization });
              this.#solver = new RiskBypass({
                apiKey: this.#options.apiKey,
                dispatcher: this.#control,
              });
            }
            return this.#solver.solve(url, proxy, solveSignal);
          },
        },
        affinity,
      );
    if (this.#challengeUrl) {
      if (!client.refresh) throw new SourceError("Carcheck clearance capture is unavailable");
      await client.refresh(this.#challengeUrl, client.generation ?? 0, signal);
    }
    signal.throwIfAborted();
    await this.#request(client, new URL(`${ENCAR_DISCOVERY_ORIGIN}/`), signal);
    signal.throwIfAborted();
    this.#client = client;
  }

  async #fetch(url: URL, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    this.#notPaused();
    this.start();
    if (!this.#client && this.#capture) await abortable(this.#capture, signal);
    signal.throwIfAborted();
    if (!this.#client) throw new SourceError("Carcheck session is unavailable");
    try {
      return await this.#request(this.#client, url, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SourceRateLimited || this.#client || !this.#challengeUrl) throw error;
      // Only an observed challenge starts a paid capture. Other callers share it;
      // a cold lookup may expire while the service continues preparing the session.
      this.start();
      if (this.#capture) await abortable(this.#capture, signal);
      signal.throwIfAborted();
      if (!this.#client) throw error;
      return this.#request(this.#client, url, signal);
    }
  }

  #replace(client: BrowserClient): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    if (this.#signal.aborted || this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(
      () => {
        this.#refreshTimer = undefined;
        this.start();
      },
      Math.max(0, this.#retryAt - Date.now(), this.#pausedUntil - Date.now()),
    );
    this.#refreshTimer.unref();
  }

  async #request(client: BrowserClient, url: URL, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const turn = Promise.withResolvers<void>();
    const resume = () => turn.resolve();
    const release = () => {
      const first = this.#queue.values().next().value === resume;
      this.#queue.delete(resume);
      if (first) this.#queue.values().next().value?.();
    };
    let admitted = false;
    let draining: Promise<void> | undefined;
    const abort = () => {
      turn.reject(signal.reason);
      if (!admitted) release();
    };
    this.#queue.add(resume);
    signal.addEventListener("abort", abort, { once: true });
    if (this.#queue.size === 1) resume();
    try {
      await turn.promise;
      admitted = true;
      signal.throwIfAborted();
      this.#notPaused();
      const wait = this.#nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      this.#notPaused();
      // Queued requests must not reuse a session challenged by the previous admission.
      if (url.pathname !== "/" && this.#client !== client)
        throw new SourceError("Carcheck session is no longer accepted");
      this.#nextRequest = Date.now() + Math.max(2, this.#options.requestDelaySeconds ?? 2) * 1000;
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
      let response: Response | ImpitResponse;
      try {
        // Impit races AbortSignal before headers without disposing the late native response.
        // Keep that request observable until headers/native timeout, then cancel late bytes.
        const nativeAbort = new AbortController();
        const pending = client
          .fetch(url, {
            method: "GET",
            headers: { Accept: "text/html" },
            redirect: "manual",
            signal: nativeAbort.signal,
          })
          .then(async (result) => {
            if (requestSignal.aborted) {
              nativeAbort.abort();
              await result.body?.cancel().catch(() => undefined);
              throw new SourceError("Carcheck ISP request was interrupted");
            }
            return result;
          });
        draining = pending.then(
          () => undefined,
          () => undefined,
        );
        this.#active.add(draining);
        const tracked = draining;
        void tracked.then(() => this.#active.delete(tracked));
        response = await abortable(pending, requestSignal);
      } catch {
        if (!signal.aborted) this.#replace(client);
        throw new SourceError("Carcheck ISP request failed");
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        const seconds = retryAfterSeconds(response.headers.get("retry-after"));
        this.#pausedUntil = Date.now() + seconds * 1000;
        throw new SourceRateLimited(seconds);
      }
      if (challenged(response)) {
        await response.body?.cancel().catch(() => undefined);
        if (url.pathname !== "/") this.#challengeUrl = url;
        this.#replace(client);
        throw new SourceError("Carcheck rejected the clearance session");
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        if (
          response.status === 301 &&
          url.pathname.startsWith("/auto/") &&
          response.headers.get("location") ===
            `${ENCAR_DISCOVERY_ORIGIN}/vin/${url.pathname.slice(6)}`
        )
          return new Response(null, {
            status: 301,
            headers: { location: response.headers.get("location") ?? "" },
          });
        throw new SourceError("Carcheck returned an unexpected HTTP status");
      }
      let body: string;
      try {
        body = await readBody(response, requestSignal);
      } catch {
        if (!signal.aborted) this.#replace(client);
        throw new SourceError("Carcheck response was incomplete");
      }
      requestSignal.throwIfAborted();
      if (challenged(response, body)) {
        if (url.pathname !== "/") this.#challengeUrl = url;
        this.#replace(client);
        throw new SourceError("Carcheck returned a challenge page");
      }
      if (url.pathname === "/") {
        if (!/<(?:!doctype\s+html|html)\b/iu.test(body) || !/carcheck/iu.test(body))
          throw new SourceError("Carcheck root did not accept the captured session");
        return new Response(null, { status: 200 });
      }
      // Buffer once under the request deadline, so the caller cannot hold the admission open.
      return new Response(body, {
        status: 200,
        headers: { "content-type": response.headers.get("content-type") ?? "text/html" },
      });
    } finally {
      signal.removeEventListener("abort", abort);
      if (draining) void draining.then(release);
      else release();
    }
  }
}
