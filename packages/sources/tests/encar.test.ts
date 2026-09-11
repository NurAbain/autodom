import { type DocumentTransport, SourceError } from "@autodom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, parsePage, SCOPE } from "../src/encar.js";

function ad(changes: Record<string, unknown> = {}) {
  return {
    Id: "100",
    Manufacturer: "현대",
    Model: "그랜저 IG",
    Badge: "2.4 프리미엄",
    BadgeDetail: "(세부등급 없음)",
    FormYear: "2018",
    Year: 201704,
    Mileage: 12345,
    Price: "1850.125",
    SellType: "일반",
    OfficeCityState: "서울",
    ...changes,
  };
}
function document(items: unknown[], total = items.length) {
  return JSON.stringify({ Count: total, SearchResults: items });
}
const listing = (changes: Record<string, unknown> = {}) =>
  parsePage(document([ad(changes)])).listings[0]!;

afterEach(() => vi.unstubAllEnvs());

describe("Encar domestic catalog", () => {
  it("keeps whole won, model year and registration month distinct with native labels", () => {
    expect(listing()).toMatchObject({
      id: "encar:100",
      source: "encar.com",
      market: "KR",
      url: "https://fem.encar.com/cars/detail/100",
      original_currency: "KRW",
      original_price_minor: 18501250,
      price_usd_minor: null,
      price_kgs_minor: null,
      year: 2018,
      registration_month: "201704",
      title: "현대 그랜저 IG 2.4 프리미엄",
      trim: "2.4 프리미엄",
      mileage: "12345 km",
      city: "서울",
      price_kind: "asking",
    });
    expect(listing().search_aliases).toContain("Grandeur IG");
    expect(parsePage(document([ad()])).scope).toBe(SCOPE);
    expect(parsePage(document([ad({ Price: "DECIMAL" })])).scope).toContain(
      "экспорта не подтверждена",
    );
    const raw = document([ad({ Price: "DECIMAL" })]).replace('"DECIMAL"', "1850.125");
    expect(parsePage(raw).listings[0]!.original_price_minor).toBe(18501250);
  });

  it("deduplicates advertisements, not vehicles or shared photos, with last copy winning", () => {
    const first = ad({
      Condition: ["Inspection", "Record", "Resume"],
      ServiceCopyCar: "DUPLICATION",
      Photos: [{ location: "/carpicture00/pic0000/900_001.jpg" }],
    });
    const result = parsePage(
      document([first, { ...first, Id: "101" }, { ...first, Price: "1900" }]),
    );
    expect(result.listings.map((value) => value.id)).toEqual(["encar:100", "encar:101"]);
    expect(result.listings[0]!.original_price_minor).toBe(19000000);
    expect(
      result.listings.every(
        (value) => value.condition === "" && value.availability === "Опубликовано",
      ),
    ).toBe(true);
    expect(result.listings[0]!.photo_url).toBe(
      "https://ci.encar.com/carpicture/carpicture00/pic0000/900_001.jpg",
    );
    expect(listing().condition).toBe("");
  });

  it("preserves sports variant and observed aliases without inventing translations", () => {
    const sports = listing({
      Manufacturer: "KG모빌리티(쌍용)",
      Model: "더 뉴 렉스턴 스포츠",
      Badge: "디젤 2.2 4WD",
      BadgeDetail: "와일드",
    });
    expect(sports.title).toBe("KG모빌리티(쌍용) 더 뉴 렉스턴 스포츠 디젤 2.2 4WD 와일드");
    expect(sports.search_aliases).toContain("Rexton Sports");
    expect(sports.search_aliases).toContain("Wild");
    expect(
      listing({
        Manufacturer: "새로운 상표",
        Model: "미확인 모델",
        Badge: null,
        BadgeDetail: "unknown trim",
      }),
    ).toMatchObject({
      title: "새로운 상표 미확인 모델 unknown trim",
      trim: "unknown trim",
      search_aliases: "",
    });
  });

  it.each(["리스", "렌트", "", null, "unverified"])(
    "does not promote %s into a purchase price",
    (SellType) => {
      expect(listing({ SellType })).toMatchObject({
        price_kind: "unknown",
        original_price_minor: null,
        price_usd_minor: null,
        price_kgs_minor: null,
      });
    },
  );

  it.each([0, -1, true, "NaN", "Infinity", "0.00001", null, "900719925474.0992", "1e99999999"])(
    "keeps invalid or fractional won %s unknown",
    (Price) => {
      expect(listing({ Price }).original_price_minor).toBeNull();
    },
  );

  it("keeps raw non-finite amounts unknown without treating numeric metadata as strings", () => {
    const source = document([ad({ Price: "RAW" })]);
    for (const token of ["NaN", "Infinity", "-Infinity"]) {
      expect(
        parsePage(source.replace('"RAW"', token)).listings[0]!.original_price_minor,
      ).toBeNull();
    }
    expect(() => parsePage(document([ad({ SellType: "RAW" })]).replace('"RAW"', "NaN"))).toThrow(
      SourceError,
    );
  });

  it("does not lose sub-won fractions during JSON number decoding", () => {
    const raw = document([ad({ Price: "DECIMAL" })]).replace(
      '"DECIMAL"',
      "1850.000000000000000001",
    );
    expect(parsePage(raw).listings[0]!.original_price_minor).toBeNull();
  });

  it.each([201713, 201700, 179912, 220101, true, "unknown"])(
    "rejects invalid registration %s without borrowing FormYear",
    (Year) => {
      expect(listing({ Year })).toMatchObject({ registration_month: "", year: 2018 });
    },
  );

  it("preserves zero mileage and unknown model year without substituting registration year", () => {
    expect(listing({ FormYear: "unverified", Mileage: 0 })).toMatchObject({
      year: null,
      registration_month: "201704",
      mileage: "0 km",
    });
    expect(listing({ FormYear: 2018.5, Mileage: -1 })).toMatchObject({ year: null, mileage: "" });
    expect(listing({ FormYear: 2201, Mileage: true })).toMatchObject({ year: null, mileage: "" });
  });

  it("retains unique photo paths without traversal, remote URLs, or album overflow", () => {
    const paths = Array.from(
      { length: 12 },
      (_, index) => `/carpicture00/pic0000/900_${index}.png`,
    );
    const car = listing({
      Photos: [
        null,
        { location: "/carpicture/../x.jpg" },
        { location: "https://evil.example/x.jpg" },
        { location: "/carpicture00/x.jpg?redirect=1" },
        { location: paths[0] },
        ...paths.map((location) => ({ location })),
      ],
    });
    const photos = paths.slice(0, 10).map((path) => `https://ci.encar.com/carpicture${path}`);
    expect(car.photo_url).toBe(photos[0]);
    expect(car.photo_urls).toEqual(photos);
    expect(
      listing({ Photos: [{ location: "/carpicture00/x.jpg?redirect=1" }] }).photo_url,
    ).toBeNull();
  });

  it("distinguishes tail removals from lost interior pages", () => {
    expect(parsePage(document([ad()], 41), 3).pages).toBe(3);
    expect(parsePage(document([], 40), 3).listings).toEqual([]);
    expect(parsePage(document([], 41), 3).listings).toEqual([]);
    expect(parsePage(document([]))).toMatchObject({ total: 0, pages: 0, listings: [] });
    expect(() => parsePage(document([], 41))).toThrow(SourceError);
    expect(() => parsePage(document([ad()], 0))).toThrow(SourceError);
    expect(() => parsePage(document([ad()], 40), 3)).toThrow(SourceError);
    expect(() =>
      parsePage(
        document(
          Array.from({ length: 21 }, (_, id) => ad({ Id: String(id) })),
          41,
        ),
      ),
    ).toThrow(SourceError);
  });

  it("fails the whole page for malformed count, identities, titles and metadata", () => {
    for (const text of [
      "<html>blocked</html>",
      "{",
      "null",
      "[]",
      '{"Count":20,"SearchResults":{}}',
      '{"Count":true,"SearchResults":[]}',
      '{"Count":1.0,"SearchResults":[]}',
      '{"Count":-1,"SearchResults":[]}',
    ]) {
      expect(() => parsePage(text)).toThrow(SourceError);
    }
    for (const item of [
      null,
      ad({ Id: 100 }),
      ad({ Id: "100/other" }),
      ad({ Id: "" }),
      ad({ Manufacturer: "" }),
      ad({ Model: null }),
      ad({ Badge: 123 }),
      ad({ BadgeDetail: false }),
      ad({ SellType: true }),
      ad({ OfficeCityState: {} }),
    ]) {
      expect(() => parsePage(document([ad(), item]))).toThrow(SourceError);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid requested page %s",
    (page) => {
      expect(() => parsePage(document([]), page)).toThrow(SourceError);
    },
  );

  it("keeps the prepared source disabled without making any inventory request", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", undefined);
    const fetchDocument = vi.fn();
    const transport = { fetchDocument, fetchDocuments: vi.fn() } as DocumentTransport;
    await expect(fetchPage({ transport })).rejects.toThrow(SourceError);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("rejects invalid pages before transport even after approval", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,encar.com");
    const fetchDocument = vi.fn();
    const transport = { fetchDocument, fetchDocuments: vi.fn() } as DocumentTransport;
    await expect(fetchPage({ page: 0, transport })).rejects.toThrow(SourceError);
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("retains requested coverage and rejects malformed siblings through injected transport", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,encar.com");
    let body = document([ad()], 41);
    const transport: DocumentTransport = {
      async fetchDocument<T>(_url: string, parse: (text: string) => T): Promise<T> {
        return parse(body);
      },
      fetchDocuments: vi.fn(),
    };
    expect(await fetchPage({ page: 3, transport })).toMatchObject({
      page: 3,
      total: 41,
      pages: 3,
      scope: SCOPE,
    });
    body = document([ad(), ad({ Id: false })], 41);
    await expect(fetchPage({ page: 3, transport })).rejects.toThrow(SourceError);
  });
});
