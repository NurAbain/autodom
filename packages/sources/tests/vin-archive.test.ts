import { readFileSync } from "node:fs";
import { ReadableStream } from "node:stream/web";
import { ProxyRoute } from "@autodom/core";
import {
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  type VinArchivePhotoRequest,
} from "@autodom/core/vin-archive";
import { MockAgent, Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readImage } from "../src/http-response.js";
import { VinArchiveService } from "../src/vin-archive.js";

const VIN = "4JGFB4JB0LA163026";
const ORIGIN = "https://www.copart.com";
const SEARCH = "/public/lots/vin/search";
const DETAILS = "/public/data/lotdetails/solr/";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  "base64",
);
// Captured anonymous responses; mutations below model individual boundary failures.
function fixture(name: string) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/copart-archive/${name}.json`, import.meta.url), "utf8"),
  );
}
const services: VinArchiveService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
});
function setup(timeoutMs = 1_000) {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const service = new VinArchiveService({
    providers: ["copart"],
    routes: [new ProxyRoute("residential", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
    requestDelaySeconds: 0,
    timeoutMs,
    dispatcherFactory: () => mock,
  });
  services.push(service);
  return { service, mock, source: mock.get(ORIGIN) };
}
function search(mock: MockAgent, body = fixture("search-sold")) {
  mock.get(ORIGIN).intercept({ path: SEARCH, method: "POST" }).reply(200, body);
}
function lot(mock: MockAgent, id = "52446376", body = fixture("lot-sold")) {
  mock
    .get(ORIGIN)
    .intercept({ path: `${DETAILS}${id}` })
    .reply(200, body);
}
function gallery(mock: MockAgent, body = fixture("images-sold"), id = "52446376") {
  mock
    .get(ORIGIN)
    .intercept({ path: `${DETAILS}lotImages/${id}` })
    .reply(200, body);
}
function photo(
  mock: MockAgent,
  url: string,
  status = 206,
  body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
) {
  mock
    .get("https://cs.copart.com")
    .intercept({ path: new URL(url).pathname })
    .reply(status, body);
}
function smallGallery() {
  const body = fixture("images-sold");
  body.data.imagesList.content = body.data.imagesList.content.slice(0, 2);
  body.data.imagesList.totalElements = 2;
  return body;
}

describe("Copart retained SOLD archive", () => {
  it("uses the dynamic SOLD state despite false top-level flags and never invents an auction date", async () => {
    const { service, mock } = setup();
    search(mock);
    lot(mock);
    const images = fixture("images-sold");
    gallery(mock, images);
    for (const image of images.data.imagesList.content) photo(mock, image.highResUrl);
    const result = await service.check(VIN);
    expect(result.sources[0]).toMatchObject({
      status: "available",
      partial: false,
      lots: [
        {
          lot_id: "52446376",
          auction: "copart",
          events: [
            { status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: null },
          ],
          photos_complete: true,
          photos: images.data.imagesList.content.map(
            (image: { highResUrl: string }) => image.highResUrl,
          ),
        },
      ],
    });
  });

  it("does not present a currently active lot as an archive event", async () => {
    const { service, mock } = setup();
    const body = fixture("search-active");
    body.data.query.filter.MISC = ["ps_vin_number:5TDJZRFH0HS508358"];
    search(mock, body);
    lot(mock, "68379726", fixture("lot-active"));
    const result = await service.check("5TDJZRFH0HS508358");
    expect(result.sources[0]).toMatchObject({ status: "not_found", partial: false, lots: [] });
  });

  it.each(["vin", "lot", "unbound-sold", "query"])(
    "rejects uncertain %s identity instead of reporting no history",
    async (failure) => {
      const { service, mock } = setup();
      const lookup = fixture("search-sold");
      if (failure === "query") lookup.data.query.filter.MISC = ["ps_vin_number:4JGFB4JB0LA*"];
      search(mock, lookup);
      const details = failure === "unbound-sold" ? fixture("lot-old-sold") : fixture("lot-sold");
      if (failure === "vin") details.data.lotDetails.fv = "5TDJZRFH0HS******";
      if (failure === "lot") details.data.lotDetails.ln = 60871705;
      if (failure === "unbound-sold") details.data.lotDetails.ln = 52446376;
      lot(mock, "52446376", details);
      const result = await service.check(VIN);
      expect(result.sources[0]).toMatchObject({ status: "unavailable", partial: true, lots: [] });
    },
  );

  it("keeps separate sale events and only deduplicates ordered images inside each lot", async () => {
    const { service, mock } = setup();
    const lookup = fixture("search-sold");
    lookup.data.results.totalElements = 2;
    search(mock, lookup);
    const page = structuredClone(lookup);
    page.data.query.page = 1;
    page.data.results.content = [
      { ...lookup.data.results.content[0], ln: 60871705, lotNumberStr: "60871705" },
    ];
    mock
      .get(ORIGIN)
      .intercept({
        path: SEARCH,
        method: "POST",
        body: JSON.stringify({ filter: { MISC: [`ps_vin_number:${VIN}`] }, page: 1, size: 20 }),
      })
      .reply(200, page);
    lot(mock);
    const second = fixture("lot-old-sold");
    second.data.lotDetails.fv = "4JGFB4JB0LA******";
    lot(mock, "60871705", second);
    const images = smallGallery();
    const [first, next] = images.data.imagesList.content;
    images.data.imagesList.content = [next, first, first];
    images.data.imagesList.totalElements = 3;
    gallery(mock, images);
    const secondImages = structuredClone(images);
    for (const image of secondImages.data.imagesList.content) {
      image.ln = 60871705;
      image.lotNumberStr = "60871705";
    }
    secondImages.data.imagesList.content.push(
      ...fixture("images-old-sold").data.imagesList.content.filter(
        (image: { imageTypeCode: string }) =>
          image.imageTypeCode === "EXT360" || image.imageTypeCode === "INT360",
      ),
    );
    secondImages.data.imagesList.totalElements = secondImages.data.imagesList.content.length;
    gallery(mock, secondImages, "60871705");
    for (let event = 0; event < 2; event++) {
      photo(mock, first.highResUrl);
      photo(mock, next.highResUrl);
    }
    const result = await service.check(VIN);
    expect(result.sources[0]?.lots).toMatchObject([
      {
        lot_id: "52446376",
        events: [{ status: "sold", auction_at: null }],
        photos_complete: true,
        photos: [first.highResUrl, next.highResUrl],
      },
      {
        lot_id: "60871705",
        events: [{ status: "sold", auction_at: 1753203600 }],
        photos_complete: true,
        photos: [first.highResUrl, next.highResUrl],
      },
    ]);
    for (const lot_id of ["52446376", "60871705"]) {
      photo(mock, first.highResUrl, 200, PNG);
      expect(
        await service.getPhoto({
          vin: VIN,
          provider: "copart",
          auction: "copart",
          lot_id,
          photo_url: first.highResUrl,
        }),
      ).toEqual({ bytes: PNG, content_type: "image/png" });
    }
  });

  it.each([403, 429, 200])(
    "does not interpret HTTP %s or malformed source bodies as not_found",
    async (status) => {
      const { service, source } = setup();
      source
        .intercept({ path: SEARCH, method: "POST" })
        .reply(status, "<html>Access denied</html>", { headers: { "retry-after": "60" } });
      expect((await service.check(VIN)).sources[0]).toMatchObject({
        status: "unavailable",
        partial: true,
        lots: [],
      });
    },
  );

  it("retains a confirmed lot when its gallery manifest fails", async () => {
    const { service, mock, source } = setup();
    search(mock);
    lot(mock);
    source.intercept({ path: `${DETAILS}lotImages/52446376` }).reply(403, "expired");
    expect((await service.check(VIN)).sources[0]).toMatchObject({
      status: "no_photos",
      partial: true,
      lots: [{ lot_id: "52446376", photos: [], photos_complete: false }],
    });
  });

  it("keeps the known sale when every photograph has expired", async () => {
    const { service, mock } = setup();
    search(mock);
    lot(mock);
    const images = smallGallery();
    gallery(mock, images);
    for (const image of images.data.imagesList.content) photo(mock, image.highResUrl, 403);
    expect((await service.check(VIN)).sources[0]).toMatchObject({
      status: "no_photos",
      partial: true,
      lots: [{ lot_id: "52446376", photos: [], photos_complete: false }],
    });
  });

  it("retains only byte-verified photos while preserving the incomplete event", async () => {
    const { service, mock } = setup();
    search(mock);
    lot(mock);
    const images = smallGallery();
    gallery(mock, images);
    photo(mock, images.data.imagesList.content[0].highResUrl);
    photo(
      mock,
      images.data.imagesList.content[1].highResUrl,
      200,
      Buffer.from("<html>expired</html>"),
    );
    expect((await service.check(VIN)).sources[0]).toMatchObject({
      status: "available",
      partial: true,
      lots: [{ photos: [images.data.imagesList.content[0].highResUrl], photos_complete: false }],
    });
  });

  it("does not resume source traffic during Retry-After", async () => {
    const { service, source } = setup();
    source
      .intercept({ path: SEARCH, method: "POST" })
      .reply(429, "", { headers: { "retry-after": "120" } });
    await service.check(VIN);
    let traffic = false;
    source.intercept({ path: SEARCH, method: "POST" }).reply(() => {
      traffic = true;
      return { statusCode: 200, data: fixture("search-sold") };
    });
    expect((await service.check(VIN)).sources[0]?.status).toBe("unavailable");
    expect(traffic).toBe(false);
  });

  it("marks repeated search pages partial rather than silently dropping indexed events", async () => {
    const { service, mock } = setup();
    const first = fixture("search-sold");
    first.data.results.totalElements = 21;
    search(mock, first);
    const repeated = structuredClone(first);
    repeated.data.query.page = 1;
    search(mock, repeated);
    lot(mock);
    const images = smallGallery();
    gallery(mock, images);
    for (const image of images.data.imagesList.content) photo(mock, image.highResUrl);
    expect((await service.check(VIN)).sources[0]).toMatchObject({
      status: "available",
      partial: true,
      lots: [{ lot_id: "52446376" }],
    });
  });

  it("returns a completed empty index lookup without suggesting complete historical coverage", async () => {
    const { service, mock } = setup();
    search(mock, fixture("search-empty"));
    expect(await service.check("2HKRM4H74CH603903")).toMatchObject({
      coverage: "indexed_lots_only",
      sources: [{ status: "not_found", partial: false, lots: [] }],
    });
  });

  it("releases an aborted workflow so later checks can complete", async () => {
    const { service, mock, source } = setup();
    const abort = new AbortController();
    const admitted = Promise.withResolvers<void>();
    source
      .intercept({ path: SEARCH, method: "POST" })
      .reply(() => {
        admitted.resolve();
        return { statusCode: 200, data: fixture("search-sold") };
      })
      .delay(500);
    const pending = service.check(VIN, abort.signal);
    await admitted.promise;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    search(mock, fixture("search-empty"));
    expect((await service.check("2HKRM4H74CH603903")).sources[0]?.status).toBe("not_found");
  });
});

describe("bounded archive photo delivery", () => {
  it("requires a live grant for the entire verified tuple before any source traffic", async () => {
    const { service, mock } = setup();
    const images = smallGallery();
    const request: VinArchivePhotoRequest = {
      vin: VIN,
      provider: "copart",
      auction: "copart",
      lot_id: "52446376",
      photo_url: images.data.imagesList.content[0].highResUrl,
    };
    let downloads = 0;
    mock
      .get("https://cs.copart.com")
      .intercept({
        path: new URL(request.photo_url).pathname,
        headers: (headers) => Object.keys(headers).every((name) => name.toLowerCase() !== "range"),
      })
      .reply(() => {
        downloads++;
        return { statusCode: 200, data: PNG };
      })
      .persist();
    await expect(service.getPhoto(request)).rejects.toThrow();
    expect(downloads).toBe(0);
    search(mock);
    lot(mock);
    gallery(mock, images);
    for (const image of images.data.imagesList.content) photo(mock, image.highResUrl);
    await service.check(VIN);
    await expect(service.getPhoto({ ...request, vin: "1FTFW1ED9NFB06106" })).rejects.toThrow();
    await expect(service.getPhoto({ ...request, lot_id: "60871705" })).rejects.toThrow();
    await expect(service.getPhoto({ ...request, provider: "bidcars" })).rejects.toThrow();
    expect(downloads).toBe(0);
    expect(await service.getPhoto(request)).toEqual({ bytes: PNG, content_type: "image/png" });
    expect(downloads).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1000);
    await expect(service.getPhoto(request)).rejects.toThrow();
    expect(downloads).toBe(1);
    await service.close();
    await expect(service.getPhoto(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(downloads).toBe(1);
  });

  it("bounds Copart downloads to three image slots and never starts an aborted queued download", async () => {
    const { service, mock } = setup();
    const images = smallGallery();
    search(mock);
    lot(mock);
    gallery(mock, images);
    for (const image of images.data.imagesList.content) photo(mock, image.highResUrl);
    await service.check(VIN);
    const request: VinArchivePhotoRequest = {
      vin: VIN,
      provider: "copart",
      auction: "copart",
      lot_id: "52446376",
      photo_url: images.data.imagesList.content[0].highResUrl,
    };
    const occupied = Promise.withResolvers<void>();
    let downloads = 0;
    mock
      .get("https://cs.copart.com")
      .intercept({
        path: new URL(request.photo_url).pathname,
        headers: (headers) => Object.keys(headers).every((name) => name.toLowerCase() !== "range"),
      })
      .reply(() => {
        if (++downloads === 3) occupied.resolve();
        return { statusCode: 200, data: PNG };
      })
      .delay(100)
      .persist();
    const abort = new AbortController();
    const admitted = Array.from({ length: 3 }, () => service.getPhoto(request));
    const queued = service.getPhoto(request, abort.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await occupied.promise;
    abort.abort();
    await rejected;
    expect(await Promise.all(admitted)).toEqual(
      Array.from({ length: 3 }, () => ({
        bytes: PNG,
        content_type: "image/png",
      })),
    );
    expect(downloads).toBe(3);
  });

  it.each([
    ["HTML", () => new Response("<html>challenge</html>")],
    ["wrong MIME", () => new Response(PNG, { headers: { "Content-Type": "text/html" } })],
    ["truncated image", () => new Response(PNG.subarray(0, -1))],
    [
      "truncated transfer",
      () => new Response(PNG, { headers: { "Content-Length": String(PNG.length + 1) } }),
    ],
    [
      "oversized declaration",
      () =>
        new Response(PNG, {
          headers: { "Content-Length": String(VIN_ARCHIVE_PHOTO_MAX_BYTES + 1) },
        }),
    ],
    ["oversized stream", () => new Response(new Uint8Array(VIN_ARCHIVE_PHOTO_MAX_BYTES + 1))],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://example.invalid" } }),
    ],
    ["range response", () => new Response(PNG, { status: 206 })],
    [
      "disguised range",
      () => new Response(PNG, { headers: { "Content-Range": "bytes 0-67/100" } }),
    ],
  ] as const)("rejects %s instead of returning bytes", async (_name, response) => {
    await expect(readImage(response(), new AbortController().signal)).rejects.toThrow();
  });

  it("preserves fragmented raster bytes and cancels a stalled response on abort", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(PNG.subarray(0, 7));
          controller.enqueue(PNG.subarray(7));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } },
    );
    expect(await readImage(response, new AbortController().signal)).toEqual({
      bytes: PNG,
      content_type: "image/png",
    });
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const abort = new AbortController();
    const pending = readImage(
      new Response(
        new ReadableStream({
          pull() {
            entered.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      ),
      abort.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    abort.abort();
    await rejected;
    await cancelled.promise;
  });
});

it("preserves confirmed Bid.Cars events at the shared deadline without querying disabled Copart", async () => {
  const vin = "1FTFW1ED9NFB06106";
  const detail = readFileSync(
    new URL("./fixtures/bidcars-archive/ford-detail.html", import.meta.url),
    "utf8",
  );
  const service = new VinArchiveService({
    providers: ["bidcars"],
    routes: [new ProxyRoute("residential", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
    requestDelaySeconds: 0,
    timeoutMs: 50,
    dispatcherFactory: () => {
      throw new Error("Disabled Copart must not be initialized");
    },
    browserClientFactory: () => ({
      async fetch(url) {
        if (url.pathname.endsWith("/true"))
          return new Response(
            JSON.stringify({
              results: 1,
              url: `https://bid.cars/en/lot/0-45397077/2022-Ford-F-150-${vin}`,
            }),
          );
        if (url.pathname === "/app/search/archived/request")
          return new Response(
            JSON.stringify({ current_page: 1, data: [], next_page_url: null, per_page: 1 }),
          );
        if (url.pathname.startsWith("/en/lot/")) return new Response(detail);
        if (url.hostname === "mercury.bid.cars") return new Promise<Response>(() => {});
        throw new Error("Unexpected archive destination");
      },
      async refresh() {
        throw new Error("Archive clearance is disabled");
      },
    }),
  });
  services.push(service);
  const result = await service.check(vin);
  expect(result.sources).toMatchObject([
    {
      provider: "bidcars",
      status: "no_photos",
      partial: true,
      lots: [
        {
          lot_id: "45397077",
          auction: "iaai",
          photos: [],
          photos_complete: false,
          events: [
            { auction_date: "2026-08-31" },
            { auction_date: "2026-09-08" },
            { auction_date: "2026-09-12" },
          ],
        },
      ],
    },
  ]);
});
