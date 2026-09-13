import { SourceError } from "@autodom/core";
import { describe, expect, it } from "vitest";
import { parsePage as parseFeed, parsePassengerCategory } from "../src/lalafo.js";

const bootstrap = `<script id="__NEXT_DATA__">${JSON.stringify({
  pageProps: {
    initialState: { listing: { selectedCategory: { id: 1502, name: "Продажа авто", url: "/avtomobili-s-probegom", children: [] } } },
    dehydratedState: { queries: [{ state: { data: [{ type: "category", id: 1608, name: "Toyota", url: "/kyrgyzstan/avtomobili-s-probegom/prodazha-avtomobiley/toyota" }] } }] },
  },
})}</script>`;
const category = parsePassengerCategory(bootstrap);
function parsePage(value: string) {
  return parseFeed(value, 1, category);
}
// The feed envelope and vehicle title/parameter shape were observed live on
// 2026-09-13. Identity/media below are synthetic; no seller data is retained.
function ad(changes: Record<string, unknown> = {}) {
  return {
    id: 100,
    country_id: 12,
    category_id: 1608,
    title: "Toyota Highlander: 2006 г., 3.3 л, Автомат, Бензин, Кроссовер",
    url: "/bishkek/ads/toyota-highlander-id-100",
    price: 13500,
    currency: "USD",
    price_type: 1,
    params: [],
    city: "Бишкек",
    ...changes,
  };
}
function document(items: unknown[], metadata: Record<string, unknown> = {}) {
  return JSON.stringify({
    items,
    _meta: { totalCount: items.length, pageCount: items.length ? 1 : 0, currentPage: 1, perPage: 50, ...metadata },
  });
}

describe("Lalafo passenger feed", () => {
  it("preserves the stated currency and public identity without storing seller data or inventing stock", () => {
    const result = parsePage(document([
      ad({ mobile: "private-phone", user: { token: "private-token" }, images: [
        { original_url: "https://img5.lalafo.com/i/posters/original/car.jpeg" },
        { original_url: "https://img5.lalafo.com/i/posters/original/car.jpeg" },
        { original_url: "https://evil.example/car.jpeg" },
      ] }),
      ad({ id: 101, url: "/bishkek/ads/toyota-highlander-id-101", price: 25900, currency: "KGS" }),
    ]));
    expect(result.listings[0]).toMatchObject({
      id: "lalafo:100", source_id: "100", source: "lalafo.kg", market: "KG",
      url: "https://lalafo.kg/bishkek/ads/toyota-highlander-id-100",
      make: "Toyota", model: "Highlander", year: 2006,
      original_currency: "USD", original_price_minor: 1350000,
      price_usd_minor: 1350000, price_kgs_minor: null,
      mileage: "", availability: "Опубликовано",
      photo_urls: ["https://img5.lalafo.com/i/posters/original/car.jpeg"],
    });
    expect(result.listings[1]).toMatchObject({ original_currency: "KGS", original_price_minor: 2590000, price_usd_minor: null, price_kgs_minor: 2590000 });
    expect(JSON.stringify(result)).not.toMatch(/private-phone|private-token|"mobile"|"user"/);
  });

  it("uses structured vehicle data while leaving unsupported title guesses and mileage unknown", () => {
    const [structured, unknown] = parsePage(document([
      ad({ title: "Продам автомобиль", params: [{ name: "Марка", value: "Toyota" }, { name: "Модель", value: "Camry" }, { name: "Год выпуска", value: "2019" }] }),
      ad({ id: 101, url: "/bishkek/ads/car-id-101", title: "Срочно, звоните после 2020", category_id: 1502 }),
    ])).listings;
    expect(structured).toMatchObject({ make: "Toyota", model: "Camry", year: 2019 });
    expect(unknown).toMatchObject({ make: null, model: null, year: null, mileage: "" });
  });

  it("keeps unsupported or invalid prices unknown and rounds decimal tokens without floating-point drift", () => {
    for (const changes of [{ price: -1 }, { price: 0 }, { price: true }, { price: "NaN" }, { price: "90071992547409.92" }, { currency: "EUR" }, { price_type: 999 }]) {
      expect(parsePage(document([ad(changes)])).listings[0]).toMatchObject({ original_price_minor: null, price_usd_minor: null, price_kgs_minor: null, price_kind: "unknown" });
    }
    const raw = document([ad({ price: "DECIMAL" })]).replace('"DECIMAL"', "1.004999999999999999999999");
    expect(parsePage(raw).listings[0]!.original_price_minor).toBe(100);
  });

  it("rejects wrong categories, countries and identity URLs rather than publishing unrelated listings", () => {
    for (const changes of [{ category_id: 1501 }, { category_id: 2001 }, { category_id: null }, { country_id: 1 }, { id: null }, { url: "https://evil.example/bishkek/ads/car-id-100" }, { url: "/bishkek/ads/car-id-101" }]) {
      expect(() => parsePage(document([ad(changes)]))).toThrow(SourceError);
    }
    expect(() => parsePage("<html>Just a moment...</html>")).toThrow(SourceError);
    expect(() => parsePage(JSON.stringify({ items: [], _meta: {} }))).toThrow(SourceError);
  });

  it("uses API pagination despite sponsored extras and deduplicates advertisements, not cars", () => {
    const result = parsePage(document([
      ad(), ad({ price: 14000 }), ad({ id: 101, url: "/bishkek/ads/car-id-101" }),
    ], { totalCount: 5, pageCount: 5, perPage: 1 }));
    expect(result).toMatchObject({ page: 1, pages: 5, total: 5 });
    expect(result.listings.map((listing) => listing.id)).toEqual(["lalafo:100", "lalafo:101"]);
    expect(result.listings[0]!.original_price_minor).toBe(1400000);
    expect(() => parsePage(document([], { totalCount: 5, pageCount: 5, perPage: 1 }))).toThrow(SourceError);
    expect(() => parsePage(document([ad()], { currentPage: 2 }))).toThrow(SourceError);
    expect(() => parsePage(document([ad()], { pageCount: 2 }))).toThrow(SourceError);
    expect(() => parsePassengerCategory(bootstrap.replaceAll("1502", "1501"))).toThrow(SourceError);
    expect(() => parsePassengerCategory(bootstrap.replace("/prodazha-avtomobiley/toyota", "/zapchasti/toyota"))).toThrow(SourceError);
    expect(parsePage(document([]))).toMatchObject({ listings: [], pages: 0, total: 0 });
  });
});
