import {
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { type Cheerio, type CheerioAPI, load } from "cheerio";
import type { AnyNode } from "domhandler";

export const CATALOG_URL = "https://bid.cars/en/automobile/page/1";
/** The shared Crawlee transport owns source pacing, including this legacy detail interval. */
export const DETAIL_DELAY_SECONDS = 2;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LOTS = 100;
const CATALOG_PATH =
  /^\/en\/automobile(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}\/page\/([1-9][0-9]{0,6})$/;
const LOT_PATH = /^\/en\/lot\/([01]-[0-9]{1,12})\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/;
const UNKNOWN: Readonly<Record<string, true>> = {
  "": true,
  "-": true,
  "--": true,
  "---": true,
  "n/a": true,
  unknown: true,
  "no information": true,
  "not available": true,
  hidden: true,
};
const US_STATES: Readonly<Record<string, true>> = {
  AL: true,
  AK: true,
  AZ: true,
  AR: true,
  CA: true,
  CO: true,
  CT: true,
  DE: true,
  FL: true,
  GA: true,
  HI: true,
  ID: true,
  IL: true,
  IN: true,
  IA: true,
  KS: true,
  KY: true,
  LA: true,
  ME: true,
  MD: true,
  MA: true,
  MI: true,
  MN: true,
  MS: true,
  MO: true,
  MT: true,
  NE: true,
  NV: true,
  NH: true,
  NJ: true,
  NM: true,
  NY: true,
  NC: true,
  ND: true,
  OH: true,
  OK: true,
  OR: true,
  PA: true,
  RI: true,
  SC: true,
  SD: true,
  TN: true,
  TX: true,
  UT: true,
  VT: true,
  VA: true,
  WA: true,
  WV: true,
  WI: true,
  WY: true,
  DC: true,
  PR: true,
};
const OPTION_LABELS: Readonly<Record<string, true>> = {
  lot: true,
  vin: true,
  "sale document": true,
  "primary damage": true,
  "secondary damage": true,
  odometer: true,
  "start code": true,
  "body style": true,
};
const VARIABLE_NAMES = [
  "lotNumber",
  "isArchived",
  "currentBid",
  "finalBid",
  "estimatedAmount1",
  "estimatedAmount2",
  "buyNowAmount",
  "auctionType",
  "liveAuctionStartDateTime",
] as const;
type VariableName = (typeof VARIABLE_NAMES)[number];
type Selection = Cheerio<AnyNode>;

export interface CatalogLot {
  lot: string;
  url: string;
  title: string;
  vin: string;
}
export interface CatalogPage {
  lots: readonly CatalogLot[];
  urls: readonly string[];
  page: number;
  pages: number;
  total: null;
}

function document(text: string): CheerioAPI {
  if (text.length > MAX_BYTES || Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new SourceError("Bid.Cars document exceeds transport limit");
  }
  // HTML-mode parsers repair truncation and missing document elements; require original evidence first.
  if (!/<html(?:\s|>)/i.test(text) || !/<\/html\s*>/i.test(text)) {
    throw new SourceError("Incomplete Bid.Cars HTML document");
  }
  const $ = load(text);
  const stack = $.root()
    .contents()
    .toArray()
    .map((node) => ({ node, depth: 1 }));
  let count = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if ("tagName" in entry.node && (++count > 100_000 || entry.depth > 256)) {
      throw new SourceError("Bid.Cars HTML complexity exceeds limit");
    }
    if ("children" in entry.node) {
      for (const node of entry.node.children) stack.push({ node, depth: entry.depth + 1 });
    }
  }
  return $;
}

function one(nodes: Selection, label: string): Selection {
  if (nodes.length !== 1) throw new SourceError(`Bid.Cars expected one ${label}`);
  return nodes;
}

function nodeText(node: Selection): string {
  return node.text().replace(/\s+/gu, " ").trim();
}

function publicUrl(value: string, pattern: RegExp): RegExpExecArray {
  if (typeof value !== "string" || value.length > 2048 || / |[\p{Cc}&&\p{ASCII}]/v.test(value)) {
    throw new SourceError("Invalid Bid.Cars URL");
  }
  // Validate the literal origin/path, not WHATWG-normalized URLs (which erase explicit ports and dot segments).
  const match = value.startsWith("https://bid.cars/")
    ? pattern.exec(value.slice("https://bid.cars".length))
    : null;
  if (!match || value.includes("?") || value.includes("#")) {
    throw new SourceError("Bid.Cars URL is outside the permitted public English scope");
  }
  return match;
}

export function catalogUrl(): string {
  const value = process.env.AUTODOM_BIDCARS_CATALOG_URL ?? CATALOG_URL;
  if (publicUrl(value, CATALOG_PATH)[1] !== "1")
    throw new SourceError("Bid.Cars catalog configuration must start at page/1");
  return value;
}

function options($: CheerioAPI, root: Selection): Record<string, string> {
  const result: Record<string, string> = {};
  root.find(".option").each((_index, element) => {
    const node = $(element);
    const label = nodeText(
      node.contents().filter((_i, child) => child.type === "text"),
    ).toLowerCase();
    if (OPTION_LABELS[label] !== true) return;
    const value = nodeText(one(node.find(".right-info"), "right-info"));
    if (result[label] !== undefined && result[label] !== value)
      throw new SourceError("Conflicting Bid.Cars labeled attributes");
    result[label] = value;
  });
  return result;
}

function optional(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new SourceError("Bid.Cars text schema changed");
  const normalized = value.replace(/\s+/gu, " ").trim();
  return UNKNOWN[normalized.toLowerCase()] === true ? "" : normalized;
}

function amount(value: string, dom = false): number | null {
  if (typeof value !== "string") throw new SourceError("Bid.Cars amount schema changed");
  value = value.trim();
  if (UNKNOWN[value.toLowerCase()] === true || value === "null") return null;
  if (value.length > 32) throw new SourceError("Bid.Cars amount exceeds supported range");
  const match = (
    dom
      ? /^\$([0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(\.[0-9]{1,2})?(?:\s+USD)?$/
      : /^([0-9]{1,12})(\.[0-9]{1,2})?$/
  ).exec(value);
  if (!match) throw new SourceError("Malformed Bid.Cars USD amount");
  const cents =
    BigInt(match[1]!.replaceAll(",", "")) * 100n +
    BigInt((match[2]?.slice(1) ?? "").padEnd(2, "0"));
  if (cents > 100_000_000_000_000n)
    throw new SourceError("Bid.Cars amount exceeds supported range");
  return Number(cents);
}

function variables($: CheerioAPI): Record<VariableName, string> {
  const values: Partial<Record<VariableName, string>> = {};
  $("script").each((_index, element) => {
    const node = $(element);
    if (node.attr("src") || node.attr("type") === "application/ld+json") return;
    const script = node.text();
    for (const match of script.matchAll(/^\s*(?:var|let|const)\s+(\w+)\s*=\s*([^;\r\n]*);/gm)) {
      if (!(VARIABLE_NAMES as readonly string[]).includes(match[1]!)) continue;
      const name = match[1] as VariableName;
      const literal = match[2]!.trim();
      let value: string;
      if (name === "lotNumber" || name === "auctionType" || name === "liveAuctionStartDateTime") {
        const string = /^(['"])([A-Za-z0-9 :+._/-]*)\1$/.exec(literal);
        if (!string && literal !== "null")
          throw new SourceError(`Bid.Cars ${name} is not a supported literal`);
        value = string?.[2] ?? "";
      } else {
        amount(literal);
        value = literal;
      }
      if (values[name] !== undefined && values[name] !== value)
        throw new SourceError(`Conflicting Bid.Cars ${name}`);
      values[name] = value;
    }
  });
  if (VARIABLE_NAMES.some((name) => values[name] === undefined))
    throw new SourceError("Bid.Cars auction declaration schema changed");
  return values as Record<VariableName, string>;
}

function vehicle($: CheerioAPI): Record<string, unknown> {
  const vehicles: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    let data: unknown;
    try {
      data = JSON.parse($(element).text());
    } catch {
      throw new SourceError("Malformed Bid.Cars structured identity");
    }
    if (
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "@type" in data &&
      data["@type"] === "Vehicle"
    ) {
      vehicles.push(data as Record<string, unknown>);
    }
  });
  if (vehicles.length !== 1)
    throw new SourceError("Bid.Cars expected one structured vehicle identity");
  return vehicles[0]!;
}

function deadline($: CheerioAPI, value: string): number | null {
  const footers = $(".links-footer");
  if (footers.length !== 1) return null;
  const zones = footers
    .find("button")
    .toArray()
    .map((node) => nodeText($(node)))
    .filter((text) => text.includes("(UTC"));
  if (zones.length !== 1 || zones[0] !== "(UTC+00:00) UTC") return null;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const iso = `${value.replace(" ", "T")}Z`;
  const time = Date.parse(iso);
  // Reject impossible dates that Date.parse silently normalizes, such as February 30.
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== iso.replace("Z", ".000Z") ||
    value.startsWith("0000")
  )
    return null;
  return time / 1000;
}

function mileage(value: string): string {
  value = optional(value);
  if (!value) return "";
  const exact = /^([0-9]+(?:[ ,][0-9]{3})*)\s*(mi|miles|km)(?:\s*\([0-9 ,]+\s*km\))?$/i.exec(value);
  if (exact) {
    const number = BigInt(exact[1]!.replace(/[ ,]/g, ""));
    return `${number} ${exact[2]!.toLowerCase() === "km" ? "km" : "miles"}`;
  }
  if (/^[0-9]+(?:\.[0-9]+)?[kK]\s*(?:mi|miles|km)$/.test(value)) return "";
  throw new SourceError("Bid.Cars odometer schema changed");
}

function location($: CheerioAPI, lot: string, vin: string): string | null {
  const description = one($('meta[name="description"]'), "location evidence").attr("content") ?? "";
  if (
    !new RegExp(`\\bLot:\\s*${lot}(?:[,\\s]|$)`).test(description) ||
    !new RegExp(`\\bVIN:\\s*${vin}(?:[,\\s]|$)`).test(description)
  ) {
    throw new SourceError("Bid.Cars location identity mismatch");
  }
  const match = /Location:\s*([^|]+),\s*(USA|Canada)\s*\|/.exec(description);
  if (!match) throw new SourceError("Bid.Cars yard country is not evidenced");
  const yard = match[1]!.trim();
  const locations = $("li.location");
  if (
    !locations.length ||
    locations.toArray().some(
      (node) =>
        nodeText($(node))
          .replace(/^Location:/, "")
          .trim() !== yard,
    )
  ) {
    throw new SourceError("Conflicting Bid.Cars yard location");
  }
  if (match[2] === "Canada") return null;
  const state = /\(([A-Z]{2})\)$/.exec(yard);
  if (!state || US_STATES[state[1]!] !== true)
    throw new SourceError("Bid.Cars USA label contradicts yard state");
  return yard;
}

/** Parse one identified public lot. Canadian inventory is excluded only with explicit yard evidence. */
export function parseDetail(text: string, url: string): Listing | null {
  const lot = publicUrl(url, LOT_PATH)[1]!;
  const $ = document(text);
  const identity = vehicle($);
  if (identity.url !== url) throw new SourceError("Bid.Cars returned a different vehicle URL");
  const declarations = variables($);
  // Never let inline code/styles masquerade as displayed labels, status, or price evidence.
  $("script,style").remove();
  const main = options($, one($('[id="main-info"]'), "main-info"));
  const secondary = options($, one($('[id="secondary-info"]'), "secondary-info"));
  const tertiary = options($, one($('[id="tertiary-info"]'), "tertiary-info"));
  if (
    ["lot", "vin", "sale document"].some((key) => main[key] === undefined) ||
    ["odometer", "primary damage", "secondary damage", "start code"].some(
      (key) => secondary[key] === undefined,
    )
  ) {
    throw new SourceError("Bid.Cars detail attribute schema changed");
  }
  const vin = optional(identity.vehicleIdentificationNumber);
  if (!/^[A-Z0-9]{5,25}$/.test(vin) || main.vin !== vin || main.lot!.replaceAll(" ", "") !== lot) {
    throw new SourceError("Conflicting Bid.Cars lot or vehicle identity");
  }
  if (
    declarations.lotNumber !== lot ||
    declarations.auctionType !== (lot[0] === "0" ? "IAAI" : "Copart")
  ) {
    throw new SourceError("Conflicting Bid.Cars auction identity");
  }
  if (!["0", "1"].includes(declarations.isArchived))
    throw new SourceError("Bid.Cars archive declaration schema changed");
  const archived = declarations.isArchived === "1";
  const city = location($, lot, vin);
  const bidding = one($('[id="bidding-info"]'), "bidding-info");
  const prices = one(bidding.find(".lot-price-info"), "lot-price-info");
  const bidNode = one(prices.find(".current_bid"), "current_bid");
  const label = nodeText(
    one(
      prices
        .find(".field-name")
        .filter((_index, node) =>
          ["current bid", "final bid"].includes(nodeText($(node)).toLowerCase()),
        ),
      "labeled auction bid",
    ),
  ).toLowerCase();
  const current = label === "current bid" ? amount(declarations.currentBid) : null;
  const final = label === "final bid" ? amount(declarations.finalBid) : null;
  if (amount(nodeText(bidNode), true) !== (label === "current bid" ? current : final)) {
    throw new SourceError("Bid.Cars labeled bid conflicts with auction declaration");
  }
  const statuses = bidding
    .find(".bid-status")
    .toArray()
    .map((node) => nodeText($(node)));
  let status: "unknown" | "ended" | "active" = "unknown";
  if (archived) {
    const notice = nodeText(one($('[id="archieved-message"]'), "archieved-message"));
    if (
      label !== "final bid" ||
      statuses.length ||
      !notice.startsWith("You are watching archived offer.")
    ) {
      throw new SourceError("Bid.Cars archived result evidence conflicts");
    }
    status = "ended";
  } else {
    if (statuses.length !== 1) throw new SourceError("Bid.Cars auction status schema changed");
    if (statuses[0]!.toLowerCase() === "final auction ended") status = "ended";
    else if (label === "current bid" && /^(?:[0-9]+\s*(?:d|h|min|sec)\s*)+$/.test(statuses[0]!))
      status = "active";
  }
  const buy = amount(declarations.buyNowAmount) || null;
  const buyBlocks = bidding.find(".buy-now-wr");
  let buyActive = false;
  if (buyBlocks.length) {
    const buyBlock = one(buyBlocks, "buy now block");
    if (
      nodeText(one(buyBlock.find(".field-name"), "field-name"))
        .toLowerCase()
        .replace(/:+$/, "") !== "fast buy price" ||
      (amount(nodeText(one(buyBlock.find(".price"), "price")), true) || null) !== buy
    ) {
      throw new SourceError("Bid.Cars labeled Buy Now price conflicts with declaration");
    }
    buyActive = buyBlock
      .find("a,button")
      .toArray()
      .some((element) => {
        const node = $(element);
        return (
          nodeText(node) === "Buy Now" &&
          node.attr("disabled") === undefined &&
          !node.hasClass("disabled")
        );
      });
  }
  const estimateMin = amount(declarations.estimatedAmount1) || null;
  const estimateMax = amount(declarations.estimatedAmount2) || null;
  const estimates = $("li.est_price");
  if (!estimates.length && (!archived || estimateMin !== null || estimateMax !== null)) {
    throw new SourceError("Bid.Cars labeled estimate schema changed");
  }
  estimates.each((_index, element) => {
    const amounts = $(element)
      .find("b")
      .toArray()
      .map((node) => amount(nodeText($(node)), true) || null);
    if (amounts.length !== 2 || amounts[0] !== estimateMin || amounts[1] !== estimateMax) {
      throw new SourceError("Bid.Cars labeled estimate conflicts with declaration");
    }
  });
  if (estimateMin !== null && estimateMax !== null && estimateMin > estimateMax)
    throw new SourceError("Bid.Cars estimate interval is reversed");
  const year = identity.vehicleModelDate;
  if (typeof year !== "string" || !/^[12][0-9]{3}$/.test(year))
    throw new SourceError("Bid.Cars vehicle year schema changed");
  const name = optional(identity.name);
  const suffix = ` | ${vin} | ${archived ? "Bid History | " : ""}BidCars`;
  if (!name.endsWith(suffix) || !name.startsWith(`${year} `))
    throw new SourceError("Bid.Cars vehicle title identity mismatch");
  const title = name.slice(0, -suffix.length);
  const photos: string[] = [];
  for (const photo of Array.isArray(identity.image) ? identity.image : [identity.image]) {
    if (
      typeof photo === "string" &&
      !/[\s\\\p{Cc}]/u.test(photo) &&
      /^https:\/\/(?:images\.bid\.cars|mercury\.bid\.cars|pluto\.bid\.car)\/[^?#\s]+$/.test(photo)
    ) {
      if (!photos.includes(photo)) photos.push(photo);
      if (photos.length === 10) break;
    }
  }
  const saleDocument = optional(main["sale document"]);
  const primary = optional(secondary["primary damage"]);
  const secondaryDamage = optional(secondary["secondary damage"]);
  const start = optional(secondary["start code"]);
  const condition = [
    ["Документ", saleDocument],
    ["Основное повреждение", primary],
    ["Вторичное повреждение", secondaryDamage],
    ["Код запуска", start],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("; ");
  const price = status === "active" && buyActive ? buy : null;
  const listing = makeListing({
    id: `bidcars:${lot}`,
    title,
    url,
    price_usd_minor: price,
    price_kgs_minor: null,
    year: Number(year),
    mileage: mileage(secondary.odometer!),
    transmission: optional(identity.vehicleTransmission),
    city: city ?? "",
    availability: { active: "Опубликовано", ended: "Завершено", unknown: "Неизвестно" }[status],
    photo_url: photos[0] ?? null,
    photo_urls: photos,
    source: "bid.cars",
    market: "US",
    original_currency: "USD",
    original_price_minor: price,
    trim: title.includes(", ") ? title.slice(title.indexOf(", ") + 2) : "",
    body_type: optional(tertiary["body style"]),
    condition: condition ? `По данным аукциона: ${condition}` : "",
    price_kind: price !== null ? "buy_now" : "auction",
    vin,
    auction_house: declarations.auctionType,
    auction_lot: lot,
    auction_status: status,
    auction_at: deadline($, declarations.liveAuctionStartDateTime),
    current_bid_minor: current,
    final_bid_minor: final,
    buy_now_minor: buy,
    estimated_min_minor: estimateMin,
    estimated_max_minor: estimateMax,
    sale_document: saleDocument,
    primary_damage: primary,
    secondary_damage: secondaryDamage,
    start_code: start,
  });
  return city === null ? null : listing;
}

/** Discover catalog rows only; gallery, history, and recommendation links never become inventory. */
export function parseCatalog(
  text: string,
  page = 1,
  options: { catalogUrl?: string } = {},
): CatalogPage {
  if (!Number.isInteger(page) || page < 1 || page > 9_999_999)
    throw new SourceError("Bid.Cars catalog page must be a positive bounded integer");
  const base = options.catalogUrl ?? CATALOG_URL;
  if (publicUrl(base, CATALOG_PATH)[1] !== "1")
    throw new SourceError("Bid.Cars catalog scope must start at page/1");
  const prefix = base.slice(0, base.lastIndexOf("/") + 1);
  const requested = prefix + page;
  const $ = document(text);
  const identities = $('link[rel="canonical"],meta[property="og:url"]')
    .toArray()
    .map((node) => $(node).attr(node.tagName === "link" ? "href" : "content"));
  if (!identities.length || identities.some((identity) => identity !== requested))
    throw new SourceError("Bid.Cars returned a different catalog scope or page");
  const area = one($('[id="search_area"]'), "search_area");
  const rows = area.find("div.item-horizontal.lots-search");
  if (
    area
      .find("*")
      .toArray()
      .some((node) => $(node).hasClass("item-horizontal") !== $(node).hasClass("lots-search"))
  ) {
    throw new SourceError("Bid.Cars catalog row schema changed");
  }
  if (
    !rows.length &&
    area
      .contents()
      .toArray()
      .some(
        (node) =>
          (node.type !== "text" && node.type !== "comment") ||
          (node.type === "text" && node.data.trim() !== ""),
      )
  ) {
    throw new SourceError("Unrecognized Bid.Cars catalog content");
  }
  if (rows.length > MAX_LOTS)
    throw new SourceError("Bid.Cars catalog exceeds bounded detail count");
  $("script,style").remove();
  const lots = new Map<string, CatalogLot>();
  rows.each((_index, element) => {
    const row = $(element);
    const name = one(row.find(".name"), "name");
    const anchor = one(name.find("a.item-title"), "catalog title link");
    const url = anchor.attr("href") ?? "";
    const lot = publicUrl(url, LOT_PATH)[1]!;
    if (row.attr("id") !== lot)
      throw new SourceError("Bid.Cars catalog row and link identity conflict");
    const vinNode = one(row.find("h2.vin_title"), "catalog VIN");
    const vin = nodeText(vinNode);
    const vinLinks = vinNode
      .find("a")
      .toArray()
      .map((node) => $(node).attr("href"));
    const lotLabels = row
      .find("span.vin_title")
      .toArray()
      .map((node) => nodeText($(node)));
    if (
      !/^[A-Z0-9]{5,25}$/.test(vin) ||
      vinLinks.length !== 1 ||
      vinLinks[0] !== url ||
      lotLabels.length !== 1 ||
      lotLabels[0] !== lot
    ) {
      throw new SourceError("Bid.Cars catalog identity labels conflict");
    }
    const title = nodeText(anchor);
    if (!/^[12][0-9]{3}\s+\S/.test(title))
      throw new SourceError("Bid.Cars catalog title schema changed");
    const found = { lot, url, title, vin };
    const previous = lots.get(lot);
    if (previous && (previous.url !== url || previous.title !== title || previous.vin !== vin)) {
      throw new SourceError("Bid.Cars duplicate lot has conflicting identity");
    }
    lots.set(lot, found);
  });
  const breadcrumbs = one($(".breadcrumbs"), "breadcrumbs");
  const active = one(breadcrumbs.find("li.active"), "current catalog page");
  const activeAnchor = one(active.find("a"), "current page link");
  if (
    nodeText(activeAnchor) !== String(page) ||
    !["#", requested].includes(activeAnchor.attr("href") ?? "")
  ) {
    throw new SourceError("Bid.Cars returned a different pagination position");
  }
  let pages = page;
  breadcrumbs.find("a").each((_index, element) => {
    if (element === activeAnchor[0]) return;
    const anchor = $(element);
    const target = anchor.attr("href") ?? "";
    const label = nodeText(anchor);
    if (target === "#" && ["...", "…"].includes(label)) return;
    const number = Number(publicUrl(target, CATALOG_PATH)[1]);
    if (target !== prefix + number)
      throw new SourceError("Bid.Cars pagination escapes requested scope");
    if (/^[0-9]+$/.test(label) && Number(label) !== number)
      throw new SourceError("Bid.Cars pagination link and label conflict");
    pages = Math.max(pages, number);
  });
  if (!lots.size && page < pages)
    throw new SourceError("Unexpected empty Bid.Cars interior catalog page");
  const found = [...lots.values()];
  return { lots: found, urls: found.map((lot) => lot.url), page, pages, total: null };
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess("bid.cars");
  const base = catalogUrl();
  if (!Number.isInteger(page) || page < 1 || page > 9_999_999)
    throw new SourceError("Bid.Cars catalog page must be a positive bounded integer");
  const url = base.slice(0, base.lastIndexOf("/") + 1) + page;
  const catalog = await transport.fetchDocument(
    url,
    (text) => parseCatalog(text, page, { catalogUrl: base }),
    {
      source: "bid.cars",
      page,
      headers: { Accept: "text/html" },
    },
  );
  const details = await transport.fetchDocuments(
    catalog.lots.map((lot) => ({
      url: lot.url,
      parse: (text: string): Listing | null => {
        const listing = parseDetail(text, lot.url);
        if (
          listing !== null &&
          (listing.vin !== lot.vin ||
            listing.title !== lot.title ||
            listing.auction_lot !== lot.lot ||
            listing.url !== lot.url)
        ) {
          throw new SourceError("Bid.Cars catalog and detail identity conflict");
        }
        return listing;
      },
      options: { source: "bid.cars", headers: { Accept: "text/html" } },
    })),
  );
  return makeSourcePage({
    listings: details.filter((listing): listing is Listing => listing !== null),
    page,
    pages: catalog.pages,
    total: null,
    scope: `США: аукционы Copart/IAAI; каталог ${base}; экспорт не подтверждён`,
  });
}
