import { setTimeout as delay } from "node:timers/promises";
import { normalizeVin, type ProxyRoute, SourceError } from "@autodom/core";
import {
  isCopartPhotoUrl,
  parseVinArchivePhotoRequest,
  VIN_ARCHIVE_PROVIDERS,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveLookup,
  type VinArchiveLot,
  type VinArchiveObservation,
  type VinArchivePhotoLookup,
  type VinArchivePhotoRequest,
  type VinArchiveProvider,
} from "@autodom/core/vin-archive";
import pLimit from "p-limit";
import { type Dispatcher, fetch, ProxyAgent, type Response } from "undici";
import { BidCarsArchive } from "./bidcars-archive.js";
import type { BrowserClient } from "./bidcars-browser.js";
import { CarwayArchive } from "./carway-archive.js";
import {
  abortable,
  readBody,
  readImage,
  readImageProbe,
  retryAfterSeconds,
} from "./http-response.js";

const ORIGIN = "https://www.copart.com";
const SEARCH = "/public/lots/vin/search";
const DETAILS = "/public/data/lotdetails/solr/";
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
const MAX_IMAGES = 100;
const PHOTO_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_PHOTO_GRANTS = 4096;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type JsonObject = Record<string, unknown>;

export interface VinArchiveServiceOptions {
  providers: readonly VinArchiveProvider[];
  routes: readonly ProxyRoute[];
  signal?: AbortSignal;
  requestDelaySeconds?: number;
  /** Whole lookup deadline, including admission, pagination and image verification. */
  timeoutMs?: number;
  dispatcherFactory?: (route: ProxyRoute, page: number, index: number) => Dispatcher;
  browserClientFactory?: (route: ProxyRoute, page: number, index: number) => BrowserClient;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SourceError("Copart returned an invalid response");
  return value as JsonObject;
}

function lotId(value: JsonObject): string {
  const identifiers = [value.ln, value.lotNumberStr].filter((id) => id !== undefined && id !== "");
  if (!identifiers.length || identifiers.some((id) => !/^[1-9]\d{4,11}$/u.test(String(id))))
    throw new SourceError("Copart returned an invalid lot identity");
  const id = String(identifiers[0]);
  if (identifiers.some((other) => String(other) !== id))
    throw new SourceError("Copart returned conflicting lot identities");
  return id;
}

function compatibleVin(value: unknown, vin: string): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim().toUpperCase();
  return (
    /^[A-HJ-NPR-Z0-9*]{17}$/u.test(candidate) &&
    /[A-HJ-NPR-Z0-9]/u.test(candidate) &&
    [...candidate].every((character, index) => character === "*" || character === vin[index])
  );
}

function requireVin(entry: JsonObject, details: JsonObject, vin: string): void {
  const values = [entry.fv, details.fv].filter((value) => value !== undefined && value !== "");
  if (!values.length || values.some((value) => !compatibleVin(value, vin)))
    throw new SourceError("Copart did not confirm the requested VIN");
}

function sold(details: JsonObject): boolean {
  const dynamic = details.dynamicLotDetails === undefined ? {} : object(details.dynamicLotDetails);
  if (
    dynamic.lotSold === true ||
    dynamic.saleStatus === "Sold" ||
    details.ess === "Sold" ||
    details.errorCode === "LOT_SOLD" ||
    dynamic.errorCode === "LOT_SOLD"
  )
    return true;
  // A known live state is not an archive event. Missing/unknown state is not a negative lookup.
  if (dynamic.lotSold === false && dynamic.saleStatus === "MINIMUM_BID") return false;
  throw new SourceError("Copart did not confirm the lot sale status");
}

function auctionAt(value: unknown): number | null {
  // Copart's ad is milliseconds. Update dates and next/last-yard fields are not sale dates.
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= Date.now()
    ? Math.floor(value / 1000)
    : null;
}

export class VinArchiveService {
  readonly #options: VinArchiveServiceOptions;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #bidcars: BidCarsArchive | undefined;
  readonly #carway: CarwayArchive | undefined;
  readonly #abort = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  readonly #metadataQueue = new Set<() => void>();
  // Shared across VIN workflows, not one independent pool per lot or lookup.
  readonly #images = pLimit(3);
  readonly #photoGrants = new Map<string, number>();
  #nextRequest = 0;
  #rateLimitedUntil = 0;
  #closing: Promise<void> | undefined;

  constructor(options: VinArchiveServiceOptions) {
    if (
      !options.providers.length ||
      new Set(options.providers).size !== options.providers.length ||
      options.providers.some((provider) => !VIN_ARCHIVE_PROVIDERS.includes(provider))
    )
      throw new SourceError("Configure unique supported VIN archive providers");
    if (options.providers.some((provider) => provider !== "carway") && !options.routes.length)
      throw new SourceError(
        "VIN archive checks require configured proxies; direct access is disabled",
      );
    if (
      !Number.isFinite(options.requestDelaySeconds ?? 2) ||
      (options.requestDelaySeconds ?? 2) < 0
    )
      throw new SourceError("VIN archive request delay must be non-negative");
    if (!Number.isSafeInteger(options.timeoutMs ?? 40_000) || (options.timeoutMs ?? 40_000) < 1)
      throw new SourceError("VIN archive timeout must be a positive integer");
    this.#options = options;
    const preferred = options.routes.findIndex((route) => route.tier === "residential");
    const index = preferred < 0 ? 0 : preferred;
    const route = options.routes[index];
    try {
      if (options.providers.includes("copart")) {
        if (!route) throw new SourceError("VIN archive proxy route is missing");
        this.#dispatcher =
          options.dispatcherFactory?.(route, 1, index) ??
          new ProxyAgent({ uri: route.urlFor(1), token: route.authorization });
      }
      if (options.providers.includes("bidcars")) this.#bidcars = new BidCarsArchive(options);
    } catch {
      throw new SourceError("VIN archive proxy initialization failed");
    }
    if (options.providers.includes("carway"))
      this.#carway = new CarwayArchive(options.requestDelaySeconds);
  }

  readonly check: VinArchiveLookup = async (value, signal) => {
    const vin = normalizeVin(value);
    if (!vin) throw new RangeError("Invalid VIN");
    const cancellation = AbortSignal.any([
      this.#abort.signal,
      ...(this.#options.signal ? [this.#options.signal] : []),
      ...(signal ? [signal] : []),
    ]);
    const budget = AbortSignal.timeout(this.#options.timeoutMs ?? 40_000);
    const combined = AbortSignal.any([cancellation, budget]);
    cancellation.throwIfAborted();
    const task = Promise.all(
      this.#options.providers.map(async (provider): Promise<VinArchiveObservation> => {
        try {
          if (provider === "copart") return await this.#lookup(vin, combined);
          if (provider === "carway") {
            if (!this.#carway) throw new SourceError("Carway archive requests are disabled");
            return await this.#carway.check(vin, combined);
          }
          if (!this.#bidcars) throw new SourceError("Bid.Cars archive requests are disabled");
          return await this.#bidcars.check(vin, cancellation, budget);
        } catch {
          return {
            provider,
            status: "unavailable",
            source_url: VIN_ARCHIVE_SOURCE_URLS[provider],
            checked_at: Math.floor(Date.now() / 1000),
            partial: true,
            lots: [],
          };
        }
      }),
    );
    this.#active.add(task);
    try {
      const observations = await task;
      if (signal?.aborted || this.#options.signal?.aborted || this.#abort.signal.aborted)
        throw new DOMException("VIN archive lookup aborted", "AbortError");
      this.#prunePhotoGrants();
      const expires = Date.now() + PHOTO_GRANT_TTL_MS;
      for (const observation of observations)
        for (const lot of observation.lots)
          for (const photo_url of lot.photos) {
            const key = JSON.stringify([
              vin,
              observation.provider,
              lot.auction,
              lot.lot_id,
              photo_url,
            ]);
            this.#photoGrants.delete(key);
            if (this.#photoGrants.size >= MAX_PHOTO_GRANTS)
              this.#photoGrants.delete(this.#photoGrants.keys().next().value!);
            this.#photoGrants.set(key, expires);
          }
      return {
        vin,
        checked_at: Math.floor(Date.now() / 1000),
        coverage: "indexed_lots_only",
        sources: observations,
      };
    } finally {
      this.#active.delete(task);
    }
  };

  #prunePhotoGrants(): void {
    const now = Date.now();
    for (const [key, expires] of this.#photoGrants)
      if (expires <= now || this.#photoGrants.size > MAX_PHOTO_GRANTS)
        this.#photoGrants.delete(key);
  }

  #requirePhotoGrant(request: VinArchivePhotoRequest): void {
    const key = JSON.stringify([
      request.vin,
      request.provider,
      request.auction,
      request.lot_id,
      request.photo_url,
    ]);
    if (
      !this.#options.providers.includes(request.provider) ||
      (this.#photoGrants.get(key) ?? 0) <= Date.now()
    )
      throw new SourceError("Archive photo is unavailable; repeat the archive lookup");
  }

  readonly getPhoto: VinArchivePhotoLookup = async (value, signal) => {
    const request = parseVinArchivePhotoRequest(value);
    const combined = AbortSignal.any([
      this.#abort.signal,
      AbortSignal.timeout(this.#options.timeoutMs ?? 40_000),
      ...(this.#options.signal ? [this.#options.signal] : []),
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    this.#prunePhotoGrants();
    this.#requirePhotoGrant(request);
    const task =
      request.provider === "bidcars"
        ? this.#bidcars!.getPhoto(request, combined, () => this.#requirePhotoGrant(request))
        : request.provider === "carway"
          ? this.#carway!.getPhoto(request, combined, () => this.#requirePhotoGrant(request))
          : this.#images(async () => {
              combined.throwIfAborted();
              this.#requirePhotoGrant(request);
              return readImage(
                await this.#response(request.photo_url, combined, undefined, false),
                combined,
              );
            });
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      () => this.#active.delete(task),
    );
    return abortable(task, combined);
  };

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      this.#photoGrants.clear();
      while (this.#active.size) await Promise.allSettled(this.#active);
      try {
        await Promise.all([this.#dispatcher?.close(), this.#bidcars?.close()]);
      } catch {
        throw new SourceError("VIN archive proxy shutdown failed");
      }
    })();
    return this.#closing;
  }

  #requireTraffic(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#rateLimitedUntil > Date.now())
      throw new SourceError("Copart is temporarily rate limited");
  }

  async #response(
    url: string,
    signal: AbortSignal,
    json?: JsonObject,
    probe = true,
  ): Promise<Response> {
    if (!this.#dispatcher) throw new SourceError("Copart archive requests are disabled");
    this.#requireTraffic(signal);
    const metadata = url.startsWith(`${ORIGIN}/`);
    if (
      metadata
        ? !(
            url === `${ORIGIN}${SEARCH}` ||
            /^https:\/\/www\.copart\.com\/public\/data\/lotdetails\/solr\/(?:lotImages\/)?[1-9]\d{4,11}$/u.test(
              url,
            )
          )
        : !isCopartPhotoUrl(url)
    )
      throw new SourceError("VIN archive request is outside approved source paths");
    let response: Response;
    try {
      response = await fetch(url, {
        dispatcher: this.#dispatcher,
        method: json ? "POST" : "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: metadata ? "application/json" : "image/jpeg,image/png,image/webp",
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...(!metadata && probe ? { Range: "bytes=0-511" } : {}),
        },
        ...(json ? { body: JSON.stringify(json) } : {}),
        redirect: "manual",
        signal,
      });
    } catch {
      throw new SourceError("Copart proxy request failed");
    }
    if (response.status === 429) {
      this.#rateLimitedUntil = Math.max(
        this.#rateLimitedUntil,
        Date.now() + retryAfterSeconds(response.headers.get("retry-after")) * 1000,
      );
    }
    if (response.status !== 200 && !(response.status === 206 && !metadata && probe)) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceError(`Copart returned HTTP ${response.status}`);
    }
    return response;
  }

  async #json(path: string, signal: AbortSignal, body?: JsonObject): Promise<JsonObject> {
    this.#requireTraffic(signal);
    const queue = this.#metadataQueue;
    const turn = Promise.withResolvers<void>();
    const resume = () => turn.resolve();
    const release = () => {
      const first = queue.values().next().value === resume;
      queue.delete(resume);
      if (first) queue.values().next().value?.();
    };
    const abort = () => {
      turn.reject(new SourceError("VIN archive lookup aborted"));
      release();
    };
    queue.add(resume);
    signal.addEventListener("abort", abort, { once: true });
    if (queue.size === 1) resume();
    let response: Promise<Response>;
    try {
      await turn.promise;
      this.#requireTraffic(signal);
      const wait = this.#nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      this.#requireTraffic(signal);
      this.#nextRequest = Date.now() + (this.#options.requestDelaySeconds ?? 2) * 1000;
      response = this.#response(`${ORIGIN}${path}`, signal, body);
    } finally {
      signal.removeEventListener("abort", abort);
      release();
    }
    const payload = object(JSON.parse(await readBody(await response)));
    if (payload.returnCode !== 1) throw new SourceError("Copart lookup did not succeed");
    return object(payload.data);
  }

  async #verifyImage(url: string, signal: AbortSignal): Promise<boolean> {
    const task = this.#images(async () => {
      try {
        return await readImageProbe(await this.#response(url, signal), signal);
      } catch {
        return false;
      }
    });
    this.#active.add(task);
    void task.finally(() => this.#active.delete(task));
    return task;
  }

  async #gallery(lot: VinArchiveLot, signal: AbortSignal): Promise<void> {
    const data = await this.#json(`${DETAILS}lotImages/${lot.lot_id}`, signal);
    const images = object(data.imagesList);
    if (
      !Array.isArray(images.content) ||
      !Number.isSafeInteger(images.totalElements) ||
      Number(images.totalElements) < 0
    )
      throw new SourceError("Copart returned an invalid image manifest");
    let complete =
      images.totalElements === images.content.length && images.content.length <= MAX_IMAGES;
    const entries: { sequence: number; url: string }[] = [];
    for (const raw of images.content.slice(0, MAX_IMAGES)) {
      try {
        const image = object(raw);
        if (lotId(image) !== lot.lot_id)
          throw new SourceError("Copart image belongs to another lot");
        if (image.imageTypeCode === "EXT360" || image.imageTypeCode === "INT360") continue;
        if (image.imageTypeCode !== "IMG")
          throw new SourceError("Copart returned an unknown image type");
        if (!Number.isSafeInteger(image.imageSeqNumber) || Number(image.imageSeqNumber) < 0)
          throw new SourceError("Copart image sequence is invalid");
        const url =
          typeof image.highResUrl === "string" && image.highResUrl
            ? image.highResUrl
            : image.fullUrl;
        if (typeof url !== "string" || !isCopartPhotoUrl(url))
          throw new SourceError("Copart image URL is outside approved source paths");
        entries.push({ sequence: Number(image.imageSeqNumber), url });
      } catch {
        complete = false;
      }
    }
    entries.sort((left, right) => left.sequence - right.sequence);
    const urls = [...new Set(entries.map((entry) => entry.url))];
    const verified = urls.map(() => false);
    const verification = Promise.all(
      urls.map(async (url, index) => {
        verified[index] = await this.#verifyImage(url, signal);
      }),
    );
    const cancelled = Promise.withResolvers<void>();
    const abort = () => cancelled.resolve();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await Promise.race([verification, cancelled.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    lot.photos = urls.filter((_url, index) => verified[index]);
    lot.photos_complete = complete && !signal.aborted && verified.every(Boolean);
  }

  async #lookup(vin: string, signal: AbortSignal): Promise<VinArchiveObservation> {
    const lots: VinArchiveLot[] = [];
    let partial = false;
    const entries = new Map<string, JsonObject>();
    try {
      let expectedTotal: number | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await this.#json(SEARCH, signal, {
          filter: { MISC: [`ps_vin_number:${vin}`] },
          ...(page ? { page, size: PAGE_SIZE } : {}),
        });
        const query = object(data.query);
        const filter = object(query.filter);
        if (
          !Array.isArray(filter.MISC) ||
          filter.MISC.length !== 1 ||
          filter.MISC[0] !== `ps_vin_number:${vin}` ||
          query.page !== page ||
          query.size !== PAGE_SIZE
        )
          throw new SourceError("Copart did not confirm the exact VIN search");
        const results = object(data.results);
        if (
          !Array.isArray(results.content) ||
          !Number.isSafeInteger(results.totalElements) ||
          Number(results.totalElements) < 0
        )
          throw new SourceError("Copart returned invalid search results");
        const total = Number(results.totalElements);
        if (expectedTotal !== undefined && expectedTotal !== total) partial = true;
        expectedTotal = total;
        const before = entries.size;
        if (results.content.length > PAGE_SIZE) partial = true;
        for (const raw of results.content.slice(0, PAGE_SIZE)) {
          try {
            const entry = object(raw);
            const id = lotId(entry);
            if (entry.fv !== undefined && !compatibleVin(entry.fv, vin))
              throw new SourceError("Copart search returned a different VIN");
            if (!entries.has(id)) entries.set(id, entry);
          } catch {
            partial = true;
          }
        }
        if (entries.size >= total) {
          if (entries.size !== total) partial = true;
          break;
        }
        if (entries.size === before || page === MAX_PAGES - 1) {
          partial = true;
          break;
        }
      }
    } catch {
      partial = true;
    }
    for (const [id, entry] of entries) {
      try {
        const data = await this.#json(`${DETAILS}${id}`, signal);
        const details = object(data.lotDetails);
        if (lotId(details) !== id) throw new SourceError("Copart returned a different lot");
        requireVin(entry, details, vin);
        if (!sold(details)) continue;
        const lot: VinArchiveLot = {
          auction: "copart",
          lot_id: id,
          source_url: `${ORIGIN}/lot/${id}`,
          events: [
            {
              status: "sold",
              auction_at: auctionAt(details.ad),
              auction_date: null,
              final_bid_usd_minor: null,
            },
          ],
          photos: [],
          photos_complete: false,
        };
        // Once confirmed, a sold event survives gallery failures and expired photographs.
        lots.push(lot);
        await this.#gallery(lot, signal);
        if (!lot.photos_complete) partial = true;
      } catch {
        partial = true;
      }
    }
    return {
      provider: "copart",
      status: lots.some((lot) => lot.photos.length)
        ? "available"
        : lots.length
          ? "no_photos"
          : partial
            ? "unavailable"
            : "not_found",
      source_url: VIN_ARCHIVE_SOURCE_URLS.copart,
      checked_at: Math.floor(Date.now() / 1000),
      partial,
      lots,
    };
  }
}
