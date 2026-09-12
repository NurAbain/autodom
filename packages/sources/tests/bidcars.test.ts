import { readFileSync } from "node:fs";
import {
  type DocumentOptions,
  type DocumentRequest,
  type DocumentTransport,
  listingPrice,
  makeProfile,
  matches,
  SourceError,
  SourceRateLimited,
} from "@autodom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG_URL, catalogUrl, fetchPage, parseCatalog, parseDetail } from "../src/bidcars.js";

const URL = "https://bid.cars/en/lot/1-66587646/1969-Alfa-Romeo-Duetto-AR1480400";
const MISSING_VIN_URL = "https://bid.cars/en/lot/0-46046054/1997-Suzuki-800-Intruder";
const MISSING_VIN_DETAIL = readFileSync(
  new globalThis.URL("./fixtures/bidcars-missing-vin.html", import.meta.url),
  "utf8",
);
function detail({
  ended = false,
  status,
  timezone = "(UTC+00:00) UTC",
  mileage = "59 197 mi (95 268 km)",
  image = "https://images.bid.cars/example.jpg",
}: {
  ended?: boolean;
  status?: string;
  timezone?: string;
  mileage?: string;
  image?: unknown;
} = {}): string {
  const vehicle = {
    "@type": "Vehicle",
    url: URL,
    name: "1969 Alfa Romeo Duetto | AR1480400 | BidCars",
    vehicleIdentificationNumber: "AR1480400",
    vehicleModelDate: "1969",
    vehicleTransmission: "Manual",
    vehicleEngine: { name: "" },
    image,
    offers: { price: "475", availability: "https://schema.org/OnlineOnly" },
  };
  const label = ended ? "Final bid" : "Current Bid";
  const amount = ended ? "13,350" : "450";
  status ??= ended ? "Final auction ended" : '<label id="time-left">3 d 23 h 43 min 16 sec</label>';
  const buy = ended
    ? ""
    : '<div class="buy-now-wr"><div><div class="field-name">Fast Buy Price:</div><div class="price">$38,500 USD</div></div><a>Buy Now</a></div>';
  return `<html><head><meta property="og:url" content="${URL}">
    <meta name="description" content="VIN: AR1480400 Lot: 1-66587646, Sale date: 2026-09-14 Location: Portland North (OR), USA | Odometer: 59 197 mi">
    <script type="application/ld+json">${JSON.stringify(vehicle)}</script></head><body>
    <div id="main-info"><div class="option">Lot<span class="right-info">1-<h2>66587646</h2></span></div>
    <div class="option">VIN<span class="right-info">AR1480400</span></div>
    <div class="option">Sale Document<span class="right-info"><span>Certificate of title (WI)</span><img alt="Approved"></span></div></div>
    <ul class="lot-info"><li class="location"><span>Location:</span>Portland North (OR)</li>
    <li class="est_price"><span>Estimated cost:</span><b>$475</b> - <b>$9,000</b></li></ul>
    <div id="secondary-info"><div class="option">Odometer<span class="right-info">${mileage}</span></div>
    <div class="option">Primary damage<span class="right-info">Minor dent / scratches</span></div>
    <div class="option">Secondary damage<span class="right-info">Normal wear</span></div>
    <div class="option start_code">Start code<span class="right-info">Run and Drive</span></div></div>
    <div id="tertiary-info"></div>
    <div id="bidding-info"><div class="lot-price-info"><div><div class="field-name">${label}</div>
    <span class="price current_bid">$${amount} USD</span></div></div>
    <div class="bid-status">${status}</div>${buy}</div>
    <div id="history"><span class="current_bid">$999999</span>Final auction ended</div>
    <ul class="links-footer"><li><button>${timezone}</button></li></ul>
    <script>
var lotNumber = '1-66587646';
var isArchived = 0;
var currentBid = ${ended ? 0 : 450};
var finalBid = ${ended ? 13350 : 0};
var estimatedAmount1 = 475;
var estimatedAmount2 = 9000;
var buyNowAmount = ${ended ? 0 : 38500};
var auctionType = 'Copart';
var liveAuctionStartDateTime = '2026-09-14 21:00:00';
    </script></body></html>`;
}
function archivedDetail(): string {
  return detail({ ended: true })
    .replace(" | BidCars", " | Bid History | BidCars")
    .replace("https://images.bid.cars/", "https://mercury.bid.cars/")
    .replace(
      '<div class="bid-status">Final auction ended</div>',
      '<div id="archieved-message">You are watching archived offer. Auction ended.</div>',
    )
    .replace(
      '<li class="est_price"><span>Estimated cost:</span><b>$475</b> - <b>$9,000</b></li>',
      "",
    )
    .replace("var estimatedAmount1 = 475", "var estimatedAmount1 = 0")
    .replace("var estimatedAmount2 = 9000", "var estimatedAmount2 = 0")
    .replace("var isArchived = 0", "var isArchived = 1");
}
function row(url = URL, lot = "1-66587646", title = "1969 Alfa Romeo Duetto"): string {
  return `<div class="item-horizontal lots-search" id="${lot}">
    <a class="gallery" href="https://bid.cars/en/lot/0-111/Unrelated">Decorative</a>
    <div class="name"><a class="item-title" href="${url}">${title}</a></div>
    <h2 class="vin_title"><a href="${url}">AR1480400</a></h2>
    <span class="vin_title">${lot}</span><span>52k mi</span></div>`;
}
function catalog(rows = [row()], { page = 1, pages = 1, base = CATALOG_URL } = {}): string {
  const prefix = base.slice(0, base.lastIndexOf("/") + 1);
  const url = prefix + page;
  const links = Array.from({ length: pages }, (_, i) => i + 1)
    .map((number) =>
      number === page
        ? `<li class="active"><a href="#">${number}</a></li>`
        : `<li><a href="${prefix}${number}">${number}</a></li>`,
    )
    .join("");
  return `<html><head><meta property="og:url" content="${url}"><link rel="canonical" href="${url}"></head><body>
    <div id="search_area">${rows.join("")}</div><div class="breadcrumbs"><ul>${links}</ul></div>
    <div class="recommended">${row("https://bid.cars/en/lot/0-123/Other", "0-123")}</div>
    <span>385281 Live auctions</span></body></html>`;
}
function transportFor(
  documents: Record<string, string | Error>,
  calls: string[] = [],
): DocumentTransport {
  return {
    async fetchDocument<T>(
      url: string,
      parse: (text: string) => T,
      _options: DocumentOptions,
    ): Promise<T> {
      calls.push(url);
      const value = documents[url];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Unexpected document: ${url}`);
      return parse(value);
    },
    async fetchDocuments<T>(requests: readonly DocumentRequest<T>[]): Promise<T[]> {
      return Promise.all(
        requests.map((request) => this.fetchDocument(request.url, request.parse, request.options)),
      );
    },
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Bid.Cars detail", () => {
  it("uses corroborated DOM identity when the source omits VIN and Vehicle JSON-LD", () => {
    const listing = parseDetail(MISSING_VIN_DETAIL, MISSING_VIN_URL)!;
    expect(listing).toMatchObject({
      id: "bidcars:0-46046054",
      title: "1997 Suzuki 800 Intruder",
      year: 1997,
      vin: "",
      mileage: "",
      auction_lot: "0-46046054",
      auction_house: "IAAI",
      city: "Englishtown (NJ)",
      current_bid_minor: 0,
    });
    expect(listingPrice(listing, "USD")).toBeNull();
  });
  it("combines provided VIN evidence without treating absent structured VIN as a contradiction", () => {
    const html = detail().replace(
      '"vehicleIdentificationNumber":"AR1480400"',
      '"vehicleIdentificationNumber":null',
    );
    expect(parseDetail(html, URL)?.vin).toBe("AR1480400");
    const unknown = html
      .replace("Duetto | AR1480400 |", "Duetto |  |")
      .replace("VIN: AR1480400 Lot:", "VIN:  Lot:")
      .replace('class="right-info">AR1480400', 'class="right-info">');
    expect(parseDetail(unknown, URL)?.vin).toBe("");
    expect(() =>
      parseDetail(
        html.replace('"vehicleIdentificationNumber":null', '"vehicleIdentificationNumber":123'),
        URL,
      ),
    ).toThrow(SourceError);
  });
  it("rejects provided malformed or conflicting VINs and independent identity conflicts without JSON-LD", () => {
    for (const html of [
      MISSING_VIN_DETAIL.replace(
        '<span class="vin-drop"></span>',
        '<span class="vin-drop">bad!</span>',
      ),
      MISSING_VIN_DETAIL.replace(
        '<span class="vin-drop"></span>',
        '<span class="vin-drop">AR1480400</span>',
      ).replace("VIN:  Lot:", "VIN: AR1480401 Lot:"),
      MISSING_VIN_DETAIL.replace('class="title_lot">1997 Suzuki', 'class="title_lot">1997 Other'),
      MISSING_VIN_DETAIL.replace("var auctionType = 'IAAI'", "var auctionType = 'Copart'"),
      MISSING_VIN_DETAIL.replace("var lotNumber = '0-46046054'", "var lotNumber = '0-46046055'"),
      MISSING_VIN_DETAIL.replace(
        `property="og:url" content="${MISSING_VIN_URL}"`,
        `property="og:url" content="${URL}"`,
      ),
    ]) {
      expect(() => parseDetail(html, MISSING_VIN_URL)).toThrow(SourceError);
    }
  });
  it("keeps primary attributes separate from supplemental platform specifications", () => {
    const html = detail().replace(
      '<div id="tertiary-info"></div>',
      `<div id="tertiary-info">
        <div class="option">Body Style<span class="right-info">Sedan</span></div>
        <div class="more-specs">
          <div class="option">Body Style<span class="right-info">Saloon</span></div>
        </div>
      </div>`,
    );
    expect(parseDetail(html, URL)?.body_type).toBe("Sedan");
    expect(() =>
      parseDetail(
        html.replace(
          '<div class="more-specs">',
          '<div class="option">Body Style<span class="right-info">Wagon</span></div><div class="more-specs">',
        ),
        URL,
      ),
    ).toThrow(SourceError);
  });
  it("separates buy-now, current and estimate amounts while preserving an old chassis and actual odometer", () => {
    const listing = parseDetail(detail(), URL)!;
    expect(listing).toMatchObject({
      id: "bidcars:1-66587646",
      vin: "AR1480400",
      original_price_minor: 3_850_000,
      current_bid_minor: 45_000,
      estimated_min_minor: 47_500,
      estimated_max_minor: 900_000,
      mileage: "59197 miles",
      auction_at: Date.UTC(2026, 8, 14, 21) / 1000,
      start_code: "Run and Drive",
      sale_document: "Certificate of title (WI)",
      auction_status: "active",
    });
    expect(listing.condition).toContain("аукциона");
  });
  it("retains final auction history but never exposes a purchase price", () => {
    const listing = parseDetail(detail({ ended: true }), URL)!;
    expect(listing).toMatchObject({
      final_bid_minor: 1_335_000,
      auction_status: "ended",
      availability: "Завершено",
      original_price_minor: null,
    });
    expect(listingPrice(listing, "USD")).toBeNull();
  });
  it("accepts a single displayed estimate only when both declared bounds agree", () => {
    const html = detail({ ended: true })
      .replace("<b>$475</b> - <b>$9,000</b>", "<b>$475</b>")
      .replace("var estimatedAmount2 = 9000", "var estimatedAmount2 = 475");
    const listing = parseDetail(html, URL)!;
    expect(listing).toMatchObject({
      estimated_min_minor: 47_500,
      estimated_max_minor: 47_500,
      auction_status: "ended",
    });
    expect(listingPrice(listing, "USD")).toBeNull();
    expect(() =>
      parseDetail(html.replace("var estimatedAmount2 = 475", "var estimatedAmount2 = 9000"), URL),
    ).toThrow(SourceError);
  });
  it("accepts evidenced archived results without live status or estimate, not unrelated archive text", () => {
    const listing = parseDetail(archivedDetail(), URL)!;
    expect(listing).toMatchObject({
      title: "1969 Alfa Romeo Duetto",
      final_bid_minor: 1_335_000,
      auction_status: "ended",
      current_bid_minor: null,
      estimated_min_minor: null,
      estimated_max_minor: null,
    });
    expect(listingPrice(listing, "USD")).toBeNull();
    expect(() =>
      parseDetail(archivedDetail().replace("archieved-message", "unrelated"), URL),
    ).toThrow(SourceError);
  });
  it("preserves a known zero current bid without treating it as a purchase price", () => {
    expect(
      parseDetail(
        detail()
          .replace("$450 USD", "$0 USD")
          .replace("var currentBid = 450", "var currentBid = 0"),
        URL,
      ),
    ).toMatchObject({
      current_bid_minor: 0,
      original_price_minor: 3_850_000,
      final_bid_minor: null,
    });
  });
  it("uses source Body Style for consumer body filtering", () => {
    const listing = parseDetail(
      detail().replace(
        '<div id="tertiary-info">',
        '<div id="tertiary-info"><div class="option">Body Style<span class="right-info">Sport Utility</span></div>',
      ),
      URL,
    )!;
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    vi.useFakeTimers();
    vi.setSystemTime(new Date((listing.auction_at! - 60) * 1000));
    const profile = makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 4_000_000,
      market: "US",
      body_type: "suv",
    });
    expect(matches(profile, listing)).toBe(true);
    expect(matches({ ...profile, body_type: "sedan" }, listing)).toBe(false);
  });
  it("does not use OnlineOnly or structured offers.price as proof of a sale", () => {
    expect(parseDetail(detail({ status: "Preliminary auction ended" }), URL)).toMatchObject({
      auction_status: "unknown",
      original_price_minor: null,
    });
    expect(
      parseDetail(detail().replace("<a>Buy Now</a>", "<a disabled>Buy Now</a>"), URL),
    ).toMatchObject({ original_price_minor: null, buy_now_minor: 3_850_000 });
  });
  it.each(["", "(UTC+02:00) Europe/Warsaw", "(UTC+00:00) UTC (UTC+02:00) GMT+2"])(
    "requires explicit unambiguous UTC evidence: %s",
    (timezone) => {
      const listing = parseDetail(detail({ timezone }), URL)!;
      expect(listing.auction_at).toBeNull();
      expect(listingPrice(listing, "USD")).toBeNull();
    },
  );
  it("does not normalize impossible calendar dates into purchase deadlines", () => {
    expect(
      parseDetail(detail().replace("2026-09-14 21:00:00", "2026-02-30 21:00:00"), URL)!.auction_at,
    ).toBeNull();
  });
  it("never promotes rounded odometer values to exact mileage", () => {
    expect(parseDetail(detail({ mileage: "52k mi" }), URL)!.mileage).toBe("");
    expect(parseDetail(detail({ mileage: "95,268 km" }), URL)!.mileage).toBe("95268 km");
  });
  it("does not turn an explicitly unknown odometer placeholder into measured mileage", () => {
    expect(parseDetail(detail({ mileage: "999 999 mi (unknown)" }), URL)!.mileage).toBe("");
  });
  it.each([
    ["var lotNumber = '1-66587646'", "var lotNumber = '1-12345678'"],
    ["var currentBid = 450", "var currentBid = 475"],
    ["var buyNowAmount = 38500", "var buyNowAmount = 38501"],
    ["var estimatedAmount1 = 475", "var estimatedAmount1 = 476"],
    ["var currentBid = 450", "var currentBid = calculate()"],
    ["var auctionType = 'Copart'", "var auctionType = 'IAAI'"],
    ["var isArchived = 0", "var isArchived = 2"],
    ["var currentBid = 450", "var currentBid = 450;\nvar currentBid = 475;"],
    ["var buyNowAmount = 38500", "var buyNowAmount = 1000000000001"],
    ["var currentBid = 450", "var currentBid = 450.001"],
    ["var finalBid = 0;", ""],
  ])("fails closed on conflicting or invalid declaration: %s", (before, after) => {
    expect(() => parseDetail(detail().replace(before, after), URL)).toThrow(SourceError);
  });
  it("recognizes IAAI identities without assuming Copart", () => {
    const url = URL.replace("1-66587646", "0-66587646");
    expect(
      parseDetail(
        detail()
          .replaceAll("1-66587646", "0-66587646")
          .replace("1-<h2>", "0-<h2>")
          .replace("'Copart'", "'IAAI'"),
        url,
      ),
    ).toMatchObject({ auction_house: "IAAI", auction_lot: "0-66587646" });
  });
  it("excludes Canada but rejects unproven or contradictory US-yard identity", () => {
    expect(
      parseDetail(
        detail().replaceAll("Portland North (OR)", "Toronto (ON)").replace(", USA |", ", Canada |"),
        URL,
      ),
    ).toBeNull();
    for (const html of [
      detail().replace(", USA |", " |"),
      detail().replaceAll("Portland North (OR)", "Toronto (ON)"),
      detail().replace("VIN: AR1480400", "VIN: AR1480401"),
      detail().replace("Location:</span>Portland North", "Location:</span>Other"),
    ]) {
      expect(() => parseDetail(html, URL)).toThrow(SourceError);
    }
  });
  it("fails on incomplete documents, missing required blocks, and contradictory title/VIN/URL", () => {
    for (const html of [
      detail().replace('id="secondary-info"', 'id="changed-info"'),
      detail().replace("</html>", ""),
      detail().replace("Duetto | AR1480400", "Duetto | AR1480401"),
      detail().replace(
        '"vehicleIdentificationNumber":"AR1480400"',
        '"vehicleIdentificationNumber":"AR1480401"',
      ),
      detail().replace(`"url":"${URL}"`, '"url":"https://bid.cars/en/lot/0-123/Other"'),
    ]) {
      expect(() => parseDetail(html, URL)).toThrow(SourceError);
    }
  });
  it("keeps explicitly unknown values empty without invented condition or deadline claims", () => {
    const listing = parseDetail(
      detail({ mileage: "No information" })
        .replace("Normal wear", "-")
        .replace("Run and Drive", "No information")
        .replace(
          "var liveAuctionStartDateTime = '2026-09-14 21:00:00'",
          "var liveAuctionStartDateTime = ''",
        ),
      URL,
    )!;
    expect(listing).toMatchObject({
      mileage: "",
      secondary_damage: "",
      start_code: "",
      auction_at: null,
    });
    expect(listingPrice(listing, "USD")).toBeNull();
  });
  it("accepts only the evidenced photo hosts", () => {
    for (const host of ["images.bid.cars", "mercury.bid.cars", "pluto.bid.car"]) {
      expect(parseDetail(detail().replace("images.bid.cars", host), URL)!.photo_url).toBe(
        `https://${host}/example.jpg`,
      );
    }
    const photos = Array.from({ length: 12 }, (_, index) => `https://images.bid.cars/${index}.jpg`);
    const car = parseDetail(
      detail({
        image: [
          null,
          {},
          "https://images.bid.cars.evil.test/a.jpg",
          "https://user@images.bid.cars/a.jpg",
          "https://images.bid.cars:443/a.jpg",
          "https://images.bid.cars/a.jpg#fragment",
          "https://images.bid.cars/a.jpg?redirect=1",
          "http://images.bid.cars/a.jpg",
          photos[0],
          ...photos,
        ],
      }),
      URL,
    )!;
    expect(car.photo_url).toBe(photos[0]);
    expect(car.photo_urls).toEqual(photos.slice(0, 10));
    expect(
      parseDetail(detail({ image: "https://images.bid.cars.evil.test/a.jpg" }), URL)!.photo_url,
    ).toBeNull();
  });
});

describe("Bid.Cars catalog", () => {
  it("discovers only identified rows and collapses identical duplicates, not recommendation links or global totals", () => {
    const result = parseCatalog(catalog([row(), row()], { pages: 3 }));
    expect(result.urls).toEqual([URL]);
    expect(result).toMatchObject({ page: 1, pages: 3, total: null });
  });
  it("uses current-page evidence when the SEO canonical names the first page of the same scope", () => {
    const second = CATALOG_URL.replace("/page/1", "/page/2");
    const html = catalog(undefined, { page: 2, pages: 3 }).replace(
      `rel="canonical" href="${second}"`,
      `rel="canonical" href="${CATALOG_URL}"`,
    );
    expect(parseCatalog(html, 2)).toMatchObject({ page: 2, pages: 3, urls: [URL] });
    expect(() =>
      parseCatalog(
        html.replace(
          `property="og:url" content="${second}"`,
          `property="og:url" content="${CATALOG_URL}"`,
        ),
        2,
      ),
    ).toThrow(SourceError);
  });
  it("accepts a non-link range separator without weakening pagination scope", () => {
    const html = catalog(undefined, { page: 4, pages: 5 }).replace(
      "</ul>",
      '<li><a href="#">-</a></li></ul>',
    );
    expect(parseCatalog(html, 4)).toMatchObject({ page: 4, pages: 5, urls: [URL] });
    expect(() =>
      parseCatalog(html.replace('href="#">-', 'href="https://example.com/">-'), 4),
    ).toThrow(SourceError);
  });
  it("rejects page, scope, row, and duplicate identity conflicts as whole-page failures", () => {
    for (const html of [
      catalog(undefined, { page: 2, pages: 3 }),
      catalog().replace(
        'rel="canonical" href="https://bid.cars/en/automobile/page/1"',
        'rel="canonical" href="https://bid.cars/en/automobile/toyota/page/1"',
      ),
      catalog([row(), row(URL, "1-66587646", "1969 Conflicting vehicle")]),
      catalog([row(URL, "1-99999999")]),
      catalog([row("https://bid.cars/app/lot/1-66587646")]),
      catalog().replace("item-horizontal lots-search", "item-horizontal changed"),
      catalog().replace('<a href="#">1</a>', '<a href="#">2</a>'),
      catalog([row().replace(">AR1480400</a>", ">bad</a>")]),
    ]) {
      expect(() => parseCatalog(html)).toThrow(SourceError);
    }
  });
  it("retains an otherwise identified catalog row with an absent VIN as unknown", () => {
    // Reduced from /en/automobile/page/17: lot 0-46046054 also has no VIN on its detail page.
    const missingVin = `<div class="item-horizontal lots-search" id="0-46046054">
      <div class="name"><a href="https://bid.cars/en/lot/0-46046054/1997-Suzuki-800-Intruder" class="item-title damage-info">1997 Suzuki 800 Intruder</a></div>
      <h2 class="vin_title"><a href="https://bid.cars/en/lot/0-46046054/1997-Suzuki-800-Intruder"></a></h2>
      <span class="vin_title">0-46046054</span>
    </div>`;
    expect(parseCatalog(catalog([row(), missingVin], { page: 17, pages: 18 }), 17).lots).toEqual([
      { lot: "1-66587646", url: URL, title: "1969 Alfa Romeo Duetto", vin: "AR1480400" },
      { lot: "0-46046054", url: MISSING_VIN_URL, title: "1997 Suzuki 800 Intruder", vin: "" },
    ]);
  });
  it("merges absent duplicate VIN evidence without losing a provided VIN or accepting disagreement", () => {
    const absent = row().replace("AR1480400</a>", "</a>");
    expect(parseCatalog(catalog([absent, row(), absent])).lots).toEqual([
      { lot: "1-66587646", url: URL, title: "1969 Alfa Romeo Duetto", vin: "AR1480400" },
    ]);
    expect(() =>
      parseCatalog(catalog([absent, row(), row().replace("AR1480400</a>", "AR1480401</a>")])),
    ).toThrow(SourceError);
  });
  it("accepts an empty terminal page but not an empty interior or unrecognized page", () => {
    expect(parseCatalog(catalog([]))).toMatchObject({ urls: [], total: null });
    expect(() => parseCatalog(catalog([], { pages: 2 }))).toThrow(SourceError);
    expect(() => parseCatalog(catalog(["<div>Changed schema</div>"]))).toThrow(SourceError);
  });
  it("accepts filtered public catalogs with bound pagination", () => {
    const base = "https://bid.cars/en/automobile/alfa-romeo/duetto/page/1";
    vi.stubEnv("AUTODOM_BIDCARS_CATALOG_URL", base);
    expect(catalogUrl()).toBe(base);
    expect(
      parseCatalog(catalog(undefined, { base, page: 2, pages: 3 }), 2, { catalogUrl: base }),
    ).toMatchObject({ page: 2, pages: 3 });
  });
  it.each([
    "http://bid.cars/en/automobile/page/1",
    "https://bid.cars:443/en/automobile/page/1",
    "https://user@bid.cars/en/automobile/page/1",
    "https://bid.cars/en/automobile/page/2",
    "https://bid.cars/en/automobile/page/1?",
    "https://bid.cars/en/automobile/%2e%2e/page/1",
    "https://bid.cars/en/search/results?query=Toyota",
  ])("rejects catalog scope escapes: %s", (url) => {
    vi.stubEnv("AUTODOM_BIDCARS_CATALOG_URL", url);
    expect(() => catalogUrl()).toThrow(SourceError);
  });
  it("bounds the page and detail count before fetching", () => {
    for (const page of [0, -1, 1.5, NaN, 10_000_000])
      expect(() => parseCatalog(catalog(), page)).toThrow(SourceError);
    expect(() => parseCatalog(catalog(Array.from({ length: 101 }, () => row())))).toThrow(
      SourceError,
    );
  });
});

describe("Bid.Cars fetch", () => {
  it("returns all identified lots when VIN is absent and retains a VIN supplied only by detail", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const unknown = row(MISSING_VIN_URL, "0-46046054", "1997 Suzuki 800 Intruder").replace(
      "AR1480400</a>",
      "</a>",
    );
    const result = await fetchPage({
      transport: transportFor({
        [CATALOG_URL]: catalog([row().replace("AR1480400</a>", "</a>"), unknown]),
        [URL]: detail(),
        [MISSING_VIN_URL]: MISSING_VIN_DETAIL,
      }),
    });
    expect(result.listings.map(({ id, vin }) => ({ id, vin }))).toEqual([
      { id: "bidcars:1-66587646", vin: "AR1480400" },
      { id: "bidcars:0-46046054", vin: "" },
    ]);
  });
  it("retains a provided catalog VIN when detail VIN is unknown after corroborating lot identity", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const result = await fetchPage({
      transport: transportFor({
        [CATALOG_URL]: catalog([row(MISSING_VIN_URL, "0-46046054", "1997 Suzuki 800 Intruder")]),
        [MISSING_VIN_URL]: MISSING_VIN_DETAIL,
      }),
    });
    expect(result.listings.map(({ id, vin }) => ({ id, vin }))).toEqual([
      { id: "bidcars:0-46046054", vin: "AR1480400" },
    ]);
  });
  it("gates before any network access", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    const calls: string[] = [];
    await expect(fetchPage({ transport: transportFor({}, calls) })).rejects.toThrow(SourceError);
    expect(calls).toEqual([]);
  });
  it("fetches identified details as one bounded scheduler batch and preserves unknown scope total", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const calls: string[] = [];
    const transport = transportFor(
      { [CATALOG_URL]: catalog([row(), row()]), [URL]: detail() },
      calls,
    );
    const batch = vi.spyOn(transport, "fetchDocuments");
    const result = await fetchPage({ transport });
    expect(result.listings.map((listing) => listing.id)).toEqual(["bidcars:1-66587646"]);
    expect(result.total).toBeNull();
    expect(calls).toEqual([CATALOG_URL, URL]);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it("decodes structured title entities before matching the catalog without interpreting markup", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const encoded = "1969 Alfa Romeo Duetto, 5&#039;7&nbsp;&amp;&nbsp;&lt;Prototype&gt;";
    const result = await fetchPage({
      transport: transportFor({
        [CATALOG_URL]: catalog([row(URL, "1-66587646", encoded)]),
        [URL]: detail().replaceAll("1969 Alfa Romeo Duetto", encoded),
      }),
    });
    expect(result.listings[0]?.title).toBe("1969 Alfa Romeo Duetto, 5'7 & <Prototype>");
  });
  it("uses the full detail identity when the catalog visibly truncates the trim", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    const title = "1969 Alfa Romeo Duetto, 1750 Veloce Spider";
    const result = await fetchPage({
      transport: transportFor({
        [CATALOG_URL]: catalog([row(URL, "1-66587646", "1969 Alfa Romeo Duetto, 1750 Vel...")]),
        [URL]: detail().replaceAll("1969 Alfa Romeo Duetto", title),
      }),
    });
    const profile = makeProfile({
      user_id: 0,
      chat_id: 0,
      market: "US",
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 4_000_000,
      budget_scope: "car",
      allow_import: true,
      query: "Veloce Spider",
    });
    expect(
      result.listings.filter((listing) => matches(profile, listing)).map((listing) => listing.id),
    ).toEqual(["bidcars:1-66587646"]);
    await expect(
      fetchPage({
        transport: transportFor({
          [CATALOG_URL]: catalog([row(URL, "1-66587646", "1969 Other car...")]),
          [URL]: detail(),
        }),
      }),
    ).rejects.toBeInstanceOf(SourceError);
  });
  it("propagates detail rate limiting instead of returning a partial page", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const second = "https://bid.cars/en/lot/1-11111111/Other-AR1480400";
    const calls: string[] = [];
    await expect(
      fetchPage({
        transport: transportFor(
          {
            [CATALOG_URL]: catalog([row(), row(second, "1-11111111")]),
            [URL]: detail(),
            [second]: new SourceRateLimited(300),
          },
          calls,
        ),
      }),
    ).rejects.toThrow(SourceRateLimited);
    expect(calls).toEqual([CATALOG_URL, URL, second]);
  });
  it("rejects catalog/detail title or VIN disagreements before returning results", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    for (const html of [
      catalog([row(URL, "1-66587646", "1969 Other car")]),
      catalog().replaceAll("AR1480400</a>", "AR1480401</a>"),
    ]) {
      await expect(
        fetchPage({ transport: transportFor({ [CATALOG_URL]: html, [URL]: detail() }) }),
      ).rejects.toThrow(SourceError);
    }
  });
  it("omits evidenced Canadian details without inventing scope totals", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const result = await fetchPage({
      transport: transportFor({
        [CATALOG_URL]: catalog(),
        [URL]: detail()
          .replaceAll("Portland North (OR)", "Toronto (ON)")
          .replace(", USA |", ", Canada |"),
      }),
    });
    expect(result.listings).toEqual([]);
    expect(result.total).toBeNull();
  });
});
