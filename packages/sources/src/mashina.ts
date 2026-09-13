import {
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import {
  CATALOG_OPTION_LABELS,
  CATALOG_RANGE_LABELS,
  CATALOG_VEHICLE_LABELS,
} from "@autodom/core/catalog-filter";
import { Decimal } from "decimal.js";

export const CATALOG_URL = "https://mashina.kg/catalog/passenger";
const CATALOG_KEYS = ["items", "total", "page", "size", "pages"] as const;
const ATTRIBUTE_SLUGS = {
  ...CATALOG_VEHICLE_LABELS,
  ...CATALOG_OPTION_LABELS,
  ...CATALOG_RANGE_LABELS,
};
type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Decimal)
  );
}

function listingShape(
  item: unknown,
): item is ObjectValue & { id: number | bigint; slug: string; title: string; status: string } {
  return (
    isObject(item) &&
    ((typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0) ||
      (typeof item.id === "bigint" && item.id > 0n)) &&
    ["slug", "title", "status"].every(
      (key) => typeof item[key] === "string" && item[key].trim().length > 0,
    )
  );
}

function catalogs(text: string): ObjectValue[] {
  // The legacy feed decoder accepts non-finite JSON constants. Preserve their
  // numeric type so a bad optional price is unknown but bad metadata still fails.
  let marker = "_autodom_nonfinite_";
  while (text.includes(marker)) marker += "_";
  text = text.replace(/"(?:\\[\s\S]|[^"\\])*"|-Infinity\b|\b(?:NaN|Infinity)\b/g, (token) =>
    token.startsWith('"') ? token : JSON.stringify(marker + token),
  );
  const found: ObjectValue[] = [];
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf("{", position);
    if (start < 0) break;
    let end = start;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        end++;
        break;
      }
    }
    let root: unknown;
    try {
      root = JSON.parse(
        text.slice(start, end),
        (_key: string, value: unknown, context?: { source?: string }): unknown => {
          if (
            typeof value === "string" &&
            value.startsWith(marker) &&
            context?.source === JSON.stringify(value)
          ) {
            return new Decimal(value.slice(marker.length));
          }
          if (typeof value !== "number" || !context?.source) return value;
          // Node 24 exposes the original token, before IEEE-754 conversion.
          if (/[.eE]/.test(context.source)) return new Decimal(context.source);
          return Number.isSafeInteger(value) ? value : BigInt(context.source);
        },
      );
    } catch {
      position = start + 1;
      continue;
    }
    position = end;
    const pending: unknown[] = [root];
    while (pending.length) {
      const node = pending.pop();
      if (isObject(node)) {
        if (
          CATALOG_KEYS.every((key) => Object.hasOwn(node, key)) &&
          Array.isArray(node.items) &&
          node.items.every(listingShape)
        )
          found.push(node);
        else pending.push(...Object.values(node));
      } else if (Array.isArray(node)) pending.push(...node);
    }
  }
  return found;
}

function decimal(value: unknown): Decimal | null {
  if (value instanceof Decimal) return value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
    return null;
  const text = String(value).trim().replaceAll("_", "");
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return null;
  try {
    return new Decimal(text);
  } catch {
    return null;
  }
}

function minorUnits(amount: unknown): number | null {
  const value = decimal(amount);
  if (!value?.isFinite() || !value.isPositive() || value.isZero()) return null;
  // Round before scaling: multiplying first can discard significant fractional
  // digits under Decimal's precision and turn a below-half amount into a tie.
  const minor = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).times(100);
  if (minor.lte(0) || minor.gt(Number.MAX_SAFE_INTEGER)) return null;
  return minor.toNumber();
}

function attributeText(attribute: ObjectValue): string {
  if (typeof attribute.value_text === "string" && attribute.value_text.trim())
    return attribute.value_text.trim();
  const value = attribute.value_json;
  if (isObject(value)) {
    if (typeof value.name === "string") return value.name.trim();
    if (
      (typeof value.value === "string" ||
        typeof value.value === "number" ||
        typeof value.value === "bigint" ||
        value.value instanceof Decimal) &&
      typeof value.suffix === "string"
    ) {
      return `${String(value.value)} ${value.suffix}`.trim();
    }
  } else if (typeof value === "string") return value.trim();
  return "";
}

function photoUrls(images: unknown): string[] {
  const photos: string[] = [];
  if (!Array.isArray(images)) return photos;
  for (const image of images) {
    if (!isObject(image)) continue;
    for (const key of ["medium", "thumb"]) {
      const value = image[key];
      if (
        typeof value !== "string" ||
        /[\s\\\p{Cc}]/u.test(value) ||
        !/^https:\/\/(?:im|pictures|storage|s3)\.mashina\.kg\//.test(value)
      )
        continue;
      try {
        const url = new URL(value);
        if (url.username || url.password || url.port || url.hash) continue;
        if (!photos.includes(url.href)) photos.push(url.href);
        break;
      } catch {
        /* Invalid optional photo URLs do not invalidate the listing. */
      }
    }
    if (photos.length === 10) break;
  }
  return photos;
}

function parseListing(
  item: ObjectValue & { id: number | bigint; slug: string; title: string; status: string },
): Listing {
  const prices = item.prices ?? [];
  const attributes = item.attributes ?? [];
  if (!Array.isArray(prices) || !prices.every(isObject))
    throw new SourceError("Mashina catalog price schema changed");
  if (!Array.isArray(attributes) || !attributes.every(isObject))
    throw new SourceError("Mashina catalog attribute schema changed");
  const amounts: Record<string, number | null> = { USD: null, KGS: null };
  let original: ObjectValue | undefined;
  let originalCount = 0;
  for (const price of prices) {
    if (typeof price.currency === "string" && Object.hasOwn(amounts, price.currency))
      amounts[price.currency] = minorUnits(price.amount);
    if (price.is_original === true) {
      original = price;
      originalCount += 1;
    }
  }
  // The live catalog identifies the entered price explicitly; array order is not provenance.
  const originalCurrency =
    originalCount === 1 &&
    typeof original?.currency === "string" &&
    Object.hasOwn(amounts, original.currency) &&
    amounts[original.currency] !== null &&
    prices.every(
      (price) =>
        (price === original || price.currency !== original.currency) &&
        (price.is_original == null || typeof price.is_original === "boolean"),
    )
      ? original.currency
      : "";
  const attrs = new Map<string, ObjectValue>();
  for (const attr of attributes) {
    if (typeof attr.slug === "string" && Object.hasOwn(ATTRIBUTE_SLUGS, attr.slug))
      attrs.set(attr.slug, attr);
  }
  const yearAttr = attrs.get("year") ?? {};
  const numericYear = decimal(yearAttr.value_number ?? attributeText(yearAttr));
  const year =
    numericYear?.isFinite() &&
    numericYear.isInteger() &&
    numericYear.gte(1800) &&
    numericYear.lte(2200)
      ? numericYear.toNumber()
      : null;
  const catalog_attributes: Record<string, string> = { publication_status: item.status };
  const catalog_numbers: Record<string, number | null> = {};
  for (const key of [
    ...Object.keys(CATALOG_VEHICLE_LABELS),
    ...Object.keys(CATALOG_OPTION_LABELS),
  ]) {
    const value = attributeText(attrs.get(key) ?? {});
    if (value) catalog_attributes[key] = value;
  }
  for (const key of Object.keys(CATALOG_RANGE_LABELS)) {
    const attribute = attrs.get(key) ?? {};
    const json = isObject(attribute.value_json) ? attribute.value_json : {};
    const text = attributeText(attribute);
    const numericText =
      key === "mileage"
        ? text.match(
            /^([0-9]+(?:\.[0-9]+)?)\s*(?:km|км|kilometers?|kilometres?|mi|miles?|миль|мили|миля)$/iu,
          )?.[1]
        : text;
    const value = decimal(attribute.value_number ?? json.value ?? numericText);
    if (!value?.isFinite() || value.isNegative() || value.gt(Number.MAX_SAFE_INTEGER)) continue;
    if (key === "mileage") {
      const suffix =
        typeof json.suffix === "string"
          ? json.suffix.trim().toLowerCase()
          : text
              .match(/(km|км|kilometers?|kilometres?|mi|miles?|миль|мили|миля)$/iu)?.[0]
              ?.toLowerCase();
      if (!suffix) continue;
      if (/^(mi|miles?|миль|мили|миля)$/iu.test(suffix))
        catalog_numbers[key] = value.times("1.609344").toNumber();
      else if (/^(km|км|kilometers?|kilometres?)$/iu.test(suffix))
        catalog_numbers[key] = value.toNumber();
    } else if (key === "year") {
      if (year !== null) catalog_numbers[key] = year;
    } else {
      catalog_numbers[key] = value.toNumber();
    }
  }
  const sourceMarket = decimal(item.price_range);
  catalog_numbers.price_range =
    sourceMarket?.isFinite() && sourceMarket.abs().lte(Number.MAX_SAFE_INTEGER)
      ? sourceMarket.toNumber()
      : null;
  if (
    !catalog_attributes.availibility &&
    typeof item.availability === "string" &&
    item.availability.trim()
  )
    catalog_attributes.availibility = item.availability.trim();
  if (item.availability != null && typeof item.availability !== "string")
    throw new SourceError("Mashina catalog availability schema changed");
  if (item.created_at != null && typeof item.created_at !== "string")
    throw new SourceError("Mashina catalog publication date schema changed");
  const photos = photoUrls(item.images);
  return makeListing({
    id: `mashina:${item.id}`,
    title: item.title.trim(),
    url: `https://mashina.kg/details/${encodeURIComponent(item.slug).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    price_usd_minor: amounts.USD ?? null,
    price_kgs_minor: amounts.KGS ?? null,
    original_currency: originalCurrency,
    original_price_minor: originalCurrency ? (amounts[originalCurrency] ?? null) : null,
    year,
    catalog_attributes,
    catalog_numbers,
    mileage: attributeText(attrs.get("mileage") ?? {}),
    transmission: attributeText(attrs.get("gearbox") ?? {}),
    body_type: attributeText(attrs.get("body_type") ?? {}),
    city: attributeText(attrs.get("city") ?? {}),
    availability:
      item.status !== "active"
        ? "Неактивно"
        : (item.availability ?? catalog_attributes.availibility ?? "").trim(),
    published_at: item.created_at ?? "",
    photo_url: photos[0] ?? null,
    photo_urls: photos,
  });
}

export function parsePage(text: string, page = 1): SourcePage {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new SourceError("Catalog page must be a positive integer");
  let candidates: ObjectValue[];
  try {
    candidates = catalogs(text);
  } catch (cause) {
    throw new SourceError("Malformed Mashina catalog response", { cause });
  }
  if (candidates.length !== 1)
    throw new SourceError("Expected exactly one Mashina catalog with listing-shaped items");
  const catalog = candidates[0]!;
  for (const key of ["page", "pages", "size", "total"]) {
    if (!Number.isSafeInteger(catalog[key]))
      throw new SourceError("Mashina catalog pagination schema changed");
  }
  if (catalog.page !== page)
    throw new SourceError(`Mashina returned page ${String(catalog.page)} instead of ${page}`);
  const total = catalog.total as number;
  const pages = catalog.pages as number;
  const size = catalog.size as number;
  if (total < 0 || pages < 0 || size <= 0 || (total > 0 && pages === 0))
    throw new SourceError("Invalid Mashina catalog pagination");
  const items = catalog.items as Array<
    ObjectValue & { id: number | bigint; slug: string; title: string; status: string }
  >;
  if (items.length > size || items.length > total)
    throw new SourceError("Mashina catalog item count contradicts pagination");
  if (items.length === 0 && total > 0 && page < pages)
    throw new SourceError("Unexpected empty Mashina catalog interior page");
  if (items.length > 0 && page > pages)
    throw new SourceError("Mashina returned listings beyond the final page");
  const listings = items.map(parseListing);
  if (new Set(listings.map((listing) => listing.id)).size !== listings.length)
    throw new SourceError("Mashina catalog contains duplicate listing IDs");
  return makeSourcePage({ listings, page, total, pages });
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess("mashina.kg");
  if (!Number.isSafeInteger(page) || page < 1)
    throw new SourceError("Catalog page must be a positive integer");
  const result = await transport.fetchDocument(CATALOG_URL, (text) => parsePage(text, page), {
    source: "mashina.kg",
    page,
    params: { page },
    headers: { RSC: "1", Accept: "text/x-component" },
  });
  // Enrich at scheduled ingestion, never during a user's search. Two workers bound
  // additional source traffic; partial/failed pages are not presented as complete.
  let next = 0;
  const controller = new AbortController();
  await Promise.all(
    Array.from({ length: Math.min(2, result.listings.length) }, async () => {
      try {
        while (!controller.signal.aborted) {
          const index = next++;
          const listing = result.listings[index];
          if (!listing) return;
          const slug = decodeURIComponent(new URL(listing.url).pathname.split("/").at(-1)!);
          result.listings[index] = await transport.fetchDocument(
            `https://api.mashina.kg/api/mbank-proxy/v1/ads/${encodeURIComponent(slug)}/detail`,
            (text) => {
              let detail: unknown;
              try {
                detail = JSON.parse(text);
              } catch (cause) {
                throw new SourceError("Malformed Mashina detail response", { cause });
              }
              if (
                !listingShape(detail) ||
                detail.slug !== slug ||
                `mashina:${detail.id}` !== listing.id ||
                detail.category_id !== 1
              )
                throw new SourceError("Mashina detail identity or category changed");
              const enriched = parseListing(detail);
              return makeListing({
                ...listing,
                catalog_attributes: {
                  ...listing.catalog_attributes,
                  ...enriched.catalog_attributes,
                },
                catalog_numbers: {
                  ...listing.catalog_numbers,
                  ...Object.fromEntries(
                    Object.entries(enriched.catalog_numbers).filter(([, value]) => value !== null),
                  ),
                },
                year: enriched.year ?? listing.year,
                mileage: enriched.mileage || listing.mileage,
                city: enriched.city || listing.city,
                body_type: enriched.body_type || listing.body_type,
                transmission: enriched.transmission || listing.transmission,
                availability: enriched.availability || listing.availability,
              });
            },
            {
              source: "mashina.kg",
              headers: { Accept: "application/json", "Accept-Language": "ru" },
              signal: controller.signal,
            },
          );
        }
      } catch (error) {
        controller.abort(error);
      }
    }),
  );
  controller.signal.throwIfAborted();
  return result;
}
