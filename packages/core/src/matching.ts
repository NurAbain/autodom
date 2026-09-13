import { Decimal } from "decimal.js";
import { approvedSources } from "./config.js";
import { type Listing, listingPrice, MARKETS, type Profile } from "./models.js";

const ALIASES: Readonly<Record<string, string>> = {
  тойота: "toyota",
  камри: "camry",
  хонда: "honda",
  хендай: "hyundai",
  хундай: "hyundai",
  хёндай: "hyundai",
  киа: "kia",
  бмв: "bmw",
  мерседес: "mercedes",
  лексус: "lexus",
};
const BODY_LABELS: Readonly<Record<string, readonly string[]>> = {
  sedan: ["sedan", "седан", "세단"],
  suv: ["suv", "sport utility", "crossover", "внедорожник", "кроссовер", "внедорожник кроссовер"],
  hatchback: ["hatchback", "хэтчбек", "хетчбэк", "хэтчбэк", "해치백"],
  wagon: ["wagon", "station wagon", "универсал", "왜건"],
  minivan: ["minivan", "минивэн", "минивен", "미니밴"],
  pickup: ["pickup", "pickup truck", "пикап", "픽업"],
  coupe: ["coupe", "купе", "쿠페"],
  convertible: ["convertible", "cabriolet", "кабриолет", "컨버터블"],
  van: ["van", "cargo van", "фургон"],
};
const TRANSMISSION_LABELS: Readonly<Record<string, readonly string[]>> = {
  manual: ["manual", "механика", "механическая", "мкпп", "수동"],
  automatic: ["automatic", "автомат", "автоматическая", "акпп", "오토", "자동"],
  cvt: ["cvt", "вариатор", "무단변속기"],
  robot: ["robot", "automated manual", "dct", "dsg", "робот", "роботизированная"],
};
const MILEAGE =
  /^([0-9]+(?:\.[0-9]+)?|[0-9]{1,3}(?:[ ,\u00a0\u202f][0-9]{3})+)\s*(km|км|kilometers?|kilometres?|mi|miles?|миль|мили|миля)$/iu;
const ExactDecimal = Decimal.clone({ precision: 50 });

export function normalizeCity(text: string): string {
  // Case-fold expansions relevant to place/vehicle words, unlike locale-sensitive casing.
  const folded = text.toLowerCase().replace(/ё/gu, "е").replace(/ß/gu, "ss").replace(/ς/gu, "σ");
  return (folded.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}
export function normalizeBodyType(text: string): string {
  const value = normalizeCity(text);
  return Object.entries(BODY_LABELS).find(([, labels]) => labels.includes(value))?.[0] ?? "";
}
export function normalizeTransmission(text: string): string {
  const value = normalizeCity(text).replace(/^[0-9]+ speed /u, "");
  return (
    Object.entries(TRANSMISSION_LABELS).find(([, labels]) => labels.includes(value))?.[0] ?? ""
  );
}
export function normalizeMileageKm(text: string): number | null {
  const found = MILEAGE.exec(text.trim());
  if (!found || found[1]!.length > 24) return null;
  const number = new ExactDecimal(found[1]!.replace(/[ ,\u00a0\u202f]/gu, ""));
  const kilometers = /^(?:km|км|kilometers?|kilometres?)$/iu.test(found[2]!);
  const result = (kilometers ? number : number.mul("1.609344")).ceil();
  return result.lte(Number.MAX_SAFE_INTEGER) ? result.toNumber() : null;
}
export function normalize(text: string): string {
  return normalizeCity(text)
    .split(" ")
    .map((word) => ALIASES[word] ?? word)
    .join(" ");
}
export function queryGroups(query: string): string[][] {
  return query
    .split(",")
    .map((part) => normalize(part).split(" ").filter(Boolean))
    .filter((group) => group.length > 0);
}
export function searchableText(listing: Listing): string {
  return ` ${normalize(
    [
      listing.title,
      listing.body_type,
      listing.transmission,
      listing.city,
      listing.mileage,
      listing.trim,
      listing.search_aliases,
      listing.year === null ? "" : String(listing.year),
    ].join(" "),
  )} `;
}
export function matches(profile: Profile, listing: Listing, now = Date.now() / 1000): boolean {
  if (
    !["USD", "KGS"].includes(profile.currency) ||
    !Object.hasOwn(MARKETS, profile.market) ||
    !approvedSources().includes(listing.source) ||
    (profile.market !== "ALL" && listing.market !== profile.market) ||
    (listing.market !== "KG" &&
      (profile.allow_import === false || profile.budget_scope === "total")) ||
    (profile.city && normalizeCity(listing.city) !== normalizeCity(profile.city)) ||
    (profile.body_type && normalizeBodyType(listing.body_type) !== profile.body_type) ||
    (profile.transmission &&
      normalizeTransmission(listing.transmission) !== profile.transmission) ||
    (profile.year_min !== null &&
      (listing.year === null || !Number.isInteger(listing.year) || listing.year < profile.year_min))
  )
    return false;
  if (profile.mileage_max_km !== null) {
    const mileage = normalizeMileageKm(listing.mileage);
    if (mileage === null || mileage > profile.mileage_max_km) return false;
  }
  const price = listingPrice(listing, profile.currency, now);
  const availability = normalize(listing.availability);
  if (
    price === null ||
    price <= 0 ||
    price < profile.budget_min_minor ||
    price > profile.budget_max_minor ||
    (availability !== "в наличии" && availability !== "опубликовано")
  )
    return false;
  const groups = queryGroups(profile.query);
  if (groups.length === 0) return profile.query.trim().length === 0;
  const text = searchableText(listing);
  return groups.some((group) => group.every((word) => text.includes(` ${word} `)));
}
