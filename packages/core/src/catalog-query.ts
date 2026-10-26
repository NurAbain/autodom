import type { Profile } from "./models.js";

/** Sort options offered by the public catalogue; `new` is the freshness default. */
export const CATALOG_SORTS = ["new", "price_asc", "price_desc", "mileage_asc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** Rows per catalogue page. */
export const CATALOG_PAGE_SIZE = 24;

export interface CatalogQuery {
  /** Free-text request; empty means no text restriction. */
  q: string;
  /** Market filter; the catalogue serves the local market only. */
  market: string;
  currency: "USD" | "KGS";
  /** Budget bounds in minor units of `currency`; null means unbounded. */
  budget_min_minor: number | null;
  budget_max_minor: number | null;
  year_min: number | null;
  year_max: number | null;
  mileage_max_km: number | null;
  body_type: string;
  transmission: string;
  city: string;
  make: string;
  model: string;
  sort: CatalogSort;
  page: number;
}

const MAX_TEXT = 120;
const MAX_PAGE = 500;
const MAX_MONEY = 1_000_000_000_00;

function text(value: string | null): string {
  if (value === null) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\p{Cc}]/u.test(trimmed)) return "";
  return trimmed.slice(0, MAX_TEXT);
}

function wholeNumber(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,12}$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Money is entered in whole units and kept in minor units; sub-unit precision is lost. */
function money(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,12}(?:\.\d{1,2})?$/u.test(trimmed)) return null;
  const parsed = Math.round(Number(trimmed) * 100);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MONEY) return null;
  return parsed;
}

/**
 * Reads the public catalogue query from a URL. Unknown parameters are ignored so that
 * campaign links keep working, but every recognised parameter is validated strictly:
 * an unusable value falls back to the default instead of widening the result set.
 */
export function parseCatalogQuery(input: string | URLSearchParams): CatalogQuery {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const currency = params.get("currency")?.trim().toUpperCase() === "USD" ? "USD" : "KGS";
  const sortValue = params.get("sort")?.trim();
  const sort = (CATALOG_SORTS as readonly string[]).includes(sortValue ?? "")
    ? (sortValue as CatalogSort)
    : "new";
  const pageValue = wholeNumber(params.get("page"));
  const yearMin = wholeNumber(params.get("year_min"));
  const yearMax = wholeNumber(params.get("year_max"));
  const mileage = wholeNumber(params.get("mileage_max_km"));
  const budgetMin = money(params.get("budget_min"));
  const budgetMax = money(params.get("budget_max"));
  return {
    q: text(params.get("q")),
    market: "KG",
    currency,
    budget_min_minor: budgetMin,
    budget_max_minor: budgetMax,
    year_min: yearMin !== null && yearMin >= 1800 && yearMin <= 2200 ? yearMin : null,
    year_max:
      yearMax !== null &&
      yearMax >= 1800 &&
      yearMax <= 2200 &&
      (yearMin === null || yearMax >= yearMin)
        ? yearMax
        : null,
    mileage_max_km: mileage !== null && mileage <= 100_000_000 ? mileage : null,
    body_type: text(params.get("body_type")),
    transmission: text(params.get("transmission")),
    city: text(params.get("city")),
    make: text(params.get("make")),
    model: text(params.get("model")),
    sort,
    page: pageValue !== null && pageValue >= 1 ? Math.min(pageValue, MAX_PAGE) : 1,
  };
}

/** Rebuilds the query parameters for canonical links; defaults stay out of the URL. */
export function catalogQueryParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.currency !== "KGS") params.set("currency", query.currency);
  if (query.budget_min_minor !== null)
    params.set("budget_min", String(query.budget_min_minor / 100));
  if (query.budget_max_minor !== null)
    params.set("budget_max", String(query.budget_max_minor / 100));
  if (query.year_min !== null) params.set("year_min", String(query.year_min));
  if (query.year_max !== null) params.set("year_max", String(query.year_max));
  if (query.mileage_max_km !== null) params.set("mileage_max_km", String(query.mileage_max_km));
  if (query.body_type) params.set("body_type", query.body_type);
  if (query.transmission) params.set("transmission", query.transmission);
  if (query.city) params.set("city", query.city);
  if (query.make) params.set("make", query.make);
  if (query.model) params.set("model", query.model);
  if (query.sort !== "new") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

/** True when no parameter narrows the catalogue, so the plain URL already is the state. */
export function catalogQueryIsPlain(query: CatalogQuery): boolean {
  return catalogQueryParams(query).toString() === "";
}

/**
 * Make, model and free text describe one car, so they narrow each other: every word
 * has to be present. The catalogue cannot use source attributes, because only one
 * marketplace fills them in.
 */
export function catalogQueryText(query: CatalogQuery): string {
  const words = [query.make, query.model, query.q]
    .flatMap((part) => part.split(/[,;]/u))
    .flatMap((part) => part.split(/\s+/u))
    .filter(Boolean);
  return words.join(" ");
}

/**
 * Builds the profile the shared catalogue query runs on. The public site has no user,
 * so the identity fields are neutral; only the search conditions matter downstream.
 */
export function catalogQueryToProfile(query: CatalogQuery): Profile {
  return {
    user_id: 0,
    chat_id: 0,
    currency: query.currency,
    budget_min_minor: query.budget_min_minor ?? 0,
    budget_max_minor: query.budget_max_minor ?? Number.MAX_SAFE_INTEGER,
    query: catalogQueryText(query),
    monitoring: false,
    revision: "0",
    cursor: 0,
    quiet_start_minute: null,
    quiet_end_minute: null,
    market: query.market,
    city: query.city,
    budget_scope: "car",
    body_type: query.body_type,
    year_min: query.year_min,
    year_max: query.year_max,
    mileage_max_km: query.mileage_max_km,
    transmission: query.transmission,
    use_case: "",
    allow_import: true,
    purchase_by: "",
  };
}
