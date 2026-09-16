import { randomUUID } from "node:crypto";
import { makeListing } from "@autodom/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../../packages/storage/src/store.js";
import { type Candidate, campaignSchema, DeliveryError, type Messenger } from "../src/contracts.js";
import { OutreachService } from "../src/service.js";

let admin: pg.Pool;
let pool: pg.Pool;
let catalog: Store;
let container: StartedPostgreSqlContainer | undefined;
const database = `outreach_${randomUUID().replaceAll("-", "")}`;
const input = campaignSchema.parse({
  name: "VIN",
  text: "Предложение проверки VIN",
  filter: { source: "mashina.kg", query: "Toyota", limit: 10 },
  intervalSeconds: 60,
  dailyLimit: 2,
});
const delivered: string[] = [];
const messenger: Messenger = {
  source: "mashina.kg",
  async check() {
    return { source: "mashina.kg", ready: true, message: "Isolated test transport" };
  },
  async resolve(candidate) {
    return {
      id: candidate.listingId.endsWith("duplicate") ? "seller-1" : candidate.listingId,
      listingId: candidate.listingId,
    };
  },
  async send(recipient) {
    delivered.push(recipient.id);
    return { remoteId: `receipt-${delivered.length}` };
  },
};
let service: OutreachService;

beforeAll(async () => {
  let url = process.env.AUTODOM_TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    url = container.getConnectionUri();
  }
  admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE DATABASE "${database}"`);
  const address = new URL(url);
  address.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: address.href });
  catalog = await Store.open(address.href);
  service = new OutreachService(pool, new Map([["mashina.kg", messenger]]), true);
  await service.init();
}, 120_000);
beforeEach(async () => {
  delivered.length = 0;
  await pool.query(
    "TRUNCATE autodom_outreach.contacts,autodom_outreach.deliveries,autodom_outreach.campaigns,autodom_outreach.images,public.events,public.listings CASCADE",
  );
  await pool.query(
    "UPDATE autodom_outreach.source_pacing SET last_attempt=NULL,next_allowed=NULL,attempt_day=NULL,attempts=0,blocked=false",
  );
});
afterAll(async () => {
  await catalog?.close();
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
  await container?.stop();
});

async function seed(ids: string[]) {
  await catalog.upsertListings(
    ids.map((id) =>
      makeListing({
        id,
        title: `Toyota Camry ${id}`,
        url: `https://mashina.kg/details/toyota-${id}`,
        source: "mashina.kg",
        city: "Бишкек",
        year: 2020,
        availability: "В наличии",
        price_usd_minor: 2_000_000,
        price_kgs_minor: 170_000_000,
      }),
    ),
    Date.now() / 1000,
  );
}
async function releasePacing() {
  await pool.query(
    "UPDATE autodom_outreach.source_pacing SET last_attempt=clock_timestamp()-interval '1 day',next_allowed=clock_timestamp()-interval '1 second'",
  );
}

describe("durable marketplace delivery boundary", () => {
  it("initializes a pre-created schema without catalog-write or database-create privileges", async () => {
    const role = `outreach_role_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE ROLE "${role}"`);
    const restrictedPool = new pg.Pool({
      connectionString: pool.options.connectionString,
      options: `-c role=${role}`,
    });
    try {
      await pool.query(`
        DROP SCHEMA autodom_outreach CASCADE;
        CREATE SCHEMA autodom_outreach AUTHORIZATION "${role}";
        GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT ON public.listings TO "${role}";
      `);
      const restricted = new OutreachService(restrictedPool, new Map(), false);
      await restricted.init();
      await seed(["restricted-role"]);
      const campaign = await restricted.create(input);
      expect(
        (await restricted.detail(campaign.id)).deliveries.map((row) => row.candidate.listingId),
      ).toEqual(["restricted-role"]);
      await expect(
        restrictedPool.query("UPDATE public.listings SET last_seen=last_seen WHERE false"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(restrictedPool.query("CREATE SCHEMA forbidden_schema")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await restrictedPool.end();
      await pool.query(`
        DROP SCHEMA autodom_outreach CASCADE;
        DROP OWNED BY "${role}";
        DROP ROLE "${role}";
      `);
      await service.init();
    }
  });

  it("requires explicit start and preserves pause across a replacement worker", async () => {
    await seed(["seller-1", "seller-2"]);
    const campaign = await service.create(input);
    await service.tick();
    expect(delivered).toEqual([]);
    await expect(service.action(campaign.id, "start", false)).rejects.toMatchObject({
      status: 400,
    });
    await service.action(campaign.id, "start", true);
    await service.action(campaign.id, "pause", false);
    await new OutreachService(pool, new Map([["mashina.kg", messenger]]), true).tick();
    expect(delivered).toEqual([]);
    await service.action(campaign.id, "start", true);
    await service.tick();
    expect(delivered).toHaveLength(1);
  });

  it("serializes concurrent workers and deduplicates seller across listings and campaigns", async () => {
    await seed(["seller-1", "seller-duplicate"]);
    const campaign = await service.create(input);
    await service.action(campaign.id, "start", true);
    await Promise.all([
      service.tick(),
      new OutreachService(pool, new Map([["mashina.kg", messenger]]), true).tick(),
    ]);
    expect(delivered).toEqual(["seller-1"]);
    await releasePacing();
    await service.tick();
    const next = await service.create(input);
    await service.action(next.id, "start", true);
    await service.tick();
    await service.tick();
    expect(delivered).toEqual(["seller-1"]);
    expect((await service.detail(campaign.id)).campaign.counts).toMatchObject({
      sent: 1,
      skipped: 1,
    });
    expect((await service.detail(next.id)).campaign.counts).toMatchObject({ sent: 0, skipped: 2 });
  });

  it("enforces source-wide interval and daily cap across campaigns and restarts", async () => {
    await seed(["seller-1", "seller-2", "seller-3"]);
    const campaign = await service.create(input);
    await service.action(campaign.id, "start", true);
    await service.tick();
    await service.tick();
    expect(delivered).toHaveLength(1);
    await releasePacing();
    await service.tick();
    expect(delivered).toHaveLength(2);
    await releasePacing();
    await new OutreachService(pool, new Map([["mashina.kg", messenger]]), true).tick();
    expect(delivered).toHaveLength(2);
    expect((await service.detail(campaign.id)).campaign.counts.pending).toBe(1);
    await pool.query(
      "UPDATE autodom_outreach.source_pacing SET attempt_day=(clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date-1",
    );
    await service.tick();
    expect(delivered).toHaveLength(3);
  });

  it("finishes an unresolvable listing without stopping another pending campaign", async () => {
    await seed(["invalid", "valid"]);
    const resolved: string[] = [];
    const localFailure: Messenger = {
      ...messenger,
      async resolve(candidate) {
        resolved.push(candidate.listingId);
        if (candidate.listingId === "invalid")
          throw new DeliveryError("Listing is no longer available", "failed", false);
        return messenger.resolve(candidate);
      },
    };
    const worker = new OutreachService(pool, new Map([["mashina.kg", localFailure]]), true);
    const failed = await worker.create({
      ...input,
      filter: { ...input.filter, query: "invalid" },
    });
    const next = await worker.create({
      ...input,
      filter: { ...input.filter, query: "valid" },
    });
    await worker.action(failed.id, "start", true);
    await worker.action(next.id, "start", true);
    await worker.tick();
    expect((await worker.detail(failed.id)).campaign).toMatchObject({
      status: "completed",
      counts: { failed: 1, pending: 0 },
    });
    expect((await worker.detail(next.id)).campaign.status).toBe("running");
    await worker.tick();
    await worker.tick();
    expect((await worker.detail(next.id)).campaign).toMatchObject({
      status: "completed",
      counts: { sent: 1 },
    });
    expect(delivered).toEqual(["valid"]);
    expect(resolved).toEqual(["invalid", "valid"]);
  });

  it("keeps a locally rejected send reserved while another pending campaign continues", async () => {
    await seed(["invalid", "valid"]);
    const attempted: string[] = [];
    const localFailure: Messenger = {
      ...messenger,
      async send(recipient, text, image) {
        attempted.push(recipient.id);
        if (recipient.id === "invalid")
          throw new DeliveryError("Listing cannot receive messages", "failed", false);
        return messenger.send(recipient, text, image);
      },
    };
    const worker = new OutreachService(pool, new Map([["mashina.kg", localFailure]]), true);
    const failedInput = {
      ...input,
      dailyLimit: 3,
      filter: { ...input.filter, query: "invalid" },
    };
    const failed = await worker.create(failedInput);
    const next = await worker.create({
      ...input,
      dailyLimit: 3,
      filter: { ...input.filter, query: "valid" },
    });
    await worker.action(failed.id, "start", true);
    await worker.action(next.id, "start", true);
    await worker.tick();
    expect((await worker.detail(failed.id)).campaign).toMatchObject({
      status: "completed",
      counts: { failed: 1, pending: 0 },
    });
    expect((await worker.detail(next.id)).campaign.status).toBe("running");
    await releasePacing();
    await worker.tick();
    expect((await worker.detail(next.id)).campaign).toMatchObject({
      status: "completed",
      counts: { sent: 1 },
    });
    const duplicate = await worker.create(failedInput);
    await worker.action(duplicate.id, "start", true);
    await releasePacing();
    await worker.tick();
    await worker.tick();
    expect((await worker.detail(duplicate.id)).campaign).toMatchObject({
      status: "completed",
      counts: { skipped: 1 },
    });
    expect(delivered).toEqual(["valid"]);
    expect(attempted).toEqual(["invalid", "valid"]);
  });

  it("keeps ambiguous sends reserved, pauses source, and never resends them", async () => {
    await seed(["seller-1"]);
    const uncertain: Messenger = {
      ...messenger,
      async send(recipient) {
        delivered.push(recipient.id);
        throw new DeliveryError("Disconnected after emit", "unknown", false);
      },
    };
    const worker = new OutreachService(pool, new Map([["mashina.kg", uncertain]]), true);
    const campaign = await worker.create(input);
    await worker.action(campaign.id, "start", true);
    await worker.tick();
    await worker.tick();
    expect((await worker.detail(campaign.id)).campaign).toMatchObject({
      status: "paused",
      counts: { unknown: 1 },
    });
    const next = await service.create(input);
    await service.action(next.id, "start", true);
    await releasePacing();
    await service.tick();
    expect(delivered).toEqual(["seller-1"]);
    expect((await service.detail(next.id)).campaign.counts.skipped).toBe(1);
  });

  it("recovers crashed reservations as unknown and observes suppression before sending", async () => {
    await seed(["seller-1", "seller-2"]);
    const campaign = await service.create(input);
    await service.action(campaign.id, "start", true);
    await pool.query(
      "UPDATE autodom_outreach.deliveries SET status='sending',recipient_id='seller-2' WHERE campaign_id=$1 AND candidate->>'listingId'='seller-2'",
      [campaign.id],
    );
    await pool.query(
      "INSERT INTO autodom_outreach.contacts(source,recipient_id,delivery_id) SELECT 'mashina.kg','seller-2',id FROM autodom_outreach.deliveries WHERE campaign_id=$1 AND status='sending'",
      [campaign.id],
    );
    await service.tick();
    expect(delivered).toEqual([]);
    expect((await service.detail(campaign.id)).campaign).toMatchObject({
      status: "paused",
      counts: { unknown: 1 },
    });
    await service.suppress("mashina.kg", "seller-1", "Отказ продавца");
    await service.action(campaign.id, "start", true);
    await service.tick();
    expect(delivered).toEqual([]);
    expect((await service.detail(campaign.id)).campaign.counts).toMatchObject({
      unknown: 1,
      skipped: 1,
    });
  });

  it("filters the real catalog by source, city, year and full-unit price, excluding stale rows", async () => {
    await seed(["match", "stale"]);
    await pool.query(
      "UPDATE public.listings SET last_seen=EXTRACT(EPOCH FROM clock_timestamp())-49*3600 WHERE id='stale'",
    );
    const result = await service.preview({
      ...input.filter,
      city: "Бишкек",
      yearMin: 2019,
      yearMax: 2021,
      priceMin: 19999,
      priceMax: 20001,
    });
    expect(result.candidates.map((candidate: Candidate) => candidate.listingId)).toEqual(["match"]);
    expect(result.candidates[0]?.price).toBe(20000);
    expect((await service.preview({ ...input.filter, query: "%" })).candidates).toEqual([]);
  });
});
