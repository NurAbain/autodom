import {
  normalizeVin,
  SourceError,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinLookup,
  type VinProvider,
} from "@autodom/core";
import { checkAutoDev } from "./autodev.js";
import { checkCar365 } from "./car365.js";
import { checkCarHistory } from "./carhistory.js";
import { checkNhtsaVpic } from "./nhtsa-vpic.js";
import { VinTransport, type VinTransportOptions } from "./vin-session.js";

export class VinCheckService {
  readonly #enabled: Record<VinProvider, boolean> = {
    carhistory: false,
    car365: false,
    nhtsa_vpic: false,
    autodev: false,
  };
  readonly #transport: VinTransport | undefined;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #autoDevApiKey: string | undefined;
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    options: VinTransportOptions & {
      providers: readonly VinProvider[];
      autoDevApiKey?: string | undefined;
    },
  ) {
    for (const provider of options.providers) this.#enabled[provider] = true;
    this.#autoDevApiKey = this.#enabled.autodev ? options.autoDevApiKey?.trim() : undefined;
    if (
      this.#enabled.autodev &&
      (!this.#autoDevApiKey ||
        this.#autoDevApiKey.length > 4096 ||
        /[^\x21-\x7e]/u.test(this.#autoDevApiKey))
    ) {
      throw new SourceError(
        "Auto.dev requires AUTODOM_AUTODEV_API_KEY as a private API credential",
      );
    }
    if (this.#enabled.carhistory || this.#enabled.car365) {
      this.#transport = new VinTransport(options);
    }
    this.#timeoutMs = options.timeoutMs ?? 40_000;
    if (
      (this.#enabled.nhtsa_vpic || this.#enabled.autodev) &&
      (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
    ) {
      throw new SourceError("Direct VIN request timeout must be a positive integer");
    }
    this.#signal = options.signal
      ? AbortSignal.any([this.#abort.signal, options.signal])
      : this.#abort.signal;
  }

  readonly check: VinLookup = async (value, signal): Promise<VinCheckResult> => {
    const vin = normalizeVin(value);
    if (!vin) throw new RangeError("VIN must contain 17 letters and digits, without I, O or Q");
    signal?.throwIfAborted();
    // Both phases share the existing lookup budget; fallback must not extend it.
    const fallbackSignal =
      this.#enabled.nhtsa_vpic || this.#enabled.autodev
        ? AbortSignal.any([
            this.#signal,
            AbortSignal.timeout(this.#timeoutMs),
            ...(signal ? [signal] : []),
          ])
        : undefined;
    const result: VinCheckResult = {
      vin,
      checked_at: Date.now() / 1000,
      carhistory: { status: "disabled", source_url: VIN_SOURCE_URLS.carhistory, checked_at: null },
      car365: {
        status: "disabled",
        source_url: VIN_SOURCE_URLS.car365,
        checked_at: null,
        data: null,
      },
    };
    const transport = this.#transport;
    await Promise.all([
      (async () => {
        if (!this.#enabled.carhistory || !transport) return;
        result.carhistory.checked_at = Date.now() / 1000;
        try {
          result.carhistory.status = await transport.run(
            "carhistory",
            (session) => checkCarHistory(vin, session),
            signal,
          );
        } catch {
          signal?.throwIfAborted();
          result.carhistory.status = "unavailable";
        }
      })(),
      (async () => {
        if (!this.#enabled.car365 || !transport) return;
        result.car365.checked_at = Date.now() / 1000;
        try {
          result.car365.data = await transport.run(
            "car365",
            (session) => checkCar365(vin, session),
            signal,
          );
          result.car365.status = result.car365.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          result.car365.status = "unavailable";
        }
      })(),
    ]);
    signal?.throwIfAborted();
    // A failed Korean lookup is not absence and must not trigger decoder egress.
    if (
      !fallbackSignal ||
      this.#signal.aborted ||
      (this.#enabled.carhistory && result.carhistory.status !== "not_found") ||
      (this.#enabled.car365 && result.car365.status !== "not_found")
    ) {
      return result;
    }
    await Promise.all([
      (async () => {
        if (!this.#enabled.nhtsa_vpic) return;
        const observation: NonNullable<VinCheckResult["nhtsa_vpic"]> = {
          status: "unavailable",
          source_url: VIN_SOURCE_URLS.nhtsa_vpic,
          checked_at: Date.now() / 1000,
          data: null,
        };
        result.nhtsa_vpic = observation;
        const task = checkNhtsaVpic(vin, fallbackSignal, this.#timeoutMs);
        this.#active.add(task);
        try {
          observation.data = await task;
          observation.status = observation.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          observation.status = "unavailable";
        } finally {
          this.#active.delete(task);
        }
      })(),
      (async () => {
        if (!this.#autoDevApiKey) return;
        const observation: NonNullable<VinCheckResult["autodev"]> = {
          status: "unavailable",
          source_url: VIN_SOURCE_URLS.autodev,
          checked_at: Date.now() / 1000,
          data: null,
        };
        result.autodev = observation;
        const task = checkAutoDev(vin, this.#autoDevApiKey, fallbackSignal, this.#timeoutMs);
        this.#active.add(task);
        try {
          observation.data = await task;
          observation.status = observation.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          observation.status = "unavailable";
        } finally {
          this.#active.delete(task);
        }
      })(),
    ]);
    return result;
  };

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.all([this.#transport?.close(), Promise.allSettled(this.#active)]);
  }
}
