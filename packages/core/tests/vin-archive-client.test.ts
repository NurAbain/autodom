import { createServer } from "node:http";
import { expect, it } from "vitest";
import { VIN_SOURCE_URLS } from "../src/vin.js";
import {
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  type VinArchivePhotoRequest,
  type VinArchiveResult,
} from "../src/vin-archive.js";
import { createVinApiLookup, createVinArchivePhotoApiLookup } from "../src/vin-client.js";

function automaticResult(vin: string, archives: unknown) {
  const checkedAt = 1_789_344_000;
  return {
    vin,
    checked_at: checkedAt,
    carhistory: {
      status: "not_found",
      source_url: VIN_SOURCE_URLS.carhistory,
      checked_at: checkedAt,
    },
    car365: {
      status: "not_found",
      source_url: VIN_SOURCE_URLS.car365,
      checked_at: checkedAt,
      data: null,
    },
    archives,
  };
}

it("rejects a different VIN, foreign photo host, and a source link for a different lot", async () => {
  const vin = "4JGFB4JB0LA163026";
  const result: VinArchiveResult = {
    vin,
    checked_at: 1_789_000_000,
    coverage: "indexed_lots_only",
    sources: [
      {
        provider: "copart",
        status: "available",
        source_url: "https://www.copart.com/",
        checked_at: 1_789_000_000,
        partial: false,
        lots: [
          {
            auction: "copart",
            lot_id: "52446376",
            source_url: "https://www.copart.com/lot/52446376",
            events: [
              { status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: null },
            ],
            photos: [
              "https://cs.copart.com/v1/AUTH_svc.pdoc00001/ids-c-prod-lpp/0526/25c7adbfae444179a7507552226679aa_hrs.jpg",
            ],
            photos_complete: true,
          },
        ],
      },
    ],
  };
  const source = result.sources[0]!;
  const lot = source.lots[0]!;
  let body: unknown;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the bounded test request. */
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(automaticResult(vin, body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const lookup = createVinApiLookup({
      AUTODOM_VIN_API_URL: `http://127.0.0.1:${address.port}`,
      AUTODOM_VIN_API_TOKEN: "archive-client-test-token-with-32-characters",
    })!;
    for (const invalid of [
      { ...result, vin: "4JGFB4JB0LA163027" },
      {
        ...result,
        sources: [
          { ...source, lots: [{ ...lot, photos: ["https://attacker.invalid/photo.jpg"] }] },
        ],
      },
      {
        ...result,
        sources: [
          { ...source, lots: [{ ...lot, source_url: "https://www.copart.com/lot/60871705" }] },
        ],
      },
    ]) {
      body = invalid;
      await expect(lookup(vin)).rejects.toThrow();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("accepts Bid.Cars archive evidence but rejects photos belonging to a different VIN or auction", async () => {
  const vin = "1FTFW1ED9NFB06106";
  const photo = `https://mercury.bid.cars/0-45397077/2022-Ford-F-150-${vin}-1.jpg?ver=0337`;
  const lot = {
    auction: "iaai",
    lot_id: "45397077",
    source_url: `https://bid.cars/en/lot/0-45397077/2022-Ford-F-150-${vin}`,
    events: [
      {
        status: "ended",
        auction_at: null,
        auction_date: "2026-09-12",
        final_bid_usd_minor: 1550000,
      },
    ],
    photos: [photo],
    photos_complete: true,
    details: {
      odometer: { value: 164957, unit: "mi", status: "Not Actual" },
      keys_present: false,
      title: "Salvage",
    },
  };
  const source = {
    provider: "bidcars",
    status: "available",
    source_url: "https://bid.cars/",
    checked_at: 1789344000,
    partial: false,
    lots: [lot],
  };
  const result = {
    vin,
    checked_at: 1789344000,
    coverage: "indexed_lots_only",
    sources: [source],
  };
  let body: unknown = result;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the bounded test request. */
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(automaticResult(vin, body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const lookup = createVinApiLookup({
      AUTODOM_VIN_API_URL: `http://127.0.0.1:${address.port}`,
      AUTODOM_VIN_API_TOKEN: "archive-client-test-token-with-32-characters",
    })!;
    await expect(lookup(vin)).resolves.toMatchObject({
      archives: {
        sources: [
          {
            provider: "bidcars",
            lots: [
              {
                auction: "iaai",
                photos: [photo],
                details: {
                  odometer: { value: 164957, unit: "mi", status: "Not Actual" },
                  keys_present: false,
                },
              },
            ],
          },
        ],
      },
    });
    for (const wrong of [
      photo.replace("/0-45397077/", "/0-45397078/"),
      photo.replace(vin, "1FTFW1ED9NFB06107"),
      photo.replace("/0-45397077/", "/1-45397077/"),
      `${photo}&redirect=https://attacker.invalid`,
      `${photo}&ver=0338`,
      photo.replace("ver=0337", "ver=latest"),
      photo.replace("ver=0337", "ver=%30%33%33%37"),
      photo.replace("ver=0337", "ver=12345678901234567"),
    ]) {
      body = { ...result, sources: [{ ...source, lots: [{ ...lot, photos: [wrong] }] }] };
      await expect(lookup(vin)).rejects.toThrow();
    }
    for (const invalid of [
      { ...result, sources: [source, source] },
      { ...result, sources: [{ ...source, source_url: "https://www.copart.com/" }] },
      { ...result, sources: [{ ...source, lots: [lot, lot] }] },
      ...[
        { ...lot, auction: "copart" },
        { ...lot, source_url: lot.source_url.replace(vin, "1FTFW1ED9NFB06107") },
        { ...lot, source_url: lot.source_url.replace("/0-45397077/", "/0-45397078/") },
        { ...lot, details: { odometer: { value: -1, unit: "mi" } } },
        { ...lot, details: { odometer: { value: 164957, unit: "miles" } } },
        { ...lot, details: { keys_present: "No" } },
        {
          ...lot,
          reports: [
            {
              kind: "inspection",
              status: "available",
              source_url: "https://attacker.invalid/report",
              checked_at: result.checked_at,
              report_date: null,
              partial: false,
              facts: [{ section: "", label: "VIN", value: vin }],
            },
          ],
        },
        ...[
          { ...lot.events[0], auction_date: "2026-02-30" },
          { ...lot.events[0], auction_date: "2026-09-15" },
          { ...lot.events[0], auction_at: result.checked_at + 1 },
          { ...lot.events[0], final_bid_usd_minor: undefined },
          { ...lot.events[0], final_bid_usd_minor: -1 },
        ].map((event) => ({ ...lot, events: [event] })),
      ].map((invalidLot) => ({ ...result, sources: [{ ...source, lots: [invalidLot] }] })),
    ]) {
      body = invalid;
      await expect(lookup(vin)).rejects.toThrow();
    }
    const copartLot = {
      ...lot,
      auction: "copart",
      source_url: `https://www.copart.com/lot/${lot.lot_id}`,
      photos: [],
    };
    body = {
      ...result,
      sources: [
        {
          ...source,
          provider: "copart",
          source_url: "https://www.copart.com/",
          status: "no_photos",
          lots: [copartLot],
        },
        {
          ...source,
          lots: [
            lot,
            {
              ...lot,
              auction: "copart",
              source_url: lot.source_url.replace("/0-", "/1-"),
              photos: [photo.replace("/0-", "/1-")],
            },
          ],
        },
      ],
    };
    await expect(lookup(vin)).resolves.toMatchObject({
      archives: {
        sources: [
          { provider: "copart", status: "no_photos" },
          { provider: "bidcars", lots: [{ auction: "iaai" }, { auction: "copart" }] },
        ],
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("delivers bounded raster bytes and rejects unsafe requests, HTML, oversized bodies and redirects", async () => {
  const input: VinArchivePhotoRequest = {
    vin: "1FTFW1ED9NFB06106",
    provider: "bidcars",
    auction: "iaai",
    lot_id: "45397077",
    photo_url:
      "https://mercury.bid.cars/0-45397077/2022-Ford-F-150-1FTFW1ED9NFB06106-1.jpg?ver=0337",
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
    "base64",
  );
  let payload = png;
  let mime = "image/png";
  let status = 200;
  let calls = 0;
  const token = "archive-photo-test-token-with-32-characters";
  const server = createServer(async (request, response) => {
    calls += 1;
    for await (const _chunk of request) {
      /* Consume request. */
    }
    if (
      request.url !== "/v1/vin/archive-photo" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(status, { "Content-Type": mime, Location: "/secret-fallback" }).end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const lookup = createVinArchivePhotoApiLookup({
      AUTODOM_VIN_API_URL: `http://127.0.0.1:${address.port}`,
      AUTODOM_VIN_API_TOKEN: token,
    })!;
    for (const invalid of [
      { ...input, photo_url: "https://attacker.invalid/photo.jpg" },
      { ...input, extra: "field" },
      { ...input, auction: "copart" as const },
    ])
      await expect(lookup(invalid)).rejects.toThrow();
    expect(calls).toBe(0);
    const result = await lookup(input);
    expect(result.content_type).toBe("image/png");
    expect(Buffer.from(result.bytes)).toEqual(png);
    payload = Buffer.from("<html>private-source-token</html>");
    await expect(lookup(input)).rejects.toThrow("invalid photo");
    payload = png;
    mime = "image/svg+xml";
    await expect(lookup(input)).rejects.toThrow("invalid photo");
    mime = "image/png";
    payload = Buffer.alloc(VIN_ARCHIVE_PHOTO_MAX_BYTES + 1);
    await expect(lookup(input)).rejects.toThrow("VIN API unavailable");
    status = 302;
    payload = png;
    const before = calls;
    await expect(lookup(input)).rejects.toThrow("VIN API unavailable");
    expect(calls).toBe(before + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("accepts partial Carway cards without events while preserving US evidence and URL boundaries", async () => {
  const vin = "WP0ZZZ99ZES180140";
  const result: VinArchiveResult = {
    vin,
    checked_at: 1_789_000_000,
    coverage: "indexed_lots_only",
    sources: [
      ...(["copart", "bidcars"] as const).map((provider) => ({
        provider,
        status: "disabled" as const,
        source_url: provider === "copart" ? "https://www.copart.com/" : "https://bid.cars/",
        checked_at: null,
        partial: false,
        lots: [],
      })),
      {
        provider: "carway",
        status: "available",
        source_url: "https://carway.pro/",
        checked_at: 1_789_000_000,
        partial: true,
        lots: [
          {
            auction: "copart_uae",
            lot_id: "52984784",
            source_url: `https://carway.pro/search-vin?vin_number=${vin}`,
            events: [],
            photos: ["https://carway.pro/car_image/52984784_Image_1.jpg"],
            photos_complete: false,
          },
        ],
      },
    ],
  };
  const source = result.sources[2]!;
  const lot = source.lots[0]!;
  let body: unknown = result;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the bounded request. */
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(automaticResult(vin, body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const lookup = createVinApiLookup({
      AUTODOM_VIN_API_URL: `http://127.0.0.1:${address.port}`,
      AUTODOM_VIN_API_TOKEN: "carway-client-test-token-with-32-characters",
    })!;
    await expect(lookup(vin)).resolves.toMatchObject({
      archives: {
        sources: [
          { provider: "copart" },
          { provider: "bidcars" },
          {
            provider: "carway",
            partial: true,
            lots: [
              { auction: "copart_uae", events: [], photos: lot.photos, photos_complete: false },
            ],
          },
        ],
      },
    });
    for (const invalidLot of [
      { ...lot, source_url: lot.source_url.replace(vin, "WP0ZZZ99ZES180141") },
      { ...lot, auction: "copart" },
      { ...lot, photos: [lot.photos[0]!.replace("52984784", "52984785")] },
      { ...lot, photos: ["https://carway.pro.attacker.invalid/car_image/52984784_Image_1.jpg"] },
      { ...lot, photos_complete: true },
      {
        ...lot,
        events: [{ status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: 0 }],
      },
    ]) {
      body = { ...result, sources: [{ ...source, lots: [invalidLot] }] };
      await expect(lookup(vin)).rejects.toThrow();
    }
    body = {
      ...result,
      sources: [
        {
          ...source,
          provider: "copart",
          source_url: "https://www.copart.com/",
          status: "no_photos",
          partial: false,
          lots: [
            {
              ...lot,
              auction: "copart",
              source_url: "https://www.copart.com/lot/52984784",
              photos: [],
              photos_complete: true,
            },
          ],
        },
      ],
    };
    await expect(lookup(vin)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
