import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { makeListing } from "@autodom/core";
import { Store } from "@autodom/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSiteServer } from "../src/site-server.js";

let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Pool;
let baseUrl: string;
let store: Store;
let origin: string;
const schemas: string[] = [];

const car = makeListing({
  id: "mashina-77",
  title: "Toyota Camry 2.0",
  url: "https://www.mashina.kg/77",
  price_usd_minor: 1_500_000,
  price_kgs_minor: 135_000_000,
  availability: "В наличии",
  year: 2021,
  mileage: "45 000 km",
  city: "Бишкек",
  source: "mashina.kg",
  catalog_attributes: { make: "Toyota", model: "Camry" },
});

beforeAll(async () => {
  baseUrl = process.env.AUTODOM_TEST_DATABASE_URL ?? "";
  if (!baseUrl) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    baseUrl = container.getConnectionUri();
  }
  admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `site_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  store = await Store.open(parsed.toString());
  await store.upsertListings([car], Date.now() / 1000);
  const server = await startSiteServer({
    store,
    publicUrl: "https://cars.example.org",
    botUsername: "autodomkgbot",
    assetsDirectory: "apps/bot/web",
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await store?.close();
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin?.end();
  await container?.stop();
});

describe("public catalogue site", () => {
  it("serves the home page with the catalogue counts", async () => {
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Toyota Camry 2.0");
    expect(html).toContain("Toyota (1)");
  });

  it("serves the catalogue with the source and the observation date", async () => {
    const response = await fetch(`${origin}/cars`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Источник: mashina.kg");
    expect(html).toContain("Найдено 1");
  });

  it("keeps the filters in the URL and answers an empty result honestly", async () => {
    const response = await fetch(`${origin}/cars?year_min=2030`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Под текущие условия ничего не нашлось");
    expect(html).toContain("Не ограничивать год");
  });

  it("shows the last page when the requested page is beyond the range", async () => {
    const response = await fetch(`${origin}/cars?page=999`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Toyota Camry 2.0");
    expect(html).not.toContain("page=999");
  });

  it("serves the car page with the hand-off to the bot", async () => {
    const response = await fetch(`${origin}/cars/mashina-77`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Toyota Camry 2.0");
    expect(html).toContain("https://t.me/autodomkgbot?start=car_mashina-77");
    expect(html).toContain("https://www.mashina.kg/77");
  });

  it("answers a missing car with a real 404 page", async () => {
    const response = await fetch(`${origin}/cars/unknown-id`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Страница не найдена");
  });

  it("serves the brand page from the shared catalogue", async () => {
    const response = await fetch(`${origin}/brands/Toyota`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Toyota Camry 2.0");
  });

  it("serves the stylesheet and the health probe", async () => {
    const css = await fetch(`${origin}/site.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ healthy: true });
  });

  it("refuses methods other than GET and HEAD", async () => {
    const response = await fetch(`${origin}/cars`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("sends a content security policy without inline scripts", async () => {
    const response = await fetch(`${origin}/`);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
  });
});
