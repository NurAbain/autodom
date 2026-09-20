import { randomUUID } from "node:crypto";
import { makeListing } from "@autodom/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../../packages/storage/src/store.js";
import {
  type Candidate,
  campaignSchema,
  DEFAULT_PROJECT_ID,
  DeliveryError,
  type Messenger,
} from "../src/contracts.js";
import type { InstagramPrivateClient } from "../src/instagram-private.js";
import { InstagramWatchService } from "../src/instagram-watch.js";
import { type ServerOptions, startOutreachServer } from "../src/server.js";
import { OutreachService } from "../src/service.js";
import { SocialCampaignService } from "../src/social.js";
import { CredentialVault } from "../src/vault.js";

let admin: pg.Pool;
let pool: pg.Pool;
let catalog: Store;
let container: StartedPostgreSqlContainer | undefined;
const database = `outreach_${randomUUID().replaceAll("-", "")}`;
const input = campaignSchema.parse({
  projectId: DEFAULT_PROJECT_ID,
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
  await new InstagramWatchService(pool).init();
}, 120_000);
beforeEach(async () => {
  delivered.length = 0;
  await pool.query(
    "TRUNCATE autodom_outreach.instagram_watch_pacing,autodom_outreach.instagram_observations,autodom_outreach.instagram_watches,autodom_outreach.property_vehicle_selections,autodom_outreach.contacts,autodom_outreach.deliveries,autodom_outreach.campaigns,autodom_outreach.images,public.owner_vehicles,public.events,public.listings CASCADE",
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
async function seedOwner(
  userId: number,
  purpose: "sale" | "property" | "downpayment",
  makeModel: string,
) {
  return catalog.saveOwnerVehicle({
    user_id: userId,
    chat_id: userId + 10_000,
    purpose,
    make_model: makeModel,
    year: 2020,
    mileage_km: 75_000,
    sale_price_minor: 2_000_000,
    sale_currency: "USD",
    property_city: purpose === "sale" ? null : "Бишкек",
    property_type: purpose === "sale" ? null : "apartment",
    cash_minor: purpose === "sale" ? null : 500_000,
    cash_currency: purpose === "sale" ? null : "USD",
    monthly_minor: purpose === "sale" ? null : 50_000,
    monthly_currency: purpose === "sale" ? null : "USD",
    consent_at: Date.now() / 1000 - 1,
    updated_at: Date.now() / 1000,
  });
}
async function releasePacing() {
  await pool.query(
    "UPDATE autodom_outreach.source_pacing SET last_attempt=clock_timestamp()-interval '1 day',next_allowed=clock_timestamp()-interval '1 second'",
  );
}

describe("durable marketplace delivery boundary", () => {
  it("enforces the eight-character admin password boundary and rejects incorrect credentials", async () => {
    const options: ServerOptions = {
      host: "127.0.0.1",
      port: 0,
      origin: "http://127.0.0.1",
      username: "admin",
      password: "testpass",
      pool,
      messengers: new Map(),
      sendEnabled: false,
    };
    await expect(startOutreachServer({ ...options, password: "shortpw" })).rejects.toThrow();
    const runtime = await startOutreachServer(options);
    try {
      const address = runtime.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const url = `http://127.0.0.1:${address.port}/api/campaigns`;
      const authorized = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from("admin:testpass").toString("base64")}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({ campaigns: [] });
      const incorrect = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from("admin:wrongpwd").toString("base64")}` },
      });
      expect(incorrect.status).toBe(401);
      expect((await fetch(url)).status).toBe(401);
    } finally {
      await runtime.close();
    }
  });

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
        GRANT SELECT,REFERENCES ON public.owner_vehicles TO "${role}";
        GRANT SELECT ON public.listings TO "${role}";
      `);
      const restricted = new OutreachService(
        restrictedPool,
        new Map([["mashina.kg", messenger]]),
        false,
      );
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
      await new InstagramWatchService(pool).init();
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
  it("keeps a private project shortlist of owner cars explicitly offered for property", async () => {
    await seedOwner(101, "property", "Toyota Camry");
    await seedOwner(102, "downpayment", "Lexus RX");
    await seedOwner(103, "sale", "Honda Fit");
    const project = await service.createProject({
      name: "Property partners",
      description: "Internal vehicle shortlist",
    });

    const initial = await service.propertyVehicles(project.id);
    expect(initial.total).toBe(2);
    expect(initial.vehicles.map((vehicle) => vehicle.id).sort()).toEqual(["101", "102"]);
    expect(initial.vehicles.find((vehicle) => vehicle.id === "101")).toMatchObject({
      purpose: "property",
      makeModel: "Toyota Camry",
      propertyCity: "Бишкек",
      propertyType: "apartment",
      selected: false,
    });
    expect(initial.vehicles[0]).not.toHaveProperty("chatId");
    expect(initial.vehicles[0]).not.toHaveProperty("userId");

    const selected = await service.replacePropertyVehicleSelection(project.id, {
      vehicleIds: ["101"],
    });
    expect(
      selected.vehicles.filter((vehicle) => vehicle.selected).map((vehicle) => vehicle.id),
    ).toEqual(["101"]);
    const otherProject = await service.createProject({
      name: "Another property partner",
      description: "",
    });
    expect(
      (await service.propertyVehicles(otherProject.id)).vehicles.every(
        (vehicle) => !vehicle.selected,
      ),
    ).toBe(true);
    await expect(
      service.replacePropertyVehicleSelection(project.id, { vehicleIds: ["103"] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await service.propertyVehicles(project.id)).vehicles.filter((vehicle) => vehicle.selected),
    ).toHaveLength(1);

    await seedOwner(101, "sale", "Toyota Camry");
    const changed = await service.propertyVehicles(project.id);
    expect(changed.vehicles.map((vehicle) => vehicle.id)).toEqual(["102"]);
    expect(
      Number(
        (
          await pool.query(
            "SELECT COUNT(*) amount FROM autodom_outreach.property_vehicle_selections WHERE project_id=$1",
            [project.id],
          )
        ).rows[0]?.amount,
      ),
    ).toBe(0);
  });
  it("keeps shared marketplace sessions when projects are created or edited", async () => {
    const vault = new CredentialVault(Buffer.alloc(32, 5).toString("base64"));
    const marketing = new OutreachService(pool, new Map([["mashina.kg", messenger]]), true, vault);
    await marketing.init();
    const project = await marketing.createProject({
      name: "Second marketplace brand",
      description: "Uses the operator-managed Mashina session",
    });
    expect(
      (await marketing.projectDetail(project.id)).connections.find(
        (connection) => connection.platform === "mashina.kg",
      ),
    ).toMatchObject({
      auth: "server_session",
      credentialConfigured: true,
      ready: true,
    });
    await expect(
      marketing.upsertConnection(project.id, {
        platform: "mashina.kg",
        accountLabel: "Do not replace the shared session",
        login: "operator",
        secret: "private-password",
        enabled: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Mashina.kg использует общую серверную сессию; логин и пароль здесь не нужны",
    });
    expect(
      (await marketing.projectDetail(project.id)).connections.find(
        (connection) => connection.platform === "mashina.kg",
      ),
    ).toMatchObject({
      auth: "server_session",
      login: "",
      ready: true,
    });
  });
  it("isolates project credentials and publishes explicit Instagram comments through private API", async () => {
    const vault = new CredentialVault(Buffer.alloc(32, 7).toString("base64"));
    const marketing = new OutreachService(pool, new Map([["mashina.kg", messenger]]), true, vault);
    await marketing.init();
    const project = await marketing.createProject({
      name: "Second brand",
      description: "Independent acquisition account",
    });
    await marketing.upsertConnection(project.id, {
      platform: "instagram",
      accountLabel: "Second brand Instagram",
      login: "second.brand",
      secret: "private-password",
      enabled: true,
    });
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const graph = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body instanceof URLSearchParams ? init.body.toString() : "",
      });
      return new Response(JSON.stringify({ id: `remote-${calls.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const privateComments: string[] = [];
    const instagram: InstagramPrivateClient = {
      async check() {
        return { session: { device_id: "explicit-device" } };
      },
      async discover() {
        return { session: { device_id: "explicit-device" }, media: [] };
      },
      async comment(_credentials, mediaId) {
        privateComments.push(mediaId);
        return { session: { device_id: "explicit-device" }, remoteId: `private-${mediaId}` };
      },
    };
    const social = new SocialCampaignService(
      pool,
      (projectId, platform) => marketing.accessToken(projectId, platform),
      true,
      "v26.0",
      graph,
      instagram,
      (projectId) => marketing.instagramCredentials(projectId),
      (projectId, session) => marketing.saveInstagramSession(projectId, session),
    );
    await social.init();
    const campaign = await social.create({
      projectId: project.id,
      name: "Launch comments",
      platform: "instagram",
      text: "Узнайте больше в профиле.",
      targets: [
        {
          externalId: "photo_1",
          url: "https://www.instagram.com/p/photo-1/",
          mediaType: "photo",
        },
        {
          externalId: "video_1",
          url: "https://www.instagram.com/reel/video-1/",
          mediaType: "video",
        },
      ],
      intervalSeconds: 60,
      dailyLimit: 2,
    });
    await social.action(campaign.id, "start", true);
    await social.tick();
    await pool.query(
      "UPDATE autodom_outreach.social_pacing SET next_allowed=clock_timestamp()-interval '1 second' WHERE project_id=$1 AND platform='instagram'",
      [project.id],
    );
    await social.tick();
    const detail = await social.detail(campaign.id);
    expect(detail.campaign).toMatchObject({ status: "completed", counts: { sent: 2 } });
    expect(detail.deliveries.map((delivery) => delivery.target.mediaType)).toEqual([
      "photo",
      "video",
    ]);
    expect(privateComments).toEqual(["photo_1", "video_1"]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const connection = (await marketing.projectDetail(project.id)).connections[0];
    expect(connection).toBeDefined();
    expect(connection).toMatchObject({
      platform: "instagram",
      login: "second.brand",
      credentialConfigured: true,
      ready: true,
    });
    expect(JSON.stringify(connection)).not.toContain("private-password");
    const stored = (
      await pool.query<{ credential: Buffer }>(
        "SELECT credential FROM autodom_outreach.connections WHERE project_id=$1 AND platform='instagram'",
        [project.id],
      )
    ).rows[0]?.credential;
    expect(stored).toBeDefined();
    expect(stored?.toString("utf8")).not.toContain("private-password");
  });
  it("keeps Instagram password and refreshed private session encrypted", async () => {
    const vault = new CredentialVault(Buffer.alloc(32, 13).toString("base64"));
    const marketing = new OutreachService(pool, new Map(), true, vault);
    await marketing.init();
    const connection = await marketing.upsertConnection(DEFAULT_PROJECT_ID, {
      platform: "instagram",
      accountLabel: "Autodom Instagram",
      login: "autodom.brand",
      secret: "private-password",
      enabled: true,
    });
    expect(connection).toMatchObject({
      platform: "instagram",
      login: "autodom.brand",
      auth: "credentials",
      ready: true,
    });
    expect(await marketing.instagramCredentials(DEFAULT_PROJECT_ID)).toEqual({
      username: "autodom.brand",
      password: "private-password",
      session: null,
    });
    await marketing.saveInstagramSession(DEFAULT_PROJECT_ID, { device_id: "stable-device" });
    expect(await marketing.instagramCredentials(DEFAULT_PROJECT_ID)).toEqual({
      username: "autodom.brand",
      password: "private-password",
      session: { device_id: "stable-device" },
    });
    const stored = (
      await pool.query<{ credential: Buffer }>(
        "SELECT credential FROM autodom_outreach.connections WHERE project_id=$1 AND platform='instagram'",
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]?.credential;
    expect(stored?.toString("utf8")).not.toContain("private-password");
    expect(stored?.toString("utf8")).not.toContain("stable-device");
  });
  it("comments on selected photo and video posts without an age cutoff", async () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const vault = new CredentialVault(Buffer.alloc(32, 15).toString("base64"));
    const marketing = new OutreachService(pool, new Map(), true, vault);
    await marketing.init();
    await marketing.upsertConnection(DEFAULT_PROJECT_ID, {
      platform: "instagram",
      accountLabel: "Autodom Instagram",
      login: "autodom.brand",
      secret: "private-password",
      enabled: true,
    });
    const comments: string[] = [];
    const privateClient: InstagramPrivateClient = {
      async check() {
        return { session: { device_id: "stable-device" } };
      },
      async discover(_credentials, targetUsername) {
        return {
          session: { device_id: "stable-device" },
          media:
            targetUsername === "dealer_one"
              ? [
                  {
                    id: "photo-current",
                    code: "photo-current",
                    url: "https://www.instagram.com/p/photo-current/",
                    mediaType: "photo",
                    takenAt: "2026-09-17T11:30:00.000Z",
                  },
                  {
                    id: "photo-stale",
                    code: "photo-stale",
                    url: "https://www.instagram.com/p/photo-stale/",
                    mediaType: "photo",
                    takenAt: "2026-09-17T09:59:00.000Z",
                  },
                ]
              : [
                  {
                    id: "video-current",
                    code: "video-current",
                    url: "https://www.instagram.com/reel/video-current/",
                    mediaType: "video",
                    takenAt: "2026-09-17T10:01:00.000Z",
                  },
                ],
        };
      },
      async comment(_credentials, mediaId) {
        comments.push(mediaId);
        return { session: { device_id: "stable-device" }, remoteId: `comment-${mediaId}` };
      },
    };
    const watches = new InstagramWatchService(
      pool,
      privateClient,
      (projectId) => marketing.instagramCredentials(projectId),
      (projectId, session) => marketing.saveInstagramSession(projectId, session),
      true,
      () => now,
    );
    await watches.init();
    await pool.query(
      "TRUNCATE autodom_outreach.instagram_observations,autodom_outreach.instagram_watches CASCADE",
    );
    const watch = await watches.create({
      projectId: DEFAULT_PROJECT_ID,
      name: "Fresh dealer posts",
      commentText: "Посмотрите доступные варианты в профиле.",
      accounts: ["dealer_one", "dealer_two"],
      mediaTypes: ["photo", "video"],
      intervalSeconds: 300,
      dailyLimit: 10,
    });
    await watches.action(watch.id, "start", true);
    await watches.tick();
    await pool.query(
      "UPDATE autodom_outreach.instagram_watch_pacing SET next_allowed='2026-09-17T11:59:59.000Z' WHERE watch_id=$1",
      [watch.id],
    );
    await watches.tick();
    await pool.query(
      "UPDATE autodom_outreach.instagram_watch_pacing SET next_allowed='2026-09-17T11:59:59.000Z' WHERE watch_id=$1",
      [watch.id],
    );
    await watches.tick();
    expect(comments).toEqual(["photo-stale", "video-current", "photo-current"]);
    expect((await watches.list())[0]).toMatchObject({
      status: "running",
      counts: { sent: 3, skipped: 0, pending: 0 },
    });
  });
  it("creates and edits an Instagram watch list", async () => {
    const runtime = await startOutreachServer({
      host: "127.0.0.1",
      port: 0,
      origin: "http://127.0.0.1",
      username: "admin",
      password: "testpass",
      pool,
      messengers: new Map(),
      sendEnabled: false,
      credentialKey: Buffer.alloc(32, 11).toString("base64"),
    });
    try {
      const address = runtime.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = {
        Authorization: `Basic ${Buffer.from("admin:testpass").toString("base64")}`,
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1",
      };
      const created = await fetch(`${base}/api/instagram-watches`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: DEFAULT_PROJECT_ID,
          name: "Dealer posts",
          commentText: "Подробности есть в нашем профиле.",
          accounts: ["dealer_one", "dealer_two"],
          mediaTypes: ["photo", "video"],
          intervalSeconds: 300,
          dailyLimit: 10,
        }),
      });
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as { watch: { id: string } };
      const updated = await fetch(
        `${base}/api/instagram-watches/${encodeURIComponent(createdBody.watch.id)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Dealer posts",
            commentText: "Новая формулировка.",
            accounts: ["dealer_two", "dealer_three"],
            mediaTypes: ["video"],
            intervalSeconds: 600,
            dailyLimit: 5,
          }),
        },
      );
      expect(updated.status).toBe(200);
      const list = await fetch(`${base}/api/instagram-watches`, { headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        watches: [
          {
            projectId: DEFAULT_PROJECT_ID,
            name: "Dealer posts",
            commentText: "Новая формулировка.",
            accounts: ["dealer_two", "dealer_three"],
            mediaTypes: ["video"],
            status: "draft",
          },
        ],
      });
      await pool.query(
        "UPDATE autodom_outreach.instagram_watches SET status='paused',last_error='Instagram unavailable' WHERE id=$1",
        [createdBody.watch.id],
      );
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      const metricsBody = await metrics.text();
      expect(metricsBody).toMatch(
        /autodom_outreach_entities\{(?=[^}]*kind="instagram_watch")(?=[^}]*status="paused")(?=[^}]*error="true")[^}]*\} 1/,
      );
      expect(metricsBody).toMatch(
        /autodom_outreach_queue_tick_success\{(?=[^}]*component="instagram_watch")[^}]*\} 1/,
      );
    } finally {
      await runtime.close();
    }
  });
});
