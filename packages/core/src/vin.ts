export const VIN_PROVIDERS = ["carhistory", "car365", "nhtsa_vpic"] as const;
export type VinProvider = (typeof VIN_PROVIDERS)[number];
export type VinSourceStatus = "available" | "not_found" | "unavailable" | "disabled";

// Fixed provider pages; never response-controlled or payment URLs.
export const VIN_SOURCE_URLS: Readonly<Record<VinProvider, string>> = {
  carhistory: "https://www.carhistory.or.kr/search/carhistory/search.car",
  car365: "https://www.car365.go.kr/ccpt/carlife/scrcar/schdcarXportView.do",
  nhtsa_vpic: "https://vpic.nhtsa.dot.gov/api/",
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

export interface VinCheckResult {
  vin: string;
  checked_at: number;
  carhistory: VinObservation;
  car365: VinObservation & { data: Car365Record | null };
  /** Omitted when not configured, including responses from an older API release. */
  nhtsa_vpic?: (VinObservation & { data: NhtsaVpicRecord | null }) | undefined;
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
