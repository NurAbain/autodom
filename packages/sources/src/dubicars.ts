import {
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { load } from "cheerio";
import { Decimal } from "decimal.js";

export const CATALOG_URL = "https://www.dubicars.com/dubai/used";
export const PAGE_SIZE = 30;
export const SCOPE = "ОАЭ: подержанные автомобили в Дубае; возможность импорта не подтверждена";
const SOURCE = "dubicars.com";
type RecordValue = Record<string, unknown>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SourceError(`DubiCars: ${message}`);
}

function object(value: unknown): RecordValue {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Decimal),
    "invalid object",
  );
  return value as RecordValue;
}

function text(value: unknown): string {
  requireValue(typeof value === "string" && value.trim().length > 0, "missing text");
  return value.trim();
}

function integer(value: unknown, minimum = 0): number {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum,
    "invalid integer",
  );
  return value;
}

function json(raw: string): unknown {
  return JSON.parse(raw, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value !== "number") return value;
    requireValue(context?.source, "JSON numeric source is unavailable");
    return /[.eE]/.test(context.source) || !Number.isSafeInteger(value)
      ? new Decimal(context.source)
      : value;
  }) as unknown;
}

function money(value: unknown): number {
  requireValue(
    typeof value === "number" || typeof value === "string" || value instanceof Decimal,
    "missing asking price",
  );
  const raw = String(value);
  requireValue(raw.length <= 40 && /^\d+(?:\.\d+)?$/.test(raw), "invalid asking price");
  const amount = new Decimal(raw);
  requireValue(
    amount.isFinite() &&
      amount.gt(0) &&
      amount.decimalPlaces() <= 2 &&
      amount.lte("90071992547409.91"),
    "invalid AED fils",
  );
  return Number(amount.toFixed(2).replace(".", ""));
}

function zeroOrMissing(value: unknown): boolean {
  return (
    value == null ||
    value === "" ||
    value === 0 ||
    value === "0" ||
    (value instanceof Decimal && value.isZero())
  );
}

function adUrl(value: unknown): { url: string; id: string } {
  const url = text(value);
  const match = /^https:\/\/www\.dubicars\.com\/[a-z0-9]+(?:-[a-z0-9]+)*-([1-9][0-9]*)\.html$/.exec(
    url,
  );
  requireValue(match, "invalid advertisement URL");
  return { url, id: match[1]! };
}

function catalogPage(value: unknown): number {
  const url = text(value);
  if (url === CATALOG_URL) return 1;
  const match = /^https:\/\/www\.dubicars\.com\/dubai\/used\?page=([1-9][0-9]*)$/.exec(url);
  requireValue(match, "invalid pagination URL");
  return integer(Number(match[1]), 1);
}

function photo(value: unknown): string | null {
  if (value == null || value === "") return null;
  const url = text(value);
  requireValue(
    /^https:\/\/www\.dubicars\.com\/images\/[a-f0-9]+\/[1-9][0-9]*x[1-9][0-9]*\/[a-z0-9-]+\/[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(
      url,
    ),
    "unverified photo URL",
  );
  return url;
}

function parseCatalog(raw: string, page: number): SourcePage {
  integer(page, 1);
  requireValue(/<\/html>\s*$/i.test(raw), "incomplete HTML response");
  const $ = load(raw);
  requireValue(
    $("body#search-new-page").length === 1 && $("#serp-list").length === 1,
    "missing catalog or access challenge",
  );
  const filterScripts = $("script")
    .toArray()
    .map((node) => $(node).text())
    .filter((value) => value.includes("window.selected_filters ="));
  requireValue(filterScripts.length === 1, "missing search filters");
  const encodedFilters = /window\.selected_filters\s*=\s*(\{[^\n]+?\});/.exec(filterScripts[0]!);
  requireValue(encodedFilters, "malformed search filters");
  const filters = object(json(encodedFilters[1]!));
  requireValue(
    object(filters.cr).id === "AED" &&
      object(filters.ul).id === "AE" &&
      object(filters.l).id === 3 &&
      object(filters.c).id === "used",
    "unexpected currency or geographic search",
  );
  const canonical = $('head link[rel="canonical"]');
  requireValue(
    canonical.length === 1 && catalogPage(canonical.attr("href")) === page,
    "wrong returned page",
  );
  const graphs: RecordValue[] = [];
  $('script[type="application/ld+json"]').each((_index, node) => {
    const document = object(json($(node).text()));
    if (Array.isArray(document["@graph"])) graphs.push(...document["@graph"].map(object));
  });
  const lists = graphs.filter((node) => node["@type"] === "ItemList");
  requireValue(lists.length === 1, "missing or ambiguous inventory");
  const list = lists[0]!;
  requireValue(
    list.url === CATALOG_URL && list["@id"] === `${CATALOG_URL}#itemlist`,
    "wrong structured inventory scope",
  );
  requireValue(Array.isArray(list.itemListElement), "missing inventory items");
  const items = list.itemListElement;
  requireValue(
    items.length > 0 && items.length <= PAGE_SIZE && integer(list.numberOfItems) === items.length,
    "empty or malformed catalog inventory",
  );
  const cards = $("#serp-list li.serp-list-item[data-sp-item]");
  requireValue(
    cards.length === items.length && $("#serp-list li.serp-list-item").length === cards.length,
    "rendered inventory count mismatch",
  );
  const active = $("#pagination .active");
  requireValue(
    active.length > 0 && active.toArray().every((node) => $(node).text().trim() === String(page)),
    "missing or wrong active page",
  );
  let pages = page;
  $("#pagination a[href]").each((_index, node) => {
    const href = $(node).attr("href");
    if (href) pages = Math.max(pages, catalogPage(href));
  });
  for (const relation of ["prev", "next"] as const) {
    const expected =
      relation === "prev" ? (page > 1 ? page - 1 : null) : page < pages ? page + 1 : null;
    const head = $(`head link[rel="${relation}"]`);
    const nav = $(`#pagination a[rel="${relation}"]`);
    requireValue(nav.length === 1, "missing pagination control");
    if (expected === null) {
      requireValue(
        head.length === 0 && !nav.attr("href") && nav.hasClass("disabled"),
        "contradictory terminal pagination",
      );
    } else {
      requireValue(
        head.length === 1 &&
          catalogPage(head.attr("href")) === expected &&
          !nav.hasClass("disabled") &&
          catalogPage(nav.attr("href")) === expected,
        "broken page progression",
      );
    }
  }
  const listings = new Map<string, Listing>();
  const identities = new Map<string, string>();
  let total: number | undefined;
  for (let index = 0; index < items.length; index++) {
    const entry = object(items[index]);
    requireValue(
      entry["@type"] === "ListItem" && integer(entry.position, 1) === index + 1,
      "invalid item position",
    );
    const car = object(entry.item);
    const card = cards.eq(index);
    const data = object(json(text(card.attr("data-sp-item"))));
    const params = object(json(text(data.params)));
    requireValue(
      params.cr === "AED" &&
        params.ul === "AE" &&
        params.l === 3 &&
        params.c === "used" &&
        params.pc === "used",
      "wrong card scope",
    );
    requireValue(
      integer(data.pno, 1) === page && data.new === false,
      "wrong card page or vehicle category",
    );
    const count = integer(data.ta, 1);
    total ??= count;
    requireValue(total === count && count >= items.length, "inconsistent inventory total");
    requireValue(car["@type"] === "Car", "unexpected structured vehicle");
    const { url, id } = adUrl(car.url);
    requireValue(
      String(integer(data.id, 1)) === id && car["@id"] === `${url}#car`,
      "contradictory advertisement identity",
    );
    const links = card.find("a.title, a.image-container");
    requireValue(
      links.length >= 2 && links.toArray().every((node) => adUrl($(node).attr("href")).url === url),
      "contradictory rendered identity",
    );
    const title = text(car.name);
    const titleParts = card
      .find("a.title.mobile-only .specs > span")
      .toArray()
      .map((node) => $(node).text().trim());
    requireValue(
      titleParts.length >= 2 && titleParts.filter(Boolean).join(" ") === title,
      "contradictory vehicle title",
    );
    const location = card.find("img.icon-location").parent().text().trim();
    requireValue(location.length > 0, "unknown stock location");
    const local = location === "Dubai";
    requireValue((integer(data.pid, 1) === 3) === local, "contradictory stock location");
    const year = data.y == null ? null : integer(data.y, 1886);
    requireValue(
      year === null
        ? car.vehicleModelDate == null
        : year <= 2200 &&
            String(year) === car.vehicleModelDate &&
            card.find("img.icon-year").parent().text().trim() === String(year),
      "contradictory model year",
    );
    let km: number | null = null;
    if (data.km != null) {
      km = integer(data.km);
      const odometer = object(car.mileageFromOdometer);
      requireValue(
        odometer.unitCode === "KMT" && integer(odometer.value) === km,
        "contradictory mileage or units",
      );
      const renderedKm = card.find("img.icon-speed").parent().text().trim();
      requireValue(
        /^(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)\s+Km$/i.test(renderedKm) &&
          Number(renderedKm.replaceAll(",", "").replace(/\s+Km$/i, "")) === km,
        "contradictory rendered mileage",
      );
    } else requireValue(car.mileageFromOdometer == null, "contradictory unknown mileage");
    requireValue(
      car.itemCondition == null || car.itemCondition === "https://schema.org/UsedCondition",
      "unexpected vehicle condition",
    );
    const offer = car.offers == null ? null : object(car.offers);
    if (offer) {
      requireValue(
        offer["@type"] === "Offer" &&
          offer.priceCurrency === "AED" &&
          adUrl(offer.url).url === url &&
          offer["@id"] === `${url}#offer`,
        "contradictory offer currency or identity",
      );
      requireValue(
        offer.priceSpecification == null && offer.leaseLength == null,
        "unsupported offer price",
      );
    }
    let amount: number | null = null;
    const price = card.find(".detail .price");
    requireValue(price.length === 1, "missing rendered price status");
    const displayed = price.children("strong");
    if (displayed.length === 0) {
      const status = price.clone();
      status.find(".premium-new, .mobile-only").remove();
      requireValue(
        [data.spr, offer?.price].every(zeroOrMissing) &&
          /^(?:price on request|poa|call for price)$/i.test(status.text().trim()),
        "contradictory unavailable price",
      );
    } else {
      // Analytics pr/rpr/rl/pnr do not establish cash price or its availability.
      // Bind the AED Offer to its rendered asking price, never to financing.
      amount = money(offer?.price);
      requireValue(money(data.spr) === amount, "contradictory native asking price");
      const digits = displayed.text().trim();
      requireValue(
        displayed.length === 1 &&
          displayed.find('[aria-label="AED"]').length === 1 &&
          /^(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$/.test(digits) &&
          money(digits.replaceAll(",", "")) === amount,
        "contradictory rendered AED asking price",
      );
    }
    const conditions: string[] = [];
    if (car.itemCondition)
      conditions.push("DubiCars: подержанный автомобиль; история и повреждения неизвестны");
    for (const [badge, label] of [
      ["1", "UAE Only (только рынок ОАЭ)"],
      ["2", "Export Only (только экспорт)"],
      ["11", "For export (по заявлению продавца)"],
    ] as const) {
      if (card.find(`[badge-popup="${badge}"]`).length > 0) conditions.push(`DubiCars: ${label}`);
    }
    for (const restriction of ["Export Only", "UAE Only", "For export"]) {
      if (
        new RegExp(`\\b${restriction}\\b`, "i").test(card.find(".detail").text()) &&
        !conditions.some((value) => value.includes(restriction))
      )
        conditions.push(`DubiCars: ${restriction}`);
    }
    const refreshed = data.rft == null ? "" : text(data.rft);
    requireValue(
      !refreshed || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(refreshed),
      "malformed source date",
    );
    if (refreshed)
      conditions.push(
        `DubiCars rft (дата источника, не подтверждённая дата публикации): ${refreshed}`,
      );
    const image = photo(car.image);
    const result = makeListing({
      id: `dubicars:${id}`,
      title,
      url,
      source: SOURCE,
      market: "AE",
      original_currency: "AED",
      original_price_minor: amount,
      price_usd_minor: null,
      price_kgs_minor: null,
      price_kind: amount === null ? "unknown" : "asking",
      year,
      mileage: km === null ? "" : `${km} km`,
      city: location,
      trim: titleParts.slice(2).join(" "),
      availability: "Опубликовано",
      photo_url: image,
      photo_urls: image ? [image] : [],
      condition: conditions.join("; "),
    });
    const signature = JSON.stringify(result);
    requireValue(
      !identities.has(id) || identities.get(id) === signature,
      "contradictory duplicate advertisement",
    );
    identities.set(id, signature);
    if (local) listings.set(id, result);
  }
  // The site's navigable page cap is independent of its advertised total; never derive it from total/30.
  return makeSourcePage({ listings: [...listings.values()], page, pages, total, scope: SCOPE });
}

export function parsePage(raw: string, page = 1): SourcePage {
  try {
    return parseCatalog(raw, page);
  } catch (cause) {
    if (cause instanceof SourceError) throw cause;
    throw new SourceError("DubiCars: malformed catalog response", { cause });
  }
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess(SOURCE);
  integer(page, 1);
  return transport.fetchDocument(CATALOG_URL, (raw) => parsePage(raw, page), {
    source: SOURCE,
    page,
    params: { cr: "AED", ul: "AE", ...(page === 1 ? {} : { page: String(page) }) },
  });
}
