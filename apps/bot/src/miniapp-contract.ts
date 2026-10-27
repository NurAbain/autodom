import type { PaymentOrder, VinReportKind } from "@autodom/core/payments";
import type { VinCheckResult } from "@autodom/core/vin";

export type MiniAppVinResult = VinCheckResult & {
  reportSalesEnabled: boolean;
  reportPrice: Pick<PaymentOrder, "amount" | "currency"> | null;
  reportKind: VinReportKind | null;
  photoAccess: {
    available: boolean;
    granted: boolean;
    salesEnabled: boolean;
    price: { amount: number; currency: "KGS" };
  };
};

export interface MiniAppFinikMethods {
  banks: { name: string; url: string; logoUrl: string | null }[];
}

export interface MiniAppCar {
  id: string;
  title: string;
  url: string | null;
  photoUrls: string[];
  price: string;
  year: number | null;
  mileage: string;
  transmission: string;
  bodyType: string;
  city: string;
  market: string;
  source: string;
  observedAt: number | null;
  availability: string;
  detailsHtml: string;
  vin: string | null;
}

/** Saved buyer conditions; the same set works for every marketplace. */
export interface MiniAppFilterProfile {
  currency: "USD" | "KGS";
  budget_min_minor: number;
  budget_max_minor: number;
  query: string;
  cities: string[];
  body_type: string;
  transmission: string;
  year_min: number | null;
  year_max: number | null;
  mileage_max_km: number | null;
  monitoring: boolean;
  revision: string;
}

/** The editor state the Mini App loads before the first save. */
export interface MiniAppFilterState {
  privacy: string;
  profile: MiniAppFilterProfile | null;
  bodyTypes: { value: string; label: string }[];
  transmissions: { value: string; label: string }[];
}

/** Conditions the user is editing; nothing is stored until the save request. */
export interface MiniAppFilterDraft {
  currency: "USD" | "KGS";
  budget_min_minor: number;
  budget_max_minor: number;
  query: string;
  city: string;
  body_type: string;
  transmission: string;
  year_min: number | null;
  year_max: number | null;
  mileage_max_km: number | null;
  monitoring: boolean;
}

export interface MiniAppFilterSaved {
  revision: string;
  monitoring: boolean;
  matches: number;
}

/** A city of the market with the number of ads behind it. */
export interface MiniAppCityChoice {
  /** The city as the marketplace writes it. */
  value: string;
  matches: number;
}

/** A make or a model of the catalogue with the number of ads behind it. */
export interface MiniAppChoice {
  id: string;
  value: string;
  label: string;
  matches: number;
}

export interface MiniAppSuggestions {
  state: "ready";
  items: { id: string; value: string; label: string }[];
}
