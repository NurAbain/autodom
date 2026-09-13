import {
  ENCAR_DISCOVERY_ORIGIN,
  ENCAR_HISTORY_MAX_LISTINGS,
  ENCAR_HISTORY_MAX_PHOTOS,
  type EncarHistory,
  type EncarListing,
  encarHistoryDiscoveryUrl,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  SourceError,
} from "@autodom/core";
import { load } from "cheerio";
import { VinRequestError, type VinSession } from "./vin-session.js";

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function listingId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value);
  return encarListingUrl(id) ? id : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function dateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leapYear ? 29 : (MONTH_DAYS[month - 1] ?? 0);
  if (
    year < 1 ||
    day < 1 ||
    day > days ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    return null;
  return value;
}

function discover(html: string, vin: string): string[] {
  const $ = load(html);
  const title = $("h1.auto-vin-title");
  const identity = title.children("span");
  const primary = title.find("button.auto-save-button");
  if (
    title.length !== 1 ||
    identity.length !== 1 ||
    identity.text().trim() !== vin ||
    primary.length !== 1 ||
    primary.attr("data-save-vin") !== vin ||
    !listingId(primary.attr("data-save-lot")) ||
    !/^[1-9]\d*$/u.test(primary.attr("data-save-auction") ?? "")
  )
    throw new SourceError("Encar discovery identity or structure changed");

  const ids = new Set<string>();
  if (primary.attr("data-save-auction") === "12") {
    ids.add(primary.attr("data-save-lot") as string);
  }
  $("details.vehicle-sales-history table.vehicle-sales-table tbody tr").each((_, row) => {
    const source = $(row).find(".history-auction");
    if (source.length !== 1 || source.text().trim() !== "Encar") return;
    $(row)
      .find("a[href]")
      .each((_, link) => {
        const href = $(link).attr("href") ?? "";
        const path = href.startsWith(`${ENCAR_DISCOVERY_ORIGIN}/`)
          ? href.slice(ENCAR_DISCOVERY_ORIGIN.length)
          : href;
        const prefix = `/auto/${vin}/`;
        if (!path.startsWith(prefix)) return;
        const id = listingId(path.slice(prefix.length));
        if (id) ids.add(id);
      });
  });
  return [...ids];
}

function parseListing(
  html: string,
  requestedId: string,
  vin: string,
): {
  listing: EncarListing;
  alias: string | null;
} {
  const $ = load(html);
  const scripts = $("script")
    .toArray()
    .filter((script) => /^\s*__PRELOADED_STATE__\s*=/u.test($(script).text()));
  const script = scripts[0];
  if (!script || scripts.length !== 1) {
    throw new SourceError("Encar advertisement state missing or ambiguous");
  }
  const json = $(script)
    .text()
    .replace(/^\s*__PRELOADED_STATE__\s*=\s*/u, "")
    .replace(/;?\s*$/u, "");
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    throw new SourceError("Malformed Encar advertisement state");
  }
  const base = record(record(record(state)?.cars)?.base);
  const id = listingId(base?.vehicleId);
  const manage = record(base?.manage);
  const alias = listingId(manage?.dummyVehicleId);
  if (
    !base ||
    !id ||
    base.vin !== vin ||
    (base.queryCarId != null && listingId(base.queryCarId) !== requestedId) ||
    (id !== requestedId && (manage?.dummy !== true || alias !== requestedId)) ||
    (manage?.dummy === true && (id === requestedId || alias !== requestedId))
  )
    throw new SourceError("Encar advertisement VIN or identifier unverified");

  const category = record(base.category);
  const model =
    [
      text(category?.manufacturerEnglishName) ?? text(category?.manufacturerName),
      text(category?.modelGroupEnglishName) ?? text(category?.modelName),
      text(category?.gradeEnglishName) ?? text(category?.gradeName),
      text(category?.gradeDetailEnglishName) ?? text(category?.gradeDetailName),
    ]
      .filter((part) => part !== null)
      .join(" ") || null;
  const mileage = record(base.spec)?.mileage;
  const status = record(base.advertisement)?.status;
  const photos = new Set<string>();
  if (Array.isArray(base.photos)) {
    for (const photo of base.photos) {
      const path = record(photo)?.path;
      if (typeof path !== "string") continue;
      const url = `https://ci.encar.com/carpicture${path}`;
      if (isEncarPhotoUrl(url, id)) photos.add(url);
      if (photos.size === ENCAR_HISTORY_MAX_PHOTOS) break;
    }
  }
  return {
    listing: {
      id,
      vin: base.vin,
      source_url: encarListingUrl(id) as string,
      model: model && model.length <= 512 ? model : null,
      mileage_km:
        typeof mileage === "number" && Number.isSafeInteger(mileage) && mileage >= 0
          ? mileage
          : null,
      advertisement_status: status === "ADVERTISE" || status === "SOLD" ? status : null,
      created_at: dateTime(manage?.registDateTime),
      first_advertised_at: dateTime(manage?.firstAdvertisedDateTime),
      modified_at: dateTime(manage?.modifyDateTime),
      re_registered: typeof manage?.reRegistered === "boolean" ? manage.reRegistered : null,
      photo_urls: [...photos],
    },
    alias: typeof manage?.dummy === "boolean" && alias !== id ? alias : null,
  };
}

/** Public candidates are only hints; all published fields come from VIN-confirmed Encar SSR. */
export async function checkEncarHistory(
  vin: string,
  session: VinSession,
): Promise<EncarHistory | null> {
  const normalizedVin = normalizeVin(vin);
  const discoveryUrl = encarHistoryDiscoveryUrl(vin);
  if (!normalizedVin || !discoveryUrl) throw new SourceError("Encar history requires a valid VIN");
  const discovery = await session.request(discoveryUrl);
  // The transport only surfaces the exact /auto/VIN -> /vin/VIN absence redirect, unfollowed.
  if (discovery.status === 301) return null;
  if (discovery.status !== 200) throw new SourceError("Encar discovery unavailable");
  const candidates = discover(discovery.body, normalizedVin);
  if (candidates.length === 0) return null;

  const listings = new Map<string, EncarListing>();
  const confirmed = new Set<string>();
  let requests = 0;
  let partial = false;
  let retryableFailure: VinRequestError | undefined;
  for (const candidate of candidates) {
    if (confirmed.has(candidate)) continue;
    if (requests === ENCAR_HISTORY_MAX_LISTINGS) {
      partial = true;
      break;
    }
    requests += 1;
    try {
      const response = await session.request(encarListingUrl(candidate) as string);
      if (response.status !== 200) throw new SourceError("Encar advertisement unavailable");
      const { listing, alias } = parseListing(response.body, candidate, normalizedVin);
      if (!listings.has(listing.id)) listings.set(listing.id, listing);
      confirmed.add(listing.id);
      if (alias) confirmed.add(alias);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw error;
      }
      if (error instanceof VinRequestError) retryableFailure = error;
      partial = true;
    }
  }
  if (listings.size === 0)
    throw (
      retryableFailure ?? new SourceError("No discovered Encar advertisement could be verified")
    );
  return {
    vin: normalizedVin,
    discovery_url: discoveryUrl,
    listings: [...listings.values()],
    partial,
  };
}
