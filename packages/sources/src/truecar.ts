import {
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { type CheerioAPI, load } from "cheerio";
import { Decimal } from "decimal.js";

export const SEARCH_URL =
  "https://www.truecar.com/used-cars-for-sale/listings/toyota/camry/location-new-york-ny/";
const SOURCE = "truecar.com";
const SEARCH_PREFIX = "marketplaceListingSearch(";
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
type RecordValue = Record<string, unknown>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SourceError(`TrueCar: ${message}`);
}

function object(value: unknown): RecordValue {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Decimal),
    "invalid object field",
  );
  return value as RecordValue;
}

function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value), "invalid array field");
  return value;
}

function integer(value: unknown, minimum = 0): number {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum,
    "invalid integer field",
  );
  return value;
}

function text(value: unknown): string {
  requireValue(typeof value === "string" && value.trim().length > 0, "missing text field");
  return value.trim();
}

function money(value: unknown): number {
  requireValue(
    typeof value === "string" || typeof value === "number" || value instanceof Decimal,
    "missing asking price",
  );
  const amount = new Decimal(value);
  requireValue(
    amount.isFinite() && amount.gt(0) && amount.lt("1000000000000"),
    "invalid asking price",
  );
  requireValue(amount.decimalPlaces() <= 2, "fractional price cents");
  // Do not multiply at Decimal's default precision: that can round hidden fractional cents.
  return Number(amount.toFixed(2).replace(".", ""));
}

function sourceUrl(value: unknown, host: string): { url: string; path: string; query: string } {
  const url = text(value);
  const parts = /^https:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(url);
  requireValue(
    parts && parts[1] === host && !parts[4] && !/[\s\\]/.test(url),
    "invalid source URL",
  );
  // Keep raw path/authority rather than URL-normalizing away an explicit port or traversal.
  return { url, path: parts[2]!, query: parts[3] ?? "" };
}

function cursor(value: unknown): number {
  const encoded = text(value);
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  requireValue(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(padded),
    "invalid pagination cursor",
  );
  const decoded = Buffer.from(padded, "base64").toString("latin1");
  requireValue(/^[0-9]+$/.test(decoded), "invalid pagination cursor");
  return integer(Number(decoded));
}

function parseJson(raw: string): unknown {
  // Node 24 exposes the original numeric token to revivers, avoiding JSON.parse's
  // binary rounding before monetary validation. Decimal also retains 1.0 vs integer 1.
  return JSON.parse(raw, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value === "number") {
      requireValue(context?.source, "JSON numeric source is unavailable");
      if (/[.eE]/.test(context.source) || !Number.isSafeInteger(value))
        return new Decimal(context.source);
    }
    return value;
  }) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value instanceof Decimal) return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson((value as RecordValue)[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  requireValue(encoded !== undefined, "invalid search scope");
  return encoded.replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function history(row: RecordValue, vehicle: RecordValue, priced: boolean): string {
  const facts = ["TrueCar: USED (подержанный автомобиль)"];
  const certified = vehicle.certifiedPreOwned;
  if (certified != null) {
    requireValue(typeof certified === "boolean", "invalid certification flag");
    if (certified) facts.push("TrueCar сообщает: certified pre-owned");
  }
  const condition = row.conditionHistory == null ? {} : object(row.conditionHistory);
  for (const [key, label] of [
    ["accidentCount", "зарегистрированных ДТП"],
    ["ownerCount", "зарегистрированных владельцев"],
  ] as const) {
    const value = condition[key];
    if (value == null) facts.push(`TrueCar: ${label} — неизвестно`);
    else {
      const count = integer(value);
      const suffix =
        key === "ownerCount" && count === 0 ? " (исходное значение, история не подтверждена)" : "";
      facts.push(`TrueCar сообщает: ${label} — ${count}${suffix}`);
    }
  }
  const title = condition.isCleanTitle;
  requireValue(title == null || typeof title === "boolean", "invalid title history");
  facts.push(
    title == null
      ? "TrueCar: статус title — неизвестно"
      : `TrueCar сообщает: clean title — ${title ? "да" : "нет"}`,
  );
  facts.push(
    priced
      ? "TrueCar: advertised asking price; NO_EXCLUSION; не итоговая стоимость"
      : "TrueCar: цена не опубликована (NOT_PRICED)",
  );
  return facts.join("; ");
}

function corroborateRenderedPurchase(
  $: CheerioAPI,
  vin: string,
  year: number,
  make: RecordValue,
  model: RecordValue,
  price: number | null,
): void {
  const card = $(`[data-test="usedListing"][data-test-item="${vin}"]`);
  requireValue(card.length === 1, "missing or ambiguous rendered vehicle");
  const links = card.find('a[data-test="cardLinkCover"]');
  requireValue(links.length === 1, "missing or ambiguous rendered vehicle link");
  const href = text(links.attr("href"));
  const target = sourceUrl(
    href.startsWith("/") ? `https://www.truecar.com${href}` : href,
    "www.truecar.com",
  );
  const path = `/used-cars-for-sale/listing/${vin}/`;
  requireValue(
    target.path === path ||
      target.path === `${path}${year}-${text(make.slug)}-${text(model.slug)}/`,
    "noncanonical rendered vehicle URL",
  );
  if (price === null) {
    requireValue(
      card.text().includes("Price Not Available") &&
        card.find('[data-test="vehicleCardPricingPrice"]').length === 0,
      "inconsistent rendered unavailable price",
    );
    return;
  }
  const pricing = card.find('[data-test="vehicleCardPricing"]');
  const amounts = pricing.find('[data-test="vehicleCardPricingPrice"]');
  requireValue(
    pricing.length === 1 &&
      /^Advertised price\s*\$/.test(pricing.text().trim()) &&
      amounts.length === 1,
    "missing rendered asking price",
  );
  // TrueCar's US retail cards display USD with "$"; do not accept monthly/foreign prices.
  const amount = amounts.text().trim();
  requireValue(
    /^\$(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{2})?$/.test(amount),
    "invalid rendered USD asking price",
  );
  requireValue(
    money(amount.slice(1).replaceAll(",", "")) === price,
    "inconsistent rendered asking price",
  );
}

function listing(
  row: RecordValue,
  linked: RecordValue | undefined,
  filters: RecordValue,
  $: CheerioAPI,
): Listing {
  requireValue(row.__typename === "ConsumerSummaryListing", "unexpected listing entity");
  const vehicle = object(row.vehicle);
  const vin = text(vehicle.vin);
  requireValue(VIN.test(vin), "invalid VIN");
  requireValue(
    vehicle.condition === "USED" &&
      (linked === undefined ||
        ["UsedCondition", "https://schema.org/UsedCondition"].includes(
          String(linked.itemCondition),
        )),
    "not a used retail listing",
  );
  const pricing = object(row.pricing);
  const unpriced = pricing.exclusion === "NOT_PRICED";
  requireValue(
    unpriced
      ? pricing.listPrice === null && pricing.discountLabel == null
      : pricing.exclusion === "NO_EXCLUSION" &&
          (pricing.discountLabel == null || pricing.discountLabel === "UPFRONT_PRICE"),
    "unsupported price qualification",
  );
  const price = unpriced ? null : money(pricing.listPrice);
  const url = `https://www.truecar.com/used-cars-for-sale/listing/${vin}/`;
  if (linked !== undefined) {
    const offer = object(linked.offers);
    requireValue(
      offer["@type"] === "Offer" &&
        offer.priceCurrency === "USD" &&
        offer.sku === vin &&
        (price === null ? offer.price === "0.00" : money(offer.price) === price),
      "inconsistent USD asking price",
    );
    requireValue(
      !Object.hasOwn(offer, "leaseLength") && !Object.hasOwn(offer, "priceSpecification"),
      "unsupported offer price type",
    );
    requireValue(
      offer.businessFunction == null ||
        offer.businessFunction === "Sell" ||
        offer.businessFunction === "http://purl.org/goodrelations/v1#Sell",
      "offer is not a retail purchase",
    );
    requireValue(sourceUrl(offer.url, "www.truecar.com").url === url, "noncanonical vehicle URL");
  }
  const make = object(vehicle.make);
  const model = object(vehicle.model);
  const selected = filters.makeModelTrim === undefined ? [] : array(filters.makeModelTrim);
  requireValue(
    !selected.length ||
      selected.some((value) => {
        const choice = object(value);
        return (
          (choice.makeSlug == null || choice.makeSlug === make.slug) &&
          (choice.modelSlug == null || choice.modelSlug === model.slug)
        );
      }),
    "listing outside requested make/model",
  );
  const year = integer(vehicle.year, 1886);
  requireValue(
    year < 2200 && (linked === undefined || String(year) === linked.vehicleModelDate),
    "inconsistent model year",
  );
  const trimValue = vehicle.style == null ? "" : (object(vehicle.style).trimName ?? "");
  const linkedTrimValue = linked?.vehicleConfiguration ?? "";
  requireValue(
    typeof trimValue === "string" && typeof linkedTrimValue === "string",
    "invalid vehicle trim",
  );
  const primaryTrim = trimValue.trim();
  const linkedTrim = linkedTrimValue.trim();
  const trim = primaryTrim || linkedTrim;
  requireValue(
    linked === undefined ||
      (object(linked.brand).name === make.name &&
        linked.model === model.name &&
        (!primaryTrim || !linkedTrim || primaryTrim === linkedTrim)),
    "inconsistent vehicle identity",
  );
  const miles = integer(vehicle.mileage);
  const details = object(vehicle.details);
  requireValue(
    details.vin === vin &&
      (details.mileage instanceof Decimal ? details.mileage.eq(miles) : details.mileage === miles),
    "inconsistent mileage or VIN",
  );
  if (linked !== undefined) {
    const odometer = object(linked.mileageFromOdometer);
    requireValue(
      odometer.value instanceof Decimal ? odometer.value.eq(miles) : odometer.value === miles,
      "inconsistent mileage or VIN",
    );
    requireValue(
      (odometer.unitCode == null || odometer.unitCode === "SMI") &&
        (odometer.unitText == null || odometer.unitText === "mi" || odometer.unitText === "miles"),
      "unsupported odometer units",
    );
  }
  if (linked === undefined || unpriced) {
    // Rendered evidence distinguishes an unavailable-price placeholder from a free car.
    requireValue(
      unpriced || pricing.discountLabel === "UPFRONT_PRICE",
      "unsupported price qualification",
    );
    corroborateRenderedPurchase($, vin, year, make, model, price);
  }
  const photos: string[] = [];
  const images = linked?.image;
  for (const image of Array.isArray(images) ? images : [images]) {
    // Static model artwork is not a photograph of this advertised vehicle.
    if (
      typeof image !== "string" ||
      /[\s\\\p{Cc}]/u.test(image) ||
      !/^https:\/\/listings-prod\.tcimg\.net\//.test(image)
    )
      continue;
    try {
      const photo = sourceUrl(image, "listings-prod.tcimg.net").url;
      if (!photos.includes(photo)) photos.push(photo);
      if (photos.length === 10) break;
    } catch {
      /* An invalid optional photograph does not invalidate the vehicle. */
    }
  }
  const makeName = text(make.name);
  const modelName = text(model.name);
  const publishedAt = details.listedAt || "";
  requireValue(typeof publishedAt === "string", "invalid publication time");
  const transmission = vehicle.transmission ?? "";
  requireValue(typeof transmission === "string", "invalid transmission");
  return makeListing({
    id: `truecar:${vin}`,
    title: `${year} ${makeName} ${modelName}${trim ? ` ${trim}` : ""}`,
    url,
    price_usd_minor: price,
    price_kgs_minor: null,
    year,
    mileage: `${miles} miles`,
    transmission: transmission.trim(),
    body_type: text(vehicle.bodyStyle),
    city: `${text(details.dealerCity)}, ${text(details.dealerState)}`,
    availability: "Опубликовано",
    published_at: publishedAt,
    photo_url: photos[0] ?? null,
    photo_urls: photos,
    source: SOURCE,
    market: "US",
    original_currency: "USD",
    original_price_minor: price,
    trim,
    condition: history(row, vehicle, !unpriced),
    search_aliases: `${make.name} ${model.name} ${trim}`,
    price_kind: unpriced ? "unknown" : "asking",
  });
}

function parseScopedPage(
  raw: string,
  page: number,
  expectedPath?: readonly string[],
  expectedQuery: Record<string, string> = {},
): SourcePage {
  try {
    integer(page, 1);
    const $ = load(raw, { sourceCodeLocationInfo: true });
    const scripts = $("script").filter((_index, script) => {
      if (!("sourceCodeLocation" in script)) return false;
      const location = script.sourceCodeLocation;
      return (
        location !== null &&
        typeof location === "object" &&
        "endTag" in location &&
        Boolean(location.endTag)
      );
    });
    const nextData = scripts.filter('[id="__NEXT_DATA__"]');
    requireValue(nextData.length === 1, "missing or ambiguous Next.js data; possible challenge");
    const data = object(parseJson(nextData.text()));
    requireValue(data.isFallback === false, "Next.js fallback document");
    const query = object(data.query);
    requireValue(
      query.condition === "used" && String(query.page ?? "1") === String(page),
      "returned search page does not match request",
    );
    const path = query.splat === undefined ? [] : array(query.splat);
    requireValue(
      path.every((part) => typeof part === "string"),
      "invalid search route",
    );
    if (expectedPath !== undefined)
      requireValue(
        path.length === expectedPath.length &&
          path.every((part, index) => part === expectedPath[index]),
        "returned search route does not match request",
      );
    for (const [key, value] of Object.entries(expectedQuery))
      requireValue(String(query[key]) === value, "returned query does not match request");
    const state = object(object(object(data.props).pageProps).__APOLLO_STATE__);
    const matches: [RecordValue, unknown][] = [];
    for (const [key, connection] of Object.entries(object(state.ROOT_QUERY))) {
      if (!key.startsWith(SEARCH_PREFIX) || !key.endsWith(")")) continue;
      const args = object(parseJson(key.slice(SEARCH_PREFIX.length, -1)));
      if (args.sponsored === true) continue;
      const size = integer(args.first, 1);
      const offset = integer(args.offset);
      const filters = object(args.filters);
      if (offset !== (page - 1) * size || filters.condition !== "USED") continue;
      const selected = filters.makeModelTrim === undefined ? [] : array(filters.makeModelTrim);
      if (
        path.length &&
        (selected.length !== 1 ||
          object(selected[0]).makeSlug !== path[0] ||
          (path.length > 1 && object(selected[0]).modelSlug !== path[1]))
      )
        continue;
      matches.push([args, connection]);
    }
    requireValue(matches.length === 1, "missing or ambiguous requested search connection");
    const [args, connectionValue] = matches[0]!;
    const connection = object(connectionValue);
    requireValue(
      connection.__typename === "MarketplaceSearchConnection" && connection.isFallback === false,
      "fallback search results",
    );
    const total = integer(connection.totalCount);
    const size = integer(args.first, 1);
    const offset = integer(args.offset);
    const pages = Math.ceil(total / size);
    requireValue(page <= Math.max(1, pages), "page outside result count");
    const edges = array(connection.edges);
    const info = object(connection.pageInfo);
    requireValue(
      edges.length === Math.min(size, Math.max(0, total - offset)),
      "incomplete search page",
    );
    requireValue(
      typeof info.hasNextPage === "boolean" && info.hasNextPage === offset + edges.length < total,
      "inconsistent next page",
    );
    if (edges.length)
      requireValue(cursor(info.endCursor) === offset + edges.length, "inconsistent end cursor");
    else
      requireValue(info.endCursor == null || info.endCursor === "", "unexpected empty-page cursor");
    const filters = object(args.filters);
    const radius = object(filters.withinRadius);
    integer(radius.distance, 1);
    const locations = path.filter(
      (part) => typeof part === "string" && part.startsWith("location-"),
    );
    requireValue(locations.length <= 1, "ambiguous search location");
    if (locations.length) {
      const location = /^location-([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z]{2})$/.exec(
        String(locations[0]),
      );
      requireValue(
        location &&
          radius.city === location[1] &&
          radius.state === location[2] &&
          radius.postalCode === undefined,
        "returned city scope differs",
      );
    } else {
      requireValue(
        typeof radius.postalCode === "string" && /^[0-9]{5}$/.test(radius.postalCode),
        "missing search postal code",
      );
    }
    requireValue(typeof args.sort === "string", "missing search sort");
    for (const [parameter, actual] of [
      ["zip", radius.postalCode],
      ["searchRadius", radius.distance],
    ] as const) {
      if (Object.hasOwn(expectedQuery, parameter))
        requireValue(
          expectedQuery[parameter] === String(actual),
          "returned location scope differs",
        );
    }
    const linked = new Map<unknown, RecordValue>();
    scripts
      .filter('[type="application/ld+json"]')
      .not('[id="__NEXT_DATA__"]')
      .each((_index, script) => {
        const document = object(parseJson($(script).text()));
        const graph = document["@graph"] === undefined ? [document] : array(document["@graph"]);
        for (const value of graph) {
          const item = object(value);
          if (item["@type"] !== "CollectionPage") continue;
          for (const element of array(object(item.mainEntity).itemListElement)) {
            const vehicle = object(object(element).item);
            requireValue(vehicle["@type"] === "Vehicle", "invalid JSON-LD inventory");
            const vin = vehicle.vehicleIdentificationNumber;
            requireValue(
              typeof vin === "string" && VIN.test(vin) && object(vehicle.offers).sku === vin,
              "inconsistent JSON-LD VIN",
            );
            requireValue(!linked.has(vin), "duplicate JSON-LD vehicle");
            linked.set(vin, vehicle);
          }
        }
      });
    const listings: Listing[] = [];
    const seen = new Set<unknown>();
    for (let index = 0; index < edges.length; index++) {
      const edge = object(edges[index]);
      requireValue(cursor(edge.cursor) === offset + index + 1, "inconsistent edge cursor");
      const reference = text(object(edge.node).__ref);
      requireValue(Object.hasOwn(state, reference), "missing connected vehicle");
      const row = object(state[reference]);
      const vin = object(row.vehicle).vin;
      requireValue(!seen.has(vin), "duplicate vehicle within search page");
      seen.add(vin);
      listings.push(listing(row, linked.get(vin), filters, $));
    }
    return makeSourcePage({
      listings,
      page,
      total,
      pages,
      scope: `${SOURCE}:${canonicalJson({ filters, sort: args.sort })}`,
    });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("TrueCar: invalid structured retail search document", { cause: error });
  }
}

/** Parse connected inventory and retain the actual executed geographic search scope. */
export function parsePage(text: string, page = 1): SourcePage {
  return parseScopedPage(text, page);
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess(SOURCE);
  integer(page, 1);
  let requestUrl: string;
  let path: string[];
  const params: Record<string, string> = {};
  try {
    const parsed = sourceUrl(
      process.env.AUTODOM_TRUECAR_SEARCH_URL ?? SEARCH_URL,
      "www.truecar.com",
    );
    requireValue(
      /^\/used-cars-for-sale\/listings\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(parsed.path),
      "invalid canonical search path",
    );
    if (parsed.query) {
      requireValue(
        parsed.query.split("&").every((pair) => pair.includes("=")),
        "invalid search parameters",
      );
      for (const [key, value] of new URLSearchParams(parsed.query)) {
        requireValue(!Object.hasOwn(params, key), "duplicate search parameters");
        requireValue(
          ["page", "zip", "searchRadius"].includes(key),
          "unsupported search parameters",
        );
        params[key] = value;
      }
    }
    if (params.zip !== undefined)
      requireValue(/^[0-9]{5}$/.test(params.zip), "invalid postal code");
    if (params.searchRadius !== undefined)
      requireValue(
        /^[0-9]+$/.test(params.searchRadius) && new Decimal(params.searchRadius).gt(0),
        "invalid search radius",
      );
    params.page = String(page);
    const route = parsed.path.slice("/used-cars-for-sale/listings/".length).replace(/\/$/, "");
    path = route ? route.split("/") : [];
    requestUrl = `https://www.truecar.com${parsed.path}`;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("TrueCar: invalid configured search URL", { cause: error });
  }
  return transport.fetchDocument(requestUrl, (text) => parseScopedPage(text, page, path, params), {
    source: SOURCE,
    page,
    params,
  });
}
