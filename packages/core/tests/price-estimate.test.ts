import { describe, expect, it } from "vitest";
import { estimateListingPrice, makeListing } from "../src/index.js";

const now = 1_780_000_000;
const car = (id: string, price: number) =>
  makeListing({
    id,
    title: "Toyota Camry",
    url: `https://www.mashina.kg/details/${id}`,
    catalog_attributes: { make: "Toyota", model: "Camry" },
    year: 2018,
    mileage: "100000 км",
    availability: "В наличии",
    price_usd_minor: price,
    observed_at: now - 3600,
  });

describe("market price reference", () => {
  it("uses only comparable recent asking prices and requires at least five", () => {
    const target = car("target", 1_200_000);
    const comparables = [100, 110, 120, 130, 140].map((price, index) =>
      car(String(index), price * 10000),
    );
    expect(estimateListingPrice(target, comparables.slice(0, 4), "USD", now)).toBeNull();
    expect(estimateListingPrice(target, comparables, "USD", now)).toMatchObject({
      medianMinor: 1_200_000,
      lowMinor: 1_100_000,
      highMinor: 1_300_000,
      sampleSize: 5,
    });
    expect(
      estimateListingPrice(
        target,
        [...comparables.slice(0, 4), { ...comparables[4]!, observed_at: now - 200_000 }],
        "USD",
        now,
      ),
    ).toBeNull();
  });
  it("does not count duplicate VINs, expired conversion or unrelated cars", () => {
    const target = car("target", 1_200_000);
    const comparables = Array.from({ length: 5 }, (_, index) => car(String(index), 1_200_000));
    comparables[0]!.vin = "KMHDU41DBAU123456";
    comparables[1]!.vin = "KMHDU41DBAU123456";
    expect(estimateListingPrice(target, comparables, "USD", now)).toBeNull();
    comparables[1]!.vin = "";
    comparables[2]!.catalog_attributes.model = "Corolla";
    expect(estimateListingPrice(target, comparables, "USD", now)).toBeNull();
    comparables[2]!.catalog_attributes.model = "Camry";
    comparables[3]!.original_currency = "KGS";
    comparables[3]!.fx_date = "2020-01-01";
    comparables[3]!.fx_expires_at = now - 1;
    expect(estimateListingPrice(target, comparables, "USD", now)).toBeNull();
  });
});
