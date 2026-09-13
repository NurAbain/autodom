import { SourceError } from "@autodom/core";
import { CARWAY_ARCHIVE_MAX_PHOTOS } from "@autodom/core/vin-archive";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CarwayArchive } from "../src/carway-archive.js";
import { VinArchiveService } from "../src/vin-archive.js";

const VIN = "WP1ZZZ92ZDLA74194";
const PHOTO =
  "https://cdn.emiratesauction.com/media/1w02sl326ylfe5djlgbf1u6hmuxa4hxzq8xdgwc4aw0gsiti7u/t_,w_800,h_600/images1.jpg?v=2";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  "base64",
);
// Reduced structure of the public Carway response, including its contradictory prose.
const HTML = `<section id="product_details">
  <div class="slider owl-carousel"><img src="${PHOTO}" alt="${VIN}" data-hash="1"></div>
  <div class="product_details_container">
    <div class="product_vin"><b>Vin:</b>${VIN}</div>
    <div class="lot_information_container"><div class="product_detail_body">
      <div class="product_detail_label_container"><p class="detail_label">Lot information</p><p class="detail_label">Auction</p></div>
      <div class="product_detail_container"><p class="detail">#426339</p><p class="detail">EmiratesAuction</p></div>
    </div></div>
  </div>
  <div class="bid_details_container">COPART lot 68191943, 51500$, 139218 mi, 2023/09/05.</div>
</section>`;

const previous = getGlobalDispatcher();
const services: VinArchiveService[] = [];
let mock: MockAgent;
beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  setGlobalDispatcher(previous);
  await mock.close();
});

it("exposes a full-VIN UAE record without inventing sale facts and serves only its granted photo", async () => {
  const service = new VinArchiveService({
    providers: ["carway"],
    routes: [],
    requestDelaySeconds: 0,
  });
  services.push(service);
  mock
    .get("https://carway.pro")
    .intercept({ path: `/search-vin?vin_number=${VIN}` })
    .reply(200, HTML, {
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  const result = await service.check(VIN);
  expect(result.sources).toMatchObject([
    {
      provider: "carway",
      status: "available",
      partial: true,
      lots: [
        {
          auction: "emiratesauction",
          lot_id: "426339",
          events: [],
          photos: [PHOTO],
          photos_complete: false,
        },
      ],
    },
  ]);
  const request = {
    vin: VIN,
    provider: "carway" as const,
    auction: "emiratesauction" as const,
    lot_id: "426339",
    photo_url: PHOTO,
  };
  await expect(service.getPhoto({ ...request, vin: "WP1ZZZ92ZDLA74195" })).rejects.toThrow();
  const url = new URL(PHOTO);
  mock
    .get(url.origin)
    .intercept({ path: url.pathname + url.search })
    .reply(200, PNG, {
      headers: { "content-type": "image/png" },
    });
  await expect(service.getPhoto(request)).resolves.toEqual({
    bytes: PNG,
    content_type: "image/png",
  });
});

function replyHtml(html: string, vin = VIN) {
  mock
    .get("https://carway.pro")
    .intercept({ path: `/search-vin?vin_number=${vin}` })
    .reply(200, html, {
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
}

const EMPTY =
  '<section class="py-5 mt-5 d-grid justify-content-center align-items-center"><h1>No Car Found!</h1></section>';
const IDENTITY = `<div class="product_vin"><b>Vin:</b>${VIN}</div>`;

it.each([
  ["different full VIN", HTML.replace(IDENTITY, IDENTITY.replace(VIN, "WP1ZZZ92ZDLA74195"))],
  ["masked VIN", HTML.replace(IDENTITY, IDENTITY.replace(VIN, "WP1ZZZ92Z********"))],
  [
    "hidden identity",
    HTML.replace(IDENTITY, IDENTITY.replace('class="product_vin"', 'class="product_vin" hidden')),
  ],
  ["CSS-hidden identity", HTML.replace(IDENTITY, `<div style="display: none">${IDENTITY}</div>`)],
  ["duplicate matching identities", HTML.replace(IDENTITY, IDENTITY + IDENTITY)],
  [
    "echo without identity",
    HTML.replace(IDENTITY, `<input value="${VIN}"><footer>${VIN}</footer>`),
  ],
  ["duplicate field labels", HTML.replace(">Auction<", ">Lot information<")],
  ["misaligned detail fields", HTML.replace('<p class="detail">#426339</p>', "")],
  ["ambiguous gallery", HTML.replace("</section>", '<div class="slider"></div></section>')],
  ["empty sentinel contradicting a record", EMPTY + HTML],
  [
    "empty sentinel contradicting masked identity",
    EMPTY + HTML.replace(IDENTITY, IDENTITY.replace(VIN, "WP1ZZZ92Z********")),
  ],
  ["hidden absence", `<div hidden>${EMPTY}</div>`],
  ["unrecognized page", `<main>Search for ${VIN}</main>`],
])("does not report an archive miss for %s", async (_name, html) => {
  const service = new VinArchiveService({
    providers: ["carway"],
    routes: [],
    requestDelaySeconds: 0,
  });
  services.push(service);
  replyHtml(html);
  expect((await service.check(VIN)).sources).toMatchObject([
    { provider: "carway", status: "unavailable", lots: [] },
  ]);
});

it("reports not found only for the visible explicit empty response", async () => {
  replyHtml(EMPTY);
  const archive = new CarwayArchive(0);
  expect(await archive.check(VIN, new AbortController().signal)).toMatchObject({
    status: "not_found",
    partial: false,
    lots: [],
  });
});

it("keeps COPART UAE distinct even when the country field is unknown", async () => {
  const vin = "WP0ZZZ99ZES180140";
  const photo = "https://carway.pro/car_image/52984784_Image_1.jpg";
  replyHtml(
    HTML.replaceAll(VIN, vin)
      .replace(PHOTO, photo)
      .replace("#426339", "#52984784")
      .replace("EmiratesAuction", "COPART UAE")
      .replace(">Auction</p>", '>Auction</p><p class="detail_label">Country</p>')
      .replace(">COPART UAE</p>", '>COPART UAE</p><p class="detail">-</p>'),
    vin,
  );
  expect(await new CarwayArchive(0).check(vin, new AbortController().signal)).toMatchObject({
    status: "available",
    partial: true,
    lots: [
      {
        auction: "copart_uae",
        lot_id: "52984784",
        photos: [photo],
        events: [],
        photos_complete: false,
      },
    ],
  });
});

it.each(["COPART", "IAAI", "UnknownAuction"])(
  "rejects %s without proven UAE attribution",
  async (auction) => {
    replyHtml(HTML.replace("EmiratesAuction", auction));
    await expect(new CarwayArchive(0).check(VIN, new AbortController().signal)).rejects.toThrow(
      SourceError,
    );
  },
);

it("rejects an explicitly contradictory auction country", async () => {
  replyHtml(
    HTML.replace(">Auction</p>", '>Auction</p><p class="detail_label">Country</p>').replace(
      ">EmiratesAuction</p>",
      '>EmiratesAuction</p><p class="detail">United States</p>',
    ),
  );
  await expect(new CarwayArchive(0).check(VIN, new AbortController().signal)).rejects.toThrow(
    SourceError,
  );
});

it("retains only deduplicated primary gallery photos with matching VIN and provenance", async () => {
  const local = "https://carway.pro/car_image/426339_Image_1.jpg";
  const image = (url: string, vin = VIN) => `<img src="${url}" alt="${vin}" data-hash="1">`;
  const gallery = [
    image(PHOTO),
    image(PHOTO),
    image(local),
    image("https://carway.pro/car_image/426340_Image_1.jpg"),
    image("https://other.example/car_image/426339_Image_1.jpg"),
    image("https://carway.pro/logo.jpg"),
    image(PHOTO.replace("?v=2", "?redirect=evil")),
    image("https://carway.pro/car_image/426339_Image_2.jpg", "WP1ZZZ92ZDLA74195"),
  ].join("");
  replyHtml(
    HTML.replace(`<img src="${PHOTO}" alt="${VIN}" data-hash="1">`, gallery).replace(
      "</section>",
      `<div class="slider_image">${image("https://carway.pro/car_image/426339_Image_3.jpg")}</div></section>`,
    ) + `<aside class="slider">${image("https://carway.pro/car_image/426339_Image_4.jpg")}</aside>`,
  );
  expect((await new CarwayArchive(0).check(VIN, new AbortController().signal)).lots).toMatchObject([
    { photos: [PHOTO, local], photos_complete: false },
  ]);
});

it("caps discovery while leaving the gallery explicitly incomplete without downloading images", async () => {
  const photos = Array.from(
    { length: CARWAY_ARCHIVE_MAX_PHOTOS + 1 },
    (_value, index) => `https://carway.pro/car_image/426339_Image_${index + 1}.jpg`,
  );
  replyHtml(
    HTML.replace(
      `<img src="${PHOTO}" alt="${VIN}" data-hash="1">`,
      photos.map((url, index) => `<img src="${url}" alt="${VIN}" data-hash="${index}">`).join(""),
    ),
  );
  expect(await new CarwayArchive(0).check(VIN, new AbortController().signal)).toMatchObject({
    status: "available",
    partial: true,
    lots: [{ photos: photos.slice(0, CARWAY_ARCHIVE_MAX_PHOTOS), photos_complete: false }],
  });
});

it("preserves confirmed lot identity when no gallery photo has safe provenance", async () => {
  replyHtml(HTML.replace(PHOTO, "https://unknown.example/image.jpg"));
  expect(await new CarwayArchive(0).check(VIN, new AbortController().signal)).toMatchObject({
    status: "no_photos",
    partial: true,
    lots: [
      {
        auction: "emiratesauction",
        lot_id: "426339",
        photos: [],
        photos_complete: false,
        events: [],
      },
    ],
  });
});

it("does not follow a redirect into a misleading empty response", async () => {
  mock
    .get("https://carway.pro")
    .intercept({ path: `/search-vin?vin_number=${VIN}` })
    .reply(302, EMPTY, {
      headers: { location: "https://other.example", "content-type": "text/html" },
    });
  await expect(new CarwayArchive(0).check(VIN, new AbortController().signal)).rejects.toThrow(
    SourceError,
  );
});

it("honors a source rate limit rather than turning a subsequent response into a miss", async () => {
  const archive = new CarwayArchive(0);
  mock
    .get("https://carway.pro")
    .intercept({ path: `/search-vin?vin_number=${VIN}` })
    .reply(429, EMPTY, {
      headers: { "retry-after": "120", "content-type": "text/html" },
    });
  await expect(archive.check(VIN, new AbortController().signal)).rejects.toThrow(SourceError);
  replyHtml(EMPTY);
  await expect(archive.check(VIN, new AbortController().signal)).rejects.toThrow(SourceError);
});

it("rejects revoked and cancelled queued downloads while three granted downloads finish", async () => {
  const archive = new CarwayArchive(0);
  const request = {
    vin: VIN,
    provider: "carway" as const,
    auction: "emiratesauction" as const,
    lot_id: "426339",
    photo_url: PHOTO,
  };
  const occupied = Promise.withResolvers<void>();
  let started = 0;
  const url = new URL(PHOTO);
  mock
    .get(url.origin)
    .intercept({ path: url.pathname + url.search })
    .reply(
      200,
      () => {
        if (++started === 3) occupied.resolve();
        return PNG;
      },
      { headers: { "content-type": "image/png" } },
    )
    .delay(50)
    .times(3);
  const active = Array.from({ length: 3 }, () =>
    archive.getPhoto(request, new AbortController().signal, () => {}),
  );
  await occupied.promise;
  let expired = false;
  const expiredGrant = new SourceError("Expired photo authorization");
  const queued = archive.getPhoto(request, new AbortController().signal, () => {
    if (expired) throw expiredGrant;
  });
  const cancelled = new AbortController();
  const aborted = archive.getPhoto(request, cancelled.signal, () => {});
  const denied = expect(queued).rejects.toBe(expiredGrant);
  const stopped = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  expired = true;
  cancelled.abort();
  await Promise.all([denied, stopped]);
  expect(await Promise.all(active)).toEqual(
    Array.from({ length: 3 }, () => ({
      bytes: PNG,
      content_type: "image/png",
    })),
  );
  mock.assertNoPendingInterceptors();
});
