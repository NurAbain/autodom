import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ProxyRoute } from "@autodom/core";
import type { VinArchivePhotoRequest } from "@autodom/core/vin-archive";
import { Response } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { BidCarsArchive } from "../src/bidcars-archive.js";
import type { BrowserClient } from "../src/cloudflare-browser.js";

const VIN = "1FTFW1ED9NFB06106";
const LOT = "https://bid.cars/en/lot/0-45397077/2022-Ford-F-150-1FTFW1ED9NFB06106";
const PHOTO = "https://mercury.bid.cars/0-45397077/2022-Ford-F-150-1FTFW1ED9NFB06106-1.jpg";
const SEARCH = `https://bid.cars/app/search/archived/request?search-type=typing&query=${VIN}`;
const DISCOVER = `https://bid.cars/app/search/en/vin-lot/${VIN}/true`;
const PHOTO_REQUEST: VinArchivePhotoRequest = {
  vin: VIN,
  provider: "bidcars",
  auction: "iaai",
  lot_id: "45397077",
  photo_url: PHOTO,
};
interface SearchFixture {
  data: Record<string, unknown>[];
  next_page_url: string | null;
  per_page: number;
}
const html = readFileSync(
  new URL("./fixtures/bidcars-archive/ford-detail.html", import.meta.url),
  "utf8",
);
function rows(): SearchFixture {
  return JSON.parse(
    readFileSync(new URL("./fixtures/bidcars-archive/ford-search.json", import.meta.url), "utf8"),
  );
}
const services: BidCarsArchive[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function setup(
  options: {
    search?: SearchFixture;
    detail?: string;
    discoveryResults?: number;
    image?: (url: URL) => Response | Promise<Response>;
    fetch?: BrowserClient["fetch"];
  } = {},
) {
  const requests: string[] = [];
  const browser: BrowserClient = {
    async fetch(url, init) {
      requests.push(url.href);
      expect(init.redirect).toBe("manual");
      if (options.fetch) return options.fetch(url, init);
      if (url.href === DISCOVER)
        return new Response(JSON.stringify({ results: options.discoveryResults ?? 1, url: LOT }));
      if (url.href === SEARCH) return new Response(JSON.stringify(options.search ?? rows()));
      if (url.href === LOT) return new Response(options.detail ?? html);
      if (url.origin === "https://mercury.bid.cars")
        return (
          options.image?.(url) ??
          new Response(Buffer.from([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0]), { status: 206 })
        );
      throw new Error(`Unexpected request ${url.href}`);
    },
    async refresh() {
      throw new Error("Archive must never submit clearance refresh");
    },
  };
  const service = new BidCarsArchive({
    routes: [new ProxyRoute("residential", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
    requestDelaySeconds: 0,
    browserClientFactory: () => browser,
  });
  services.push(service);
  return { service, requests };
}

describe("Bid.Cars photo downloads", () => {
  it("downloads through the configured browser without Range and rejects redirects", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
      "base64",
    );
    let redirected = false;
    const { service, requests } = setup({
      fetch: async (_url, init) => {
        expect(new Headers(init.headers).has("Range")).toBe(false);
        return redirected
          ? new Response(null, { status: 302, headers: { Location: "https://evil.invalid" } })
          : new Response(bytes, { headers: { "Content-Type": "image/png" } });
      },
    });
    const authorization = new AbortController();
    const authorize = () => authorization.signal.throwIfAborted();
    expect(await service.getPhoto(PHOTO_REQUEST, new AbortController().signal, authorize)).toEqual({
      bytes,
      content_type: "image/png",
    });
    redirected = true;
    await expect(
      service.getPhoto(PHOTO_REQUEST, new AbortController().signal, authorize),
    ).rejects.toThrow();
    authorization.abort();
    await expect(
      service.getPhoto(PHOTO_REQUEST, new AbortController().signal, authorize),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual([PHOTO, PHOTO]);
  });

  it("shares three image slots between downloads and probes and cancels queued work", async () => {
    const occupied = Promise.withResolvers<void>();
    const probed = Promise.withResolvers<void>();
    const detailServed = Promise.withResolvers<void>();
    let probes = 0;
    let activeImages = 0;
    let peak = 0;
    let downloads = 0;
    const { service } = setup({
      fetch: async (url, init) => {
        if (url.href === DISCOVER) return new Response(JSON.stringify({ results: 1, url: LOT }));
        if (url.href === SEARCH) return new Response(JSON.stringify(rows()));
        if (url.href === LOT) {
          detailServed.resolve();
          return new Response(html);
        }
        activeImages++;
        peak = Math.max(peak, activeImages);
        try {
          if (new Headers(init.headers).has("Range")) {
            probes++;
            probed.resolve();
            return new Response(Buffer.from([255, 216, 255, 224]), { status: 206 });
          }
          if (++downloads === 3) occupied.resolve();
          const pending = Promise.withResolvers<Response>();
          init.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), {
            once: true,
          });
          return await pending.promise;
        } finally {
          activeImages--;
        }
      },
    });
    const abort = new AbortController();
    const authorize = () => abort.signal.throwIfAborted();
    const pending = Array.from({ length: 4 }, () =>
      service.getPhoto(PHOTO_REQUEST, abort.signal, authorize),
    );
    const rejected = Promise.all(
      pending.map((promise) => expect(promise).rejects.toMatchObject({ name: "AbortError" })),
    );
    await occupied.promise;
    const lookup = service.check(VIN, new AbortController().signal);
    await detailServed.promise;
    await nextTurn();
    expect(probes).toBe(0);
    abort.abort();
    await rejected;
    await probed.promise;
    expect((await lookup).status).toBe("available");
    expect(downloads).toBe(3);
    expect(peak).toBe(3);
    await service.close();
    await expect(
      service.getPhoto(PHOTO_REQUEST, new AbortController().signal, authorize),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads).toBe(3);
  });
});

describe("Bid.Cars exact VIN archive", () => {
  it("retains the source miles, title and start evidence from the English BMW card", async () => {
    // Captured 2026-09-16 from this canonical English URL (not the Russian card).
    const vin = "WBAJA9C56KB389776";
    const url = `https://bid.cars/en/lot/1-77230345/2019-BMW-5-Series-${vin}`;
    const detail = readFileSync(
      new URL("./fixtures/bidcars-archive/bmw-detail.html", import.meta.url),
      "utf8",
    );
    const { service } = setup({
      fetch: async (request) => {
        if (request.pathname === `/app/search/en/vin-lot/${vin}/true`)
          return new Response(JSON.stringify({ results: 1, url }));
        if (request.pathname === "/app/search/archived/request")
          return new Response(JSON.stringify({ ...rows(), data: [], next_page_url: null }));
        if (request.href === url) return new Response(detail);
        if (request.origin === "https://mercury.bid.cars")
          return new Response(Buffer.from([255, 216, 255, 224]), { status: 206 });
        throw new Error(`Unexpected request ${request.href}`);
      },
    });
    const result = await service.check(vin, new AbortController().signal);
    expect(result.lots[0]).toMatchObject({
      lot_id: "77230345",
      details: {
        make: "BMW",
        model: "5 Series",
        model_year: 2019,
        odometer: { value: 164957, unit: "mi" },
        primary_damage: "Minor dent / scratches",
        title: "Dis/dlr/exp clean w/salv hist (CA)",
        keys_present: true,
        start_status: "Run and Drive",
        engine: "2.0L 4",
        transmission: "Automatic",
        drive: "Rear wheel drive",
        color: "Black",
      },
    });
    expect(result.lots[0]?.details).not.toHaveProperty("secondary_damage");
    expect(result.lots[0]?.details).not.toHaveProperty("asking_price");
    expect(result.lots[0]?.reports).toBeUndefined();
  });

  it("uses IAAI specifications instead of model decoding or adjacent vehicle metadata", async () => {
    // Native IAAI specifications say Hybrid/400HP, while Bid.Cars' generic panel says Gasoline/430HP.
    const metadata = readFileSync(
      new URL("./fixtures/bidcars-archive/ford-metadata.html", import.meta.url),
      "utf8",
    );
    const { service } = setup({
      detail: html.replace(
        "</body>",
        `${metadata}<div class="option">Odometer<span class="right-info">1 km</span></div></body>`,
      ),
    });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result.lots[0]?.details).toMatchObject({
      odometer: { value: 100588, unit: "mi" },
      loss_type: "Collision",
      primary_damage: "Front end",
      start_status: "Stationary",
      keys_present: true,
      fuel: "Hybrid",
      drive: "4x4",
      body_style: "Crew Cab",
      engine: "3.5L V-6 DI, DOHC, VVT, turbo, 400HP",
    });
  });

  it.each([
    ["0 km", "Missing", { value: 0, unit: "km" }, false],
    ["-", "-", undefined, undefined],
    ["999999", "Unknown", undefined, undefined],
  ])(
    "does not turn %s odometer/key uncertainty into a zero or false fact",
    async (odometer, key, expected, keys) => {
      const metadata = `<div id="secondary-info"><div class="option">Odometer<span class="right-info">${odometer}</span></div><div class="option">Key<span class="right-info">${key}</span></div></div>`;
      const { service } = setup({ detail: html.replace("</body>", `${metadata}</body>`) });
      const result = await service.check(VIN, new AbortController().signal);
      expect(result.lots[0]?.details?.odometer).toEqual(expected);
      expect(result.lots[0]?.details?.keys_present).toBe(keys);
      expect(result.lots[0]?.events).toContainEqual({
        status: "sold",
        auction_at: null,
        auction_date: "2026-09-12",
        final_bid_usd_minor: 1550000,
      });
    },
  );

  it("recovers versioned photos through native fast search when both VIN lookups are ambiguous", async () => {
    let fastUrl = LOT.replace("/en/lot/", "/lot/");
    const { service, requests } = setup({
      fetch: async (url) => {
        if (url.pathname.startsWith("/app/search/en/vin-lot/"))
          return new Response(
            JSON.stringify({
              results: 2,
              url: `https://bid.cars/en/search/archived/results?search-type=typing&query=${VIN}`,
            }),
          );
        if (url.href === SEARCH)
          return new Response(JSON.stringify({ ...rows(), data: [], per_page: 1 }));
        if (url.pathname === `/app/search/fast/${VIN}`)
          return new Response(JSON.stringify({ status: "ok", url: fastUrl }));
        if (url.href === LOT)
          return new Response(
            html.replaceAll(/(https:\/\/mercury\.bid\.cars\/[^"]+\.jpg)"/gu, '$1?ver=0337"'),
          );
        if (url.origin === "https://mercury.bid.cars")
          return new Response(Buffer.from([255, 216, 255, 224]), { status: 206 });
        throw new Error(`Untrusted discovery must not be requested: ${url.href}`);
      },
    });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result).toMatchObject({
      status: "available",
      partial: true,
      lots: [{ auction: "iaai", lot_id: "45397077", photos_complete: true }],
    });
    expect(result.lots[0]?.photos).toEqual(
      Array.from({ length: 16 }, (_, index) =>
        PHOTO.replace("-1.jpg", `-${index + 1}.jpg?ver=0337`),
      ),
    );
    for (const invalid of [
      fastUrl.replace("https://bid.cars", "https://attacker.invalid"),
      fastUrl.replace(VIN, "1FTFW1ED9NFB06107"),
      `${fastUrl}?redirect=https://attacker.invalid`,
    ]) {
      fastUrl = invalid;
      requests.length = 0;
      expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
        status: "unavailable",
        partial: true,
        lots: [],
      });
      expect(requests.every((url) => new URL(url).pathname.startsWith("/app/search/"))).toBe(true);
    }
  });

  it("recovers related archives from verified current history without publishing the current lot", async () => {
    const currentLot = LOT.replace("0-45397077", "0-45397079");
    const copartLot = LOT.replace("0-45397077", "1-59622426");
    const history = [
      ["IAAI", "0-45397077"],
      ["Copart", "1-59622426"],
    ]
      .map(
        ([auction, id]) =>
          `<tr><th>${auction}</th><td>2026-08-31</td><td><a href="https://bid.cars/en/lot/${id}">${id}</a></td><td>---</td><td>100588 mi</td><td>Sold</td><td>Unknown</td></tr>`,
      )
      .join("");
    const current = html
      .replaceAll("45397077", "45397079")
      .replace("var isArchived = 1;", "var isArchived = 0;")
      .replace("<tbody>", `<tbody>${history}`);
    const copart = html
      .replaceAll("0-45397077", "1-59622426")
      .replaceAll("IAAI", "Copart")
      .replace(">45397077</h2>", ">59622426</h2>")
      .replace('class="lot-drop">0-', 'class="lot-drop">1-');
    const { service } = setup({
      fetch: async (url) => {
        if (url.href === DISCOVER)
          return new Response(
            JSON.stringify({
              results: 3,
              url: `https://bid.cars/en/search/archived/results?search-type=typing&query=${VIN}`,
            }),
          );
        if (url.href === SEARCH)
          return new Response(JSON.stringify({ ...rows(), data: [], per_page: 1 }));
        if (url.href === DISCOVER.replace("/true", "/false"))
          return new Response(JSON.stringify({ results: 1, url: currentLot }));
        if (url.href === currentLot) return new Response(current);
        if (url.pathname === "/app/search/en/vin-lot/0-45397077/true")
          return new Response(JSON.stringify({ results: 1, url: LOT }));
        if (url.pathname === "/app/search/en/vin-lot/1-59622426/true")
          return new Response(JSON.stringify({ results: 1, url: copartLot }));
        if (url.href === LOT) return new Response(html);
        if (url.href === copartLot) return new Response(copart);
        if (url.origin === "https://mercury.bid.cars")
          return new Response(Buffer.from([255, 216, 255, 224]), { status: 206 });
        throw new Error(`Unexpected request ${url.href}`);
      },
    });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result).toMatchObject({
      status: "available",
      partial: true,
      lots: [
        { auction: "iaai", lot_id: "45397077", photos_complete: true },
        { auction: "copart", lot_id: "59622426", photos_complete: true },
      ],
    });
    expect(result.lots.map((lot) => lot.photos.length)).toEqual([16, 16]);
    expect(result.lots.every((lot) => lot.events.some((event) => event.status === "sold"))).toBe(
      true,
    );
  });
  it("does not discover history from a current page with a conflicting VIN", async () => {
    const current = html
      .replace("var isArchived = 1;", "var isArchived = 0;")
      .replace(
        '"vehicleIdentificationNumber": "1FTFW1ED9NFB06106"',
        '"vehicleIdentificationNumber": "1FTFW1ED9NFB06107"',
      )
      .replace(
        "<tbody>",
        '<tbody><tr><th>Copart</th><td>2026-08-31</td><td><a href="https://bid.cars/en/lot/1-59622426">1-59622426</a></td><td>---</td><td>100588 mi</td><td>Sold</td><td>Unknown</td></tr>',
      );
    const { service, requests } = setup({
      fetch: async (url) => {
        if (url.href === DISCOVER)
          return new Response(
            JSON.stringify({
              results: 3,
              url: `https://bid.cars/en/search/archived/results?search-type=typing&query=${VIN}`,
            }),
          );
        if (url.href === SEARCH)
          return new Response(JSON.stringify({ ...rows(), data: [], per_page: 1 }));
        if (url.href === DISCOVER.replace("/true", "/false"))
          return new Response(JSON.stringify({ results: 1, url: LOT }));
        if (url.href === LOT) return new Response(current);
        throw new Error(`Unverified history must not be requested: ${url.href}`);
      },
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      partial: true,
      lots: [],
    });
    expect(requests.some((url) => url.includes("/vin-lot/1-59622426/"))).toBe(false);
  });

  it("recovers all three native sales events without duplicating the gallery or fabricating timestamps", async () => {
    const search = rows();
    search.data.push({
      ...search.data[0],
      prebid_close_time_lang: { en: "Tue 8 September, 2026" },
      final_bid_formatted: "$13,800",
    });
    const { service, requests } = setup({ search });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result).toMatchObject({
      status: "available",
      partial: false,
      lots: [
        {
          auction: "iaai",
          lot_id: "45397077",
          photos_complete: true,
          events: [
            {
              status: "ended",
              auction_date: "2026-08-31",
              auction_at: null,
              final_bid_usd_minor: 1145000,
            },
            {
              status: "ended",
              auction_date: "2026-09-08",
              auction_at: null,
              final_bid_usd_minor: 1380000,
            },
            {
              status: "sold",
              auction_date: "2026-09-12",
              auction_at: null,
              final_bid_usd_minor: 1550000,
            },
          ],
        },
      ],
    });
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]!.photos).toHaveLength(16);
    expect(requests.filter((url) => url === LOT)).toHaveLength(1);
  });

  it("does not treat an exact-VIN discovery result or archive row as proof of an ended auction", async () => {
    const { service, requests } = setup({
      detail: html.replace("var isArchived = 1;", "var isArchived = 0;"),
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "not_found",
      partial: false,
      lots: [],
    });
    expect(requests).toEqual([DISCOVER, SEARCH, LOT]);
  });

  it.each(["vin", "auction"])(
    "rejects conflicting detail %s rather than trusting filenames",
    async (field) => {
      const detail =
        field === "vin"
          ? html.replace(
              '"vehicleIdentificationNumber": "1FTFW1ED9NFB06106"',
              '"vehicleIdentificationNumber": "1FTFW1ED9NFB06107"',
            )
          : html.replace("var auctionType = 'IAAI';", "var auctionType = 'Copart';");
      const { service, requests } = setup({ detail });
      expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
        status: "unavailable",
        partial: true,
        lots: [],
      });
      expect(requests).toEqual([DISCOVER, SEARCH, LOT]);
    },
  );

  it("retains confirmed events when images fail and rejects other-lot gallery URLs", async () => {
    const detail = html.replaceAll(PHOTO, PHOTO.replace("0-45397077", "1-45397077"));
    const { service, requests } = setup({
      detail,
      image: (url) =>
        url.pathname.endsWith("-2.jpg")
          ? new Response("blocked", { status: 403 })
          : new Response(Buffer.from([255, 216, 255, 224])),
    });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result).toMatchObject({
      status: "available",
      partial: true,
      lots: [{ photos_complete: false }],
    });
    expect(result.lots[0]!.events).toHaveLength(3);
    expect(result.lots[0]!.photos).toHaveLength(14);
    expect(requests.some((url) => url.includes("mercury.bid.cars/1-45397077"))).toBe(false);
  });

  it("keeps hidden and unverified-currency bids unknown without discarding dates", async () => {
    const search = rows();
    search.data[0]!.need_login = 1;
    search.data[0]!.final_bid = 0;
    const detail = html
      .replace(/\$[0-9,]+(?: USD)?/g, "----")
      .replace('"priceCurrency": "USD"', '"priceCurrency": "CAD"');
    const { service } = setup({ search, detail });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result.lots[0]!.events.map((event) => event.final_bid_usd_minor)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("marks a truncated native history as partial", async () => {
    const { service } = setup({ detail: html.replace("<span>3</span>", "<span>4</span>") });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "available",
      partial: true,
    });
  });

  it("retains no-photo events when every image response is HTML", async () => {
    const { service } = setup({ image: () => new Response("<html>challenge</html>") });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "no_photos",
      partial: true,
      lots: [{ photos: [], photos_complete: false }],
    });
  });

  it("does not follow an untrusted next-page URL but retains confirmed earlier records", async () => {
    const search = rows();
    search.next_page_url = "https://evil.invalid/";
    const { service, requests } = setup({ search });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "available",
      partial: true,
    });
    expect(requests).not.toContain("https://evil.invalid/");
  });

  it("shares Retry-After cooldown across calls without retries or tier rotation", async () => {
    const { service, requests } = setup({
      fetch: async () =>
        new Response("limited", { status: 429, headers: { "Retry-After": "120" } }),
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      partial: true,
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      partial: true,
    });
    expect(requests).toEqual([DISCOVER]);
  });

  it("propagates caller cancellation even if the client ignores its signal", async () => {
    const { service } = setup({ fetch: () => Promise.withResolvers<Response>().promise });
    const abort = new AbortController();
    const pending = service.check(VIN, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels in-flight lookups on shutdown without waiting for a noncompliant client", async () => {
    const started = Promise.withResolvers<void>();
    const { service } = setup({
      fetch: () => {
        started.resolve();
        return Promise.withResolvers<Response>().promise;
      },
    });
    const pending = service.check(VIN, new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    await service.close();
    await rejected;
  });

  it("does not follow a redirected detail response or report its unverified archive row", async () => {
    const { service, requests } = setup({
      fetch: async (url) => {
        if (url.href === DISCOVER) return new Response(JSON.stringify({ results: 1, url: LOT }));
        if (url.href === SEARCH) return new Response(JSON.stringify(rows()));
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.invalid/car" },
        });
      },
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      partial: true,
      lots: [],
    });
    expect(requests).toEqual([DISCOVER, SEARCH, LOT]);
  });

  it("distinguishes a corroborated empty archive from the native empty fallback", async () => {
    const search = rows();
    search.data = [];
    const { service } = setup({
      fetch: async (url) =>
        url.href === DISCOVER
          ? new Response(
              JSON.stringify({
                results: 0,
                url: `https://bid.cars/en/search/archived/results?search-type=typing&query=${VIN}`,
              }),
            )
          : new Response(JSON.stringify(search)),
    });
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "not_found",
      partial: false,
      lots: [],
    });
    search.per_page = 1;
    expect(await service.check(VIN, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      partial: true,
      lots: [],
    });
  });

  it("does not lose a confirmed archived detail when native archive search emits its empty fallback", async () => {
    const search = rows();
    search.data = [];
    search.per_page = 1;
    const { service } = setup({ search, discoveryResults: 2 });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result).toMatchObject({ status: "available", partial: true });
    expect(result.lots[0]!.events).toHaveLength(3);
    expect(result.lots[0]!.photos).toHaveLength(16);
  });

  it("retains past history when a source emits an impossible future sale date", async () => {
    const { service } = setup({ detail: html.replaceAll("2026-09-12", "2099-09-12") });
    const result = await service.check(VIN, new AbortController().signal);
    expect(result.partial).toBe(true);
    expect(result.lots[0]!.events.map((event) => event.auction_date)).toEqual([
      "2026-08-31",
      "2026-09-08",
      "2026-09-12",
    ]);
  });

  it("uses the shared image admission limit across simultaneous VIN checks", async () => {
    const releaseImages = Promise.withResolvers<void>();
    const threeStarted = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    const { service } = setup({
      image: async () => {
        active++;
        maximum = Math.max(maximum, active);
        if (active === 3) threeStarted.resolve();
        await releaseImages.promise;
        active--;
        return new Response(Buffer.from([255, 216, 255, 224]));
      },
    });
    const first = service.check(VIN, new AbortController().signal);
    const second = service.check(VIN, new AbortController().signal);
    await threeStarted.promise;
    releaseImages.resolve();
    const results = await Promise.all([first, second]);
    expect(maximum).toBe(3);
    expect(results.map((result) => result.lots[0]!.photos.length)).toEqual([16, 16]);
  });

  it("recovers source-labeled Copart final bids hidden in search without reusing JSON-LD offer prices", async () => {
    const vin = "2GNFLEEK0H6119198";
    const detail = readFileSync(
      new URL("./fixtures/bidcars-archive/copart-detail.html", import.meta.url),
      "utf8",
    );
    const search = readFileSync(
      new URL("./fixtures/bidcars-archive/copart-search.json", import.meta.url),
      "utf8",
    );
    const lot = "https://bid.cars/en/lot/1-77407395/2017-Chevrolet-Equinox-2GNFLEEK0H6119198";
    const { service } = setup({
      fetch: async (url) => {
        if (url.pathname === `/app/search/en/vin-lot/${vin}/true`)
          return new Response(JSON.stringify({ results: 1, url: lot }));
        if (url.pathname === "/app/search/archived/request") return new Response(search);
        if (url.href === lot) return new Response(detail);
        if (url.hostname === "mercury.bid.cars")
          return new Response(Buffer.from([255, 216, 255, 224]));
        throw new Error("Unexpected source URL");
      },
    });
    const result = await service.check(vin, new AbortController().signal);
    expect(result).toMatchObject({
      status: "available",
      lots: [{ auction: "copart", lot_id: "77407395" }],
    });
    expect(result.lots[0]!.events).toContainEqual({
      status: "sold",
      auction_at: null,
      auction_date: "2026-06-08",
      final_bid_usd_minor: 22500,
    });
    expect(result.lots[0]!.photos).toHaveLength(14);
  });
});
