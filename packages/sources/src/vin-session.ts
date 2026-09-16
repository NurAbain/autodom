import { setTimeout as delay } from "node:timers/promises";
import {
  ENCAR_DISCOVERY_ORIGIN,
  type ProxyRoute,
  SourceError,
  SourceRateLimited,
  VIN_SOURCE_URLS,
} from "@autodom/core";
import pLimit from "p-limit";
import { type Dispatcher, fetch, getSetCookies, Headers, ProxyAgent } from "undici";
import type { CarcheckSession } from "./carcheck-session.js";
import { readBody, retryAfterSeconds } from "./http-response.js";

type KoreanVinProvider = "carhistory" | "car365" | "encar";

const REQUEST_PATHS: Readonly<
  Record<Exclude<KoreanVinProvider, "encar">, Readonly<Record<string, "GET" | "POST">>>
> = {
  carhistory: {
    "/search/carhistory/search.car": "GET",
    "/search/carhistory/initSearch.car": "POST",
  },
  car365: {
    "/ccpt/carlife/scrcar/schdcarXportView.do": "GET",
    "/ccpt/carlife/scrcar/selectSchdcarXportList.do": "POST",
  },
};

export interface VinSession {
  remainingMs?(): number;
  request(
    path: string,
    options?: {
      method?: "GET" | "POST";
      form?: Readonly<Record<string, string>>;
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<{ body: string; status: number }>;
}

export interface VinTransportOptions {
  routes: readonly ProxyRoute[];
  signal?: AbortSignal;
  requestDelaySeconds?: number;
  // A whole anonymous workflow, including queueing and proxy fallback, is bounded.
  timeoutMs?: number;
  dispatcherFactory?: (route: ProxyRoute, page: number, index: number) => Dispatcher;
  encarDiscovery?: Pick<CarcheckSession, "fetch">;
}

interface SessionCookie {
  origin: string;
  name: string;
  value: string;
  path: string;
  expires: number;
}

export class VinRequestError extends SourceError {}

export class VinTransport {
  readonly #options: VinTransportOptions;
  readonly #encarRoutes: readonly [number, ProxyRoute][];
  readonly #abort = new AbortController();
  readonly #limit = pLimit(10);
  readonly #active = new Set<Promise<unknown>>();
  readonly #nextRequest = new Map<KoreanVinProvider, number>();
  readonly #requestQueues = new Map<KoreanVinProvider, Set<() => void>>();
  readonly #rateLimitedUntil = new Map<KoreanVinProvider, number>();
  #page = 0;

  constructor(options: VinTransportOptions) {
    const routes = options.routes.filter((route) => route.tier !== "lalafo");
    if (!routes.length)
      throw new SourceError("VIN checks require configured proxies; direct access is disabled");
    if (
      !Number.isFinite(options.requestDelaySeconds ?? 2) ||
      (options.requestDelaySeconds ?? 2) < 0
    )
      throw new SourceError("VIN request delay must be non-negative");
    if (!Number.isSafeInteger(options.timeoutMs ?? 40_000) || (options.timeoutMs ?? 40_000) < 1)
      throw new SourceError("VIN workflow timeout must be a positive integer");
    this.#options = { ...options, routes };
    // Listing SSR can succeed on a datacenter IP that the document API rejects.
    this.#encarRoutes = [...routes.entries()].sort(
      ([, left], [, right]) =>
        Number(right.tier === "residential") - Number(left.tier === "residential"),
    );
  }

  async run<T>(
    provider: KoreanVinProvider,
    workflow: (session: VinSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = Date.now() + (this.#options.timeoutMs ?? 40_000);
    const combined = AbortSignal.any([
      this.#abort.signal,
      AbortSignal.timeout(this.#options.timeoutMs ?? 40_000),
      ...(this.#options.signal ? [this.#options.signal] : []),
      ...(signal ? [signal] : []),
    ]);
    const task = this.#limit(async () => {
      const page = ++this.#page;
      const discovery = new Map<string, { body: string; status: number }>();
      const routes = provider === "encar" ? this.#encarRoutes : this.#options.routes.entries();
      for (const [index, route] of routes) {
        combined.throwIfAborted();
        this.#requireNotRateLimited(provider);
        const dispatcher =
          this.#options.dispatcherFactory?.(route, page, index) ??
          new ProxyAgent({ uri: route.urlFor(page), token: route.authorization });
        try {
          // Cookies and CSRF are never shared between providers, lookups or proxy tiers.
          return await workflow(this.#session(provider, dispatcher, combined, discovery, deadline));
        } catch (error) {
          combined.throwIfAborted();
          if (!(error instanceof VinRequestError)) throw error;
        } finally {
          await dispatcher.close();
        }
      }
      throw new SourceError(`${provider}: configured proxy routes failed`);
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
    await Promise.allSettled(this.#active);
  }

  #requireNotRateLimited(provider: KoreanVinProvider): void {
    const remaining = (this.#rateLimitedUntil.get(provider) ?? 0) - Date.now();
    if (remaining > 0) throw new SourceRateLimited(Math.ceil(remaining / 1000));
  }

  async #dispatch<T>(
    provider: KoreanVinProvider,
    signal: AbortSignal,
    request: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    let queue = this.#requestQueues.get(provider);
    if (!queue) {
      queue = new Set();
      this.#requestQueues.set(provider, queue);
    }
    const turn = Promise.withResolvers<void>();
    const resume = () => turn.resolve();
    const release = () => {
      const first = queue.values().next().value === resume;
      queue.delete(resume);
      if (first) queue.values().next().value?.();
    };
    const abort = () => {
      turn.reject(signal.reason);
      release();
    };
    queue.add(resume);
    signal.addEventListener("abort", abort, { once: true });
    if (queue.size === 1) resume();
    try {
      await turn.promise;
      signal.throwIfAborted();
      let wait = (this.#nextRequest.get(provider) ?? 0) - Date.now();
      while (wait > 0) {
        await delay(wait, undefined, { signal });
        wait = (this.#nextRequest.get(provider) ?? 0) - Date.now();
      }
      signal.throwIfAborted();
      this.#requireNotRateLimited(provider);
      // Charge only real admissions; cancelled queue entries leave no future debt.
      this.#nextRequest.set(provider, Date.now() + (this.#options.requestDelaySeconds ?? 2) * 1000);
      return request();
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      release();
    }
  }

  #session(
    provider: KoreanVinProvider,
    dispatcher: Dispatcher,
    signal: AbortSignal,
    discovery: Map<string, { body: string; status: number }>,
    deadline: number,
  ): VinSession {
    const origin = new URL(VIN_SOURCE_URLS[provider]).origin;
    const cookies = new Map<string, SessionCookie>();
    return {
      remainingMs: () => (signal.aborted ? 0 : Math.max(0, deadline - Date.now())),
      request: async (path, options = {}) => {
        const url = new URL(path, origin);
        const method = options.method ?? "GET";
        const allowedPath =
          provider === "encar"
            ? method === "GET" &&
              ((url.origin === origin && /^\/cars\/detail\/[1-9]\d{0,9}$/u.test(url.pathname)) ||
                (url.origin === "https://api.encar.com" &&
                  /^\/legacy\/usedcar\/(?:inspect|diagnosis)\/[1-9]\d{0,9}$/u.test(url.pathname)) ||
                (url.origin === ENCAR_DISCOVERY_ORIGIN &&
                  /^\/auto\/[A-HJ-NPR-Z0-9]{17}$/u.test(url.pathname)))
            : url.origin === origin && REQUEST_PATHS[provider][url.pathname] === method;
        if (
          !allowedPath ||
          url.username ||
          url.password ||
          url.hash ||
          url.search ||
          (options.form && method !== "POST")
        )
          throw new SourceError("VIN request is outside the approved free lookup paths");
        const headers = new Headers(options.headers);
        for (const name of ["cookie", "authorization", "proxy-authorization", "host", "connection"])
          if (headers.has(name))
            throw new SourceError("VIN session credentials are transport-owned");
        const encarDiscovery = this.#options.encarDiscovery;
        if (url.origin === ENCAR_DISCOVERY_ORIGIN && encarDiscovery) {
          const cached = discovery.get(url.href);
          if (cached) return cached;
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
          try {
            const response = await this.#dispatch(provider, requestSignal, () =>
              encarDiscovery.fetch(url, requestSignal),
            );
            if (
              response.status === 301 &&
              response.headers.get("cf-mitigated") !== "challenge" &&
              response.headers.get("location") ===
                `${ENCAR_DISCOVERY_ORIGIN}/vin/${url.pathname.slice("/auto/".length)}`
            ) {
              await response.body?.cancel();
              const result = { body: "", status: 301 };
              discovery.set(url.href, result);
              return result;
            }
            if (response.status !== 200 || response.headers.get("cf-mitigated") === "challenge") {
              await response.body?.cancel();
              if (response.status === 429 || response.status >= 500) {
                const seconds = retryAfterSeconds(response.headers.get("retry-after"));
                this.#rateLimitedUntil.set(provider, Date.now() + seconds * 1000);
                throw new SourceRateLimited(seconds);
              }
              throw new SourceError("encar: Carcheck discovery is unavailable");
            }
            const result = {
              body: await readBody(response, requestSignal),
              status: response.status,
            };
            requestSignal.throwIfAborted();
            discovery.set(url.href, result);
            return result;
          } catch (error) {
            if (error instanceof SourceRateLimited) throw error;
            // Discovery owns its session recovery, never restart it on another ordinary tier.
            throw new SourceError("encar: Carcheck discovery is unavailable");
          }
        }
        headers.set(
          "User-Agent",
          "Mozilla/5.0 (compatible; AutodomBot/0.2; +https://autodom.skup.kg)",
        );
        if (options.form)
          headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        const now = Date.now();
        const matching = [...cookies.values()]
          .filter(
            (cookie) =>
              cookie.origin === url.origin &&
              cookie.expires > now &&
              (url.pathname === cookie.path ||
                url.pathname.startsWith(
                  cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
                )),
          )
          .sort((a, b) => b.path.length - a.path.length);
        if (matching.length)
          headers.set("Cookie", matching.map(({ name, value }) => `${name}=${value}`).join("; "));
        const response = await this.#dispatch(provider, signal, async () => {
          try {
            return await fetch(url, {
              dispatcher,
              method,
              headers,
              ...(options.form ? { body: new URLSearchParams(options.form).toString() } : {}),
              redirect: "manual",
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            });
          } catch {
            signal.throwIfAborted();
            throw new VinRequestError(`${provider}: proxy request failed`);
          }
        });
        if (
          provider === "encar" &&
          ((url.origin === ENCAR_DISCOVERY_ORIGIN &&
            response.status === 301 &&
            response.headers.get("location") ===
              `${ENCAR_DISCOVERY_ORIGIN}/vin/${url.pathname.slice("/auto/".length)}`) ||
            ((url.origin === origin || url.origin === "https://api.encar.com") &&
              response.status === 404))
        ) {
          // A declared missing archive or removed official page; never follow the report redirect.
          await response.body?.cancel();
          return { body: "", status: response.status };
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 429) {
            const seconds = retryAfterSeconds(response.headers.get("retry-after"));
            this.#rateLimitedUntil.set(provider, Date.now() + seconds * 1000);
            throw new SourceRateLimited(seconds);
          }
          const ErrorType =
            response.status === 403 || response.status === 408 || response.status >= 500
              ? VinRequestError
              : SourceError;
          throw new ErrorType(`${provider}: HTTP ${response.status}`);
        }
        for (const cookie of getSetCookies(response.headers)) {
          const domain = cookie.domain?.replace(/^\./u, "").toLowerCase();
          if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
          const cookiePath = cookie.path?.startsWith("/")
            ? cookie.path
            : url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
          const expires =
            cookie.maxAge !== undefined
              ? Date.now() + cookie.maxAge * 1000
              : cookie.expires !== undefined
                ? Number(new Date(cookie.expires))
                : Number.POSITIVE_INFINITY;
          const key = `${url.origin};${cookie.name};${cookiePath}`;
          if (expires <= Date.now()) cookies.delete(key);
          else
            cookies.set(key, {
              origin: url.origin,
              name: cookie.name,
              value: cookie.value,
              path: cookiePath,
              expires,
            });
        }
        try {
          return { body: await readBody(response), status: response.status };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof SourceError) throw error;
          throw new VinRequestError(`${provider}: incomplete proxy response`);
        }
      },
    };
  }
}
