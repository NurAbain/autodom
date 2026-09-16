import { setTimeout as delay } from "node:timers/promises";
import {
  normalizeVin,
  SourceError,
  SourceRateLimited,
  type VagvinCarfaxRecord,
} from "@autodom/core";
import { type Dispatcher, fetch, ProxyAgent } from "undici";
import { readBody, retryAfterSeconds } from "./http-response.js";
import type { VinTransportOptions } from "./vin-session.js";

const COUNT = "\u{1F4CD} Записи в базе CARFAX";
const VEHICLE = "\u2705 VIN определен как";

export function parseVagvinCarfaxRecord(body: string, vin: string): VagvinCarfaxRecord | null {
  const expected = normalizeVin(vin);
  if (!expected) throw new SourceError("VAGVIN requires a valid VIN");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SourceError("Malformed VAGVIN response");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SourceError("VAGVIN response schema changed");
  }
  const fields = payload as Record<string, unknown>;
  const count = fields[COUNT];
  const vehicle = fields[VEHICLE];
  if (
    fields.VIN !== expected ||
    Object.hasOwn(fields, "Сообщение") ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (vehicle != null && (typeof vehicle !== "string" || vehicle.length > 512))
  ) {
    throw new SourceError("VAGVIN record identity or schema mismatch");
  }
  // Only an explicit numeric zero for this VIN establishes a negative observation.
  if (count === 0) return null;
  return {
    vin: expected,
    record_count: count,
    vehicle: typeof vehicle === "string" ? vehicle.trim() || null : null,
  };
}

function isProxyAuthorizationFailure(error: unknown): boolean {
  // ProxyAgent rejects CONNECT before fetch has a Response; undici retains the status in this error.
  for (let depth = 0; error instanceof Error && depth < 4; depth += 1) {
    if (
      "code" in error &&
      error.code === "UND_ERR_ABORTED" &&
      /^Proxy response \((?:401|403|407)\) !== 200 when HTTP Tunneling$/u.test(error.message)
    ) {
      return true;
    }
    error = error.cause;
  }
  return false;
}

/** Public reseller availability only: no reports, purchases, redirects or proxy rotation. */
export class VagvinCarfaxLookup {
  readonly #dispatcher: Dispatcher;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #gapMs: number;
  readonly #queue = new Set<() => void>();
  readonly #active = new Set<Promise<unknown>>();
  #nextRequest = 0;
  #cooldownUntil = 0;
  #blocked = false;
  #closing: Promise<void> | undefined;

  constructor(options: VinTransportOptions) {
    const index = options.routes.findIndex((route) => route.tier === "residential");
    const route = options.routes[index];
    if (!route) throw new SourceError("VAGVIN requires a configured residential proxy");
    this.#timeoutMs = options.timeoutMs ?? 40_000;
    const requestedDelay = options.requestDelaySeconds ?? 5;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new SourceError("VAGVIN timeout must be a positive integer");
    }
    if (!Number.isFinite(requestedDelay) || requestedDelay < 0) {
      throw new SourceError("VAGVIN request delay must be non-negative");
    }
    this.#gapMs = Math.max(5, requestedDelay) * 1000;
    this.#signal = options.signal
      ? AbortSignal.any([this.#abort.signal, options.signal])
      : this.#abort.signal;
    this.#dispatcher =
      options.dispatcherFactory?.(route, 1, index) ??
      new ProxyAgent({ uri: route.urlFor(1), token: route.authorization });
  }

  async check(value: string, signal?: AbortSignal): Promise<VagvinCarfaxRecord | null> {
    const vin = normalizeVin(value);
    if (!vin) throw new SourceError("VAGVIN requires a valid VIN");
    const combined = AbortSignal.any([
      this.#signal,
      AbortSignal.timeout(this.#timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    this.#requireAvailable();
    if (this.#queue.size >= 10) throw new SourceError("VAGVIN request queue is full");
    const task = this.#run(vin, combined);
    this.#active.add(task);
    try {
      return await task;
    } finally {
      this.#active.delete(task);
    }
  }

  #requireAvailable(): void {
    if (this.#blocked) throw new SourceError("VAGVIN access is blocked for this instance");
    const remaining = this.#cooldownUntil - Date.now();
    if (remaining > 0) throw new SourceRateLimited(Math.ceil(remaining / 1000));
  }

  async #run(vin: string, signal: AbortSignal): Promise<VagvinCarfaxRecord | null> {
    const turn = Promise.withResolvers<void>();
    const resume = () => turn.resolve();
    let attempting = false;
    const release = () => {
      const first = this.#queue.values().next().value === resume;
      this.#queue.delete(resume);
      if (first) this.#queue.values().next().value?.();
    };
    const abort = () => {
      turn.reject(signal.reason);
      // In-flight admission stays held until fetch AND response body have settled.
      if (!attempting) release();
    };
    this.#queue.add(resume);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (this.#queue.size === 1) resume();
    try {
      await turn.promise;
      signal.throwIfAborted();
      this.#requireAvailable();
      let remaining = this.#nextRequest - Date.now();
      while (remaining > 0) {
        await delay(remaining, undefined, { signal });
        remaining = this.#nextRequest - Date.now();
      }
      signal.throwIfAborted();
      this.#requireAvailable();
      attempting = true;
      return await this.#request(vin, signal);
    } catch (error) {
      if (attempting) {
        if (isProxyAuthorizationFailure(error)) this.#blocked = true;
        this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + 60_000);
      }
      signal.throwIfAborted();
      throw new SourceError("VAGVIN availability could not be verified");
    } finally {
      if (attempting) this.#nextRequest = Date.now() + this.#gapMs;
      signal.removeEventListener("abort", abort);
      release();
    }
  }

  async #request(vin: string, signal: AbortSignal): Promise<VagvinCarfaxRecord | null> {
    const response = await fetch(`https://vagvin.ru/check_vin_car_aut?input=${vin}`, {
      dispatcher: this.#dispatcher,
      signal,
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (
      [401, 403, 407].includes(response.status) ||
      response.headers.get("cf-mitigated") === "challenge"
    ) {
      this.#blocked = true;
      await response.body?.cancel().catch(() => undefined);
      throw new SourceError("VAGVIN access is blocked");
    }
    if (response.status === 429) {
      this.#cooldownUntil =
        Date.now() + retryAfterSeconds(response.headers.get("retry-after")) * 1000;
      await response.body?.cancel().catch(() => undefined);
      throw new SourceError("VAGVIN rate limited the request");
    }
    const body = await readBody(response, signal);
    if (
      /captcha|cf-chl-|challenge-platform|verify (?:that )?you are human|провер.{0,20}(?:робот|человек)/iu.test(
        body,
      )
    ) {
      this.#blocked = true;
      throw new SourceError("VAGVIN access is challenged");
    }
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
    ) {
      throw new SourceError("VAGVIN returned an unexpected response");
    }
    return parseVagvinCarfaxRecord(body, vin);
  }

  close(): Promise<void> {
    this.#abort.abort();
    this.#closing ??= (async () => {
      await Promise.allSettled(this.#active);
      await this.#dispatcher.close();
    })();
    return this.#closing;
  }
}
