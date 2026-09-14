import { setTimeout as delay } from "node:timers/promises";
import { normalizeVin, type ProxyRoute, SourceError } from "@autodom/core";
import {
  isVinArchiveLotUrl,
  isVinArchivePhotoUrl,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveAuction,
  type VinArchiveEvent,
  type VinArchiveLot,
  type VinArchiveObservation,
  type VinArchivePhoto,
  type VinArchivePhotoRequest,
} from "@autodom/core/vin-archive";
import { load } from "cheerio";
import pLimit from "p-limit";
import { type BrowserClient, CloudflareBrowser } from "./cloudflare-browser.js";
import {
  abortable,
  readBody,
  readImage,
  readImageProbe,
  retryAfterSeconds,
} from "./http-response.js";

const ORIGIN = "https://bid.cars";
const MAX_RECORDS = 100;
const MAX_PAGES = 5;
const MAX_IMAGES = 100;
const MAX_RELATED_LOTS = 5;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
type JsonObject = Record<string, unknown>;
interface Candidate {
  auction: VinArchiveAuction;
  id: string;
  url: string;
  rows: JsonObject[];
  detail?: Detail;
}
interface Detail {
  lot: VinArchiveLot | null;
  partial: boolean;
  related: string[];
}
export interface BidCarsArchiveOptions {
  routes: readonly ProxyRoute[];
  requestDelaySeconds?: number;
  signal?: AbortSignal;
  browserClientFactory?: (route: ProxyRoute, page: number, index: number) => BrowserClient;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SourceError("Bid.Cars archive schema changed");
  return value as JsonObject;
}

function calendar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let date = value;
  const english = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([0-9]{1,2}) ([A-Za-z]+), ([0-9]{4})$/u.exec(
    value,
  );
  if (english) {
    const month = MONTHS.indexOf(english[2]!);
    if (month < 0) return null;
    date = `${english[3]}-${String(month + 1).padStart(2, "0")}-${english[1]!.padStart(2, "0")}`;
  }
  if (!/^[12][0-9]{3}-[0-9]{2}-[0-9]{2}$/u.test(date)) return null;
  const instant = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(instant) &&
    instant <= Date.now() &&
    new Date(instant).toISOString().slice(0, 10) === date
    ? date
    : null;
}

function dollars(value: unknown, usd: boolean): number | null {
  if (!usd || typeof value !== "string" || value.length > 32) return null;
  const match = /^\$([0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.([0-9]{1,2}))?(?:\s+USD)?$/u.exec(
    value.trim(),
  );
  if (!match) return null;
  const cents =
    BigInt(match[1]!.replaceAll(",", "")) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return cents <= 100_000_000_000_000n ? Number(cents) : null;
}

function declaration(text: string, name: string): string {
  const values = [
    ...text.matchAll(
      new RegExp(
        `^\\s*(?:var|let|const)\\s+${name}\\s*=\\s*(?:'([^'\\r\\n]*)'|"([^"\\r\\n]*)"|([01]));`,
        "gm",
      ),
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]!);
  if (!values.length || values.some((value) => value !== values[0]))
    throw new SourceError("Conflicting Bid.Cars archive declaration");
  return values[0]!;
}

function parseDetail(text: string, candidate: Candidate, vin: string): Detail {
  if (!/<html(?:\s|>)/iu.test(text) || !/<\/html\s*>/iu.test(text))
    throw new SourceError("Incomplete Bid.Cars detail");
  const $ = load(text);
  const stack = $.root()
    .contents()
    .toArray()
    .map((node) => ({ node, depth: 1 }));
  let count = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++count > 100_000 || entry.depth > 256)
      throw new SourceError("Bid.Cars detail complexity exceeds limit");
    if ("children" in entry.node)
      for (const node of entry.node.children) stack.push({ node, depth: entry.depth + 1 });
  }
  const lot = `${candidate.auction === "copart" ? "1" : "0"}-${candidate.id}`;
  const auction = candidate.auction === "copart" ? "Copart" : "IAAI";
  const scripts = $("script:not([src]):not([type='application/ld+json'])")
    .toArray()
    .map((node) => $(node).text())
    .join("\n");
  if (declaration(scripts, "lotNumber") !== lot || declaration(scripts, "auctionType") !== auction)
    throw new SourceError("Bid.Cars detail auction identity mismatch");
  const archived = declaration(scripts, "isArchived");
  if (archived !== "0" && archived !== "1")
    throw new SourceError("Bid.Cars archive status schema changed");
  const identities = $("script[type='application/ld+json']")
    .toArray()
    .map((node) => object(JSON.parse($(node).text())))
    .filter((data) => data["@type"] === "Vehicle");
  if (identities.length > 1) throw new SourceError("Ambiguous Bid.Cars vehicle identity");
  const identity = identities[0];
  if (identity && (identity.url !== candidate.url || identity.vehicleIdentificationNumber !== vin))
    throw new SourceError("Bid.Cars detail VIN mismatch");
  if (
    $('meta[property="og:url"]').length !== 1 ||
    $('meta[property="og:url"]').attr("content") !== candidate.url
  )
    throw new SourceError("Bid.Cars detail URL mismatch");
  $("script,style").remove();
  const labels: Record<string, string> = {};
  $("#main-info .option")
    .not(".more-specs .option")
    .each((_index, node) => {
      const label = $(node)
        .contents()
        .filter((_i, child) => child.type === "text")
        .text()
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
      if (!["vin", "lot"].includes(label)) return;
      const value = $(node).find(".right-info").text().replace(/\s+/gu, "");
      if (labels[label] !== undefined && labels[label] !== value)
        throw new SourceError("Conflicting Bid.Cars detail label");
      labels[label] = value;
    });
  if (labels.vin !== vin || labels.lot !== lot)
    throw new SourceError("Bid.Cars displayed vehicle identity mismatch");
  for (const node of $(".copy-vin").toArray())
    if ($(node).text().replace(/\s+/gu, "") !== vin)
      throw new SourceError("Bid.Cars displayed VIN mismatch");
  if (
    archived === "1" &&
    !$("#archieved-message")
      .text()
      .replace(/\s+/gu, " ")
      .trim()
      .startsWith("You are watching archived offer.")
  )
    throw new SourceError("Bid.Cars archive evidence missing");

  const currency =
    identity?.offers && typeof identity.offers === "object" && !Array.isArray(identity.offers)
      ? object(identity.offers).priceCurrency
      : undefined;
  const visiblePrice = $("#bidding-info .lot-price-info .current_bid")
    .text()
    .replace(/\s+/gu, " ")
    .trim();
  const usd = currency === "USD" || (currency === undefined && / USD$/u.test(visiblePrice));
  let partial = false;
  const events: VinArchiveEvent[] = [];
  const related = new Set<string>();
  const history = $(".sales-history-table");
  const headers = history
    .find("thead th")
    .toArray()
    .map((node) => $(node).text().replace(/\s+/gu, " ").trim());
  const historyRows = history.find("tbody tr");
  const badge = $(".link-history:not(.archived-section) span").first().text().trim();
  if (
    history.length !== 1 ||
    headers.slice(0, 6).join("|") !== "Auction|Date|Lot #|Final bid|Odometer|Status"
  ) {
    partial = true;
  } else {
    if (!/^\d+$/u.test(badge) || Number(badge) !== historyRows.length) partial = true;
    if (historyRows.length > MAX_RECORDS) partial = true;
    for (const node of historyRows.toArray().slice(0, MAX_RECORDS)) {
      const cells = $(node).children("th,td");
      const cell = (index: number) => cells.eq(index).text().replace(/\s+/gu, " ").trim();
      const date = calendar(cell(1));
      const link = cells.eq(2).find("a").attr("href");
      const key = cell(2);
      const status = cell(5).toLowerCase();
      if (cells.length !== 7 || !date) {
        partial = true;
        continue;
      }
      if (key !== lot) {
        partial = true;
        const match = /^([01])-([1-9][0-9]{0,11})$/u.exec(key);
        if (
          match?.[2] &&
          cell(0) === (match[1] === "1" ? "Copart" : "IAAI") &&
          cells.eq(2).find("a").length === 1 &&
          typeof link === "string" &&
          (link === `${ORIGIN}/en/lot/${key}` ||
            isVinArchiveLotUrl(
              link,
              "bidcars",
              match[1] === "1" ? "copart" : "iaai",
              match[2],
              vin,
            )) &&
          ["sold", "not sold", "ended", "auction ended"].includes(status) &&
          related.size < MAX_RELATED_LOTS
        )
          related.add(key);
        continue;
      }
      if (cell(0) !== auction || (link !== `${ORIGIN}/en/lot/${lot}` && link !== candidate.url)) {
        partial = true;
        continue;
      }
      if (!["sold", "not sold", "ended", "auction ended"].includes(status)) {
        partial = true;
        continue;
      }
      if (archived === "0") continue;
      events.push({
        status: status === "sold" ? "sold" : "ended",
        auction_at: null,
        auction_date: date,
        final_bid_usd_minor: dollars(cell(3), usd),
      });
    }
  }
  if (archived === "0") return { lot: null, partial, related: [...related] };
  for (const row of candidate.rows) {
    const date = calendar(
      row.prebid_close_time_lang && typeof row.prebid_close_time_lang === "object"
        ? object(row.prebid_close_time_lang).en
        : null,
    );
    if (!date) partial = true;
    const bid = row.need_login === 0 ? dollars(row.final_bid_formatted, usd) : null;
    const existing = events.filter((event) => event.auction_date === date);
    // Native labeled history contains explicit sale status and can expose a bid hidden by search.
    if (
      existing.length &&
      (bid === null || existing.some((event) => event.final_bid_usd_minor === bid))
    )
      continue;
    if (existing.length) partial = true;
    events.push({
      status: "ended",
      auction_at: null,
      auction_date: date,
      final_bid_usd_minor: bid,
    });
  }
  const described = $('meta[name="description"]').attr("content") ?? "";
  const detailDate = calendar(/\bSale date: (\d{4}-\d{2}-\d{2})\b/u.exec(described)?.[1]);
  const finalLabel = $("#bidding-info .lot-price-info .field-name")
    .toArray()
    .some((node) => $(node).text().replace(/\s+/gu, " ").trim().toLowerCase() === "final bid");
  const detailBid = finalLabel ? dollars(visiblePrice, usd) : null;
  if (detailDate) {
    const matching = events.filter((event) => event.auction_date === detailDate);
    if (!matching.length)
      events.push({
        status: "ended",
        auction_at: null,
        auction_date: detailDate,
        final_bid_usd_minor: detailBid,
      });
    else if (matching.every((event) => event.final_bid_usd_minor === null))
      for (const event of matching) event.final_bid_usd_minor = detailBid;
    else if (
      detailBid !== null &&
      !matching.some((event) => event.final_bid_usd_minor === detailBid)
    )
      partial = true;
  }
  if (!events.length) {
    partial = true;
    events.push({
      status: "ended",
      auction_at: null,
      auction_date: null,
      final_bid_usd_minor: detailBid,
    });
  }
  const unique = events.filter(
    (event, index) =>
      events.findIndex(
        (other) =>
          other.auction_date === event.auction_date &&
          other.status === event.status &&
          other.final_bid_usd_minor === event.final_bid_usd_minor,
      ) === index,
  );
  unique.sort((a, b) => (a.auction_date ?? "").localeCompare(b.auction_date ?? ""));
  if (unique.length > MAX_RECORDS) {
    unique.length = MAX_RECORDS;
    partial = true;
  }
  const gallery = $("#productCarousel");
  const slides = gallery.find(".f-carousel__slide[data-fancybox='gallery']");
  const photos = new Set<string>();
  let complete = gallery.length === 1 && slides.length > 0;
  for (const slide of slides.toArray()) {
    const urls = [
      $(slide).attr("data-thumb-src"),
      ...$(slide)
        .find("img")
        .toArray()
        .flatMap((node) => [$(node).attr("src"), $(node).attr("data-lazy-src")]),
    ].filter((value): value is string => value !== undefined);
    let found = false;
    for (const url of urls) {
      if (url === "" || url.startsWith("data:")) continue;
      if (
        isVinArchivePhotoUrl(url, "bidcars", candidate.auction, candidate.id, vin) &&
        new URL(url).href === url
      ) {
        photos.add(url);
        found = true;
      } else complete = false;
    }
    if (!found) complete = false;
  }
  if (photos.size > MAX_IMAGES) complete = false;
  return {
    lot: {
      auction: candidate.auction,
      lot_id: candidate.id,
      source_url: candidate.url,
      events: unique,
      photos: [...photos].slice(0, MAX_IMAGES),
      photos_complete: complete,
    },
    partial,
    related: [...related],
  };
}

export class BidCarsArchive {
  readonly #options: BidCarsArchiveOptions;
  readonly #browser: BrowserClient;
  readonly #abort = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  readonly #metadataQueue = new Set<() => void>();
  readonly #images = pLimit(3);
  #nextRequest = 0;
  #limitedUntil = 0;
  #closing?: Promise<void>;

  constructor(options: BidCarsArchiveOptions) {
    if (
      !Number.isFinite(options.requestDelaySeconds ?? 2) ||
      (options.requestDelaySeconds ?? 2) < 0
    )
      throw new SourceError("Bid.Cars request delay must be non-negative");
    this.#options = options;
    const preferred = options.routes.findIndex(
      (route) => route.tier === "residential" || route.tier === "isp",
    );
    const index = preferred < 0 ? 0 : preferred;
    const route = options.routes[index];
    if (!route) throw new SourceError("Bid.Cars archive proxy route is missing");
    this.#browser =
      options.browserClientFactory?.(route, 1, index) ?? new CloudflareBrowser(route, 1);
  }

  async check(
    value: string,
    signal: AbortSignal,
    budget = AbortSignal.timeout(40_000),
  ): Promise<VinArchiveObservation> {
    const vin = normalizeVin(value);
    if (!vin) throw new RangeError("Invalid VIN");
    const combined = AbortSignal.any([
      signal,
      budget,
      this.#abort.signal,
      ...(this.#options.signal ? [this.#options.signal] : []),
    ]);
    const task = this.#lookup(vin, combined);
    this.#active.add(task);
    try {
      const result = await task;
      signal.throwIfAborted();
      this.#abort.signal.throwIfAborted();
      this.#options.signal?.throwIfAborted();
      return result;
    } finally {
      this.#active.delete(task);
    }
  }

  async getPhoto(
    request: VinArchivePhotoRequest,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<VinArchivePhoto> {
    if (
      request.provider !== "bidcars" ||
      !isVinArchivePhotoUrl(
        request.photo_url,
        "bidcars",
        request.auction,
        request.lot_id,
        request.vin,
      )
    )
      throw new SourceError("Invalid Bid.Cars photo request");
    const combined = AbortSignal.any([
      signal,
      this.#abort.signal,
      ...(this.#options.signal ? [this.#options.signal] : []),
    ]);
    combined.throwIfAborted();
    const task = this.#images(async () => {
      combined.throwIfAborted();
      authorize();
      return readImage(await this.#response(request.photo_url, true, combined, false), combined);
    });
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      () => this.#active.delete(task),
    );
    return abortable(task, combined);
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      while (this.#active.size) await Promise.allSettled(this.#active);
    })();
    return this.#closing;
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

  async #response(url: string, image: boolean, signal: AbortSignal, probe = image) {
    signal.throwIfAborted();
    if (this.#limitedUntil > Date.now())
      throw new SourceError("Bid.Cars is temporarily rate limited");
    const pending = this.#browser.fetch(new URL(url), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        Accept: image ? "image/jpeg" : "application/json,text/html",
        ...(probe ? { Range: "bytes=0-511" } : {}),
      },
    });
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await abortable(pending, signal);
    if (response.status === 429)
      this.#limitedUntil = Math.max(
        this.#limitedUntil,
        Date.now() + retryAfterSeconds(response.headers.get("retry-after")) * 1000,
      );
    if (
      (response.url && response.url !== url) ||
      (response.status !== 200 && !(probe && response.status === 206))
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new SourceError("Bid.Cars archive request failed");
    }
    return response;
  }

  async #text(url: string, signal: AbortSignal): Promise<string> {
    const release = await this.#admit(signal);
    try {
      const wait = this.#nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      this.#nextRequest = Date.now() + (this.#options.requestDelaySeconds ?? 2) * 1000;
      return await abortable(readBody(await this.#response(url, false, signal)), signal);
    } finally {
      release();
    }
  }

  async #image(url: string, signal: AbortSignal): Promise<boolean> {
    try {
      return await readImageProbe(await this.#response(url, true, signal), signal);
    } catch {
      return false;
    }
  }

  async #discover(
    vin: string,
    signal: AbortSignal,
    query = vin,
    archived = true,
  ): Promise<Candidate | undefined> {
    const url = `${ORIGIN}/app/search/en/vin-lot/${query}/${archived}`;
    const body = object(JSON.parse(await this.#text(url, signal)));
    if (
      !Number.isSafeInteger(body.results) ||
      Number(body.results) < 0 ||
      typeof body.url !== "string"
    )
      throw new SourceError("Bid.Cars VIN discovery schema changed");
    const match = /^https:\/\/bid\.cars\/en\/lot\/([01])-([1-9][0-9]{0,11})\//u.exec(body.url);
    if (Number(body.results) > 0 && match) {
      const auction = match[1] === "1" ? "copart" : "iaai";
      if (
        !isVinArchiveLotUrl(body.url, "bidcars", auction, match[2]!, vin) ||
        new URL(body.url).href !== body.url ||
        (query !== vin && query !== `${match[1]}-${match[2]}`)
      )
        throw new SourceError("Bid.Cars VIN discovery identity mismatch");
      return { auction, id: match[2]!, url: body.url, rows: [] };
    }
    if (body.url !== `${ORIGIN}/en/search/archived/results?search-type=typing&query=${query}`)
      throw new SourceError("Bid.Cars VIN discovery URL mismatch");
    return undefined;
  }

  async #lookup(vin: string, signal: AbortSignal): Promise<VinArchiveObservation> {
    const lots: VinArchiveLot[] = [];
    let partial = false;
    const base = `${ORIGIN}/app/search/archived/request?search-type=typing&query=${vin}`;
    const candidates = new Map<string, Candidate>();
    try {
      // Discovery is not archive proof: every candidate still needs a verified detail.
      const candidate = await this.#discover(vin, signal);
      if (candidate)
        candidates.set(`${candidate.auction === "copart" ? "1" : "0"}-${candidate.id}`, candidate);
    } catch {
      partial = true;
    }
    try {
      for (let page = 1, records = 0; page <= MAX_PAGES; page++) {
        const body = object(
          JSON.parse(await this.#text(page === 1 ? base : `${base}&page=${page}`, signal)),
        );
        if (
          body.current_page !== page ||
          !Array.isArray(body.data) ||
          !(body.next_page_url === null || typeof body.next_page_url === "string")
        )
          throw new SourceError("Bid.Cars archive pagination schema changed");
        // Native anonymous fallback is HTTP 200 with per_page:1 and empty data; it is not a proven miss.
        if (body.per_page !== 50) partial = true;
        for (const value of body.data) {
          if (++records > MAX_RECORDS) {
            partial = true;
            break;
          }
          try {
            const row = object(value);
            if (
              row.vin !== vin ||
              row.search_status !== "archived" ||
              typeof row.lot !== "string" ||
              !/^[01]-[1-9][0-9]{0,11}$/u.test(row.lot) ||
              typeof row.tag !== "string"
            )
              throw new SourceError("Bid.Cars archive row identity mismatch");
            const auction = row.lot.startsWith("1-") ? "copart" : "iaai";
            const id = row.lot.slice(2);
            const url = `${ORIGIN}/en/lot/${row.lot}/${row.tag}`;
            if (!isVinArchiveLotUrl(url, "bidcars", auction, id, vin) || new URL(url).href !== url)
              throw new SourceError("Bid.Cars archive lot URL mismatch");
            const existing = candidates.get(row.lot);
            if (existing) {
              if (existing.url !== url)
                throw new SourceError("Conflicting Bid.Cars archive lot URL");
              existing.rows.push(row);
            } else candidates.set(row.lot, { auction, id, url, rows: [row] });
          } catch {
            partial = true;
          }
        }
        if (body.next_page_url === null) break;
        if (
          body.next_page_url !== `${base}&page=${page + 1}` ||
          page === MAX_PAGES ||
          records >= MAX_RECORDS
        ) {
          partial = true;
          break;
        }
      }
    } catch {
      partial = true;
    }
    if (partial && !candidates.size) {
      try {
        // Anonymous archive pagination can be empty while a current VIN page links old lots.
        const current = await this.#discover(vin, signal, vin, false);
        if (current) {
          current.detail = parseDetail(await this.#text(current.url, signal), current, vin);
          candidates.set(`${current.auction === "copart" ? "1" : "0"}-${current.id}`, current);
          for (const key of current.detail.related) {
            try {
              const candidate = await this.#discover(vin, signal, key);
              if (candidate) candidates.set(key, candidate);
            } catch {
              partial = true;
            }
          }
        }
      } catch {
        partial = true;
      }
    }
    for (const candidate of candidates.values()) {
      try {
        const detail =
          candidate.detail ?? parseDetail(await this.#text(candidate.url, signal), candidate, vin);
        if (!detail.lot) continue;
        partial ||= detail.partial;
        const lot = detail.lot;
        // Preserve identity and event evidence even if cancellation or every image fails.
        const retained: VinArchiveLot = { ...lot, photos: [], photos_complete: false };
        lots.push(retained);
        const verified = await Promise.all(
          lot.photos.map(async (url) =>
            (await this.#images(() => this.#image(url, signal))) ? url : null,
          ),
        );
        retained.photos = verified.filter((url): url is string => url !== null);
        retained.photos_complete =
          lot.photos_complete && retained.photos.length === lot.photos.length;
        partial ||= !retained.photos_complete;
      } catch {
        partial = true;
      }
    }
    return {
      provider: "bidcars",
      source_url: VIN_ARCHIVE_SOURCE_URLS.bidcars,
      checked_at: Math.floor(Date.now() / 1000),
      status: lots.some((lot) => lot.photos.length)
        ? "available"
        : lots.length
          ? "no_photos"
          : partial
            ? "unavailable"
            : "not_found",
      partial,
      lots,
    };
  }
}
