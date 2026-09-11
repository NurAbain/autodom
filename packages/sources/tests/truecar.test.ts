import { type DocumentTransport, SourceError } from "@autodom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, parsePage, SEARCH_URL } from "../src/truecar.js";

const VIN = "1ABCDEFGH23456789";
const OTHER_VIN = "1ABCDEFGH23456780";
type RecordValue = Record<string, any>;
type Fixture = [RecordValue, RecordValue, RecordValue, RecordValue];
const cursor = (number: number) =>
  Buffer.from(String(number)).toString("base64").replace(/=+$/, "");

function fixture({ page = 1, total = 1, size = 1, vin = VIN } = {}): Fixture {
  const args = {
    filters: {
      condition: "USED",
      fallbackStrategy: "SIMPLE",
      makeModelTrim: [{ makeSlug: "toyota", modelSlug: "camry" }],
      withinRadius: { distance: 75, postalCode: "10017" },
    },
    first: size,
    offset: (page - 1) * size,
    sort: "BEST_MATCH",
  };
  const row = {
    __typename: "ConsumerSummaryListing",
    pricing: {
      listPrice: "12345.67",
      exclusion: "NO_EXCLUSION",
      discountLabel: "UPFRONT_PRICE",
      totalMsrp: 99999,
    },
    precalculatedLease: { monthlyPayment: 99 },
    vehicle: {
      vin,
      condition: "USED",
      year: 2020,
      mileage: 12001,
      make: { name: "Toyota", slug: "toyota" },
      model: { name: "Camry", slug: "camry" },
      style: { trimName: "LE" },
      transmission: "Automatic",
      bodyStyle: "SEDAN",
      details: {
        vin,
        mileage: 12001,
        dealerCity: "Example City",
        dealerState: "NY",
        listedAt: "2026-08-01T12:00:00Z",
      },
    },
    conditionHistory: { accidentCount: 3, ownerCount: 2, isCleanTitle: true },
  };
  const linked = {
    "@type": "Vehicle",
    vehicleIdentificationNumber: vin,
    itemCondition: "UsedCondition",
    vehicleModelDate: "2020",
    brand: { name: "Toyota" },
    model: "Camry",
    vehicleConfiguration: "LE",
    mileageFromOdometer: { value: 12001 },
    image: "https://listings-prod.tcimg.net/synthetic.jpg",
    offers: {
      "@type": "Offer",
      price: "12345.67",
      priceCurrency: "USD",
      sku: vin,
      url: `https://www.truecar.com/used-cars-for-sale/listing/${vin}/`,
    },
  };
  const connection = {
    __typename: "MarketplaceSearchConnection",
    isFallback: false,
    totalCount: total,
    edges: [{ cursor: cursor(args.offset + 1), node: { __ref: "connected" } }],
    pageInfo: { endCursor: cursor(args.offset + 1), hasNextPage: args.offset + 1 < total },
  };
  return [args, connection, row, linked];
}

function document(
  parts: Fixture,
  {
    extraRoot = {},
    extraState = {},
    query,
    extraGraph = [],
  }: {
    extraRoot?: RecordValue;
    extraState?: RecordValue;
    query?: RecordValue;
    extraGraph?: RecordValue[];
  } = {},
): string {
  const [args, connection, row, linked] = parts;
  const data = {
    isFallback: false,
    query: query ?? {
      condition: "used",
      page: String(Math.floor(args.offset / args.first) + 1),
      splat: ["toyota", "camry"],
    },
    props: {
      pageProps: {
        __APOLLO_STATE__: {
          ROOT_QUERY: {
            ...extraRoot,
            [`marketplaceListingSearch(${JSON.stringify(args)})`]: connection,
          },
          connected: row,
          ...extraState,
        },
      },
    },
  };
  const ld = {
    "@graph": [
      {
        "@type": "CollectionPage",
        mainEntity: {
          itemListElement: connection.edges.length ? [{ item: linked }] : [],
        },
      },
      ...extraGraph,
    ],
  };
  return `<html><script type="application/json" id="__NEXT_DATA__">${JSON.stringify(data)}</script><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`;
}

function capturedTransport(html: string, requests: unknown[] = []): DocumentTransport {
  return {
    async fetchDocument(url, parse, options) {
      requests.push({ url, options });
      return parse(html);
    },
    async fetchDocuments() {
      throw new Error("TrueCar must use its document transport");
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("TrueCar connected retail inventory", () => {
  it("ignores sponsored searches and unrelated cached vehicles", () => {
    const parts = fixture();
    const sponsoredArgs: RecordValue = { ...parts[0], first: 3, sponsored: true };
    delete sponsoredArgs.sort;
    const sponsored = structuredClone(parts[1]);
    sponsored.edges[0].node.__ref = "advertising-only";
    const unrelated = structuredClone(parts[2]);
    unrelated.vehicle.vin = OTHER_VIN;
    const result = parsePage(
      document(parts, {
        extraRoot: { [`marketplaceListingSearch(${JSON.stringify(sponsoredArgs)})`]: sponsored },
        extraState: { unrelated },
        extraGraph: [{ "@type": "Vehicle", vehicleIdentificationNumber: OTHER_VIN }],
      }),
    );
    expect(result.listings.map((car) => car.id)).toEqual([`truecar:${VIN}`]);
    expect([result.total, result.pages]).toEqual([1, 1]);
    expect(result.listings[0]).toMatchObject({
      title: "2020 Toyota Camry LE",
      trim: "LE",
      year: 2020,
      original_currency: "USD",
      original_price_minor: 1234567,
      price_usd_minor: 1234567,
      price_kgs_minor: null,
      mileage: "12001 miles",
      city: "Example City, NY",
      availability: "Опубликовано",
      photo_url: "https://listings-prod.tcimg.net/synthetic.jpg",
      observed_at: null,
      url: `https://www.truecar.com/used-cars-for-sale/listing/${VIN}/`,
      published_at: "2026-08-01T12:00:00Z",
      source: "truecar.com",
      market: "US",
      price_kind: "asking",
      transmission: "Automatic",
      body_type: "SEDAN",
    });
  });

  it("does not present generic model artwork as the advertised car photograph", () => {
    const parts = fixture();
    parts[3].image = "https://static.tcimg.net/vehicles/primary/model-example.png";
    expect(parsePage(document(parts)).listings[0]?.photo_url).toBeNull();
  });

  it("keeps actual vehicle photos despite invalid artwork and duplicate gallery entries", () => {
    const parts = fixture();
    const photos = Array.from(
      { length: 12 },
      (_, index) => `https://listings-prod.tcimg.net/${index}.jpg`,
    );
    parts[3].image = [
      null,
      {},
      "https://static.tcimg.net/vehicles/primary/model-example.png",
      "https://listings-prod.tcimg.net.evil.test/a.jpg",
      "https://user@listings-prod.tcimg.net/a.jpg",
      "https://listings-prod.tcimg.net:443/a.jpg",
      "https://listings-prod.tcimg.net/a.jpg#fragment",
      "http://listings-prod.tcimg.net/a.jpg",
      photos[0],
      ...photos,
    ];
    const car = parsePage(document(parts)).listings[0]!;
    expect(car.photo_url).toBe(photos[0]);
    expect(car.photo_urls).toEqual(photos.slice(0, 10));
    parts[3].image = "https://evil.test/a.jpg";
    expect(parsePage(document(parts)).listings[0]?.photo_url).toBeNull();
  });

  it("retains actual geographic scope across ranked page overlap", () => {
    const first = parsePage(document(fixture({ total: 2 })));
    const second = parsePage(document(fixture({ page: 2, total: 2 })), 2);
    expect(first.listings[0]?.id).toBe(second.listings[0]?.id);
    expect([second.page, second.total, second.pages]).toEqual([2, 2, 2]);
    expect(first.scope).toBe(second.scope);
    expect(JSON.parse(first.scope.slice("truecar.com:".length)).filters.withinRadius).toEqual({
      distance: 75,
      postalCode: "10017",
    });
    const elsewhere = fixture();
    elsewhere[0].filters.withinRadius.postalCode = "90210";
    expect(parsePage(document(elsewhere)).scope).not.toBe(first.scope);
  });

  it("keeps clean title separate from accident counts and zero owners unconfirmed", () => {
    const car = parsePage(document(fixture())).listings[0]!;
    expect(car.condition).toContain("зарегистрированных ДТП — 3");
    expect(car.condition).toContain("clean title — да");
    expect(car.condition).not.toContain("ДТП — 0");
    for (const history of [null, {}, { isCleanTitle: true, accidentCount: null, ownerCount: 0 }]) {
      const parts = fixture();
      parts[2].conditionHistory = history;
      const condition = parsePage(document(parts)).listings[0]!.condition;
      expect(condition).toContain("ДТП — неизвестно");
      expect(condition).not.toContain("ДТП — 0");
      expect(condition).toContain(
        history && "ownerCount" in history ? "история не подтверждена" : "владельцев — неизвестно",
      );
    }
    const parts = fixture();
    delete parts[2].conditionHistory;
    expect(parsePage(document(parts)).listings[0]!.condition).toContain("ДТП — неизвестно");
    parts[2].conditionHistory = { accidentCount: 0 };
    expect(parsePage(document(parts)).listings[0]!.condition).toContain(
      "зарегистрированных ДТП — 0",
    );
    expect(parsePage(document(parts)).listings[0]!.condition).toContain("title — неизвестно");
  });

  it.each([null, true, 0, -1, "NaN", "Infinity", "123.456", "1e999999"])(
    "rejects invalid asking price %s without MSRP or lease fallback",
    (price) => {
      const parts = fixture();
      parts[2].pricing.listPrice = price;
      expect(() => parsePage(document(parts))).toThrow(SourceError);
    },
  );

  it("retains exact JSON decimal prices without binary rounding or hidden fractional cents", () => {
    const parts = fixture();
    parts[2].pricing.listPrice = 12345.67;
    parts[3].offers.price = 12345.67;
    expect(parsePage(document(parts)).listings[0]?.price_usd_minor).toBe(1234567);
    const hiddenFraction = document(parts).replaceAll("12345.67", "12345.670000000000000001");
    expect(() => parsePage(hiddenFraction)).toThrow(SourceError);
    parts[2].pricing.listPrice = "999999999999.99";
    parts[3].offers.price = "999999999999.99";
    expect(parsePage(document(parts)).listings[0]?.price_usd_minor).toBe(99999999999999);
  });

  it.each([
    ["priceCurrency", "KRW"],
    ["price", "12345.68"],
    ["sku", OTHER_VIN],
    ["url", `https://www.truecar.com.evil.example/used-cars-for-sale/listing/${VIN}/`],
    ["url", `https://www.truecar.com/used-cars-for-sale/listing/${OTHER_VIN}/`],
    ["url", `http://www.truecar.com/used-cars-for-sale/listing/${VIN}/`],
    ["@type", "AggregateOffer"],
    ["priceSpecification", { unitText: "MONTH" }],
    ["leaseLength", null],
    ["businessFunction", "LeaseOut"],
  ])("rejects incompatible purchase offer %s = %s", (key, value) => {
    const parts = fixture();
    parts[3].offers[key as string] = value;
    expect(() => parsePage(document(parts))).toThrow(SourceError);
  });

  it.each(["CONDITIONAL_DISCOUNT", "ESTIMATED_PRICE"])(
    "rejects qualified price %s",
    (qualification) => {
      const parts = fixture();
      parts[2].pricing.exclusion = qualification;
      expect(() => parsePage(document(parts))).toThrow(SourceError);
    },
  );

  it.each([
    [
      "fallback",
      (p: Fixture) => {
        p[1].isFallback = true;
      },
    ],
    [
      "incomplete page",
      (p: Fixture) => {
        p[0].first = 2;
        p[1].totalCount = 2;
      },
    ],
    [
      "next page",
      (p: Fixture) => {
        p[1].pageInfo.hasNextPage = true;
      },
    ],
    [
      "end cursor",
      (p: Fixture) => {
        p[1].pageInfo.endCursor = cursor(2);
      },
    ],
    [
      "edge cursor",
      (p: Fixture) => {
        p[1].edges[0].cursor = cursor(2);
      },
    ],
    [
      "malformed base64",
      (p: Fixture) => {
        p[1].edges[0].cursor += "!";
      },
    ],
    [
      "boolean count",
      (p: Fixture) => {
        p[1].totalCount = true;
      },
    ],
    [
      "missing node",
      (p: Fixture) => {
        p[1].edges[0].node.__ref = "absent";
      },
    ],
    [
      "VIN conflict",
      (p: Fixture) => {
        p[2].vehicle.details.vin = OTHER_VIN;
      },
    ],
    [
      "mileage conflict",
      (p: Fixture) => {
        p[3].mileageFromOdometer.value = 12002;
      },
    ],
    [
      "odometer units",
      (p: Fixture) => {
        p[3].mileageFromOdometer.unitCode = "KMT";
      },
    ],
    [
      "model year",
      (p: Fixture) => {
        p[3].vehicleModelDate = "2021";
      },
    ],
    [
      "make identity",
      (p: Fixture) => {
        p[3].brand.name = "Honda";
      },
    ],
    [
      "new vehicle",
      (p: Fixture) => {
        p[2].vehicle.condition = "NEW";
      },
    ],
    [
      "missing ZIP",
      (p: Fixture) => {
        delete p[0].filters.withinRadius.postalCode;
      },
    ],
    [
      "invalid radius",
      (p: Fixture) => {
        p[0].filters.withinRadius.distance = 0;
      },
    ],
    [
      "invalid history",
      (p: Fixture) => {
        p[2].conditionHistory.accidentCount = true;
      },
    ],
  ] as const)("fails closed on %s", (_name, mutate) => {
    const parts = fixture();
    mutate(parts);
    expect(() => parsePage(document(parts))).toThrow(SourceError);
  });

  it("rejects duplicate vehicles rather than returning a partial page", () => {
    const parts = fixture({ total: 2, size: 2 });
    parts[1].edges.push({ cursor: cursor(2), node: { __ref: "connected" } });
    parts[1].pageInfo = { endCursor: cursor(2), hasNextPage: false };
    expect(() => parsePage(document(parts))).toThrow(SourceError);
    expect(() => parsePage(document(fixture({ total: 2 })), 2)).toThrow(SourceError);
  });

  it("ignores a different offset but rejects ambiguous matching connections", () => {
    const parts = fixture();
    const otherArgs = structuredClone(parts[0]);
    otherArgs.offset = 1;
    expect(
      parsePage(
        document(parts, {
          extraRoot: {
            [`marketplaceListingSearch(${JSON.stringify(otherArgs)})`]: { invalid: "unconnected" },
          },
        }),
      ).listings[0]?.id,
    ).toBe(`truecar:${VIN}`);
    otherArgs.offset = 0;
    otherArgs.filters.withinRadius.postalCode = "90210";
    expect(() =>
      parsePage(
        document(parts, {
          extraRoot: { [`marketplaceListingSearch(${JSON.stringify(otherArgs)})`]: parts[1] },
        }),
      ),
    ).toThrow(SourceError);
  });

  it("rejects challenges, truncated JSON, missing inventory and duplicate Next data", () => {
    for (const html of [
      "<html>Access denied</html>",
      '<script src="/_Incapsula_Resource"></script>',
      document(fixture()).slice(0, -40),
      document(fixture()).replace(/<\/script><\/html>$/, ""),
      '<script id="__NEXT_DATA__">{}</script>',
      document(fixture()) + document(fixture()),
    ]) {
      expect(() => parsePage(html)).toThrow(SourceError);
    }
    const parts = fixture();
    parts[3].vehicleIdentificationNumber = OTHER_VIN;
    expect(() => parsePage(document(parts))).toThrow(SourceError);
    expect(() =>
      parsePage(
        document(fixture(), {
          extraGraph: [
            {
              "@type": "CollectionPage",
              mainEntity: { itemListElement: [{ item: fixture()[3] }] },
            },
          ],
        }),
      ),
    ).toThrow(SourceError);
  });

  it("accepts empty inventory only with consistent pagination", () => {
    const parts = fixture({ total: 0 });
    parts[1].edges = [];
    parts[1].pageInfo = { endCursor: null, hasNextPage: false };
    const result = parsePage(document(parts));
    expect([result.listings, result.total, result.pages]).toEqual([[], 0, 0]);
    parts[1].totalCount = 1;
    expect(() => parsePage(document(parts))).toThrow(SourceError);
  });
});

describe("TrueCar gated document transport", () => {
  it("requires approval before invoking transport", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    vi.stubEnv("AUTODOM_TRUECAR_SEARCH_URL", SEARCH_URL);
    const requests: unknown[] = [];
    await expect(
      fetchPage({ transport: capturedTransport(document(fixture()), requests) }),
    ).rejects.toThrow(SourceError);
    expect(requests).toEqual([]);
  });

  it.each([
    "http://www.truecar.com/used-cars-for-sale/listings/toyota/camry/",
    "https://www.truecar.com.evil.example/used-cars-for-sale/listings/toyota/camry/",
    "https://www.truecar.com/abp/api/vehicles/",
    `${SEARCH_URL}?zip=10017&zip=90210`,
    `${SEARCH_URL}?zip=1001`,
    `${SEARCH_URL}?searchRadius=0`,
    `${SEARCH_URL}?searchRadius=75.5`,
    `${SEARCH_URL}?sort=price`,
    `${SEARCH_URL}?zip`,
    `${SEARCH_URL}#fragment`,
    "https://www.truecar.com:443/used-cars-for-sale/listings/",
  ])("rejects unsafe or unsupported configured search %s before transport", async (url) => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "truecar.com");
    vi.stubEnv("AUTODOM_TRUECAR_SEARCH_URL", url);
    const requests: unknown[] = [];
    await expect(
      fetchPage({ transport: capturedTransport(document(fixture()), requests) }),
    ).rejects.toThrow(SourceError);
    expect(requests).toEqual([]);
  });

  it("requires the executed route, ZIP and radius to match configured scope", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "truecar.com");
    vi.stubEnv(
      "AUTODOM_TRUECAR_SEARCH_URL",
      "https://www.truecar.com/used-cars-for-sale/listings/honda/civic/",
    );
    await expect(fetchPage({ transport: capturedTransport(document(fixture())) })).rejects.toThrow(
      SourceError,
    );
    for (const [parameter, value] of [
      ["zip", "90210"],
      ["searchRadius", "100"],
    ]) {
      vi.stubEnv("AUTODOM_TRUECAR_SEARCH_URL", `${SEARCH_URL}?${parameter}=${value}`);
      const query = {
        condition: "used",
        page: "1",
        splat: ["toyota", "camry"],
        [parameter!]: value,
      };
      await expect(
        fetchPage({ transport: capturedTransport(document(fixture(), { query })) }),
      ).rejects.toThrow(SourceError);
    }
  });

  it("uses injected transport with query-free canonical URL and explicit requested page", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "truecar.com");
    vi.stubEnv("AUTODOM_TRUECAR_SEARCH_URL", `${SEARCH_URL}?page=99&zip=10017&searchRadius=75`);
    const requests: unknown[] = [];
    const query = {
      condition: "used",
      page: "2",
      splat: ["toyota", "camry"],
      zip: "10017",
      searchRadius: "75",
    };
    const result = await fetchPage({
      page: 2,
      transport: capturedTransport(document(fixture({ page: 2, total: 2 }), { query }), requests),
    });
    expect(result.page).toBe(2);
    expect(result.listings[0]?.id).toBe(`truecar:${VIN}`);
    expect(requests).toEqual([
      {
        url: SEARCH_URL,
        options: {
          source: "truecar.com",
          page: 2,
          params: { page: "2", zip: "10017", searchRadius: "75" },
        },
      },
    ]);
  });
});
