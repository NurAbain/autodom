import { randomUUID } from "node:crypto";
import {
  type DocumentTransport,
  makeListing,
  makeSourcePage,
  RateBook,
  type Settings,
  SOURCES,
} from "@autodom/core";
import { fetchSourcePage } from "@autodom/sources";
import { Store } from "@autodom/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectTick } from "../src/collector.js";

vi.mock("@autodom/sources", () => ({ fetchSourcePage: vi.fn() }));

const NOW = 2_000_000_000;
const configuredSource = SOURCES.find((candidate) => candidate.id === "bid.cars");
if (!configuredSource) throw new Error("Bid.Cars source is not registered");
const source = configuredSource;
const prefix = `source:${source.id}:`;
const scope = "automobiles";
const transport: DocumentTransport = {
  async fetchDocument() {
    throw new Error("Unexpected network request in collector regression");
  },
  async fetchDocuments() {
    throw new Error("Unexpected network request in collector regression");
  },
};
let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Pool;
let baseUrl: string;
let schema: string | undefined;
let store: Store | undefined;
let db: Store;
let settings: Settings;
let rates: RateBook;

function catalogPage(page: number, pages: number, exact = false, searchScope = scope) {
  return makeSourcePage({
    page,
    pages,
    pages_exact: exact,
    scope: searchScope,
    listings: [
      makeListing({
        id: `bid.cars:${searchScope}:${page}`,
        source: source.id,
        market: source.market,
        title: `Toyota Camry lot ${page}`,
        url: `https://bid.cars/en/lot/1-${page}/`,
        price_kind: "auction",
        auction_house: "Copart",
        auction_lot: String(page),
      }),
    ],
  });
}

async function seedCrawl(pages: number, nextPage: number, searchScope = scope) {
  await db.transaction(async () => {
    await db.setMeta(`${prefix}scope`, searchScope);
    await db.setMeta(`${prefix}catalog_pages`, String(pages));
    await db.setMeta(`${prefix}crawl_next_page`, String(nextPage));
    await db.setMeta(`${prefix}full_scan_completed_at`, "0");
    await db.setMeta(`${prefix}next_refresh_at`, String(NOW));
  });
}

async function tick() {
  return collectTick(db, source, settings, transport, rates, new AbortController().signal);
}

beforeAll(async () => {
  baseUrl = process.env.AUTODOM_TEST_DATABASE_URL ?? "";
  if (!baseUrl) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    baseUrl = container.getConnectionUri();
  }
  admin = new pg.Pool({ connectionString: baseUrl });
}, 120_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  vi.mocked(fetchSourcePage).mockReset();
  schema = `collector_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = await Store.open(url.toString());
  store = db;
  settings = {
    database_url: url.toString(),
    redis_url: "redis://127.0.0.1:6379/0",
    data_dir: ".local",
    backup_directory: ".local/backups",
    monitor_seconds: 30,
    refresh_seconds: 60,
    refresh_pages: 3,
    crawl_delay: 0,
    full_refresh_seconds: 86400,
  };
  rates = new RateBook(db, transport);
  vi.spyOn(rates, "refresh").mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await store?.close();
  store = undefined;
  if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  schema = undefined;
});

afterAll(async () => {
  await admin?.end();
  await container?.stop();
});

describe("durable catalog pagination", () => {
  it("keeps ingesting deeper lots across repeated smaller inexact front-page refreshes", async () => {
    await seedCrawl(9, 8);
    const requested: number[] = [];
    vi.mocked(fetchSourcePage).mockImplementation(async (_source, { page = 1 }) => {
      requested.push(page);
      if (![1, 2, 3, 8, 9].includes(page)) throw new Error(`Unexpected page ${page}`);
      return catalogPage(page, page + 1);
    });

    await tick();

    expect(await db.getListing("bid.cars:automobiles:8")).toMatchObject({
      auction_lot: "8",
      observed_at: NOW,
    });
    expect(requested).toEqual([1, 2, 3, 8]);
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("9");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");

    vi.setSystemTime((NOW + settings.refresh_seconds) * 1000);
    await tick();

    expect(await db.getListing("bid.cars:automobiles:9")).toMatchObject({
      auction_lot: "9",
      observed_at: NOW + settings.refresh_seconds,
    });
    expect(requested).toEqual([1, 2, 3, 8, 1, 2, 3, 9]);
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("10");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");
  });

  it("honors a smaller exact terminal page instead of fetching beyond the evidenced end", async () => {
    await seedCrawl(20, 3);
    const requested: number[] = [];
    vi.mocked(fetchSourcePage).mockImplementation(async (_source, { page = 1 }) => {
      requested.push(page);
      if (page > 2) throw new Error(`Nonexistent page ${page}`);
      return catalogPage(page, 2, page === 2);
    });

    await tick();
    await tick();

    expect(await db.getListing("bid.cars:automobiles:2")).toMatchObject({ auction_lot: "2" });
    expect(requested).toEqual([1, 2]);
    expect(await db.getMeta(`${prefix}catalog_pages`)).toBe("2");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe(String(NOW));
    expect(await db.getMeta(`${prefix}source_error`)).toBe("");
  });

  it("honors exact reduced counts reported by nonterminal refresh pages", async () => {
    await seedCrawl(20, 8);
    vi.mocked(fetchSourcePage).mockImplementation(async (_source, { page = 1 }) => {
      if (page > 5) throw new Error(`Nonexistent page ${page}`);
      return catalogPage(page, 5, true);
    });

    await tick();

    expect(await db.getListing("bid.cars:automobiles:3")).toMatchObject({ auction_lot: "3" });
    expect(await db.getMeta(`${prefix}catalog_pages`)).toBe("5");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe(String(NOW));
    expect(await db.getMeta(`${prefix}source_error`)).toBe("");
  });

  it("does not carry an old inexact frontier into a changed first-page scope", async () => {
    await seedCrawl(20, 8, "old-search");
    const requested: number[] = [];
    vi.mocked(fetchSourcePage).mockImplementation(async (_source, { page = 1 }) => {
      requested.push(page);
      if (page > 3) throw new Error(`Page ${page} belongs to the old crawl`);
      return catalogPage(page, page + 1, false, "new-search");
    });

    await tick();

    expect(await db.getListing("bid.cars:new-search:3")).toMatchObject({ auction_lot: "3" });
    expect(requested).not.toContain(8);
    expect(await db.getMeta(`${prefix}catalog_pages`)).toBe("4");
    expect(await db.getMeta(`${prefix}source_error`)).toBe("");
  });
});
