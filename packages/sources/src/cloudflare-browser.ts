import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import { type ProxyRoute, SourceError } from "@autodom/core";
import { Impit, type ImpitOptions, type ImpitResponse } from "impit";
import { Cookie, CookieJar } from "tough-cookie";
import type { Response } from "undici";
import { type RiskBypass, RiskBypassError } from "./riskbypass.js";

export interface BrowserClient {
  readonly generation?: number;
  fetch(
    url: URL,
    init: {
      method: "GET" | "POST";
      headers: Record<string, string>;
      body?: string;
      redirect: "manual";
      signal: AbortSignal;
    },
  ): Promise<Response | ImpitResponse>;
  refresh?(url: URL, expectedGeneration: number, signal: AbortSignal): Promise<void>;
}

export const REFRESH_COOLDOWN_MS = 300_000;

function publicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function pinProxy(route: ProxyRoute, page: number, affinity?: string): Promise<URL> {
  try {
    const proxy = new URL(route.urlFor(page));
    const credentials = Buffer.from(route.authorization.slice(6), "base64").toString("latin1");
    const separator = credentials.indexOf(":");
    if (!route.authorization.startsWith("Basic ") || separator < 1) throw new Error();
    proxy.username = credentials.slice(0, separator);
    proxy.password = credentials.slice(separator + 1);
    const addresses = [
      ...new Set(
        (await lookup(proxy.hostname, { family: 4, all: true }))
          .map(({ address }) => address)
          .filter(publicIPv4),
      ),
    ].sort();
    if (!addresses.length) throw new Error();
    // This pins a gateway, not necessarily the provider's downstream exit IP.
    const selection = createHash("sha256")
      .update(affinity ?? proxy.href)
      .digest()
      .readUInt32BE(0);
    const address = addresses[selection % addresses.length];
    if (!address) throw new Error();
    proxy.hostname = address;
    return proxy;
  } catch {
    throw new SourceError("Unable to pin a public IPv4 proxy gateway");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
  );
  return result;
}

function nativeClient(proxy: URL, jar: CookieJar, userAgent?: string): Impit {
  // Impit's declaration expects void, while tough-cookie resolves to the stored Cookie.
  const cookieJar: NonNullable<ImpitOptions["cookieJar"]> = {
    async setCookie(cookie, url) {
      await jar.setCookie(cookie, url);
    },
    getCookieString: (url) => jar.getCookieString(url),
  };
  return new Impit({
    browser: userAgent === undefined ? "firefox144" : "chrome",
    proxyUrl: proxy.href,
    cookieJar,
    ...(userAgent === undefined ? {} : { headers: { "user-agent": userAgent } }),
    timeout: 40_000,
    followRedirects: false,
    ignoreTlsErrors: false,
    http3: false,
    vanillaFallback: false,
  });
}

export class CloudflareBrowser implements BrowserClient {
  readonly #route: ProxyRoute;
  readonly #page: number;
  readonly #solver: Pick<RiskBypass, "solve"> | undefined;
  readonly #affinity: string | undefined;
  #proxy: Promise<URL> | undefined;
  #session: { client: Impit; userAgent?: string } | undefined;
  #generation = 0;
  #lastSubmission = -Infinity;
  #refresh: { promise: Promise<void>; abort: AbortController } | undefined;

  constructor(
    route: ProxyRoute,
    page: number,
    solver?: Pick<RiskBypass, "solve">,
    affinity?: string,
  ) {
    this.#route = route;
    this.#page = page;
    this.#solver = solver;
    this.#affinity = affinity;
  }

  get generation(): number {
    return this.#generation;
  }

  async fetch(url: URL, init: Parameters<BrowserClient["fetch"]>[1]): Promise<ImpitResponse> {
    init.signal.throwIfAborted();
    const proxy = await this.proxy(init.signal);
    init.signal.throwIfAborted();
    this.#session ??= { client: nativeClient(proxy, new CookieJar()) };
    const session = this.#session;
    // The solved UA and jar must win over transport defaults, including mixed-case headers.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers)) {
      const lower = name.toLowerCase();
      if (lower !== "cookie" && (session.userAgent === undefined || lower !== "user-agent")) {
        headers[name] = value;
      }
    }
    if (session.userAgent !== undefined) headers["user-agent"] = session.userAgent;
    return session.client.fetch(url, { ...init, headers, redirect: "manual" });
  }

  async refresh(url: URL, expectedGeneration: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (expectedGeneration !== this.#generation) return;
    let pending = this.#refresh;
    if (!pending) {
      if (performance.now() - this.#lastSubmission < REFRESH_COOLDOWN_MS) {
        throw new SourceError("Clearance refresh is cooling down after a submission");
      }
      const abort = new AbortController();
      const promise = this.solve(url, abort.signal).finally(() => {
        this.#refresh = undefined;
      });
      pending = { promise, abort };
      this.#refresh = pending;
    }
    // A cancelled participant cancels the shared API operation, not just its local waiter.
    const abort = () => pending.abort.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await abortable(pending.promise, signal);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private proxy(signal: AbortSignal): Promise<URL> {
    this.#proxy ??= pinProxy(this.#route, this.#page, this.#affinity).catch((error: unknown) => {
      this.#proxy = undefined;
      throw error;
    });
    return abortable(this.#proxy, signal);
  }

  private async solve(url: URL, signal: AbortSignal): Promise<void> {
    if (!this.#solver) throw new RiskBypassError("Bid.Cars clearance submissions are disabled");
    const proxy = await this.proxy(signal);
    signal.throwIfAborted();
    this.#lastSubmission = performance.now();
    const session = await this.#solver.solve(url, proxy, signal);
    signal.throwIfAborted();
    const jar = new CookieJar();
    try {
      for (const [key, value] of Object.entries(session.cookies)) {
        await jar.setCookie(
          new Cookie({ key, value, path: "/", secure: url.protocol === "https:" }),
          url.href,
        );
      }
      const client = nativeClient(proxy, jar, session.userAgent);
      signal.throwIfAborted();
      this.#session = { client, userAgent: session.userAgent };
      this.#generation++;
    } catch {
      signal.throwIfAborted();
      throw new RiskBypassError("Unable to install the clearance session");
    }
  }
}
