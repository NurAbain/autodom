import { normalizeVin } from "./vin.js";

export const VIN_ARCHIVE_PROVIDERS = ["copart", "bidcars", "carway"] as const;
export type VinArchiveProvider = (typeof VIN_ARCHIVE_PROVIDERS)[number];
export type VinArchiveStatus = "available" | "no_photos" | "not_found" | "unavailable" | "disabled";
export type VinArchiveAuction = "copart" | "iaai" | "emiratesauction" | "copart_uae";

export const VIN_ARCHIVE_PROVIDER_NAMES: Readonly<Record<VinArchiveProvider, string>> = {
  copart: "Copart",
  bidcars: "Bid.Cars",
  carway: "Carway",
};

export const VIN_ARCHIVE_AUCTION_NAMES: Readonly<Record<VinArchiveAuction, string>> = {
  copart: "Copart",
  iaai: "IAAI",
  emiratesauction: "Emirates Auction (ОАЭ)",
  copart_uae: "Copart UAE",
};

export const VIN_ARCHIVE_SOURCE_URLS: Readonly<Record<VinArchiveProvider, string>> = {
  copart: "https://www.copart.com/",
  bidcars: "https://bid.cars/",
  carway: "https://carway.pro/",
};

export const VIN_ARCHIVE_COVERAGE_NOTICE =
  "Поиск охватывает только лоты, которые источник ещё находит по VIN. Старые фотографии могут сохраняться вне этого поиска. Пустой результат не означает отсутствия аукционов, ДТП или повреждений.";

export const CARWAY_ARCHIVE_MAX_PHOTOS = 64;

export function carwayArchiveSearchUrl(value: string): string | null {
  const vin = normalizeVin(value);
  return vin ? `https://carway.pro/search-vin?vin_number=${vin}` : null;
}

export interface VinArchiveEvent {
  /** Ended auctions are not automatically sold vehicles or completed transactions. */
  status: "sold" | "ended";
  /** Source auction timestamp in seconds; never an update or inferred sale date. */
  auction_at: number | null;
  /** Source calendar date when no precise timestamp is available. No inferred timezone. */
  auction_date: string | null;
  /** Source-labelled final bid in US cents, not a transaction price. Hidden bids remain null. */
  final_bid_usd_minor: number | null;
}

export interface VinArchiveLot {
  auction: VinArchiveAuction;
  /** Original auction lot/stock ID, without the intermediary's auction prefix. */
  lot_id: string;
  source_url: string;
  /** Different auctions remain distinct; Carway's unverified outcome/dates have no events. */
  events: readonly VinArchiveEvent[];
  photos: readonly string[];
  /** False when the manifest or any of its photographs could not be verified. */
  photos_complete: boolean;
}

export interface VinArchiveObservation {
  provider: VinArchiveProvider;
  status: VinArchiveStatus;
  source_url: string;
  checked_at: number | null;
  /** An incomplete lookup, distinct from the permanently limited index coverage. */
  partial: boolean;
  lots: readonly VinArchiveLot[];
}

export interface VinArchiveResult {
  vin: string;
  checked_at: number;
  coverage: "indexed_lots_only";
  sources: readonly VinArchiveObservation[];
}

/** Separate, explicitly requested action; never part of the decoding workflow. */
export type VinArchiveLookup = (vin: string, signal?: AbortSignal) => Promise<VinArchiveResult>;

export const VIN_ARCHIVE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export interface VinArchivePhotoRequest {
  vin: string;
  provider: VinArchiveProvider;
  auction: VinArchiveAuction;
  lot_id: string;
  photo_url: string;
}

export interface VinArchivePhoto {
  bytes: Uint8Array;
  content_type: "image/jpeg" | "image/png" | "image/webp";
}

export type VinArchivePhotoLookup = (
  request: VinArchivePhotoRequest,
  signal?: AbortSignal,
) => Promise<VinArchivePhoto>;

export function parseVinArchivePhotoRequest(value: unknown): VinArchivePhotoRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError("Invalid archive photo request");
  const fields = value as Record<string, unknown>;
  const vin = typeof fields.vin === "string" ? normalizeVin(fields.vin) : null;
  const { provider, auction, lot_id, photo_url } = fields;
  if (
    Object.keys(fields).length !== 5 ||
    !vin ||
    !VIN_ARCHIVE_PROVIDERS.includes(provider as VinArchiveProvider) ||
    (auction !== "copart" &&
      auction !== "iaai" &&
      auction !== "emiratesauction" &&
      auction !== "copart_uae") ||
    typeof lot_id !== "string" ||
    typeof photo_url !== "string" ||
    photo_url.length > 768 ||
    !isVinArchivePhotoUrl(photo_url, provider as VinArchiveProvider, auction, lot_id, vin)
  )
    throw new RangeError("Invalid archive photo request");
  return { vin, provider: provider as VinArchiveProvider, auction, lot_id, photo_url };
}

export function configuredVinArchiveProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly VinArchiveProvider[] {
  const providers = (env.AUTODOM_VIN_ARCHIVE_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    new Set(providers).size !== providers.length ||
    providers.some((value) => !VIN_ARCHIVE_PROVIDERS.includes(value as VinArchiveProvider))
  )
    throw new Error(
      `AUTODOM_VIN_ARCHIVE_PROVIDERS must contain unique ${VIN_ARCHIVE_PROVIDERS.join(",")} provider IDs`,
    );
  return providers as VinArchiveProvider[];
}

export function disabledVinArchiveResult(value: string): VinArchiveResult {
  const vin = normalizeVin(value);
  if (!vin) throw new RangeError("Invalid VIN");
  return {
    vin,
    checked_at: Math.floor(Date.now() / 1000),
    coverage: "indexed_lots_only",
    sources: VIN_ARCHIVE_PROVIDERS.map((provider) => ({
      provider,
      status: "disabled",
      source_url: VIN_ARCHIVE_SOURCE_URLS[provider],
      checked_at: null,
      partial: false,
      lots: [],
    })),
  };
}

export function isCopartPhotoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://cs.copart.com" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.pathname.startsWith("/v1/AUTH_svc.pdoc00001/")
    );
  } catch {
    return false;
  }
}

export function isVinArchiveLotUrl(
  value: string,
  provider: VinArchiveProvider,
  auction: VinArchiveAuction,
  lotId: string,
  vin: string,
): boolean {
  if (!/^[1-9]\d{0,11}$/u.test(lotId) || normalizeVin(vin) !== vin) return false;
  if (provider === "copart")
    return auction === "copart" && value === `https://www.copart.com/lot/${lotId}`;
  if (provider === "carway")
    return (
      (auction === "emiratesauction" || auction === "copart_uae") &&
      value === carwayArchiveSearchUrl(vin)
    );
  if (provider !== "bidcars" || (auction !== "copart" && auction !== "iaai")) return false;
  try {
    const url = new URL(value);
    const prefix = auction === "copart" ? "1" : "0";
    return (
      url.origin === "https://bid.cars" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(`/en/lot/${prefix}-${lotId}/`) &&
      /^\/en\/lot\/[01]-[1-9]\d{0,11}\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(url.pathname) &&
      url.pathname.endsWith(`-${vin}`)
    );
  } catch {
    return false;
  }
}

const CARWAY_PHOTO_URL =
  /^https:\/\/(?:www\.)?carway\.pro\/car_image\/([1-9]\d{0,11})_Image_[1-9]\d{0,2}\.jpg$/u;
const EMIRATES_ARCHIVE_PHOTO_URL =
  /^https:\/\/cdn\.emiratesauction\.com\/media\/[a-z0-9]{16,64}\/t_,w_800,h_600\/images[1-9]\d{0,2}\.jpg\?v=2$/u;

export function isVinArchivePhotoUrl(
  value: string,
  provider: VinArchiveProvider,
  auction: VinArchiveAuction,
  lotId: string,
  vin: string,
): boolean {
  if (provider === "copart") return auction === "copart" && isCopartPhotoUrl(value);
  if (!/^[1-9]\d{0,11}$/u.test(lotId) || normalizeVin(vin) !== vin) return false;
  if (provider === "carway") {
    if (auction !== "emiratesauction" && auction !== "copart_uae") return false;
    return (
      CARWAY_PHOTO_URL.exec(value)?.[1] === lotId ||
      (auction === "emiratesauction" && EMIRATES_ARCHIVE_PHOTO_URL.test(value))
    );
  }
  if (provider !== "bidcars" || (auction !== "copart" && auction !== "iaai")) return false;
  try {
    const url = new URL(value);
    const prefix = auction === "copart" ? "1" : "0";
    return (
      url.origin === "https://mercury.bid.cars" &&
      !url.username &&
      !url.password &&
      (!url.search || /^\?ver=[0-9]{1,16}$/u.test(url.search)) &&
      !url.hash &&
      url.pathname.startsWith(`/${prefix}-${lotId}/`) &&
      /^\/[01]-[1-9]\d{0,11}\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.jpg$/u.test(url.pathname) &&
      new RegExp(`-${vin}-[1-9]\\d{0,2}\\.jpg$`, "u").test(url.pathname)
    );
  } catch {
    return false;
  }
}

export interface VinArchiveLotSource {
  provider: VinArchiveProvider;
  lot: VinArchiveLot;
}

export interface VinArchiveLotGroup {
  auction: VinArchiveAuction;
  lot_id: string;
  sources: VinArchiveLotSource[];
  photo_source: VinArchiveLotSource;
}

/** One vehicle-lot card, all source evidence, and one primary gallery rather than duplicate albums. */
export function groupVinArchiveLots(result: VinArchiveResult): readonly VinArchiveLotGroup[] {
  const groups = new Map<string, VinArchiveLotGroup>();
  for (const source of result.sources) {
    for (const lot of source.lots) {
      const key = `${lot.auction}:${lot.lot_id}`;
      const candidate = { provider: source.provider, lot };
      const group = groups.get(key);
      if (!group) {
        groups.set(key, {
          auction: lot.auction,
          lot_id: lot.lot_id,
          sources: [candidate],
          photo_source: candidate,
        });
        continue;
      }
      group.sources.push(candidate);
      const selected = group.photo_source.lot;
      if (
        lot.photos.length &&
        (!selected.photos.length ||
          (lot.photos_complete && !selected.photos_complete) ||
          (lot.photos_complete === selected.photos_complete &&
            (lot.photos.length > selected.photos.length ||
              (lot.photos.length === selected.photos.length && source.provider === "copart"))))
      )
        group.photo_source = candidate;
    }
  }
  return [...groups.values()];
}
