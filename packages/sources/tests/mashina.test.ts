import {
  type DocumentTransport,
  isPriceDrop,
  makeProfile,
  matches,
  SourceError,
} from "@autodom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, parsePage } from "../src/mashina.js";

function ad(changes: Record<string, unknown> = {}) {
  return {
    id: 10112178,
    slug: "volkswagen-tharu-xr-example",
    title: "Volkswagen Tharu XR 1.5 AT",
    status: "active",
    availability: "В наличии",
    created_at: "2026-08-14T07:06:47.273197+06:00",
    prices: [
      { currency: "USD", amount: 11300 },
      { currency: "KGS", amount: 988185 },
    ],
    attributes: [
      { slug: "year", value_number: 2026 },
      { slug: "mileage", value_text: "165000 miles" },
      { slug: "city", value_json: { name: "Бишкек" } },
    ],
    location: {},
    ...changes,
  };
}
function catalog(items: unknown[], changes: Record<string, unknown> = {}) {
  return { items, total: items.length, page: 1, size: 21, pages: 1, ...changes };
}
function flight(value: unknown) {
  return '0:I["component",[],"default"]\n1:' + JSON.stringify(value) + "\n";
}
const listing = (changes: Record<string, unknown> = {}) =>
  parsePage(flight(catalog([ad(changes)]))).listings[0]!;

afterEach(() => vi.unstubAllEnvs());

describe("Mashina Flight catalog", () => {
  it("finds vehicle catalog through nested translations without corrupting seller text", () => {
    const title = 'Lexus LX «Кыргызстан» [570] \\"особый" {seller}';
    const result = parsePage(
      flight({
        translations: {
          items: [{ items: ["один", { text: "[скобки] и кавычки" }] }],
          total: "Всего",
          page: "Страница",
          size: "Размер",
          pages: "Страницы",
        },
        children: [catalog([ad({ title })])],
      }),
    );
    expect(result.listings[0]).toMatchObject({
      title,
      id: "mashina:10112178",
      url: "https://mashina.kg/details/volkswagen-tharu-xr-example",
      price_usd_minor: 1130000,
      price_kgs_minor: 98818500,
      city: "Бишкек",
      mileage: "165000 miles",
      year: 2026,
      availability: "В наличии",
      published_at: "2026-08-14T07:06:47.273197+06:00",
      source: "mashina.kg",
      market: "KG",
    });
  });

  it("preserves large numeric advertisement identity without IEEE-754 aliasing", () => {
    const source = flight(catalog([ad()])).replace("10112178", "9007199254740993");
    expect(parsePage(source).listings[0]!.id).toBe("mashina:9007199254740993");
  });

  it("keeps currencies separate and respects the last supplied currency observation", () => {
    expect(
      listing({
        prices: [
          { currency: "USD", amount: 123 },
          { currency: "EUR", amount: 456 },
          { currency: "USD", amount: null },
          { currency: "KGS", amount: "900.01" },
        ],
      }),
    ).toMatchObject({ price_usd_minor: null, price_kgs_minor: 90001, original_currency: "" });
  });

  it("distinguishes the marked seller price from a changing converted display price", () => {
    const before = listing({
      prices: [
        { currency: "USD", amount: 34000, is_original: false },
        { currency: "KGS", amount: 2973300, is_original: true },
      ],
    });
    const converted = listing({
      prices: [
        { currency: "USD", amount: 33000, is_original: false },
        { currency: "KGS", amount: 2973300, is_original: true },
      ],
    });
    const event = {
      id: 1,
      kind: "price_change",
      listing: converted,
      previous_usd_minor: before.price_usd_minor,
      previous_kgs_minor: before.price_kgs_minor,
      previous_original_price_minor: before.original_price_minor,
      previous_original_currency: before.original_currency,
    };
    expect(isPriceDrop(event, "USD")).toBe(false);
    const reduced = listing({
      prices: [
        { currency: "USD", amount: 32000, is_original: false },
        { currency: "KGS", amount: 2883200, is_original: true },
      ],
    });
    expect(isPriceDrop({ ...event, listing: reduced }, "USD")).toBe(true);
    expect(reduced.original_currency).toBe("KGS");
    expect(reduced.original_price_minor).toBe(288320000);
  });

  it("leaves conflicting or malformed original-price evidence unknown", () => {
    for (const prices of [
      [
        { currency: "USD", amount: 100, is_original: true },
        { currency: "KGS", amount: 9000, is_original: true },
      ],
      [
        { currency: "USD", amount: 100, is_original: true },
        { currency: "USD", amount: 90, is_original: false },
      ],
      [
        { currency: "USD", amount: 100, is_original: "true" },
        { currency: "KGS", amount: 9000, is_original: true },
      ],
      [
        { currency: "USD", amount: 100, is_original: false },
        { currency: "KGS", amount: null, is_original: true },
      ],
      [{ currency: "USD", amount: 100 }],
      [{ currency: "EUR", amount: 100, is_original: true }],
    ]) {
      const value = listing({ prices });
      expect(value.original_currency).toBe("");
      expect(value.original_price_minor).toBeNull();
    }
  });

  it("keeps decimal JSON prices exact and rounds half cents upwards", () => {
    const document = flight(catalog([ad({ prices: [{ currency: "USD", amount: "DECIMAL" }] })]));
    expect(parsePage(document.replace('"DECIMAL"', "11300.29")).listings[0]!.price_usd_minor).toBe(
      1130029,
    );
    expect(parsePage(document.replace('"DECIMAL"', "1.005")).listings[0]!.price_usd_minor).toBe(
      101,
    );
    expect(
      parsePage(document.replace('"DECIMAL"', "1.004999999999999999999")).listings[0]!
        .price_usd_minor,
    ).toBe(100);
    expect(
      parsePage(document.replace('"DECIMAL"', "11300.29")).listings[0]!.price_kgs_minor,
    ).toBeNull();
  });

  it.each([
    null,
    "NaN",
    "Infinity",
    "-Infinity",
    -1,
    0,
    true,
    "не указана",
    "1e99999999",
    "90071992547409.92",
  ])("keeps invalid, negotiable or unrepresentable price %s unknown", (amount) => {
    expect(listing({ prices: [{ currency: "USD", amount }] }).price_usd_minor).toBeNull();
  });

  it("keeps raw non-finite amounts unknown without weakening metadata validation", () => {
    const source = flight(catalog([ad({ prices: [{ currency: "USD", amount: "RAW" }] })]));
    for (const token of ["NaN", "Infinity", "-Infinity"]) {
      expect(parsePage(source.replace('"RAW"', token)).listings[0]!.price_usd_minor).toBeNull();
    }
    expect(() =>
      parsePage(flight(catalog([ad({ availability: "RAW" })])).replace('"RAW"', "NaN")),
    ).toThrow(SourceError);
  });

  it("an explicit inactive status becomes ineligible to matching consumers", () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    const profile = makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 2_000_000,
    });
    expect(matches(profile, listing())).toBe(true);
    expect(matches(profile, listing({ status: "inactive" }))).toBe(false);
    expect(listing({ status: "inactive" }).availability).toBe("Неактивно");
  });

  it("preserves explicit units and known metadata without inventing absent details", () => {
    const result = listing({
      attributes: [
        { slug: "mileage", value_json: { value: "64000", suffix: "km" } },
        { slug: "gearbox", value_json: " АКПП " },
        { slug: "body_type", value_json: { name: " Седан " } },
        { slug: "city", value_text: " Ош ", value_json: { name: "Бишкек" } },
        { slug: "year", value_text: "2018" },
      ],
    });
    expect(result).toMatchObject({
      mileage: "64000 km",
      transmission: "АКПП",
      body_type: "Седан",
      city: "Ош",
      year: 2018,
    });
    expect(listing({ attributes: [{ slug: "mileage", value_number: 12000 }] }).mileage).toBe("");
    expect(
      listing({ prices: null, attributes: null, availability: null, created_at: null }),
    ).toMatchObject({
      price_usd_minor: null,
      price_kgs_minor: null,
      year: null,
      availability: "",
      published_at: "",
      city: "",
    });
  });

  it.each([true, 1799, 2201, 2018.5, "NaN", "unknown"])(
    "does not manufacture a year from %s",
    (value_number) => {
      expect(listing({ attributes: [{ slug: "year", value_number }] }).year).toBeNull();
    },
  );

  it("encodes the full slug and retains a bounded gallery of trusted photo variants", () => {
    expect(listing({ slug: "a/b?c#d!'()" }).url).toBe(
      "https://mashina.kg/details/a%2Fb%3Fc%23d%21%27%28%29",
    );
    const photos = Array.from({ length: 12 }, (_, index) => `https://im.mashina.kg/${index}.jpg`);
    const car = listing({
      images: [
        null,
        { medium: "https://user:secret@im.mashina.kg/a.jpg" },
        { medium: "https://im.mashina.kg.evil.test/a.jpg" },
        { medium: "https://im.mashina.kg:443/a.jpg" },
        { medium: "https://im.mashina.kg/a.jpg#fragment" },
        { medium: "http://im.mashina.kg/a.jpg", thumb: photos[0] },
        { medium: photos[0], thumb: "https://im.mashina.kg/duplicate-thumb.jpg" },
        ...photos.slice(1).map((medium) => ({ medium, thumb: `${medium}?thumb=1` })),
      ],
    });
    expect(car.photo_url).toBe(photos[0]);
    expect(car.photo_urls).toEqual(photos.slice(0, 10));
    expect(listing({ images: [{ medium: "https://evil.test/a.jpg" }] }).photo_url).toBeNull();
  });

  it("permits empty final and out-of-range pages but rejects missing interior coverage", () => {
    expect(parsePage(flight(catalog([], { page: 3, pages: 3, total: 42 })), 3)).toMatchObject({
      listings: [],
      page: 3,
      pages: 3,
      total: 42,
    });
    expect(parsePage(flight(catalog([], { page: 4, pages: 3, total: 42 })), 4).listings).toEqual(
      [],
    );
    expect(parsePage(flight(catalog([], { pages: 0 }))).listings).toEqual([]);
    expect(() => parsePage(flight(catalog([], { pages: 3, total: 42 })))).toThrow(SourceError);
  });

  it("fails closed on malformed, ambiguous, contradictory and duplicate catalog entries", () => {
    const invalid = [
      "<html>Service unavailable</html>",
      flight({ items: [], total: 0 }),
      flight(catalog([{ title: "not a listing" }])),
      flight(catalog([ad()])).slice(0, -10),
      flight(catalog([ad()], { page: 2, pages: 2 })),
      flight(catalog([ad()], { total: true })),
      flight([catalog([ad()]), catalog([ad({ id: 10112179 })])]),
      flight(catalog([ad({ prices: {} })])),
      flight(catalog([ad({ attributes: {} })])),
      flight(catalog([ad({ prices: [null] })])),
      flight(catalog([ad({ attributes: [null] })])),
      flight(catalog([ad({ availability: false })])),
      flight(catalog([ad({ created_at: 123 })])),
      flight(catalog([ad(), ad()])),
      flight(catalog([ad()], { total: 0 })),
      flight(catalog([ad()], { size: 0 })),
      flight(catalog([ad()], { pages: 0 })),
      flight(catalog([ad()], { total: -1 })),
      flight(catalog([ad({ id: true })])),
      flight(catalog([ad(), { title: "malformed sibling" }])),
      flight(catalog([ad()])).replace('"total":1', '"total":1.0'),
    ];
    for (const document of invalid) expect(() => parsePage(document)).toThrow(SourceError);
    expect(() => parsePage(flight(catalog([ad()], { page: 3, pages: 2 })), 3)).toThrow(SourceError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid requested page %s",
    (page) => {
      expect(() => parsePage(flight(catalog([])), page)).toThrow(SourceError);
    },
  );

  it("binds transport parsing to the requested page and rejects a different catalog page", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    let body = flight(catalog([ad()], { page: 3, pages: 3, total: 42 }));
    const transport: DocumentTransport = {
      async fetchDocument<T>(_url: string, parse: (text: string) => T): Promise<T> {
        return parse(body);
      },
      fetchDocuments: vi.fn(),
    };
    expect(await fetchPage({ page: 3, transport })).toMatchObject({ page: 3, total: 42 });
    body = flight(catalog([ad()], { page: 2, pages: 3, total: 42 }));
    await expect(fetchPage({ page: 3, transport })).rejects.toThrow(SourceError);
  });

  it("gates before invoking even an injected transport", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "encar.com");
    const fetchDocument = vi.fn();
    const transport = { fetchDocument, fetchDocuments: vi.fn() } as DocumentTransport;
    await expect(fetchPage({ transport })).rejects.toThrow(SourceError);
    expect(fetchDocument).not.toHaveBeenCalled();
  });
});
