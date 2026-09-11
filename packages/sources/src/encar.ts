import {
  type FetchPageOptions,
  type Listing,
  makeListing,
  makeSourcePage,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { Decimal } from "decimal.js";

export const CATALOG_URL = "https://api.encar.com/search/car/list/general";
export const PAGE_SIZE = 20;
export const SCOPE = "Корея: корейские марки; возможность экспорта не подтверждена";
const MAKES: Readonly<Record<string, string>> = {
  현대: "Hyundai",
  기아: "Kia",
  제네시스: "Genesis",
  "KG모빌리티(쌍용)": "KG Mobility KGM SsangYong",
  "쉐보레(GM대우)": "Chevrolet GM Daewoo",
  "르노코리아(삼성)": "Renault Korea Renault Samsung",
};
const MODELS: Readonly<Record<string, string>> = {
  "그랜저 IG": "Grandeur IG",
  "아반떼 AD": "Avante AD Elantra AD",
  "LF 쏘나타": "Sonata LF",
  "싼타페 DM": "Santa Fe DM",
  "싼타페 CM": "Santa Fe CM",
  "뉴 쏘렌토 R": "New Sorento R",
  "더 뉴 카니발": "The New Carnival",
  "올 뉴 카니발": "All New Carnival",
  "더 뉴 모하비": "The New Mohave",
  "더 뉴 레이": "The New Ray",
  스파크: "Spark",
  "그랑 콜레오스": "Grand Koleos",
  "더 뉴 렉스턴 스포츠": "The New Rexton Sports",
  "그랜드 스타렉스": "Grand Starex",
  "K5 2세대": "K5 second generation",
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

function integer(value: unknown, scale = 1): number | null {
  if (
    !(value instanceof Decimal) &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  )
    return null;
  const text = String(value).trim().replaceAll("_", "");
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return null;
  try {
    const number = value instanceof Decimal ? value : new Decimal(text);
    if (!number.isFinite() || number.lt(0)) return null;
    // Check fractional won before multiplying: Decimal arithmetic precision must
    // not round a long fractional token into an apparently integral price.
    if (number.decimalPlaces() > (scale === 10000 ? 4 : 0)) return null;
    const scaled = number.times(scale);
    return scaled.isInteger() && scaled.lte(Number.MAX_SAFE_INTEGER) ? scaled.toNumber() : null;
  } catch {
    return null;
  }
}

function textField(item: ObjectValue, key: string): string {
  const value = item[key];
  if (value == null) return "";
  if (typeof value !== "string") throw new SourceError(`Encar ${key} schema changed`);
  return value.trim();
}

function photoUrls(item: ObjectValue): string[] {
  const photos: string[] = [];
  if (!Array.isArray(item.Photos)) return photos;
  for (const photo of item.Photos) {
    const path = isObject(photo) ? photo.location : null;
    if (
      typeof path === "string" &&
      /^\/carpicture[\p{L}\p{N}_/.-]+\.(?:jpg|jpeg|png)$/u.test(path) &&
      !path.includes("..")
    ) {
      const url = `https://ci.encar.com/carpicture${path}`;
      if (!photos.includes(url)) photos.push(url);
      if (photos.length === 10) break;
    }
  }
  return photos;
}

function parseListing(item: unknown): Listing {
  if (!isObject(item)) throw new SourceError("Encar listing schema changed");
  const id = item.Id;
  if (typeof id !== "string" || !/^[0-9]+$/.test(id))
    throw new SourceError("Encar advertisement identity missing");
  const make = textField(item, "Manufacturer");
  const model = textField(item, "Model");
  if (!make || !model) throw new SourceError("Encar vehicle title missing");
  const badge = textField(item, "Badge");
  const rawDetail = textField(item, "BadgeDetail");
  const detail = rawDetail === "(세부등급 없음)" ? "" : rawDetail;
  const trim = [badge, detail].filter(Boolean).join(" ");
  const modelYear = integer(item.FormYear);
  const year = modelYear !== null && modelYear >= 1800 && modelYear <= 2200 ? modelYear : null;
  const month = integer(item.Year);
  const registration =
    month !== null &&
    Math.floor(month / 100) >= 1800 &&
    Math.floor(month / 100) <= 2200 &&
    month % 100 >= 1 &&
    month % 100 <= 12
      ? String(month)
      : "";
  const mileage = integer(item.Mileage);
  const asking = textField(item, "SellType") === "일반";
  const amount = asking ? integer(item.Price, 10000) : null;
  const aliases = [
    Object.hasOwn(MAKES, make) ? MAKES[make] : "",
    Object.hasOwn(MODELS, model) ? MODELS[model] : "",
  ];
  if (make === "KG모빌리티(쌍용)" && model === "더 뉴 렉스턴 스포츠" && detail === "와일드")
    aliases.push("Wild");
  const photos = photoUrls(item);
  return makeListing({
    id: `encar:${id}`,
    title: [make, model, trim].filter(Boolean).join(" "),
    url: `https://fem.encar.com/cars/detail/${id}`,
    price_usd_minor: null,
    price_kgs_minor: null,
    year,
    registration_month: registration,
    mileage: mileage === null ? "" : `${mileage} km`,
    city: textField(item, "OfficeCityState"),
    availability: "Опубликовано",
    photo_url: photos[0] ?? null,
    photo_urls: photos,
    source: "encar.com",
    market: "KR",
    original_currency: "KRW",
    original_price_minor: amount === 0 ? null : amount,
    trim,
    price_kind: asking ? "asking" : "unknown",
    search_aliases: aliases.filter(Boolean).join(" "),
    // Inspection/report presence is not evidence of accident outcomes.
    condition: "",
  });
}

export function parsePage(text: string, page = 1): SourcePage {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new SourceError("Catalog page must be a positive integer");
  let data: unknown;
  try {
    // Preserve the legacy decoder's numeric NaN/Infinity tokens without
    // interpreting quoted seller text as numbers.
    let marker = "_autodom_nonfinite_";
    while (text.includes(marker)) marker += "_";
    const normalized = text.replace(
      /"(?:\\[\s\S]|[^"\\])*"|-Infinity\b|\b(?:NaN|Infinity)\b/g,
      (token) => (token.startsWith('"') ? token : JSON.stringify(marker + token)),
    );
    data = JSON.parse(
      normalized,
      (_key: string, value: unknown, context?: { source?: string }): unknown => {
        if (
          typeof value === "string" &&
          value.startsWith(marker) &&
          context?.source === JSON.stringify(value)
        ) {
          return new Decimal(value.slice(marker.length));
        }
        if (typeof value !== "number" || !context?.source) return value;
        if (/[.eE]/.test(context.source)) return new Decimal(context.source);
        return Number.isSafeInteger(value) ? value : BigInt(context.source);
      },
    );
  } catch (cause) {
    throw new SourceError("Malformed Encar catalog response", { cause });
  }
  if (!isObject(data) || !Number.isSafeInteger(data.Count))
    throw new SourceError("Encar count schema changed");
  const total = data.Count as number;
  const items = data.SearchResults;
  if (total < 0 || !Array.isArray(items) || items.length > PAGE_SIZE)
    throw new SourceError("Encar catalog pagination schema changed");
  const pages = Math.ceil(total / PAGE_SIZE);
  if (items.length === 0 && total > 0 && page < pages)
    throw new SourceError("Unexpected empty Encar catalog interior page");
  if (items.length > total || (items.length > 0 && page > pages))
    throw new SourceError("Encar catalog item count contradicts pagination");
  // Preserve insertion order, but retain the last version of a duplicate ad.
  // Service copies with distinct advertisement IDs remain distinct listings.
  const listings = new Map<string, Listing>();
  for (const item of items) {
    const listing = parseListing(item);
    listings.set(listing.id, listing);
  }
  return makeSourcePage({ listings: [...listings.values()], page, total, pages, scope: SCOPE });
}

export async function fetchPage({ page = 1, transport }: FetchPageOptions): Promise<SourcePage> {
  requireSourceAccess("encar.com");
  if (!Number.isSafeInteger(page) || page < 1)
    throw new SourceError("Catalog page must be a positive integer");
  const offset = (page - 1) * PAGE_SIZE;
  if (!Number.isSafeInteger(offset))
    throw new SourceError("Catalog page offset exceeds exact integer range");
  return transport.fetchDocument(CATALOG_URL, (text) => parsePage(text, page), {
    source: "encar.com",
    page,
    params: {
      count: "true",
      q: "(And.Hidden.N._.CarType.Y.)",
      sr: `|ModifiedDate|${offset}|${PAGE_SIZE}`,
    },
  });
}
