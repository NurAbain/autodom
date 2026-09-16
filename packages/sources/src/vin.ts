import {
  type EncarHistory,
  normalizeVin,
  type ProxyRoute,
  SourceError,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinLookup,
  type VinProvider,
} from "@autodom/core";
import type { VinArchivePhotoLookup, VinArchiveProvider } from "@autodom/core/vin-archive";
import { checkAutoDev } from "./autodev.js";
import { checkCar365 } from "./car365.js";
import { CarcheckSession } from "./carcheck-session.js";
import { checkCarHistory } from "./carhistory.js";
import { EncarHistoryLookup } from "./encar-cache.js";
import { abortable } from "./http-response.js";
import { checkNhtsaVpic } from "./nhtsa-vpic.js";
import { VinArchiveService } from "./vin-archive.js";
import { VinTransport, type VinTransportOptions } from "./vin-session.js";

export class VinCheckService {
  readonly #enabled: Record<VinProvider, boolean> = {
    carhistory: false,
    car365: false,
    encar: false,
    nhtsa_vpic: false,
    autodev: false,
  };
  readonly #transport: VinTransport | undefined;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #timeoutMs: number;
  readonly #autoDevApiKey: string | undefined;
  readonly #active = new Set<Promise<unknown>>();
  readonly #carcheck: CarcheckSession | undefined;
  readonly #encarLookup: EncarHistoryLookup | undefined;
  readonly #encarRequests = new Map<string, Promise<EncarHistory | null>>();
  readonly #archives: VinArchiveService | undefined;

  constructor(
    options: VinTransportOptions & {
      providers: readonly VinProvider[];
      archiveProviders?: readonly VinArchiveProvider[] | undefined;
      autoDevApiKey?: string | undefined;
      riskBypassApiKey?: string | undefined;
      encarCachePath?: string | undefined;
      carcheckRoutes?: readonly ProxyRoute[] | undefined;
    },
  ) {
    this.#signal = options.signal
      ? AbortSignal.any([this.#abort.signal, options.signal])
      : this.#abort.signal;
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
    let encarDiscovery = options.encarDiscovery;
    if (this.#enabled.encar) {
      if (!encarDiscovery) {
        this.#carcheck = new CarcheckSession({
          routes: options.carcheckRoutes ?? options.routes,
          apiKey: options.riskBypassApiKey ?? "",
          signal: this.#signal,
          ...(options.requestDelaySeconds === undefined
            ? {}
            : { requestDelaySeconds: options.requestDelaySeconds }),
        });
        encarDiscovery = this.#carcheck;
      }
      this.#encarLookup = new EncarHistoryLookup({
        ...(options.encarCachePath === undefined ? {} : { cachePath: options.encarCachePath }),
      });
    }
    if (this.#enabled.carhistory || this.#enabled.car365 || this.#enabled.encar) {
      this.#transport = new VinTransport({
        ...options,
        ...(encarDiscovery ? { encarDiscovery } : {}),
      });
    }
    this.#timeoutMs = options.timeoutMs ?? 40_000;
    if (options.archiveProviders?.length)
      this.#archives = new VinArchiveService({
        ...options,
        providers: options.archiveProviders,
        signal: this.#signal,
      });
    if (
      (this.#enabled.nhtsa_vpic || this.#enabled.autodev) &&
      (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
    ) {
      throw new SourceError("Direct VIN request timeout must be a positive integer");
    }
  }

  async start(): Promise<void> {
    await this.#encarLookup?.initialize();
    this.#signal.throwIfAborted();
    this.#carcheck?.start();
  }

  #checkEncar(vin: string, signal?: AbortSignal): Promise<EncarHistory | null> {
    let task = this.#encarRequests.get(vin);
    if (!task) {
      const transport = this.#transport;
      const lookup = this.#encarLookup;
      if (!transport || !lookup) throw new SourceError("Encar is not configured");
      // One bounded lookup may serve several callers; one caller cannot cancel the others.
      task = transport
        .run("encar", (session) => lookup.check(vin, session), this.#signal)
        .finally(() => this.#encarRequests.delete(vin));
      this.#encarRequests.set(vin, task);
    }
    return abortable(task, signal ?? this.#signal);
  }

  readonly check: VinLookup = async (value, signal): Promise<VinCheckResult> => {
    const vin = normalizeVin(value);
    if (!vin) throw new RangeError("VIN must contain 17 letters and digits, without I, O or Q");
    signal?.throwIfAborted();
    // Korea, decoders and archives share one deadline, never a fresh fallback budget.
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const cancellation = AbortSignal.any([this.#signal, ...(signal ? [signal] : [])]);
    const workflowSignal = AbortSignal.any([cancellation, deadline]);
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
            workflowSignal,
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
            workflowSignal,
          );
          result.car365.status = result.car365.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          result.car365.status = "unavailable";
        }
      })(),
      (async () => {
        if (!this.#enabled.encar || !transport) return;
        const observation: NonNullable<VinCheckResult["encar"]> = {
          status: "unavailable",
          source_url: VIN_SOURCE_URLS.encar,
          checked_at: Date.now() / 1000,
          data: null,
        };
        result.encar = observation;
        try {
          // The shared task's deadline preserves facts when optional reports time out.
          observation.data = await this.#checkEncar(vin, cancellation);
          observation.status = observation.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          observation.status = "unavailable";
        }
      })(),
    ]);
    signal?.throwIfAborted();
    // A failed Korean lookup is not absence and must not trigger fallback egress.
    if (
      this.#signal.aborted ||
      (this.#enabled.carhistory && result.carhistory.status !== "not_found") ||
      (this.#enabled.car365 && result.car365.status !== "not_found") ||
      (this.#enabled.encar && result.encar?.status !== "not_found")
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
        if (workflowSignal.aborted) return;
        const task = checkNhtsaVpic(vin, workflowSignal, this.#timeoutMs);
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
        if (workflowSignal.aborted) return;
        const task = checkAutoDev(vin, this.#autoDevApiKey, workflowSignal, this.#timeoutMs);
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
        if (!this.#archives) return;
        result.archives = await this.#archives.check(vin, cancellation, deadline);
      })(),
    ]);
    return result;
  };

  readonly getArchivePhoto: VinArchivePhotoLookup = async (request, signal) => {
    if (!this.#archives) throw new SourceError("VIN archives are not configured");
    return this.#archives.getPhoto(request, signal);
  };

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.all([
      this.#transport?.close(),
      this.#carcheck?.close(),
      this.#archives?.close(),
      Promise.allSettled(this.#active),
    ]);
    await this.#encarLookup?.close();
  }
}
