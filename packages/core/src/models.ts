import { z } from "zod";

export const MARKETS = { KG: "Кыргызстан", KR: "Корея", US: "США", ALL: "Все рынки" } as const;
export const BUDGET_SCOPES = {
  car: "Только автомобиль",
  total: "Весь бюджет, включая доставку и оформление",
} as const;
export const BODY_TYPES = {
  sedan: "Седан",
  suv: "Внедорожник / кроссовер",
  hatchback: "Хэтчбек",
  wagon: "Универсал",
  minivan: "Минивэн",
  pickup: "Пикап",
  coupe: "Купе",
  convertible: "Кабриолет",
  van: "Фургон",
} as const;
export const TRANSMISSIONS = {
  manual: "Механика",
  automatic: "Автомат",
  cvt: "Вариатор",
  robot: "Робот",
} as const;
export const USE_CASES = {
  city: "Город",
  family: "Семья",
  work: "Работа",
  travel: "Поездки",
} as const;

const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const optionalInteger = integer.nullable().default(null);
const timestamp = z.number().finite().nullable().default(null);
const text = z.string().default("");

export const listingSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    price_usd_minor: optionalInteger,
    price_kgs_minor: optionalInteger,
    year: optionalInteger,
    mileage: text,
    transmission: text,
    body_type: text,
    city: text,
    availability: text,
    published_at: text,
    photo_url: z.string().nullable().default(null),
    photo_urls: z.array(z.string()).default([]),
    source: z.string().default("mashina.kg"),
    observed_at: timestamp,
    market: z.string().default("KG"),
    original_currency: text,
    original_price_minor: optionalInteger,
    trim: text,
    condition: text,
    search_aliases: text,
    registration_month: text,
    price_kind: z.string().default("asking"),
    fx_date: text,
    fx_expires_at: timestamp,
    vin: text,
    auction_house: text,
    auction_lot: text,
    auction_status: text,
    auction_at: timestamp,
    current_bid_minor: optionalInteger,
    buy_now_minor: optionalInteger,
    final_bid_minor: optionalInteger,
    estimated_min_minor: optionalInteger,
    estimated_max_minor: optionalInteger,
    sale_document: text,
    primary_damage: text,
    secondary_damage: text,
    start_code: text,
  })
  .passthrough();

export const profileSchema = z
  .object({
    user_id: integer,
    chat_id: integer,
    currency: z.string(),
    budget_min_minor: integer,
    budget_max_minor: integer,
    query: text,
    monitoring: z.boolean().default(false),
    revision: z.string().regex(/^\d+$/u).default("0"),
    cursor: integer.default(0),
    quiet_start_minute: optionalInteger,
    quiet_end_minute: optionalInteger,
    market: z.string().default("KG"),
    city: text,
    budget_scope: z.string().default("car"),
    body_type: text,
    year_min: optionalInteger,
    mileage_max_km: optionalInteger,
    transmission: text,
    use_case: text,
    allow_import: z.boolean().nullable().default(null),
    purchase_by: text,
  })
  .strip();

export const sourcePageSchema = z
  .object({
    listings: z.array(listingSchema).default([]),
    page: integer.default(1),
    total: optionalInteger,
    pages: integer.default(1),
    scope: text,
  })
  .passthrough();

export type Listing = z.output<typeof listingSchema>;
export type Profile = z.output<typeof profileSchema>;
export type SourcePage = z.output<typeof sourcePageSchema>;
export interface ListingEvent {
  id: number;
  listing: Listing;
  kind: string;
  previous_usd_minor: number | null;
  previous_kgs_minor: number | null;
  previous_original_price_minor: number | null;
  previous_original_currency: string;
}

export function makeListing(input: z.input<typeof listingSchema>): Listing {
  return listingSchema.parse(input);
}
export function makeProfile(input: z.input<typeof profileSchema>): Profile {
  return profileSchema.parse(input);
}
export function makeSourcePage(input: z.input<typeof sourcePageSchema>): SourcePage {
  return sourcePageSchema.parse(input);
}

export function listingIsAuction(listing: Listing): boolean {
  return Boolean(
    listing.auction_status ||
      listing.auction_house ||
      listing.auction_lot ||
      listing.auction_at !== null ||
      listing.price_kind === "auction" ||
      listing.current_bid_minor !== null ||
      listing.buy_now_minor !== null ||
      listing.final_bid_minor !== null ||
      listing.estimated_min_minor !== null ||
      listing.estimated_max_minor !== null,
  );
}

export function purchaseEligible(listing: Listing, now = Date.now() / 1000): boolean {
  return (
    (listing.price_kind === "asking" || listing.price_kind === "buy_now") &&
    (!listingIsAuction(listing) ||
      (listing.price_kind === "buy_now" &&
        listing.auction_status === "active" &&
        listing.auction_at !== null &&
        listing.auction_at > now))
  );
}

export function listingPrice(
  listing: Listing,
  currency: string,
  now = Date.now() / 1000,
): number | null {
  if (currency !== "USD" && currency !== "KGS") throw new Error("Unsupported currency");
  if (!purchaseEligible(listing, now)) return null;
  if (
    listing.market !== "KG" &&
    currency !== listing.original_currency &&
    (listing.fx_expires_at === null || listing.fx_expires_at <= now)
  )
    return null;
  return currency === "USD" ? listing.price_usd_minor : listing.price_kgs_minor;
}

export function isPriceDrop(
  event: ListingEvent,
  currency: string,
  now = Date.now() / 1000,
): boolean {
  const listing = event.listing;
  if (!purchaseEligible(listing, now)) return false;
  // Native-price comparisons must survive an expired conversion until FX refresh.
  if (listing.original_currency) {
    return (
      event.previous_original_currency === listing.original_currency &&
      event.previous_original_price_minor !== null &&
      listing.original_price_minor !== null &&
      listing.original_price_minor < event.previous_original_price_minor
    );
  }
  const current = listingPrice(listing, currency, now);
  const previous = currency === "USD" ? event.previous_usd_minor : event.previous_kgs_minor;
  return previous !== null && current !== null && current < previous;
}
