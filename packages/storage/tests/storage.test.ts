import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Listing, makeListing, makeProfile, matches } from "@autodom/core";
import type { OwnerVehicle } from "@autodom/core/owner-vehicle";
import type { PaymentEvent, PaymentOfferInput } from "@autodom/core/payments";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importSqlite } from "../src/import-sqlite.js";
import { PaymentStore } from "../src/payments.js";
import { backup, restore } from "../src/snapshots.js";
import { Store } from "../src/store.js";

const NOW = 2_000_000_000;
const car = (changes: Partial<Listing> = {}) =>
  makeListing({
    id: "1",
    title: "Toyota Camry",
    url: "https://www.mashina.kg/1",
    price_usd_minor: 100,
    price_kgs_minor: 9000,
    availability: "В наличии",
    ...changes,
  });
const profile = () =>
  makeProfile({
    user_id: 1,
    chat_id: 10,
    currency: "USD",
    budget_min_minor: 100,
    budget_max_minor: 200,
    monitoring: true,
  });
const ownerCard = (): OwnerVehicle => ({
  user_id: 1,
  chat_id: 10,
  purpose: "downpayment",
  make_model: "Toyota Camry",
  year: 2018,
  mileage_km: null,
  sale_price_minor: null,
  sale_currency: null,
  property_city: "Бишкек",
  property_type: "apartment",
  cash_minor: 0,
  cash_currency: "KGS",
  monthly_minor: 3000000,
  monthly_currency: "KGS",
  consent_at: NOW - 10,
  updated_at: NOW,
});
let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Pool;
let baseUrl: string;
let db: Store;
let url: string;
let directory: string;
const schemas: string[] = [];
const stores: Store[] = [];
async function database() {
  const schema = `storage_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}
async function open(address: string) {
  const store = await Store.open(address);
  stores.push(store);
  return store;
}
async function rewriteSnapshot(
  source: string,
  destination: string,
  change: (record: Record<string, unknown>) => void,
) {
  const records = (await readFile(source, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const footer = records.pop()!;
  for (const record of records) change(record);
  if (Number(records[0]?.schema_version) < 4) {
    records[0]!.tables = (records[0]!.tables as string[]).filter(
      (table) => table !== "owner_vehicles",
    );
    delete (footer.counts as Record<string, number>).owner_vehicles;
  }
  if (Number(records[0]?.schema_version) < 5) {
    records[0]!.tables = (records[0]!.tables as string[]).filter(
      (table) => !table.startsWith("payment_"),
    );
    for (const table of ["payment_orders", "payment_events", "payment_refunds"])
      delete (footer.counts as Record<string, number>)[table];
  }
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  footer.sha256 = createHash("sha256").update(body).digest("hex");
  await writeFile(destination, `${body}${JSON.stringify(footer)}\n`);
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
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,encar.com,truecar.com,bid.cars");
  directory = await mkdtemp(join(tmpdir(), "autodom-storage-"));
  url = await database();
  db = await open(url);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const schema of schemas.splice(0)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await admin?.end();
  await container?.stop();
});

const inspectionOffer = (userId = 1): PaymentOfferInput => ({
  userId,
  product: "inspection",
  amount: 150000,
  title: "Vehicle inspection",
  description: "On-site mechanical inspection by the named executor, by appointment.",
  seller: "Test inspection seller",
  executor: "Test mechanic",
  supportUrl: "https://example.com/support",
  terms: "Inspection only; appointment agreed separately.",
  expiresAt: new Date((NOW + 3600) * 1000).toISOString(),
});
const receipt = (orderId: string | null, chargeId = randomUUID()): PaymentEvent => ({
  provider: "finik",
  eventId: chargeId,
  kind: "paid",
  orderId,
  userId: null,
  currency: "KGS",
  amount: 150000,
  chargeId,
  occurredAt: new Date(NOW * 1000).toISOString(),
});

describe("Finik physical inspection ledger", () => {
  it("requires explicit physical terms and protects immutable owned invoices", async () => {
    const payments = new PaymentStore(db);
    await expect(payments.createOffer({ ...inspectionOffer(), amount: 150001 })).rejects.toThrow();
    await expect(payments.createOffer({ ...inspectionOffer(), executor: "" })).rejects.toThrow();
    await expect(
      payments.createOffer({ ...inspectionOffer(), description: "x".repeat(301) }),
    ).rejects.toThrow();
    await expect(
      payments.createOffer({
        ...inspectionOffer(),
        supportUrl: "https://secret:password@example.com",
      }),
    ).rejects.toThrow();
    const order = await payments.createOffer(inspectionOffer());
    await expect(payments.setInvoice(order.id, "https://example.com/invoice")).rejects.toThrow();
    const accepted = await payments.acceptOrder(order.id, 1);
    expect(await payments.acceptOrder(order.id, 1)).toEqual(accepted);
    expect(await payments.cancelOffer(order.id, 1)).toBe(false);
    await payments.setInvoice(order.id, "https://example.com/invoice");
    await expect(payments.setInvoice(order.id, "https://example.com/another")).rejects.toThrow();
    expect((await payments.getOrder(order.id))?.paymentStatus).toBe("unpaid");
    expect(await payments.completeInspection(order.id)).toBe(false);
  });

  it("normalizes timezone offsets before durable retry identity", async () => {
    const payments = new PaymentStore(db);
    const offer = inspectionOffer();
    const offsetExpiry = offer.expiresAt.replace("Z", "+00:00");
    const order = await payments.createOffer({ ...offer, expiresAt: offsetExpiry });
    expect(order.expiresAt).toBe(offer.expiresAt);
    await payments.acceptOrder(order.id, 1);
    const event = receipt(order.id);
    expect(
      await payments.ingestEvent({ ...event, occurredAt: event.occurredAt.replace("Z", "+00:00") }),
    ).toBe("applied");
    expect(await payments.ingestEvent(event)).toBe("duplicate");
  });

  it("serializes cross-connection receipts and requires separate physical completion", async () => {
    const payments = new PaymentStore(db);
    const peer = new PaymentStore(await open(url));
    const order = await payments.createOffer(inspectionOffer());
    await expect(payments.acceptOrder(order.id, 2)).rejects.toThrow();
    await payments.acceptOrder(order.id, 1);
    const event = receipt(order.id);
    expect(
      (await Promise.all([payments.ingestEvent(event), peer.ingestEvent(event)])).sort(),
    ).toEqual(["applied", "duplicate"]);
    expect(await payments.getOrder(order.id)).toMatchObject({
      paymentStatus: "paid",
      fulfillmentStatus: "ready",
      needsReview: false,
    });
    expect(await payments.completeInspection(order.id)).toBe(true);
    expect(await peer.completeInspection(order.id)).toBe(true);
    expect((await payments.getOrder(order.id))?.fulfillmentStatus).toBe("fulfilled");
  });

  it("retains mismatches and conflicting charge reuse without paying another order", async () => {
    const payments = new PaymentStore(db);
    const first = await payments.createOffer(inspectionOffer());
    const second = await payments.createOffer(inspectionOffer(2));
    await payments.acceptOrder(first.id, 1);
    await payments.acceptOrder(second.id, 2);
    const event = receipt(first.id);
    expect(await payments.ingestEvent({ ...event, amount: 149999 })).toBe("review");
    expect(await payments.ingestEvent(event)).toBe("review");
    expect((await payments.getOrder(first.id))?.paymentStatus).toBe("unpaid");
    const good = receipt(first.id);
    expect(await payments.ingestEvent(good)).toBe("applied");
    expect(await payments.ingestEvent({ ...good, orderId: second.id })).toBe("review");
    expect((await payments.getOrder(second.id))?.paymentStatus).toBe("unpaid");
    expect(await payments.completeInspection(first.id)).toBe(false);
    expect(await payments.completeInspection(second.id)).toBe(false);
    expect(await payments.ingestEvent(receipt(null))).toBe("review");
    await expect(payments.ingestEvent({ ...receipt(second.id), amount: 1.1 })).rejects.toThrow();
    expect((await payments.getOrder(second.id))?.paymentStatus).toBe("unpaid");
  });

  it("accounts for late accepted money but never fulfills or pays an unaccepted offer", async () => {
    const payments = new PaymentStore(db);
    const accepted = await payments.createOffer(inspectionOffer());
    const unaccepted = await payments.createOffer(inspectionOffer());
    await payments.acceptOrder(accepted.id, 1);
    vi.setSystemTime((NOW + 3601) * 1000);
    expect(await payments.ingestEvent(receipt(accepted.id))).toBe("review");
    expect(await payments.getOrder(accepted.id)).toMatchObject({
      paymentStatus: "paid",
      needsReview: true,
      fulfillmentStatus: "ready",
    });
    expect(await payments.completeInspection(accepted.id)).toBe(false);
    expect(await payments.ingestEvent(receipt(unaccepted.id))).toBe("review");
    expect((await payments.getOrder(unaccepted.id))?.paymentStatus).toBe("unpaid");
  });

  it("reserves partial refunds atomically and never treats submission as returned money", async () => {
    const payments = new PaymentStore(db);
    const peer = new PaymentStore(await open(url));
    const order = await payments.createOffer(inspectionOffer());
    await expect(payments.requestRefund(order.id, 1, "Not captured")).rejects.toThrow();
    await payments.acceptOrder(order.id, 1);
    await payments.ingestEvent(receipt(order.id));
    const results = await Promise.allSettled([
      payments.requestRefund(order.id, 50000, "Partial request"),
      peer.requestRefund(order.id, 50000, "Concurrent request"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [first] = await payments.listRefunds(order.id);
    await payments.markRefund(first!.id, "submitted", "Operator sent request to provider");
    await expect(payments.markRefund(first!.id, "failed")).rejects.toThrow();
    await expect(payments.requestRefund(order.id, 100001, "Too much")).rejects.toThrow();
    await expect(payments.requestRefund(order.id, 0.1, "Fractional")).rejects.toThrow();
    const rest = await payments.requestRefund(order.id, 100000, "Remaining amount");
    await payments.markRefund(rest.id, "failed", "Provider procedure unavailable");
    const replacement = await payments.requestRefund(order.id, 100000, "Retry requested");
    await payments.markRefund(replacement.id, "submitted");
    await expect(payments.requestRefund(order.id, 1, "Over capture")).rejects.toThrow();
    expect((await payments.getOrder(order.id))?.paymentStatus).toBe("paid");
  });

  it("round trips financial audit and deduplication independently of deleted free profiles", async () => {
    const payments = new PaymentStore(db);
    await db.saveProfile(profile());
    const order = await payments.createOffer(inspectionOffer());
    await payments.acceptOrder(order.id, 1);
    const event = receipt(order.id);
    await payments.ingestEvent(event);
    const unknown = receipt(null);
    await payments.ingestEvent(unknown);
    const refund = await payments.requestRefund(order.id, 100, "Partial refund requested");
    await db.deleteUser(1);
    expect(await payments.getOrder(order.id)).not.toBeNull();
    const path = join(directory, "financial.ndjson");
    await backup(db, path);
    const targetUrl = await database();
    await restore(path, targetUrl);
    const restored = new PaymentStore(await open(targetUrl));
    expect(await restored.getOrder(order.id)).toEqual(await payments.getOrder(order.id));
    expect(await restored.getRefund(refund.id)).toEqual(refund);
    expect(await restored.ingestEvent(event)).toBe("duplicate");
    expect(await restored.ingestEvent(unknown)).toBe("duplicate");
    const emptyUrl = await database();
    const empty = await open(emptyUrl);
    const emptyPath = join(directory, "empty.ndjson");
    await backup(empty, emptyPath);
    await expect(restore(emptyPath, targetUrl)).rejects.toThrow();
    const auditOnlyUrl = await database();
    const auditOnly = new PaymentStore(await open(auditOnlyUrl));
    await auditOnly.ingestEvent(receipt(null));
    await expect(restore(emptyPath, auditOnlyUrl)).rejects.toThrow();
  });

  it("rejects checksummed financial snapshots with forged capture or excessive refunds atomically", async () => {
    const payments = new PaymentStore(db);
    const order = await payments.createOffer(inspectionOffer());
    await payments.acceptOrder(order.id, 1);
    await payments.ingestEvent(receipt(order.id));
    await payments.requestRefund(order.id, 100, "Refund requested");
    const source = join(directory, "source.ndjson");
    await backup(db, source);
    for (const damage of ["charge", "refund"]) {
      const damaged = join(directory, `${damage}.ndjson`);
      await rewriteSnapshot(source, damaged, (record) => {
        const row = record.row as Record<string, unknown>;
        if (damage === "charge" && record.table === "payment_orders") row.charge_id = randomUUID();
        if (damage === "refund" && record.table === "payment_refunds") row.amount = "150001";
      });
      const targetUrl = await database();
      await expect(restore(damaged, targetUrl)).rejects.toThrow();
      expect(await new PaymentStore(await open(targetUrl)).getOrder(order.id)).toBeNull();
    }
  });
  it("keeps a last-millisecond acceptance restorable when the clock crosses expiry", async () => {
    const payments = new PaymentStore(db);
    const order = await payments.createOffer(inspectionOffer());
    const acceptedAt = Date.parse(order.expiresAt) - 1;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      vi.setSystemTime(acceptedAt + 2);
      return acceptedAt;
    });
    try {
      await payments.acceptOrder(order.id, 1);
    } finally {
      clock.mockRestore();
    }
    const source = join(directory, "last-millisecond.ndjson");
    await backup(db, source);
    const targetUrl = await database();
    await restore(source, targetUrl);
    expect((await new PaymentStore(await open(targetUrl)).getOrder(order.id))?.acceptedAt).toBe(
      new Date(acceptedAt).toISOString(),
    );
  });

  it("preserves a late capture review hold through restore and rejects its removal", async () => {
    const payments = new PaymentStore(db);
    const order = await payments.createOffer(inspectionOffer());
    await payments.acceptOrder(order.id, 1);
    vi.setSystemTime((NOW + 3601) * 1000);
    await payments.ingestEvent(receipt(order.id));
    const source = join(directory, "late-review.ndjson");
    await backup(db, source);
    const validUrl = await database();
    await restore(source, validUrl);
    const valid = new PaymentStore(await open(validUrl));
    expect(await valid.getOrder(order.id)).toMatchObject({
      paymentStatus: "paid",
      needsReview: true,
    });
    expect(await valid.completeInspection(order.id)).toBe(false);
    const damaged = join(directory, "removed-review.ndjson");
    await rewriteSnapshot(source, damaged, (record) => {
      if (record.table === "payment_orders")
        (record.row as Record<string, unknown>).needs_review = false;
    });
    const targetUrl = await database();
    await expect(restore(damaged, targetUrl)).rejects.toThrow();
    expect(await new PaymentStore(await open(targetUrl)).getOrder(order.id)).toBeNull();
  });

  it("rejects a late capture snapshot that forgets the captured money", async () => {
    const payments = new PaymentStore(db);
    const order = await payments.createOffer(inspectionOffer());
    await payments.acceptOrder(order.id, 1);
    vi.setSystemTime((NOW + 3601) * 1000);
    await payments.ingestEvent(receipt(order.id));
    const source = join(directory, "late-capture.ndjson");
    await backup(db, source);
    const damaged = join(directory, "forgotten-capture.ndjson");
    await rewriteSnapshot(source, damaged, (record) => {
      if (record.table === "payment_orders") {
        const row = record.row as Record<string, unknown>;
        row.payment_status = "unpaid";
        row.charge_id = null;
      }
    });
    const targetUrl = await database();
    await expect(restore(damaged, targetUrl)).rejects.toThrow();
    expect(await new PaymentStore(await open(targetUrl)).getOrder(order.id)).toBeNull();
  });

  it("rejects removing the original order hold after its charge is reused by another order", async () => {
    const payments = new PaymentStore(db);
    const first = await payments.createOffer(inspectionOffer());
    const second = await payments.createOffer(inspectionOffer(2));
    await payments.acceptOrder(first.id, 1);
    await payments.acceptOrder(second.id, 2);
    const event = receipt(first.id);
    await payments.ingestEvent(event);
    await payments.ingestEvent({ ...event, orderId: second.id, eventId: randomUUID() });
    const source = join(directory, "conflict-review.ndjson");
    await backup(db, source);
    const damaged = join(directory, "removed-original-hold.ndjson");
    await rewriteSnapshot(source, damaged, (record) => {
      const row = record.row as Record<string, unknown> | undefined;
      if (record.table === "payment_orders" && row?.id === first.id) row.needs_review = false;
    });
    const targetUrl = await database();
    await expect(restore(damaged, targetUrl)).rejects.toThrow();
    expect(await new PaymentStore(await open(targetUrl)).getOrder(first.id)).toBeNull();
  });
});

describe("PostgreSQL Store", () => {
  it("serializes concurrent startup migrations without losing either connection", async () => {
    const fresh = await database();
    const [left, right] = await Promise.all([open(fresh), open(fresh)]);
    await left.setMeta("migrated", "yes");
    expect(await right.getMeta("migrated")).toBe("yes");
  });
  it("refuses a modified payment migration checksum on reopen", async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("UPDATE autodom_migrations SET checksum = 'modified' WHERE version = 6");
      await expect(Store.open(url)).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
  it("isolates concurrent transactions sharing an advisory-lock connection", async () => {
    await db.withLock("shared", async () => {
      const results = await Promise.allSettled([
        db.transaction(async () => {
          await db.setMeta("rolled-back", "bad");
          throw new Error("abort");
        }),
        db.setMeta("committed", "good"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    });
    expect(await db.getMeta("rolled-back")).toBeNull();
    expect(await db.getMeta("committed")).toBe("good");
  });
  it("serializes first insertion and price changes across independent pools without duplicate events", async () => {
    const other = await open(url);
    expect(
      await Promise.all([db.upsertListings([car()], NOW), other.upsertListings([car()], NOW)]),
    ).toEqual(expect.arrayContaining([0, 1]));
    expect(
      await Promise.all([
        db.upsertListings([car({ price_usd_minor: 90 })], NOW + 1),
        other.upsertListings([car({ price_usd_minor: 90 })], NOW + 1),
      ]),
    ).toEqual(expect.arrayContaining([0, 1]));
    const events = await other.eventsAfter(0);
    expect(events.map((event) => event.kind)).toEqual(["new", "price_change"]);
    expect(events[1]?.previous_usd_minor).toBe(100);
    expect(events[1]?.listing.observed_at).toBe(NOW + 1);
    expect(await db.upsertListings([car({ title: "Honda", price_usd_minor: 50 })], NOW)).toBe(0);
    expect((await db.getListing("1"))?.title).toBe("Toyota Camry");
  });
  it("rolls back an entire ingestion batch on invalid data", async () => {
    await expect(db.upsertListings([car(), car({ id: "bad", market: "ALL" })])).rejects.toThrow();
    expect((await db.stats()).listings).toBe(0);
    expect(await db.eventsAfter(0)).toEqual([]);
  });
  it("guards cursors by revision and preserves pending events when quiet hours change", async () => {
    await db.upsertListings([car()]);
    const original = await db.saveProfile(profile());
    await db.upsertListings([car({ id: "2" })]);
    const pending = (await db.eventsAfter(original.cursor))[0]!;
    const quiet = (await db.setQuietHours(1, 1320, 480))!;
    expect(quiet.cursor).toBe(original.cursor);
    expect(await db.advanceCursor(1, pending.id, original.revision)).toBe(false);
    expect(await db.advanceCursor(1, pending.id, quiet.revision)).toBe(true);
    expect(await db.advanceCursor(1, original.cursor, quiet.revision)).toBe(false);
    const edited = await db.saveProfile({ ...profile(), query: "honda" });
    expect([edited.quiet_start_minute, edited.quiet_end_minute]).toEqual([1320, 480]);
    const paused = (await db.setMonitoring(1, false))!;
    await db.saveProfile({ ...profile(), user_id: 2, chat_id: 20 });
    await db.upsertListings([car({ id: "3" })]);
    const resumed = (await db.setMonitoring(1, true))!;
    expect(await db.eventsAfter(resumed.cursor)).toEqual([]);
    expect(BigInt(resumed.revision)).toBe(BigInt(paused.revision) + 1n);
    await expect(db.setQuietHours(1, 60, 60)).rejects.toThrow();
    expect(await db.getProfile(1)).toEqual(resumed);
  });
  it("removes a previously applied advertising column without losing saved profiles", async () => {
    const oldUrl = await database();
    const old = new pg.Pool({ connectionString: oldUrl });
    try {
      await old.query(
        "CREATE TABLE autodom_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const [index, name] of [
        "0001_initial.sql",
        "0002_mileage_bigint.sql",
        "0003_advertising_consent.sql",
      ].entries()) {
        const statement = await readFile(join("packages/storage/migrations", name), "utf8");
        await old.query(statement);
        await old.query("INSERT INTO autodom_migrations(version, checksum) VALUES ($1, $2)", [
          index + 1,
          createHash("sha256").update(statement).digest("hex"),
        ]);
      }
      await old.query(
        "INSERT INTO profiles (user_id, chat_id, currency, budget_min_minor, budget_max_minor, query, monitoring, revision, cursor, ads_consent) VALUES (1, 10, 'USD', 100, 200, 'toyota', true, 7, 3, true)",
      );
    } finally {
      await old.end();
    }
    const migrated = await open(oldUrl);
    expect(await migrated.getProfile(1)).toEqual({
      ...profile(),
      query: "toyota",
      revision: "7",
      cursor: 3,
    });
    const saved = await migrated.getProfile(1);
    await migrated.migrate();
    expect(await migrated.getProfile(1)).toEqual(saved);
  });
  it("rejects invalid profile updates without replacing saved private preferences", async () => {
    const original = await db.saveProfile(profile());
    for (const changes of [
      { currency: "EUR" },
      { budget_min_minor: 1.5 },
      { budget_max_minor: 0 },
      { city: "draft:nonce" },
      { city: " " },
      { year_min: 1899 },
      { allow_import: 0 },
      { purchase_by: "2026-02-30" },
    ]) {
      await expect(
        db.saveProfile({ ...original, ...changes } as typeof original),
      ).rejects.toThrow();
      expect(await db.getProfile(1)).toEqual(original);
    }
  });
  it("filters before pagination with count and notification matching parity", async () => {
    const good = car({
      city: "Бишкек",
      body_type: "седан",
      transmission: "АКПП",
      year: 2020,
      mileage: "0 km",
    });
    const cars = [
      car({ id: "00-old", observed_at: NOW - 49 * 3600 }),
      { ...good, id: "01-unknown", mileage: "0" },
      { ...good, id: "02-over", mileage: "0.001 km" },
      { ...good, id: "03-city", city: "Бишкек область" },
      { ...good, id: "04-year", year: null },
      { ...good, id: "05-source", source: "unapproved" },
      { ...good, id: "06-good" },
      { ...good, id: "07-good" },
    ];
    await db.upsertListings(cars);
    const selected = {
      ...profile(),
      city: "бишкек",
      body_type: "sedan",
      transmission: "automatic",
      year_min: 2020,
      mileage_max_km: 0,
    };
    expect(cars.filter((item) => matches(selected, item)).map((item) => item.id)).toEqual([
      "06-good",
      "07-good",
    ]);
    expect(await db.countMatches(selected)).toBe(2);
    expect((await db.search(selected, 1, 1)).map((item) => item.id)).toEqual(["07-good"]);
    expect(await db.getListing("00-old", true)).toBeNull();
    for (const query of ["!!!", " , ", "___"])
      expect(await db.countMatches({ ...profile(), query })).toBe(0);
    await db.upsertListings([car({ id: "boundary" })], NOW - 48 * 3600);
    expect(await db.getListing("boundary", true)).not.toBeNull();
  });
  it("upgrades a populated v1 catalog without narrowing the normalized mileage range", async () => {
    const legacyUrl = await database();
    const legacy = new pg.Client({ connectionString: legacyUrl });
    const initial = await readFile("packages/storage/migrations/0001_initial.sql", "utf8");
    const previous = car({ id: "previous", mileage: "8000 км" });
    await legacy.connect();
    try {
      await legacy.query(initial);
      await legacy.query(
        "CREATE TABLE autodom_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await legacy.query("INSERT INTO autodom_migrations(version, checksum) VALUES (1, $1)", [
        createHash("sha256").update(initial).digest("hex"),
      ]);
      await legacy.query(
        "INSERT INTO listings(id, data, price_usd_minor, price_kgs_minor, availability, normalized_text, first_seen, last_seen, mileage_km) VALUES ($1, $2, 100, 9000, $3, '', $4, $4, 8000)",
        [previous.id, previous, "в наличии", NOW],
      );
    } finally {
      await legacy.end();
    }
    const migrated = await open(legacyUrl);
    await migrated.upsertListings([car({ id: "large-mileage", mileage: "2394664666 км" })]);
    expect((await migrated.getListing("previous"))?.mileage).toBe("8000 км");
    expect((await migrated.getListing("large-mileage"))?.mileage).toBe("2394664666 км");
    expect((await migrated.search(profile())).map((item) => item.id).sort()).toEqual([
      "large-mileage",
      "previous",
    ]);
    expect(
      (await migrated.search({ ...profile(), mileage_max_km: 10_000_000 })).map((item) => item.id),
    ).toEqual(["previous"]);
  });
  it("uses native prices for events and excludes expired FX but keeps native USD", async () => {
    const kr = car({
      id: "kr",
      market: "KR",
      source: "encar.com",
      availability: "Опубликовано",
      original_currency: "KRW",
      original_price_minor: 10000,
      fx_expires_at: NOW + 1,
    });
    const us = car({
      id: "us",
      market: "US",
      source: "truecar.com",
      availability: "Опубликовано",
      original_currency: "USD",
      original_price_minor: 100,
      fx_expires_at: NOW + 1,
    });
    await db.upsertListings([kr, us], NOW - 10);
    expect(await db.upsertListings([{ ...kr, price_usd_minor: 120 }], NOW - 9)).toBe(0);
    expect(
      await db.upsertListings(
        [{ ...kr, price_usd_minor: 130, original_price_minor: 9000 }],
        NOW - 8,
      ),
    ).toBe(1);
    expect((await db.eventsAfter(2))[0]?.previous_original_price_minor).toBe(10000);
    vi.setSystemTime((NOW + 1) * 1000);
    expect((await db.search({ ...profile(), market: "ALL" })).map((item) => item.id)).toEqual([
      "us",
    ]);
    expect(
      await db.countMatches({
        ...profile(),
        market: "ALL",
        currency: "KGS",
        budget_max_minor: 10000,
      }),
    ).toBe(0);
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    expect(await db.countMatches({ ...profile(), market: "ALL" })).toBe(0);
  });
  it("only creates purchase transitions for buy-now offers and expires them at the auction deadline", async () => {
    const lot = car({
      source: "bid.cars",
      market: "US",
      original_currency: "USD",
      original_price_minor: null,
      price_usd_minor: null,
      price_kgs_minor: null,
      availability: "Опубликовано",
      price_kind: "auction",
      auction_house: "Copart",
      auction_status: "active",
      auction_at: NOW + 1,
      current_bid_minor: 50,
    });
    await db.upsertListings([lot], NOW - 4);
    expect(await db.upsertListings([{ ...lot, current_bid_minor: 60 }], NOW - 3)).toBe(0);
    const offer = {
      ...lot,
      price_kind: "buy_now",
      original_price_minor: 150,
      price_usd_minor: 150,
      buy_now_minor: 150,
    };
    expect(await db.upsertListings([offer], NOW - 2)).toBe(1);
    expect((await db.eventsAfter(1))[0]?.kind).toBe("new");
    await db.upsertListings(
      [{ ...offer, original_price_minor: 120, price_usd_minor: 120 }],
      NOW - 1,
    );
    expect((await db.eventsAfter(2))[0]?.previous_original_price_minor).toBe(150);
    expect(await db.countMatches({ ...profile(), market: "US" })).toBe(1);
    vi.setSystemTime((NOW + 1) * 1000);
    expect(await db.countMatches({ ...profile(), market: "US" })).toBe(0);
    expect((await db.getListing("1"))?.current_bid_minor).toBe(50);
  });
  it("deletes private state without touching inventory or global metadata", async () => {
    await db.upsertListings([car()]);
    await db.saveProfile(profile());
    await db.setDraft(1, "budget", { minimum: 100 });
    await db.setMeta("monitor_cursor", "1");
    await db.saveOwnerVehicle(ownerCard());
    await db.deleteUser(1);
    expect(await db.getProfile(1)).toBeNull();
    expect(await db.getDraft(1)).toBeNull();
    expect(await db.getOwnerVehicle(1)).toBeNull();
    expect(await db.monitoringProfiles()).toEqual([]);
    expect(await db.getMeta("monitor_cursor")).toBe("1");
    expect((await db.stats()).listings).toBe(1);
    expect((await db.stats()).events).toBe(1);
  });
  it("keeps the owner card independent of buyer data and requires consent to replace it", async () => {
    const owner = ownerCard();
    await db.saveOwnerVehicle(owner);
    expect(await db.getProfile(1)).toBeNull();
    expect(await db.getOwnerVehicle(1)).toEqual(owner);
    const buyer = await db.saveProfile(profile());
    await db.setDraft(1, "budget", { minimum: 100 });
    await expect(db.saveOwnerVehicle({ ...owner, consent_at: 0 })).rejects.toThrow();
    expect(await db.getOwnerVehicle(1)).toEqual(owner);
    await db.deleteOwnerVehicle(1);
    expect(await db.getOwnerVehicle(1)).toBeNull();
    expect(await db.getProfile(1)).toEqual(buyer);
    expect(await db.getDraft(1)).toEqual(["budget", { minimum: 100 }]);
  });
  it("reuses locked connections and releases ownership on callback failure", async () => {
    const other = await open(url);
    await expect(
      db.withLock("owner", async () => {
        expect(await other.tryWithLock("owner", async () => "acquired")).toBeNull();
        await db.withLock("nested", async () => {
          await db.setMeta("nested", "ok");
        });
        throw new Error("callback failure");
      }),
    ).rejects.toThrow("callback failure");
    expect(await other.tryWithLock("owner", async () => db.getMeta("nested"))).toBe("ok");
    await expect(
      db.transaction(() =>
        db.withLock("transaction-owner", () => db.setMeta("invalid", null as unknown as string)),
      ),
    ).rejects.toThrow();
    expect(await other.tryWithLock("transaction-owner", async () => "released")).toBe("released");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.withLock(`independent:${i}`, async () => {
          await db.setMeta(`lock:${i}`, "ok");
        }),
      ),
    );
  });
});

describe("portable snapshots and read-only legacy import", () => {
  it("round trips all committed private/catalog state, uses private exclusive files, and restores sequences", async () => {
    const initial = car({
      photo_url: "https://cdn.mashina.kg/cover.jpg",
      photo_urls: ["https://cdn.mashina.kg/front.jpg", "https://cdn.mashina.kg/rear.jpg"],
    });
    await db.upsertListings([initial], NOW - 2);
    const saved = await db.saveProfile({ ...profile(), city: "Бишкек", allow_import: false });
    const quiet = await db.setQuietHours(1, 1320, 480);
    const second = await db.saveProfile({ ...profile(), user_id: 2, chat_id: 20 });
    await db.setDraft(1, "budget", { query: "тойота", minimum: 100 });
    await db.setMeta("source:mashina.kg:crawl_next_page", "37");
    const owner = await db.saveOwnerVehicle(ownerCard());
    const updated = {
      ...initial,
      price_usd_minor: 150,
      photo_urls: ["https://cdn.mashina.kg/new.jpg"],
    };
    await db.upsertListings([updated], NOW - 1);
    const destination = join(directory, "private", "snapshot.ndjson");
    await backup(db, destination);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
    const original = await readFile(destination);
    await expect(backup(db, destination)).rejects.toThrow();
    expect(await readFile(destination)).toEqual(original);
    const targetUrl = await database();
    await restore(destination, targetUrl);
    const target = await open(targetUrl);
    expect(await target.getProfile(1)).toEqual(quiet);
    expect(await target.getProfile(2)).toEqual(second);
    expect(quiet?.cursor).toBe(saved.cursor);
    expect(await target.getDraft(1)).toEqual(["budget", { query: "тойота", minimum: 100 }]);
    expect(await target.getOwnerVehicle(1)).toEqual(owner);
    expect(await target.eventsAfter(0)).toEqual(await db.eventsAfter(0));
    const expectedListing = { ...updated, observed_at: NOW - 1 };
    expect(await target.getListing("1")).toEqual(expectedListing);
    expect(await target.search(profile())).toEqual([expectedListing]);
    expect((await target.eventsAfter(0)).map((event) => event.listing)).toEqual([
      { ...initial, observed_at: NOW - 2 },
      expectedListing,
    ]);
    expect(await target.getMeta("source:mashina.kg:crawl_next_page")).toBe("37");
    await expect(restore(destination, targetUrl)).rejects.toThrow();
    await target.upsertListings([car({ id: "next" })]);
    expect((await target.eventsAfter(2))[0]?.id).toBe(3);
  });
  it("rejects empty, truncated, and altered snapshots without committing rows", async () => {
    const snapshot = join(directory, "broken.ndjson");
    await writeFile(snapshot, "");
    await expect(restore(snapshot, url)).rejects.toThrow();
    await db.upsertListings([car()]);
    const good = join(directory, "good.ndjson");
    await backup(db, good);
    const text = await readFile(good, "utf8");
    const targetUrl = await database();
    await writeFile(snapshot, text.slice(0, text.lastIndexOf("\n", text.length - 2) + 1));
    await expect(restore(snapshot, targetUrl)).rejects.toThrow();
    const target = await open(targetUrl);
    expect((await target.stats()).listings).toBe(0);
    await writeFile(snapshot, text.replace("Toyota Camry", "Honda Civic"));
    await expect(restore(snapshot, targetUrl)).rejects.toThrow();
    expect((await target.stats()).listings).toBe(0);
  });
  it.each([1, 2, 3, 4])(
    "migrates schema-v%i snapshots without restoring removed profile fields",
    async (version) => {
      await db.upsertListings([car()]);
      const saved = await db.saveProfile(profile());
      const owner = version === 4 ? await db.saveOwnerVehicle(ownerCard()) : null;
      await db.setDraft(1, "budget", { minimum: 150 });
      await db.upsertListings([car({ id: "2" })]);
      const current = join(directory, "current.ndjson");
      const legacy = join(directory, `v${version}.ndjson`);
      await backup(db, current);
      await rewriteSnapshot(current, legacy, (record) => {
        if (Object.hasOwn(record, "schema_version")) record.schema_version = version;
        if (version === 2 && record.table === "profiles")
          (record.row as Record<string, unknown>).ads_consent = true;
        if (record.table === "listings" || record.table === "events")
          delete ((record.row as Record<string, unknown>).data as Record<string, unknown>)
            .photo_urls;
      });
      const targetUrl = await database();
      await restore(legacy, targetUrl);
      const target = await open(targetUrl);
      expect(await target.getProfile(1)).toEqual(saved);
      expect(await target.getDraft(1)).toEqual(["budget", { minimum: 150 }]);
      expect(await target.eventsAfter(saved.cursor)).toEqual(await db.eventsAfter(saved.cursor));
      expect((await target.getListing("1"))?.photo_urls).toEqual([]);
      expect(await target.getOwnerVehicle(1)).toEqual(owner);
    },
  );
  it.each([
    { schemaVersion: 2, damage: "missing historical column" },
    { schemaVersion: 2, damage: "malformed historical column" },
    { schemaVersion: 1, damage: "unexpected column" },
    { schemaVersion: 3, damage: "unexpected column" },
    { schemaVersion: 3, damage: "missing filter" },
  ])(
    "rejects checksummed schema-$schemaVersion snapshots with $damage",
    async ({ schemaVersion, damage }) => {
      await db.upsertListings([car()]);
      await db.saveProfile(profile());
      const good = join(directory, "good.ndjson");
      const damaged = join(directory, "damaged.ndjson");
      await backup(db, good);
      await rewriteSnapshot(good, damaged, (record) => {
        if (Object.hasOwn(record, "schema_version")) record.schema_version = schemaVersion;
        if (record.table !== "profiles") return;
        const row = record.row as Record<string, unknown>;
        if (damage === "missing historical column") delete row.ads_consent;
        else if (damage === "malformed historical column") row.ads_consent = "true";
        else if (damage === "unexpected column") row.ads_consent = true;
        else {
          delete row.query;
        }
      });
      const targetUrl = await database();
      await expect(restore(damaged, targetUrl)).rejects.toThrow();
      const target = await open(targetUrl);
      expect(await target.getProfile(1)).toBeNull();
      expect(await target.getListing("1")).toBeNull();
    },
  );
  it.each([1, 2, 3, 4, 5])(
    "imports SQLite schema v%i read-only with migrated defaults and exact IDs",
    async (version) => {
      const path = join(directory, "legacy.sqlite3");
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, data TEXT NOT NULL, price_usd_minor INTEGER, price_kgs_minor INTEGER, availability TEXT NOT NULL, normalized_text TEXT NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, previous_usd_minor INTEGER, previous_kgs_minor INTEGER, observed_at REAL NOT NULL);
      CREATE TABLE profiles (user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, currency TEXT NOT NULL, budget_min_minor INTEGER NOT NULL, budget_max_minor INTEGER NOT NULL, query TEXT NOT NULL, monitoring INTEGER NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE drafts (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const listing = car({
        city: "Бишкек",
        body_type: "Седан",
        transmission: "Автомат",
        year: 2020,
        mileage: "15,625 miles",
        photo_url: "https://cdn.mashina.kg/cover.jpg",
        photo_urls: ["https://cdn.mashina.kg/front.jpg", "https://cdn.mashina.kg/rear.jpg"],
      });
      legacy
        .prepare("INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          "1",
          JSON.stringify(listing),
          100,
          9000,
          "в наличии",
          " toyota camry в наличии ",
          NOW - 72 * 3600,
          NOW - 49 * 3600,
        );
      legacy
        .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(7, "1", "new", JSON.stringify(listing), null, null, NOW - 72 * 3600);
      legacy.exec(
        "INSERT INTO profiles VALUES (1, 10, 'USD', 100, 200, 'toyota', 1, 4, 6); INSERT INTO drafts VALUES (1, 'budget', '{\"minimum\":100}'); INSERT INTO metadata VALUES ('monitor_cursor','8'); INSERT INTO metadata VALUES ('catalog_total','123');",
      );
      if (version >= 2)
        legacy.exec(
          "ALTER TABLE profiles ADD COLUMN quiet_start_minute INTEGER; ALTER TABLE profiles ADD COLUMN quiet_end_minute INTEGER; UPDATE profiles SET quiet_start_minute=60, quiet_end_minute=120;",
        );
      if (version >= 3) {
        legacy.exec(
          "ALTER TABLE profiles ADD COLUMN market TEXT NOT NULL DEFAULT 'KG'; ALTER TABLE events ADD COLUMN previous_original_price_minor INTEGER; ALTER TABLE events ADD COLUMN previous_original_currency TEXT NOT NULL DEFAULT ''; ",
        );
        for (const definition of [
          "source TEXT NOT NULL DEFAULT 'mashina.kg'",
          "market TEXT NOT NULL DEFAULT 'KG'",
          "original_currency TEXT NOT NULL DEFAULT ''",
          "original_price_minor INTEGER",
          "fx_expires_at REAL",
        ])
          legacy.exec(`ALTER TABLE listings ADD COLUMN ${definition}`);
        legacy.exec(
          "UPDATE metadata SET key='source:mashina.kg:catalog_total' WHERE key='catalog_total'",
        );
      }
      if (version >= 4) {
        for (const definition of [
          "city TEXT NOT NULL DEFAULT ''",
          "budget_scope TEXT NOT NULL DEFAULT 'car'",
          "body_type TEXT NOT NULL DEFAULT ''",
          "year_min INTEGER",
          "mileage_max_km INTEGER",
          "transmission TEXT NOT NULL DEFAULT ''",
          "use_case TEXT NOT NULL DEFAULT ''",
          "allow_import INTEGER",
          "purchase_by TEXT NOT NULL DEFAULT ''",
        ])
          legacy.exec(`ALTER TABLE profiles ADD COLUMN ${definition}`);
        for (const definition of [
          "normalized_city TEXT NOT NULL DEFAULT ''",
          "normalized_body_type TEXT NOT NULL DEFAULT ''",
          "normalized_transmission TEXT NOT NULL DEFAULT ''",
          "vehicle_year INTEGER",
          "mileage_km INTEGER",
        ])
          legacy.exec(`ALTER TABLE listings ADD COLUMN ${definition}`);
      }
      if (version >= 5)
        legacy.exec(
          "ALTER TABLE listings ADD COLUMN auction_status TEXT NOT NULL DEFAULT ''; ALTER TABLE listings ADD COLUMN auction_at REAL;",
        );
      legacy.exec(
        'UPDATE profiles SET revision=1760000000000000123; UPDATE drafts SET data=\'{"minimum":100,"revision":1760000000000000123,"nested":{"profile_revision":1760000000000000123}}\';',
      );
      legacy.exec(`PRAGMA user_version = ${version}`);
      legacy.close();
      const before = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      expect(await importSqlite(path, db)).toMatchObject({
        listings: 1,
        events: 1,
        profiles: 1,
        drafts: 1,
        metadata: 2,
      });
      expect(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ).toBe(before);
      expect(await db.getProfile(1)).toMatchObject({
        revision: "1760000000000000123",
        cursor: 6,
        city: "",
        budget_scope: "car",
        allow_import: null,
        quiet_start_minute: version >= 2 ? 60 : null,
      });
      expect(await db.getMeta("source:mashina.kg:catalog_total")).toBe("123");
      expect(await db.getDraft(1)).toEqual([
        "budget",
        {
          minimum: 100,
          revision: "1760000000000000123",
          nested: { profile_revision: "1760000000000000123" },
        },
      ]);
      expect((await db.eventsAfter(6))[0]?.listing).toEqual({
        ...listing,
        observed_at: NOW - 72 * 3600,
      });
      expect(await db.getListing("1")).toEqual({ ...listing, observed_at: NOW - 49 * 3600 });
      expect(await db.getListing("1", true)).toBeNull();
      vi.setSystemTime((NOW - 2 * 3600) * 1000);
      expect(
        await db.countMatches({
          ...profile(),
          city: "бишкек",
          body_type: "sedan",
          transmission: "automatic",
          year_min: 2020,
          mileage_max_km: 25146,
        }),
      ).toBe(1);
      expect(await db.countMatches({ ...profile(), mileage_max_km: 25145 })).toBe(0);
      await expect(importSqlite(path, db)).rejects.toThrow();
      await db.upsertListings([car({ id: "2" })]);
      expect((await db.eventsAfter(7))[0]?.id).toBe(8);
      expect((await db.setQuietHours(1, 120, 180))?.revision).toBe("1760000000000000124");
    },
  );
});
