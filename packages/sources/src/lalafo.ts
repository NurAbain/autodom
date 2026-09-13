import {
  type DocumentTransport,
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { Decimal } from "decimal.js";

export const CATALOG_URL = "https://lalafo.kg/api/search/v3/feed/search";
export const PASSENGER_URL = "https://lalafo.kg/kyrgyzstan/avtomobili-s-probegom";
// The server caps _meta.perPage at 50 even if asked for 200 rows.
export const PAGE_SIZE = 50;
export const PASSENGER_CATEGORY_ID = 1502;
export const SCOPE = "Кыргызстан: объявления о продаже легковых автомобилей";
type ObjectValue = Record<string, unknown>;
export interface PassengerCategory {
  id: number;
  allowedIds: ReadonlySet<number>;
  brands: ReadonlyMap<number, string>;
}
const categoryCache = new WeakMap<DocumentTransport, { expiresAt: number; value: Promise<PassengerCategory> }>();

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Decimal);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveId(value: unknown): number | null {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseJson(document: string): unknown {
  try {
    return JSON.parse(document, (_key: string, value: unknown, context?: { source?: string }): unknown => {
      if (typeof value !== "number" || !context?.source) return value;
      if (/[.eE]/.test(context.source)) return new Decimal(context.source);
      return Number.isSafeInteger(value) ? value : BigInt(context.source);
    });
  } catch (cause) {
    throw new SourceError("Malformed Lalafo response", { cause });
  }
}

function objects(root: unknown): ObjectValue[] {
  const found: ObjectValue[] = [];
  const pending: unknown[] = [root];
  while (pending.length) {
    const node = pending.pop();
    if (isObject(node)) {
      found.push(node);
      pending.push(...Object.values(node));
    } else if (Array.isArray(node)) pending.push(...node);
  }
  return found;
}

// Official passenger bootstrap observed 2026-09-13: root 1502, with brand
// categories in dehydrated queries rather than selectedCategory.children.
export function parsePassengerCategory(document: string): PassengerCategory {
  const scripts = [...document.matchAll(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== 1) throw new SourceError("Lalafo passenger bootstrap missing or ambiguous");
  const nodes = objects(parseJson(scripts[0]![1]!));
  if (!nodes.some((node) => node.id === PASSENGER_CATEGORY_ID && node.url === "/avtomobili-s-probegom" && node.name === "Продажа авто")) {
    throw new SourceError("Lalafo passenger category evidence missing");
  }
  const brands = new Map<number, string>();
  for (const node of nodes) {
    const id = positiveId(node.id);
    if (node.type !== "category" || id === null || id === 1501 || id === 2000 || id === PASSENGER_CATEGORY_ID) continue;
    if (!/^\/(?:kyrgyzstan\/)?avtomobili-s-probegom\/prodazha-avtomobiley\/[^/?#]+\/?$/.test(text(node.url))) continue;
    const name = text(node.name);
    if (name) brands.set(id, name === "Другие автомобили" ? "" : name);
  }
  if (!brands.size) throw new SourceError("Lalafo passenger brand categories missing");
  return { id: PASSENGER_CATEGORY_ID, allowedIds: new Set([PASSENGER_CATEGORY_ID, ...brands.keys()]), brands };
}

function minorUnits(amount: unknown): number | null {
  if (!(amount instanceof Decimal) && typeof amount !== "number" && typeof amount !== "string" && typeof amount !== "bigint") return null;
  const value = String(amount).trim();
  if (!/^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) return null;
  try {
    const decimal = amount instanceof Decimal ? amount : new Decimal(value);
    if (!decimal.isFinite() || decimal.lte(0)) return null;
    const minor = decimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).times(100);
    return minor.gt(0) && minor.lte(Number.MAX_SAFE_INTEGER) ? minor.toNumber() : null;
  } catch {
    return null;
  }
}

function attributeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Decimal && value.isFinite()) return value.toString();
  return "";
}

function photoUrls(images: unknown): string[] {
  const photos: string[] = [];
  if (!Array.isArray(images)) return photos;
  for (const image of images) {
    if (!isObject(image)) continue;
    for (const key of ["original_url", "original_webp_url", "thumbnail_url"]) {
      const value = text(image[key]);
      if (!/^https:\/\/img[0-9]*\.lalafo\.com\/i\/posters\//.test(value) || /[\s\\\p{Cc}]/u.test(value)) continue;
      try {
        const url = new URL(value);
        if (url.username || url.password || url.port) continue;
        const clean = `${url.origin}${url.pathname}`;
        if (!photos.includes(clean)) photos.push(clean);
        break;
      } catch { /* Optional malformed photos stay unknown. */ }
    }
    if (photos.length === 10) break;
  }
  return photos;
}

function listingUrl(value: unknown, id: number): string {
  const raw = text(value);
  if (!raw || /[\s\\\p{Cc}]/u.test(raw)) throw new SourceError("Lalafo advertisement URL missing or invalid");
  let url: URL;
  try { url = new URL(raw, "https://lalafo.kg"); }
  catch (cause) { throw new SourceError("Invalid Lalafo advertisement URL", { cause }); }
  if (
    url.origin !== "https://lalafo.kg" || url.username || url.password ||
    !new RegExp(`^/[a-z0-9-]+/ads/[^/]+-id-${id}$`).test(url.pathname)
  ) throw new SourceError("Lalafo advertisement URL contradicts identity");
  return `${url.origin}${url.pathname}`;
}

function parseListing(item: ObjectValue, id: number, categoryMake: string): Listing {
  const attributes = item.params ?? item.parameters ?? [];
  if (!Array.isArray(attributes) || !attributes.every(isObject)) throw new SourceError("Lalafo vehicle attributes schema changed");
  const attrs = new Map<string, string>();
  for (const attribute of attributes) {
    const name = text(attribute.name).toLowerCase();
    const value = attributeValue(attribute.value);
    if (name && value) attrs.set(name, value);
  }
  const make = attrs.get("марка") ?? categoryMake;
  const rawTitle = text(item.title);
  const titleParts = /^([^:]+):\s*([0-9]{4})\s*г\.(?:,|$)/u.exec(rawTitle);
  const vehicle = titleParts?.[1]?.trim() ?? "";
  const titleModel = make && vehicle.toLowerCase().startsWith(`${make.toLowerCase()} `) ? vehicle.slice(make.length).trim() : "";
  const model = attrs.get("модель") ?? titleModel;
  const yearValue = attrs.get("год выпуска") ?? attrs.get("год") ?? titleParts?.[2] ?? "";
  const year = /^[0-9]{4}$/.test(yearValue) && Number(yearValue) >= 1800 && Number(yearValue) <= 2200 ? Number(yearValue) : null;
  const title = rawTitle || [make, model, year].filter(Boolean).join(" ");
  if (!title) throw new SourceError("Lalafo vehicle title missing");
  const currency = item.currency === "USD" || item.currency === "KGS" ? item.currency : "";
  const amount = currency && item.price_type === 1 ? minorUnits(item.price) : null;
  const photos = photoUrls(item.images);
  const created = item.created_time;
  const publishedAt = typeof created === "number" && Number.isSafeInteger(created) && created > 0 && created <= 8640000000000 ? new Date(created * 1000).toISOString() : "";
  return makeListing({
    id: `lalafo:${id}`,
    source_id: String(id),
    source: "lalafo.kg",
    market: "KG",
    title,
    make: make || null,
    model: model || null,
    url: listingUrl(item.url, id),
    year,
    price_usd_minor: currency === "USD" ? amount : null,
    price_kgs_minor: currency === "KGS" ? amount : null,
    original_currency: currency,
    original_price_minor: amount,
    price_kind: amount === null ? "unknown" : "asking",
    mileage: attrs.get("пробег (км)") ? `${attrs.get("пробег (км)")} km` : (attrs.get("пробег") ?? ""),
    transmission: attrs.get("коробка передач") ?? attrs.get("коробка") ?? "",
    body_type: attrs.get("тип кузова") ?? attrs.get("кузов") ?? "",
    city: text(item.city),
    availability: "Опубликовано",
    published_at: publishedAt,
    photo_url: photos[0] ?? null,
    photo_urls: photos,
  });
}

export function parsePage(document: string, page: number, category: PassengerCategory): SourcePage {
  if (!Number.isSafeInteger(page) || page < 1) throw new SourceError("Catalog page must be a positive integer");
  const data = parseJson(document);
  if (!isObject(data) || !Array.isArray(data.items) || !isObject(data._meta)) throw new SourceError("Lalafo feed schema changed");
  const { totalCount: total, currentPage, perPage: size, pageCount } = data._meta;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > PAGE_SIZE || currentPage !== page || !Number.isSafeInteger(pageCount)) throw new SourceError("Lalafo pagination schema changed");
  const pages = Math.ceil((total as number) / (size as number));
  if (pageCount !== pages && !(total === 0 && pageCount === 1)) throw new SourceError("Lalafo page count contradicts total");
  // Sponsored placements are additional rows: live perPage=3 returned 7.
  if ((data.items.length > 0 && page > pages) || (data.items.length === 0 && page <= pages)) throw new SourceError("Lalafo item count contradicts pagination");
  const listings = new Map<string, Listing>();
  for (const item of data.items) {
    if (!isObject(item)) throw new SourceError("Lalafo listing schema changed");
    if (item.country_id !== 12) throw new SourceError("Lalafo feed contains a non-Kyrgyzstan listing");
    const itemCategory = positiveId(item.category_id);
    if (itemCategory === null) throw new SourceError("Lalafo listing category missing");
    // A changed/ignored API filter must fail the sweep, not silently publish
    // motorcycles/parts or mark previously observed cars as disappeared.
    if (!category.allowedIds.has(itemCategory)) throw new SourceError("Lalafo feed contains a non-passenger category");
    const id = positiveId(item.id);
    if (id === null) throw new SourceError("Lalafo advertisement identity missing");
    const listing = parseListing(item, id, category.brands.get(itemCategory) ?? "");
    listings.set(listing.id, listing);
  }
  return makeSourcePage({ listings: [...listings.values()], page, pages, total: total as number, scope: SCOPE });
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess("lalafo.kg");
  if (!Number.isSafeInteger(page) || page < 1) throw new SourceError("Catalog page must be a positive integer");
  const headers = { Device: "pc", Language: "ru_RU", "Country-Id": "12", Referer: PASSENGER_URL };
  let cached = categoryCache.get(transport);
  if (!cached || (page === 1 && cached.expiresAt <= Date.now())) {
    const value = transport.fetchDocument(PASSENGER_URL, parsePassengerCategory, {
      source: "lalafo.kg", page, headers: { ...headers, Accept: "text/html" },
    });
    cached = { expiresAt: Date.now() + 5 * 60_000, value };
    categoryCache.set(transport, cached);
  }
  let category: PassengerCategory;
  try { category = await cached.value; }
  catch (cause) {
    if (categoryCache.get(transport) === cached) categoryCache.delete(transport);
    throw cause;
  }
  return transport.fetchDocument(CATALOG_URL, (document) => parsePage(document, page, category), {
    source: "lalafo.kg", page,
    params: { expand: "url", page, "per-page": PAGE_SIZE, category_id: category.id },
    headers: { ...headers, Accept: "application/json, text/plain, */*", "x-cache-bypass": "yes" },
  });
}
