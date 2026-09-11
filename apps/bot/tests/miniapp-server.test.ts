import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeListing, makeProfile } from "@autodom/core";
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
