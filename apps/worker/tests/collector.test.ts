import { randomUUID } from "node:crypto";
import {
  type DocumentTransport,
  makeListing,
  makeProfile,
  makeSourcePage,
  parseQuote,
  RateBook,
  type Settings,
  SOURCES,
  SourceError,
} from "@autodom/core";
import { fetchSourcePage } from "@autodom/sources";
import { Store } from "@autodom/storage";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOnce } from "../../bot/src/monitor.js";
import { collectTick, recordPage } from "../src/collector.js";

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
  vi.unstubAllEnvs();
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

  it("restarts a changed first-page scope and reaches its next unknown page without a full-refresh wait", async () => {
    await seedCrawl(20, 8, "old-search");
    await db.setMeta(`${prefix}full_scan_completed_at`, String(NOW - 1));
    const requested: number[] = [];
    vi.mocked(fetchSourcePage).mockImplementation(async (_source, { page = 1 }) => {
      requested.push(page);
      if (page > 4) throw new Error(`Page ${page} belongs to the old crawl`);
      return catalogPage(page, page + 1, false, "new-search");
    });

    await tick();

    expect(await db.getListing("bid.cars:new-search:3")).toMatchObject({ auction_lot: "3" });
    expect(requested).not.toContain(8);
    expect(await db.getMeta(`${prefix}catalog_pages`)).toBe("4");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");
    expect(await db.getMeta(`${prefix}source_error`)).toBe("");

    await tick();
    await tick();
    await tick();

    expect(await db.getListing("bid.cars:new-search:4")).toMatchObject({
      auction_lot: "4",
      observed_at: NOW,
    });
    expect(requested).not.toContain(8);
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("5");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");
  });

  it("rejects a changed deeper scope without ingesting it or marking a successful observation", async () => {
    await seedCrawl(20, 8, "old-search");
    await db.setMeta(`${prefix}last_success_at`, String(NOW - 60));

    await expect(
      recordPage(db, source, catalogPage(8, 9, false, "new-search"), NOW),
    ).rejects.toThrow(SourceError);

    expect(await db.getListing("bid.cars:new-search:8")).toBeNull();
    expect(await db.getMeta(`${prefix}scope`)).toBe("old-search");
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("1");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");
    expect(await db.getMeta(`${prefix}last_success_at`)).toBe(String(NOW - 60));
  });

  it("commits empty-page success and resets changed-scope crawl state atomically", async () => {
    await seedCrawl(20, 8, "old-search");
    await db.setMeta(`${prefix}full_scan_completed_at`, String(NOW - 1));
    await db.setMeta(`${prefix}source_error`, "SourceError");
    await db.setMeta(`${prefix}last_success_at`, String(NOW - 60));
    const page = makeSourcePage({ listings: [], page: 1, pages: 1, total: 0, scope: "new-search" });
    const setMeta = db.setMeta.bind(db);
    vi.spyOn(db, "setMeta").mockImplementation(async (key, value) => {
      if (key === `${prefix}source_error`) throw new Error("metadata write failed");
      await setMeta(key, value);
    });

    await expect(recordPage(db, source, page, NOW)).rejects.toThrow("metadata write failed");
    expect(await db.getMeta(`${prefix}scope`)).toBe("old-search");
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("8");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe(String(NOW - 1));
    expect(await db.getMeta(`${prefix}last_success_at`)).toBe(String(NOW - 60));

    vi.mocked(db.setMeta).mockRestore();
    await recordPage(db, source, page, NOW);

    expect(await db.getMeta(`${prefix}scope`)).toBe("new-search");
    expect(await db.getMeta(`${prefix}crawl_next_page`)).toBe("1");
    expect(await db.getMeta(`${prefix}full_scan_completed_at`)).toBe("0");
    expect(await db.getMeta(`${prefix}source_error`)).toBe("");
    expect(await db.getMeta(`${prefix}last_success_at`)).toBe(String(NOW));
  });
});

it("notifies a real Mashina native reduction once but never a converted USD display drop", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const mashina = SOURCES.find((candidate) => candidate.id === "mashina.kg")!;
  const actualSources = await vi.importActual<{ fetchSourcePage: typeof fetchSourcePage }>(
    "@autodom/sources",
  );
  let usd = 34000;
  let kgs = 2973300;
  const captured: DocumentTransport = {
    async fetchDocument(url, parse) {
      const item = {
        id: 10112178,
        slug: "toyota-camry",
        category_id: 1,
        title: "Toyota Camry",
        status: "active",
        availability: "В наличии",
        prices: [
          { currency: "USD", amount: usd, is_original: false },
          { currency: "KGS", amount: kgs, is_original: true },
        ],
      };
      if (url.endsWith("/detail")) return parse(JSON.stringify(item));
      return parse(
        `1:${JSON.stringify({
          items: [item],
          total: 1,
          page: 1,
          size: 21,
          pages: 1,
        })}\n`,
      );
    },
    fetchDocuments: transport.fetchDocuments,
  };
  const observe = async (at: number) =>
    recordPage(
      db,
      mashina,
      await actualSources.fetchSourcePage(mashina.id, { transport: captured }),
      at,
    );
  await observe(NOW - 3);
  await db.saveProfile(
    makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 4_000_000,
      monitoring: true,
    }),
  );
  const send = vi.fn(async () => undefined);
  const initialCursor = (await db.getProfile(1))!.cursor;

  usd = 33000;
  await observe(NOW - 2);
  expect(await notifyOnce(db, send)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(await db.eventsAfter(initialCursor)).toEqual([]);

  usd = 32000;
  kgs = 2883200;
  await observe(NOW - 1);
  expect(await notifyOnce(db, send)).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await notifyOnce(db, send)).toBe(0);
});

it("collects and notifies published single-currency KG ads without reporting FX-only drops", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "lalafo.kg");
  const lalafo = SOURCES.find((candidate) => candidate.id === "lalafo.kg")!;
  const quoteDate = new Date((NOW + 6 * 3600) * 1000)
    .toISOString()
    .slice(0, 10)
    .split("-")
    .reverse()
    .join(".");
  rates.quotes.USD = parseQuote(
    `<CurrencyRates Date="${quoteDate}"><Currency ISOCode="USD"><Nominal>1</Nominal><Value>90</Value></Currency></CurrencyRates>`,
    "USD",
  );
  let native = 9000;
  vi.mocked(fetchSourcePage).mockImplementation(async () =>
    makeSourcePage({
      page: 1,
      pages: 1,
      pages_exact: true,
      scope: "passenger-cars",
      listings: [
        makeListing({
          id: "lalafo:1",
          source: "lalafo.kg",
          market: "KG",
          title: "Toyota Camry",
          url: "https://lalafo.kg/bishkek/ads/toyota-camry-id-1",
          availability: "опубликовано",
          original_currency: "KGS",
          original_price_minor: native,
          price_kgs_minor: native,
        }),
      ],
    }),
  );
  await db.saveProfile(
    makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 200,
      monitoring: true,
    }),
  );
  const collect = () =>
    collectTick(db, lalafo, settings, transport, rates, new AbortController().signal);
  const send = vi.fn(async () => undefined);
  await collect();
  expect(await db.getListing("lalafo:1")).toMatchObject({
    original_price_minor: 9000,
    price_usd_minor: 100,
    price_kgs_minor: 9000,
    availability: "опубликовано",
  });
  expect(await notifyOnce(db, send)).toBe(1);
  const cursor = (await db.getProfile(1))!.cursor;

  vi.setSystemTime((NOW + 60) * 1000);
  rates.quotes.USD = parseQuote(
    `<CurrencyRates Date="${quoteDate}"><Currency ISOCode="USD"><Nominal>1</Nominal><Value>100</Value></Currency></CurrencyRates>`,
    "USD",
  );
  await collect();
  expect((await db.getListing("lalafo:1"))?.price_usd_minor).toBe(90);
  expect(await db.eventsAfter(cursor)).toEqual([]);
  expect(await notifyOnce(db, send)).toBe(0);

  vi.setSystemTime((NOW + 120) * 1000);
  native = 8000;
  await collect();
  expect((await db.getListing("lalafo:1"))?.price_usd_minor).toBe(80);
  expect(await notifyOnce(db, send)).toBe(1);
  expect(await notifyOnce(db, send)).toBe(0);
  expect(send).toHaveBeenCalledTimes(2);
});
