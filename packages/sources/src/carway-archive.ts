import { setTimeout as delay } from "node:timers/promises";
import { normalizeVin, SourceError } from "@autodom/core";
import {
  CARWAY_ARCHIVE_MAX_PHOTOS,
  carwayArchiveSearchUrl,
  isVinArchiveLotUrl,
  isVinArchivePhotoUrl,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveAuction,
  type VinArchiveLot,
  type VinArchiveObservation,
  type VinArchivePhoto,
  type VinArchivePhotoRequest,
} from "@autodom/core/vin-archive";
import { type Cheerio, load } from "cheerio";
import type { AnyNode } from "domhandler";
import pLimit from "p-limit";
import { fetch } from "undici";
import { abortable, readBody, readImage, retryAfterSeconds } from "./http-response.js";

function parseLot(text: string, vin: string, sourceUrl: string): VinArchiveLot | null {
  const $ = load(text);
  const hidden = (element: Cheerio<AnyNode>): boolean =>
    element
      .parents()
      .addBack()
      .toArray()
      .some((node) => {
        const current = $(node);
        return (
          current.is("[hidden], [aria-hidden='true'], template, script, style, noscript") ||
          /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(
            current.attr("style") ?? "",
          )
        );
      });
  const product = $("#product_details");
  const identity = product.find(".product_vin");
  const empty = $("body > section > h1")
    .toArray()
    .some((node) => {
      const element = $(node);
      return (
        element.text().trim() === "No Car Found!" &&
        !hidden(element) &&
        !element
          .find("*")
          .toArray()
          .some((child) => hidden($(child)))
      );
    });
  // A miss is evidence only without any contradictory (even masked) product identity.
  if (empty) {
    if (
      product.length ||
      $(".product_vin, .lot_information_container, .slider img[data-hash]").length
    )
      throw new SourceError("Carway returned contradictory vehicle results");
    return null;
  }
  if (
    product.length !== 1 ||
    identity.length !== 1 ||
    hidden(identity) ||
    identity
      .find("*")
      .toArray()
      .some((node) => hidden($(node))) ||
    !/^Vin\s*:/iu.test(identity.text().trim()) ||
    identity
      .text()
      .trim()
      .replace(/^Vin\s*:\s*/iu, "") !== vin
  )
    throw new SourceError("Carway vehicle identity is missing or ambiguous");

  const information = product.find(".lot_information_container");
  const labels = information.find(".product_detail_label_container .detail_label");
  const values = information.find(".product_detail_container .detail");
  if (
    information.length !== 1 ||
    information.find(".product_detail_label_container").length !== 1 ||
    information.find(".product_detail_container").length !== 1 ||
    labels.length < 2 ||
    labels.length !== values.length
  )
    throw new SourceError("Carway lot detail schema changed");
  const fields = new Map<string, string>();
  labels.each((index, node) => {
    const label = $(node);
    const value = values.eq(index);
    const name = label.text().trim().toLowerCase();
    if (!name || fields.has(name) || hidden(label) || hidden(value))
      throw new SourceError("Carway lot details are ambiguous");
    fields.set(name, value.text().trim());
  });
  const lotId = /^#([1-9][0-9]{0,11})$/u.exec(fields.get("lot information") ?? "")?.[1];
  const auctionName = fields.get("auction")?.toLowerCase();
  const country = fields.get("country")?.toLowerCase();
  const uae = country === "uae" || country === "united arab emirates";
  const unknownCountry = !country || country === "-";
  let auction: VinArchiveAuction;
  if (auctionName === "emiratesauction" && (unknownCountry || uae)) auction = "emiratesauction";
  else if (
    (auctionName === "copart" && uae) ||
    (auctionName === "copart uae" && (unknownCountry || uae))
  )
    auction = "copart_uae";
  else throw new SourceError("Carway auction is not a proven UAE archive");
  if (!lotId || !isVinArchiveLotUrl(sourceUrl, "carway", auction, lotId, vin))
    throw new SourceError("Carway lot identity is invalid");

  const galleries = product.find(".slider");
  if (galleries.length > 1) throw new SourceError("Carway primary gallery is ambiguous");
  const photos = new Set<string>();
  galleries.find("img[data-hash]").each((_index, node) => {
    const image = $(node);
    const url = image.attr("src");
    if (
      photos.size < CARWAY_ARCHIVE_MAX_PHOTOS &&
      image.attr("alt") === vin &&
      url &&
      isVinArchivePhotoUrl(url, "carway", auction, lotId, vin)
    )
      photos.add(url);
  });
  return {
    auction,
    lot_id: lotId,
    source_url: sourceUrl,
    events: [],
    photos: [...photos],
    // The VIN page is not proof of complete history or a complete gallery.
    photos_complete: false,
  };
}

export class CarwayArchive {
  readonly #requestDelayMs: number;
  readonly #metadataQueue = new Set<() => void>();
  readonly #images = pLimit(3);
  #nextRequest = 0;
  #limitedUntil = 0;

  constructor(requestDelaySeconds = 2) {
    if (!Number.isFinite(requestDelaySeconds) || requestDelaySeconds < 0)
      throw new SourceError("Carway request delay must be non-negative");
    this.#requestDelayMs = requestDelaySeconds * 1000;
  }

  async check(value: string, signal: AbortSignal): Promise<VinArchiveObservation> {
    const vin = normalizeVin(value);
    const sourceUrl = vin ? carwayArchiveSearchUrl(vin) : null;
    if (!vin || !sourceUrl) throw new RangeError("Invalid VIN");
    const release = await this.#admit(signal);
    let text: string;
    try {
      const wait = this.#nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      this.#nextRequest = Date.now() + this.#requestDelayMs;
      text = await abortable(readBody(await this.#response(sourceUrl, false, signal)), signal);
    } finally {
      release();
    }
    signal.throwIfAborted();
    const lot = parseLot(text, vin, sourceUrl);
    return {
      provider: "carway",
      source_url: VIN_ARCHIVE_SOURCE_URLS.carway,
      checked_at: Math.floor(Date.now() / 1000),
      status: lot ? (lot.photos.length ? "available" : "no_photos") : "not_found",
      partial: lot !== null,
      lots: lot ? [lot] : [],
    };
  }

  async getPhoto(
    request: VinArchivePhotoRequest,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<VinArchivePhoto> {
    if (
      request.provider !== "carway" ||
      !isVinArchivePhotoUrl(
        request.photo_url,
        "carway",
        request.auction,
        request.lot_id,
        request.vin,
      )
    )
      throw new SourceError("Invalid Carway photo request");
    signal.throwIfAborted();
    const task = this.#images(async () => {
      signal.throwIfAborted();
      authorize();
      return readImage(await this.#response(request.photo_url, true, signal), signal);
    });
    return abortable(task, signal);
  }

  async #admit(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const queue = this.#metadataQueue;
    const turn = Promise.withResolvers<void>();
    const resume = () => turn.resolve();
    queue.add(resume);
    const release = () => {
      const first = queue.values().next().value === resume;
      queue.delete(resume);
      if (first) queue.values().next().value?.();
    };
    if (queue.size === 1) resume();
    try {
      await abortable(turn.promise, signal);
      signal.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  async #response(url: string, image: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#limitedUntil > Date.now())
      throw new SourceError("Carway is temporarily rate limited");
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: image ? "image/jpeg,image/png,image/webp" : "text/html" },
    });
    if (response.status === 429)
      this.#limitedUntil = Math.max(
        this.#limitedUntil,
        Date.now() + retryAfterSeconds(response.headers.get("retry-after")) * 1000,
      );
    if (
      response.status !== 200 ||
      (response.url && response.url !== url) ||
      (!image && !/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? ""))
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new SourceError("Carway archive request failed");
    }
    return response;
  }
}
