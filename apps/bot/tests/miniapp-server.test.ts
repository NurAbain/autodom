import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeListing, makeProfile } from "@autodom/core";
import type { VinCheckResult, VinLookup } from "@autodom/core/vin";
import type {
  VinArchiveLookup,
  VinArchivePhotoLookup,
  VinArchivePhotoRequest,
  VinArchiveResult,
} from "@autodom/core/vin-archive";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMiniAppServer } from "../src/miniapp-server.js";

const TOKEN = "12345:detail-server-fixture";
const PUBLIC_URL = "https://cars.example/miniapp/";
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;
let server: Server;
let directory: string;
let base: string;
let databaseReady = true;
let readinessError: Error | null = null;
const storageError = new Error("database password=private-connection-secret");
const profile = makeProfile({
  user_id: 42,
  chat_id: 42,
  currency: "USD",
  budget_min_minor: 0,
  budget_max_minor: 100,
  query: "Honda Fit",
});
const listing = makeListing({
  id: "mashina:old-notification",
  title: "Toyota Camry",
  url: "https://www.mashina.kg/details/1",
  price_usd_minor: 2_000_000,
  availability: "В наличии",
  vin: "JTDBR32E720000001",
});
const vinResult: VinCheckResult = {
  vin: "KMHDU41DBAU123456",
  checked_at: 1_789_000_000,
  carhistory: {
    status: "available",
    source_url: "https://www.carhistory.or.kr/",
    checked_at: 1_789_000_000,
  },
  car365: {
    status: "unavailable",
    source_url: "https://www.car365.go.kr/",
    checked_at: 1_789_000_000,
    data: null,
  },
};
const checkVin = vi.fn<VinLookup>(async () => vinResult);
const archiveResult: VinArchiveResult = {
  vin: vinResult.vin,
  checked_at: vinResult.checked_at,
  coverage: "indexed_lots_only",
  sources: [
    {
      provider: "copart",
      status: "no_photos",
      source_url: "https://www.copart.com/",
      checked_at: vinResult.checked_at,
      partial: true,
      lots: [
        {
          auction: "copart",
          lot_id: "12345678",
          source_url: "https://www.copart.com/lot/12345678",
          events: [
            { status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: null },
          ],
          photos: [],
          photos_complete: false,
        },
      ],
    },
  ],
};
const checkVinArchive = vi.fn<VinArchiveLookup>(async () => archiveResult);
const photoRequest: VinArchivePhotoRequest = {
  vin: "1FTFW1ED9NFB06106",
  provider: "bidcars",
  auction: "iaai",
  lot_id: "45397077",
  photo_url: "https://mercury.bid.cars/0-45397077/2022-Ford-F-150-1FTFW1ED9NFB06106-1.jpg",
};
const photoBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
  "base64",
);
const getVinArchivePhoto = vi.fn<VinArchivePhotoLookup>(async () => ({
  bytes: photoBytes,
  content_type: "image/png",
}));

function authorization(userId = 42): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Покупатель" }),
  });
  params.sort();
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set(
    "hash",
    createHmac("sha256", secret)
      .update([...params].map(([key, value]) => `${key}=${value}`).join("\n"))
      .digest("hex"),
  );
  return `tma ${params}`;
}

beforeAll(async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  directory = await mkdtemp(join(tmpdir(), "autodom-details-"));
  await Promise.all([
    writeFile(join(directory, "index.html"), "<!doctype html><title>Details</title>"),
    writeFile(join(directory, "app.js"), ""),
    writeFile(join(directory, "app.css"), ""),
  ]);
  server = await startMiniAppServer({
    token: TOKEN,
    publicUrl: PUBLIC_URL,
    host: "127.0.0.1",
    port: 0,
    assetsDirectory: directory,
    checkVin,
    checkVinArchive,
    getVinArchivePhoto,
    ready: async () => {
      if (readinessError) throw readinessError;
      return databaseReady;
    },
    store: {
      async getProfile(id) {
        if (id === 42) return profile;
        if (id === 43) return { ...profile, user_id: 43, chat_id: -100 };
        return null;
      },
      async getListing(id, freshOnly) {
        if (id === "storage-error") throw storageError;
        if (id === listing.id) return listing;
        if (id === "stale") return freshOnly ? null : { ...listing, id };
        if (id === "disabled") return { ...listing, id, source: "encar.com" };
        if (id === "unsafe") return { ...listing, id, url: "javascript:alert(1)", vin: "" };
        return null;
      },
    },
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listening address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("rejects missing credentials, cross-origin access, absent profiles and non-private profiles", async () => {
  const path = `${base}/miniapp/api/car?id=${encodeURIComponent(listing.id)}`;
  expect((await fetch(path)).status).toBe(401);
  expect(
    (
      await fetch(path, {
        headers: { Authorization: authorization(), Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(path, {
        headers: { Authorization: authorization(), "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  for (const userId of [43, 44])
    expect((await fetch(path, { headers: { Authorization: authorization(userId) } })).status).toBe(
      403,
    );
});

it("opens a specific older notification independently of the current saved filter", async () => {
  const response = await fetch(`${base}/miniapp/api/car?id=${encodeURIComponent(listing.id)}`, {
    headers: { Authorization: authorization(), Origin: PUBLIC_ORIGIN },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: listing.id, vin: listing.vin });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

it("does not disclose stale, missing or disabled-source listings", async () => {
  for (const id of ["stale", "missing", "disabled"])
    expect(
      (
        await fetch(`${base}/miniapp/api/car?id=${id}`, {
          headers: { Authorization: authorization() },
        })
      ).status,
    ).toBe(404);
});

it("does not expose unsafe source links or fabricate a missing VIN", async () => {
  const response = await fetch(`${base}/miniapp/api/car?id=unsafe`, {
    headers: { Authorization: authorization() },
  });
  expect(response.status).toBe(200);
  const car = await response.json();
  expect(car.url).toBeNull();
  expect(car.vin).toBeNull();
  expect(car.detailsHtml).not.toContain("javascript:");
});

it("has no catalog or mutation endpoints and rejects ambiguous car IDs", async () => {
  const headers = { Authorization: authorization() };
  expect(
    (
      await fetch(`${base}/miniapp/api/car?id=${encodeURIComponent(listing.id)}`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(405);
  for (const path of [
    "/api/car",
    "/api/vin",
    "/miniapp/api/cars",
    "/miniapp/api/profile",
    "/miniapp/api/session",
    "/miniapp/api/action",
    "/miniapp/api/monitor",
    "/miniapp/api/consent",
    "/miniapp/api/send-card",
    "/miniapp/api/share",
  ])
    for (const method of ["GET", "POST"])
      expect((await fetch(`${base}${path}`, { method, headers })).status).toBe(404);
  expect((await fetch(`${base}/miniapp/api/car?id=unsafe&id=disabled`, { headers })).status).toBe(
    400,
  );
});

it("serves the detail shell and assets only at the public Mini App base", async () => {
  for (const [path, contentType] of [
    ["/miniapp/?car=mashina%3Aold-notification", "text/html"],
    ["/miniapp/app.js", "text/javascript"],
    ["/miniapp/app.css", "text/css"],
  ]) {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(contentType);
    const metadata = await fetch(`${base}${path}`, { method: "HEAD" });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-length")).toBe(response.headers.get("content-length"));
    expect(await metadata.text()).toBe("");
  }
  for (const path of ["/", "/app.js", "/app.css", "/miniapp/index.html"])
    expect((await fetch(`${base}${path}`)).status).toBe(404);
});

it("canonicalizes the Mini App URL without losing the car deep link or changing origin", async () => {
  const query = "?car=mashina%3Aold-notification";
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${base}/miniapp${query}`, { method, redirect: "manual" });
    expect(response.status).toBe(308);
    const destination = new URL(response.headers.get("location")!, PUBLIC_URL);
    expect(destination.href).toBe(`${PUBLIC_URL}${query}`);
  }
});

it("reflects current database readiness while liveness remains independent", async () => {
  try {
    for (const ready of [true, false, true]) {
      databaseReady = ready;
      const response = await fetch(`${base}/ready`);
      expect(response.status).toBe(ready ? 200 : 503);
      expect(await response.json()).toEqual({ ready });
      expect((await fetch(`${base}/health`)).status).toBe(200);
    }
    readinessError = storageError;
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(storageError.message);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {
    databaseReady = true;
    readinessError = null;
  }
});

it("returns a retryable service error without disclosing internal storage failures", async () => {
  const response = await fetch(`${base}/miniapp/api/car?id=storage-error`, {
    headers: { Authorization: authorization() },
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(storageError.message);
});

it("checks VIN without a buyer profile and preserves partial provider failures", async () => {
  checkVinArchive.mockClear();
  getVinArchivePhoto.mockClear();
  const response = await fetch(`${base}/miniapp/api/vin`, {
    method: "POST",
    headers: {
      Authorization: authorization(44),
      Origin: PUBLIC_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vin: ` ${vinResult.vin.toLowerCase()} ` }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(vinResult);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(checkVinArchive).not.toHaveBeenCalled();
  expect(getVinArchivePhoto).not.toHaveBeenCalled();
});

it("keeps a confirmed archive lot without photos accessible independently of buyer profiles and normal decoding", async () => {
  checkVin.mockClear();
  const response = await fetch(`${base}/miniapp/api/vin/archive-photos`, {
    method: "POST",
    headers: {
      Authorization: authorization(44),
      Origin: PUBLIC_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vin: vinResult.vin }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(archiveResult);
  expect(checkVin).not.toHaveBeenCalled();
});

it.each(["/miniapp/api/vin", "/miniapp/api/vin/archive-photos"])(
  "never sends unauthorized, ambiguous or invalid requests to %s",
  async (path) => {
    checkVin.mockClear();
    checkVinArchive.mockClear();
    const valid = JSON.stringify({ vin: vinResult.vin });
    for (const [headers, body, expected] of [
      [{}, valid, 401],
      [{ Authorization: authorization(), Origin: "https://other.example" }, valid, 403],
      [{ Authorization: authorization(), "Sec-Fetch-Site": "cross-site" }, valid, 403],
      [
        { Authorization: authorization() },
        '{"vin":"KMHDU41DBAU123456","vin":"JTDBR32E720000001"}',
        400,
      ],
      [
        { Authorization: authorization() },
        '{"vin":"KMHDU41DBAU123456","v\\u0069n":"JTDBR32E720000001"}',
        400,
      ],
      [{ Authorization: authorization() }, '{"vin":42}', 400],
      [{ Authorization: authorization() }, '{"vin":"KMHDU41DBAU12345I"}', 400],
      [{ Authorization: authorization() }, '{"vin":"KMHDU41DBAU123456","extra":true}', 400],
      [{ Authorization: authorization() }, `{"vin":"${"A".repeat(2048)}"}`, 413],
      [{ Authorization: authorization(), "Content-Type": "text/plain" }, valid, 415],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
      expect(response.status).toBe(expected);
    }
    const headers = { Authorization: authorization(), "Content-Type": "application/json" };
    const method = await fetch(`${base}${path}`, { headers });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expect(
      (
        await fetch(`${base}${path}?vin=${vinResult.vin}`, {
          method: "POST",
          headers,
          body: valid,
        })
      ).status,
    ).toBe(400);
    expect(checkVin).not.toHaveBeenCalled();
    expect(checkVinArchive).not.toHaveBeenCalled();
  },
);

it("reports an unconfigured VIN service without fabricating observations", async () => {
  const disabled = await startMiniAppServer({
    token: TOKEN,
    publicUrl: PUBLIC_URL,
    host: "127.0.0.1",
    port: 0,
    assetsDirectory: directory,
    ready: async () => true,
    store: { getProfile: async () => null, getListing: async () => null },
  });
  try {
    const address = disabled.address();
    if (!address || typeof address === "string") throw new Error("No listening address");
    const response = await fetch(`http://127.0.0.1:${address.port}/miniapp/api/vin`, {
      method: "POST",
      headers: { Authorization: authorization(44), "Content-Type": "application/json" },
      body: JSON.stringify({ vin: vinResult.vin }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "vin_not_enabled" });
    const archiveResponse = await fetch(
      `http://127.0.0.1:${address.port}/miniapp/api/vin/archive-photos`,
      {
        method: "POST",
        headers: { Authorization: authorization(44), "Content-Type": "application/json" },
        body: JSON.stringify({ vin: vinResult.vin }),
      },
    );
    expect(archiveResponse.status).toBe(200);
    expect(await archiveResponse.json()).toMatchObject({
      sources: [
        { provider: "copart", status: "disabled", checked_at: null, lots: [] },
        { provider: "bidcars", status: "disabled", checked_at: null, lots: [] },
      ],
    });
    const photoResponse = await fetch(
      `http://127.0.0.1:${address.port}/miniapp/api/vin/archive-photo`,
      {
        method: "POST",
        headers: { Authorization: authorization(44), "Content-Type": "application/json" },
        body: JSON.stringify(photoRequest),
      },
    );
    expect(photoResponse.status).toBe(503);
    expect(await photoResponse.json()).toMatchObject({ code: "vin_archive_photo_unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      disabled.close((error) => (error ? reject(error) : resolve()));
      disabled.closeAllConnections();
    });
  }
});

it("keeps car access and readiness independent of VIN API transport failure", async () => {
  checkVin.mockRejectedValueOnce(new Error("token=private-vin-api-secret"));
  const response = await fetch(`${base}/miniapp/api/vin`, {
    method: "POST",
    headers: { Authorization: authorization(44), "Content-Type": "application/json" },
    body: JSON.stringify({ vin: vinResult.vin }),
  });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({ code: "vin_unavailable" });
  expect(body.error).toMatch(/неизвестен/);
  expect(body.error).not.toContain("private-vin-api-secret");
  expect(
    (
      await fetch(`${base}/miniapp/api/car?id=${encodeURIComponent(listing.id)}`, {
        headers: { Authorization: authorization() },
      })
    ).status,
  ).toBe(200);
  expect((await fetch(`${base}/ready`)).status).toBe(200);
});

it("does not turn archive transport failure into an empty successful history", async () => {
  checkVinArchive.mockRejectedValueOnce(new Error("private-archive-token"));
  const response = await fetch(`${base}/miniapp/api/vin/archive-photos`, {
    method: "POST",
    headers: { Authorization: authorization(44), "Content-Type": "application/json" },
    body: JSON.stringify({ vin: vinResult.vin }),
  });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({ code: "vin_archive_unavailable" });
  expect(body).not.toHaveProperty("sources");
  expect(JSON.stringify(body)).not.toContain("private-archive-token");
});

it("reports refused dialogue admission as retryable without confusing an empty successful reply", async () => {
  let busy = true;
  const dialogueServer = await startMiniAppServer({
    token: TOKEN,
    publicUrl: PUBLIC_URL,
    host: "127.0.0.1",
    port: 0,
    assetsDirectory: directory,
    ready: async () => true,
    store: { getProfile: async () => null, getListing: async () => null },
    dialogue: async () => (busy ? null : []),
  });
  try {
    const address = dialogueServer.address();
    if (!address || typeof address === "string") throw new Error("No listening address");
    const endpoint = `http://127.0.0.1:${address.port}/miniapp/api/dialogue`;
    const request = {
      method: "POST",
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/cancel" }),
    };
    const rejected = await fetch(endpoint, request);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).not.toHaveProperty("replies");
    busy = false;
    const admitted = await fetch(endpoint, request);
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ replies: [] });
  } finally {
    await new Promise<void>((resolve, reject) => {
      dialogueServer.close((error) => (error ? reject(error) : resolve()));
      dialogueServer.closeAllConnections();
    });
  }
});

it.each(["/miniapp/api/vin", "/miniapp/api/vin/archive-photos"])(
  "cancels %s when the authenticated client disconnects",
  async (path) => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const lookup = path.endsWith("archive-photos") ? checkVinArchive : checkVin;
    lookup.mockImplementationOnce(async (_vin, signal) => {
      if (!signal) throw new Error("Missing cancellation signal");
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await aborted.promise;
      throw signal.reason;
    });
    const controller = new AbortController();
    const response = fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: authorization(44), "Content-Type": "application/json" },
      body: JSON.stringify({ vin: vinResult.vin }),
      signal: controller.signal,
    });
    const rejection = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejection;
    await aborted.promise;
  },
);

it("serves private archive photo bytes without a profile and never exposes a CDN redirect", async () => {
  const response = await fetch(`${base}/miniapp/api/vin/archive-photo`, {
    method: "POST",
    headers: { Authorization: authorization(44), "Content-Type": "application/json" },
    body: JSON.stringify(photoRequest),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe(String(photoBytes.length));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("location")).toBeNull();
  expect(Buffer.from(await response.arrayBuffer())).toEqual(photoBytes);
});

it("rejects unauthorized, duplicate-key, foreign and extended photo requests before fetching", async () => {
  getVinArchivePhoto.mockClear();
  const valid = JSON.stringify(photoRequest);
  for (const [headers, body, status] of [
    [{}, valid, 401],
    [{ Authorization: authorization(), Origin: "https://other.example" }, valid, 403],
    [
      { Authorization: authorization() },
      valid.replace('{"vin":', '{"v\\u0069n":"1FTFW1ED9NFB06106","vin":'),
      400,
    ],
    [{ Authorization: authorization() }, JSON.stringify({ ...photoRequest, extra: "field" }), 400],
    [
      { Authorization: authorization() },
      JSON.stringify({ ...photoRequest, photo_url: "https://attacker.invalid/photo.jpg" }),
      400,
    ],
    [
      { Authorization: authorization() },
      JSON.stringify({ ...photoRequest, lot_id: "45397078" }),
      400,
    ],
  ] as const) {
    const response = await fetch(`${base}/miniapp/api/vin/archive-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(response.status).toBe(status);
  }
  expect(getVinArchivePhoto).not.toHaveBeenCalled();
});

it("keeps photo delivery failures sanitized and asks for a fresh archive lookup", async () => {
  getVinArchivePhoto.mockRejectedValueOnce(new Error("proxy-password-private"));
  const response = await fetch(`${base}/miniapp/api/vin/archive-photo`, {
    method: "POST",
    headers: { Authorization: authorization(44), "Content-Type": "application/json" },
    body: JSON.stringify(photoRequest),
  });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({ code: "vin_archive_photo_unavailable" });
  expect(JSON.stringify(body)).not.toContain("proxy-password-private");
  expect(body).not.toHaveProperty("photo_url");
});

it("aborts photo upstream work when the authenticated viewer disconnects", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  getVinArchivePhoto.mockImplementationOnce(async (_request, signal) => {
    if (!signal) throw new Error("Missing cancellation signal");
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve();
    await aborted.promise;
    throw signal.reason;
  });
  const controller = new AbortController();
  const response = fetch(`${base}/miniapp/api/vin/archive-photo`, {
    method: "POST",
    headers: { Authorization: authorization(44), "Content-Type": "application/json" },
    body: JSON.stringify(photoRequest),
    signal: controller.signal,
  });
  const rejection = expect(response).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise;
  controller.abort();
  await rejection;
  await aborted.promise;
});
