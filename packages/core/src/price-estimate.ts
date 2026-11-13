import { normalizeBodyType, normalizeMileageKm, normalizeTransmission } from "./matching.js";
import { type Listing, listingIsAuction, listingPrice } from "./models.js";
import { normalize } from "./normalization.js";
import { normalizeVin } from "./vin.js";

export interface PriceEstimate {
  currency: "USD" | "KGS";
  medianMinor: number;
  lowMinor: number;
  highMinor: number;
  sampleSize: number;
  observedAt: number;
}

/** An asking-price reference, not a valuation of condition or a transaction price. */
export function estimateListingPrice(
  target: Listing,
  candidates: readonly Listing[],
  currency: "USD" | "KGS",
  now = Date.now() / 1000,
): PriceEstimate | null {
  const make = normalize(target.catalog_attributes.make ?? "");
  const model = normalize(target.catalog_attributes.model ?? "");
  if (!make || !model || target.year === null || target.market !== "KG") return null;
  const mileage = normalizeMileageKm(target.mileage);
  const body = normalizeBodyType(target.body_type);
  const transmission = normalizeTransmission(target.transmission);
  const targetVin = normalizeVin(target.vin);
  const vins = new Set<string>();
  const prices: number[] = [];
  for (const item of candidates) {
    if (
      item.id === target.id ||
      item.market !== target.market ||
      item.observed_at === null ||
      item.observed_at < now - 48 * 3600 ||
      item.observed_at > now ||
      !["в наличии", "опубликовано"].includes(normalize(item.availability)) ||
      listingIsAuction(item) ||
      item.price_kind !== "asking" ||
      normalize(item.catalog_attributes.make ?? "") !== make ||
      normalize(item.catalog_attributes.model ?? "") !== model ||
      item.year === null ||
      Math.abs(item.year - target.year) > 1 ||
      (body && normalizeBodyType(item.body_type) !== body) ||
      (transmission && normalizeTransmission(item.transmission) !== transmission)
    )
      continue;
    if (mileage !== null) {
      const otherMileage = normalizeMileageKm(item.mileage);
      if (
        otherMileage === null ||
        Math.abs(otherMileage - mileage) > Math.max(10_000, mileage * 0.25)
      )
        continue;
    }
    const vin = normalizeVin(item.vin);
    if (vin && (vin === targetVin || vins.has(vin))) continue;
    const price = listingPrice(item, currency, now);
    if (price === null || price <= 0) continue;
    if (vin) vins.add(vin);
    prices.push(price);
  }
  if (prices.length < 5) return null;
  prices.sort((left, right) => left - right);
  const at = (fraction: number) => prices[Math.floor((prices.length - 1) * fraction)]!;
  const middle = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 ? prices[middle]! : Math.round(prices[middle - 1]! / 2 + prices[middle]! / 2);
  return {
    currency,
    medianMinor: median,
    lowMinor: at(0.25),
    highMinor: at(0.75),
    sampleSize: prices.length,
    observedAt: now,
  };
}
