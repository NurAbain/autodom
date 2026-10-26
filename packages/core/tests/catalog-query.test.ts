import { describe, expect, it } from "vitest";
import {
  CATALOG_SORTS,
  catalogQueryIsPlain,
  catalogQueryParams,
  catalogQueryText,
  catalogQueryToProfile,
  parseCatalogQuery,
} from "../src/catalog-query.js";

describe("catalogue query parsing", () => {
  it("keeps recognised conditions and ignores unknown parameters", () => {
    const query = parseCatalogQuery(
      "?q=Toyota&make=Toyota&model=Camry&budget_min=5000&budget_max=15000&year_min=2019&year_max=2023&mileage_max_km=90000&body_type=suv&transmission=automatic&city=Bishkek&market=ALL&currency=USD&sort=price_asc&page=3&utm_source=ads",
    );
    expect(query).toEqual({
      q: "Toyota",
      market: "KG",
      currency: "USD",
      budget_min_minor: 500_000,
      budget_max_minor: 1_500_000,
      year_min: 2019,
      year_max: 2023,
      mileage_max_km: 90_000,
      body_type: "suv",
      transmission: "automatic",
      city: "Bishkek",
      make: "Toyota",
      model: "Camry",
      sort: "price_asc",
      page: 3,
    });
  });

  it("falls back to safe defaults for unusable values", () => {
    const query = parseCatalogQuery(
      "?currency=eur&sort=cheapest&page=0&year_min=1700&mileage_max_km=-5&budget_min=abc&market=&make=%20",
    );
    expect(query.currency).toBe("KGS");
    expect(query.sort).toBe("new");
    expect(query.page).toBe(1);
    expect(query.year_min).toBeNull();
    expect(query.mileage_max_km).toBeNull();
    expect(query.budget_min_minor).toBeNull();
    expect(query.market).toBe("KG");
    expect(query.make).toBe("");
  });

  it("drops a year maximum below the year minimum", () => {
    expect(parseCatalogQuery("?year_min=2022&year_max=2018").year_max).toBeNull();
  });

  it("keeps monetary precision in minor units", () => {
    expect(parseCatalogQuery("?budget_max=15000.55").budget_max_minor).toBe(1_500_055);
    expect(parseCatalogQuery("?budget_max=15000.555").budget_max_minor).toBeNull();
  });

  it("rejects control characters in free text", () => {
    expect(parseCatalogQuery("?q=Toyota%0ABeijing").q).toBe("");
  });

  it("caps the page number", () => {
    expect(parseCatalogQuery("?page=99999").page).toBe(500);
  });
});

describe("catalogue query round trip", () => {
  it("omits defaults from the canonical URL", () => {
    const query = parseCatalogQuery("");
    expect(catalogQueryParams(query).toString()).toBe("");
    expect(catalogQueryIsPlain(query)).toBe(true);
  });

  it("restores every non-default condition from its own URL", () => {
    const source = parseCatalogQuery(
      "?q=BMW&make=BMW&model=X5&budget_min=3000&budget_max=9000&year_min=2020&year_max=2024&mileage_max_km=120000&body_type=suv&transmission=automatic&city=Osh&currency=USD&sort=price_desc&page=4",
    );
    const restored = parseCatalogQuery(catalogQueryParams(source));
    expect(restored).toEqual(source);
  });
});

describe("catalogue query to shared conditions", () => {
  it("turns make, model and free text into one vehicle request", () => {
    expect(catalogQueryText(parseCatalogQuery("?make=BMW&model=X5"))).toBe("BMW X5");
    expect(catalogQueryText(parseCatalogQuery("?q=BMW&make=BMW&model=X5"))).toBe("BMW X5 BMW");
    expect(catalogQueryText(parseCatalogQuery(""))).toBe("");
  });

  it("builds a neutral profile that keeps every search condition", () => {
    const profile = catalogQueryToProfile(
      parseCatalogQuery(
        "?q=BMW&budget_min=3000&budget_max=9000&year_min=2020&year_max=2024&mileage_max_km=120000&body_type=suv&transmission=automatic&city=Osh&currency=USD",
      ),
    );
    expect(profile.user_id).toBe(0);
    expect(profile.monitoring).toBe(false);
    expect(profile.currency).toBe("USD");
    expect(profile.budget_min_minor).toBe(300_000);
    expect(profile.budget_max_minor).toBe(900_000);
    expect(profile.query).toBe("BMW");
    expect(profile.year_min).toBe(2020);
    expect(profile.year_max).toBe(2024);
    expect(profile.mileage_max_km).toBe(120_000);
    expect(profile.body_type).toBe("suv");
    expect(profile.transmission).toBe("automatic");
    expect(profile.city).toBe("Osh");
    expect(profile.market).toBe("KG");
    expect(profile.allow_import).toBe(true);
  });

  it("keeps the unbounded budget when no bound is given", () => {
    const profile = catalogQueryToProfile(parseCatalogQuery(""));
    expect(profile.budget_min_minor).toBe(0);
    expect(profile.budget_max_minor).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("catalogue sorts", () => {
  it("offers only the supported orders", () => {
    expect([...CATALOG_SORTS]).toEqual(["new", "price_asc", "price_desc", "mileage_asc"]);
  });
});
