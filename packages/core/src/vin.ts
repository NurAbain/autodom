export const VIN_PROVIDERS = [
  "carhistory",
  "car365",
  "encar",
  "nhtsa_vpic",
  "autodev",
  "vagvin_carfax",
] as const;
export type VinProvider = (typeof VIN_PROVIDERS)[number];
export type VinSourceStatus = "available" | "not_found" | "unavailable" | "disabled";

// Fixed provider pages; never response-controlled or payment URLs.
export const VIN_SOURCE_URLS: Readonly<Record<VinProvider, string>> = {
  carhistory: "https://www.carhistory.or.kr/search/carhistory/search.car",
  car365: "https://www.car365.go.kr/ccpt/carlife/scrcar/schdcarXportView.do",
  encar: "https://fem.encar.com/",
  nhtsa_vpic: "https://vpic.nhtsa.dot.gov/api/",
  autodev: "https://docs.auto.dev/v2/products/vin-decode",
  vagvin_carfax: "https://vagvin.ru/home",
};

export interface VinObservation {
  status: VinSourceStatus;
  source_url: string;
  checked_at: number | null;
}

export interface Car365Record {
  vin: string;
  model: string | null;
  last_mileage_km: number | null;
  /** Export-declaration date; not the date of the odometer measurement. */
  export_date: string | null;
  first_registration_date: string | null;
  total_loss: boolean | null;
}

/** Manufacturer decoding for the US market; not vehicle-history evidence. */
export interface NhtsaVpicRecord {
  vin: string;
  make: string | null;
  model: string | null;
  model_year: number | null;
  body_class: string | null;
  fuel_type: string | null;
  plant_country: string | null;
}

/** Global technical decoding; origin and ambiguity are not vehicle-history evidence. */
export interface AutoDevRecord {
  vin: string;
  make: string | null;
  model: string | null;
  model_year: number | null;
  trim: string | null;
  body_class: string | null;
  engine: string | null;
  drive: string | null;
  transmission: string | null;
  origin_country: string | null;
  ambiguous: boolean;
}

/** VAGVIN's CARFAX record-count assertion, not the report or verified accident history. */
export interface VagvinCarfaxRecord {
  vin: string;
  record_count: number;
  vehicle: string | null;
}

export const ENCAR_HISTORY_MAX_LISTINGS = 5;
export const ENCAR_HISTORY_MAX_PHOTOS = 32;
export const ENCAR_DISCOVERY_ORIGIN = "https://carcheck.by";

/** An Encar advertisement confirmed by its full VIN, not a completed transaction. */
export interface EncarListing {
  id: string;
  vin: string;
  source_url: string;
  model: string | null;
  mileage_km: number | null;
  advertisement_status: "ADVERTISE" | "SOLD" | null;
  /** Source-local timestamps without an inferred timezone or sale date. */
  created_at: string | null;
  first_advertised_at: string | null;
  modified_at: string | null;
  re_registered: boolean | null;
  photo_urls: string[];
}

export interface EncarHistory {
  vin: string;
  discovery_url: string;
  listings: EncarListing[];
  /** Some discovered candidates could not be verified, or the lookup limit was reached. */
  partial: boolean;
}

export interface VinCheckResult {
  vin: string;
  checked_at: number;
  carhistory: VinObservation;
  car365: VinObservation & { data: Car365Record | null };
  /** Omitted when not configured or absent in an older API. */
  encar?: (VinObservation & { data: EncarHistory | null }) | undefined;
  /** Omitted when not configured, skipped by Korean-first routing, or absent in an older API. */
  nhtsa_vpic?: (VinObservation & { data: NhtsaVpicRecord | null }) | undefined;
  /** Omitted when not configured, skipped by Korean-first routing, or absent in an older API. */
  autodev?: (VinObservation & { data: AutoDevRecord | null }) | undefined;
  /** Omitted when not configured or skipped by Korean-first routing. */
  vagvin_carfax?: (VinObservation & { data: VagvinCarfaxRecord | null }) | undefined;
}

export type VinLookup = (vin: string, signal?: AbortSignal) => Promise<VinCheckResult>;

export function normalizeVin(value: string): string | null {
  const vin = value.trim();
  return /^[A-HJ-NPR-Za-hj-npr-z0-9]{17}$/u.test(vin) ? vin.toUpperCase() : null;
}

/** User-initiated exact-phrase search, not a vehicle-history provider. */
export function vinGoogleSearchUrl(value: string): string | null {
  const vin = normalizeVin(value);
  return vin ? `https://www.google.com/search?q=%22${vin}%22` : null;
}

export function encarHistoryDiscoveryUrl(value: string): string | null {
  const vin = normalizeVin(value);
  return vin ? `${ENCAR_DISCOVERY_ORIGIN}/auto/${vin}` : null;
}

export function encarListingUrl(id: string): string | null {
  return /^[1-9]\d{0,9}$/u.test(id) ? `https://fem.encar.com/cars/detail/${id}` : null;
}

const ENCAR_PHOTO_URL =
  /^https:\/\/ci\.encar\.com\/carpicture\/carpicture\d{2}\/pic\d{4}\/([1-9]\d{0,9})_\d{3}\.jpg$/u;

/** Only source gallery paths for this confirmed canonical advertisement are publishable. */
export function isEncarPhotoUrl(value: string, id: string): boolean {
  return ENCAR_PHOTO_URL.exec(value)?.[1] === id;
}

// These are on-demand VIN providers, not catalog collectors in APPROVED_SOURCES.
export function configuredVinProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly VinProvider[] {
  const providers = (env.AUTODOM_VIN_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    new Set(providers).size !== providers.length ||
    providers.some((value) => !VIN_PROVIDERS.includes(value as VinProvider))
  ) {
    throw new Error(
      `AUTODOM_VIN_PROVIDERS must contain unique ${VIN_PROVIDERS.join("/")} provider IDs`,
    );
  }
  return providers as VinProvider[];
}
