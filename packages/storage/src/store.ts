import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approvedSources,
  BODY_TYPES,
  BUDGET_SCOPES,
  cityAlternatives,
  type Listing,
  type ListingEvent,
  listingIsAuction,
  listingPrice,
  MARKETS,
  makeListing,
  makeProfile,
  normalize,
  normalizeBodyType,
  normalizeCity,
  normalizeMileageKm,
  normalizeTransmission,
  type Profile,
  purchaseEligible,
  queryGroups,
  searchableText,
  TRANSMISSIONS,
  USE_CASES,
} from "@autodom/core";
import type { CatalogSort } from "@autodom/core/catalog-query";
import { type OwnerVehicle, validateOwnerVehicle } from "@autodom/core/owner-vehicle";
import {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  DATA_TABLES,
  drafts,
  events,
  listings,
  metadata,
  ownerVehicles,
  profiles,
  schema,
} from "./schema.js";

const LOCK_NAMESPACE = 0x4155544f;
const FRESH_SECONDS = 48 * 3600;
const nowSeconds = () => Date.now() / 1000;

/** One observed price of a listing; a missing price stays missing instead of becoming zero. */
export interface PricePoint {
  observed_at: number;
  price_usd_minor: number | null;
  price_kgs_minor: number | null;
  original_price_minor: number | null;
  original_currency: string;
}
const lockId = (key: string) =>
  createHash("sha256").update(`autodom:postgres:v1:${key}`).digest().readInt32BE(0);
type Session = {
  client: pg.PoolClient;
  db: NodePgDatabase<typeof schema>;
  transactional: boolean;
  queue: { tail: Promise<void> };
};
export type StoreStats = {
  listings: number;
  events: number;
  profiles: number;
  active_profiles: number;
  last_seen: number | null;
};

export function validateQuietHours(start: number | null, end: number | null): void {
  if (start === null && end === null) return;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start === null ||
    end === null ||
    start < 0 ||
    start >= 1440 ||
    end < 0 ||
    end >= 1440 ||
    start === end
  )
    throw new Error(
      "Quiet hours require distinct integer minutes from 0 through 1439, or both null",
    );
}
export function validateProfile(input: Profile): Profile {
  const p = makeProfile(input);
  if (!(p.currency === "USD" || p.currency === "KGS") || !Object.hasOwn(MARKETS, p.market))
    throw new Error("Unsupported currency or market");
  if (
    !Number.isSafeInteger(p.budget_min_minor) ||
    !Number.isSafeInteger(p.budget_max_minor) ||
    p.budget_min_minor < 0 ||
    p.budget_max_minor <= 0 ||
    p.budget_min_minor > p.budget_max_minor
  )
    throw new Error("Invalid integer budget");
  for (const [value, choices, required] of [
    [p.budget_scope, BUDGET_SCOPES, true],
    [p.body_type, BODY_TYPES, false],
    [p.transmission, TRANSMISSIONS, false],
    [p.use_case, USE_CASES, false],
  ] as const) {
    if (typeof value !== "string" || ((required || value !== "") && !Object.hasOwn(choices, value)))
      throw new Error("Unknown profile preference");
  }
  if (
    typeof p.city !== "string" ||
    [...p.city].length > 160 ||
    /:|[\p{Cc}&&\p{ASCII}]/v.test(p.city) ||
    (p.city !== "" && p.city.split(",").some((part) => !/\p{L}/u.test(normalizeCity(part))))
  )
    throw new Error("Invalid city");
  for (const [value, minimum, maximum] of [
    [p.year_min, 1900, new Date().getUTCFullYear() + 1],
    [p.year_max, 1900, new Date().getUTCFullYear() + 1],
    [p.mileage_max_km, 0, 10_000_000],
  ] as const)
    if (value !== null && (!Number.isInteger(value) || value < minimum || value > maximum))
      throw new Error("Year or mileage outside supported integer range");
  if (p.year_min !== null && p.year_max !== null && p.year_max < p.year_min)
    throw new Error("Year range ends before it starts");
  if (p.allow_import !== null && typeof p.allow_import !== "boolean")
    throw new Error("Invalid import preference");
  if (
    typeof p.purchase_by !== "string" ||
    (p.purchase_by !== "" &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(p.purchase_by) ||
        !Number.isFinite(Date.parse(p.purchase_by)) ||
        new Date(p.purchase_by).toISOString().slice(0, 10) !== p.purchase_by))
  )
    throw new Error("Invalid purchase date");
  return p;
}
export function listingRecord(input: Listing, observation: number, firstSeen = observation) {
  if (!Number.isFinite(observation) || !Number.isFinite(firstSeen))
    throw new Error("Invalid observation timestamp");
  const data = makeListing({ ...input, observed_at: observation });
  if (data.market === "ALL" || !Object.hasOwn(MARKETS, data.market))
    throw new Error("A listing must identify its actual market");
  return {
    id: data.id,
    data,
    price_usd_minor: listingPrice(data, "USD"),
    price_kgs_minor: listingPrice(data, "KGS"),
    availability: normalize(data.availability),
    normalized_text: searchableText(data),
    normalized_title: ` ${normalize(data.title)} `,
    first_seen: firstSeen,
    last_seen: observation,
    source: data.source,
    market: data.market,
    original_currency: data.original_currency,
    original_price_minor: data.original_price_minor,
    fx_expires_at: data.fx_expires_at,
    normalized_city: normalizeCity(data.city),
    normalized_body_type: normalizeBodyType(data.body_type),
    normalized_transmission: normalizeTransmission(data.transmission),
    vehicle_year: Number.isInteger(data.year) ? data.year : null,
    mileage_km: normalizeMileageKm(data.mileage),
    auction_status: data.auction_status || (listingIsAuction(data) ? "unknown" : ""),
    auction_at: data.auction_at,
  };
}
const decodeListing = (row: { data: Listing; last_seen: number }) =>
  makeListing({ ...row.data, observed_at: row.last_seen });
const decodeProfile = (row: typeof profiles.$inferSelect): Profile =>
  makeProfile({ ...row, revision: row.revision.toString() });

export class Store {
  private readonly pool: pg.Pool;
  private readonly pooledDb: NodePgDatabase<typeof schema>;
  private readonly sessions = new AsyncLocalStorage<Session>();
  private readonly lockQueues = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;
  private constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    this.pooledDb = drizzle(this.pool, { schema });
  }
  static async open(databaseUrl: string): Promise<Store> {
    const store = new Store(databaseUrl);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closing ??= this.pool.end();
    await this.closing;
  }
  /**
   * The text filter of a search matches inside the collected ads. A trigram index
   * turns that match into an index lookup, and the build runs in the background:
   * CREATE INDEX CONCURRENTLY cannot run inside a transaction and must not hold
   * the service back. The statement goes through the pool, because the extended
   * query protocol of a prepared statement runs inside an implicit transaction.
   */
  async ensureSearchIndex(): Promise<void> {
    const extension = await this.database.execute<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS present`,
    );
    if (!extension.rows[0]?.present) return;
    const index = await this.database.execute<{ valid: boolean }>(
      sql`SELECT COALESCE(
              (SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
               WHERE c.relname = 'listings_text_trgm'),
              false) AS valid`,
    );
    if (index.rows[0]?.valid) return;
    if (index.rows[0]) await this.pool.query("DROP INDEX IF EXISTS listings_text_trgm");
    try {
      await this.pool.query(
        "CREATE INDEX CONCURRENTLY listings_text_trgm ON listings USING gin (normalized_text gin_trgm_ops)",
      );
    } catch (error) {
      // Another instance may have built the same index in the meantime.
      const valid = await this.database.execute<{ valid: boolean }>(
        sql`SELECT COALESCE(
                (SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                 WHERE c.relname = 'listings_text_trgm'),
                false) AS valid`,
      );
      if (valid.rows[0]?.valid) return;
      throw error;
    }
  }
  /** Shared by the importer and snapshot transaction, never a separate persistence path. */
  get database(): NodePgDatabase<typeof schema> {
    return this.sessions.getStore()?.db ?? this.pooledDb;
  }
  private async connection<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const current = this.sessions.getStore();
    if (current) return fn(current);
    const client = await this.pool.connect();
    const session = {
      client,
      db: drizzle(client, { schema }),
      transactional: false,
      queue: { tail: Promise.resolve() },
    };
    try {
      return await this.sessions.run(session, () => fn(session));
    } finally {
      client.release();
    }
  }
  async transaction<T>(fn: () => Promise<T>, mode: "write" | "snapshot" = "write"): Promise<T> {
    return this.connection(async (session) => {
      if (session.transactional) {
        if (mode === "snapshot")
          throw new Error("Snapshot requires its own consistent transaction");
        return fn();
      }
      const predecessor = session.queue.tail;
      const { promise, resolve: release } = Promise.withResolvers<void>();
      session.queue.tail = promise;
      await predecessor;
      try {
        await session.client.query(
          mode === "snapshot" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
        );
        try {
          // One commit-ordered event stream: event IDs must never become visible out of order.
          if (mode === "write")
            await session.db.execute(
              sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${lockId("commit-order")})`,
            );
          const result = await this.sessions.run({ ...session, transactional: true }, fn);
          await session.client.query("COMMIT");
          return result;
        } catch (error) {
          await session.client.query("ROLLBACK");
          throw error;
        }
      } finally {
        release();
      }
    });
  }
  private async advisory<T>(
    key: string,
    fn: () => Promise<T>,
    attempt: boolean,
  ): Promise<T | null> {
    return this.connection(async (session) => {
      const id = lockId(`public:${key}`);
      if (session.transactional) {
        // Transaction-scoped locks survive an aborted SQL statement only until rollback;
        // trying to unlock a session lock inside an aborted transaction would leak it.
        const result = await session.db.execute(
          attempt
            ? sql`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, ${id}) AS acquired`
            : sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${id})`,
        );
        if (attempt && result.rows[0]?.acquired !== true) return null;
        return fn();
      }
      const result = await session.db.execute(
        attempt
          ? sql`SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}, ${id}) AS acquired`
          : sql`SELECT pg_advisory_lock(${LOCK_NAMESPACE}, ${id})`,
      );
      if (attempt && result.rows[0]?.acquired !== true) return null;
      try {
        return await fn();
      } finally {
        await session.db.execute(sql`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${id})`);
      }
    });
  }
  private async admittedLock<T>(
    key: string,
    fn: () => Promise<T>,
    attempt: boolean,
  ): Promise<T | null> {
    // Nested calls already own a connection. PostgreSQL remains responsible for their
    // reentrant/session/transaction lock semantics; waiting locally could deadlock them.
    if (this.sessions.getStore()) return this.advisory(key, fn, attempt);
    const predecessor = this.lockQueues.get(key);
    if (attempt && predecessor) return null;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.lockQueues.set(key, promise);
    // At most one top-level caller per key acquires a pool client, including when
    // another process holds the PostgreSQL lock. Local waiters preserve arrival order.
    await predecessor;
    try {
      return await this.advisory(key, fn, attempt);
    } finally {
      if (this.lockQueues.get(key) === promise) this.lockQueues.delete(key);
      release();
    }
  }
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return (await this.admittedLock(key, fn, false)) as T;
  }
  async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    return this.admittedLock(key, fn, true);
  }
  async migrate(): Promise<void> {
    const directory = process.env.AUTODOM_MIGRATIONS_DIR ?? "packages/storage/migrations";
    const migrations = await Promise.all(
      [
        "0001_initial.sql",
        "0002_mileage_bigint.sql",
        "0003_advertising_consent.sql",
        "0004_remove_advertising_consent.sql",
        "0005_owner_vehicles.sql",
        "0006_payments.sql",
        "0007_uae_market.sql",
        "0008_catalog_filters.sql",
        "0009_telegram_stars.sql",
        "0010_web_report_payments.sql",
        "0011_payment_channels.sql",
        "0012_vin_report_kinds.sql",
        "0013_vin_photos.sql",
        "0014_buyer_filter.sql",
        "0015_search_text_index.sql",
        "0016_owner_conditions.sql",
      ].map(async (name, index) => {
        const statement = await readFile(resolve(directory, name), "utf8");
        return {
          version: index + 1,
          statement,
          checksum: createHash("sha256").update(statement).digest("hex"),
        };
      }),
    );
    await this.transaction(async () => {
      await this.database.execute(
        sql`CREATE TABLE IF NOT EXISTS autodom_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const applied = await this.database.execute<{ version: number; checksum: string }>(
        sql`SELECT version, checksum FROM autodom_migrations ORDER BY version`,
      );
      if (
        applied.rows.some(
          (row, index) => row.version !== index + 1 || row.checksum !== migrations[index]?.checksum,
        )
      )
        throw new Error("Unsupported or modified PostgreSQL schema migration");
      for (const migration of migrations) {
        if (migration.version <= applied.rows.length) continue;
        await this.database.execute(sql.raw(migration.statement));
        if (migration.version === 8) {
          let after: string | undefined;
          for (;;) {
            const rows = await this.database
              .select({ id: listings.id, data: listings.data })
              .from(listings)
              .where(after === undefined ? undefined : gt(listings.id, after))
              .orderBy(asc(listings.id))
              .limit(500);
            if (!rows.length) break;
            await this.database.execute(sql`UPDATE ${listings} AS target
              SET normalized_title = incoming.title
              FROM (VALUES ${sql.join(
                rows.map(
                  (row) =>
                    sql`(${row.id}::text, ${` ${normalize(makeListing(row.data).title)} `}::text)`,
                ),
                sql`, `,
              )}) AS incoming(id, title) WHERE target.id = incoming.id`);
            after = rows.at(-1)!.id;
          }
        }
        await this.database.execute(
          sql`INSERT INTO autodom_migrations(version,checksum) VALUES (${migration.version},${migration.checksum})`,
        );
      }
    });
  }
  async upsertListings(input: readonly Listing[], observedAt?: number): Promise<number> {
    const ingestion = observedAt ?? nowSeconds();
    return this.transaction(async () => {
      let emitted = 0;
      for (const item of input) {
        if (item.market === "ALL" || !Object.hasOwn(MARKETS, item.market))
          throw new Error("A listing must identify its actual market");
        const observation = observedAt ?? item.observed_at ?? ingestion;
        const [previous] = await this.database
          .select()
          .from(listings)
          .where(eq(listings.id, item.id));
        if (previous && observation <= previous.last_seen) continue;
        const record = listingRecord(item, observation, previous?.first_seen ?? observation);
        const listing = record.data;
        const { id: _id, first_seen: _firstSeen, ...update } = record;
        await this.database
          .insert(listings)
          .values(record)
          .onConflictDoUpdate({ target: listings.id, set: update });
        let changed = previous === undefined;
        let kind: "new" | "price_change" = previous ? "price_change" : "new";
        let comparable = false;
        if (previous) {
          const old = decodeListing(previous);
          comparable =
            old.price_kind === listing.price_kind &&
            old.original_currency === listing.original_currency &&
            purchaseEligible(old) &&
            purchaseEligible(listing);
          const isOffer = (value: Listing) =>
            purchaseEligible(value) &&
            [value.original_price_minor, value.price_usd_minor, value.price_kgs_minor].some(
              (price) => price !== null && price > 0,
            );
          const oldOffer = isOffer(old);
          const newOffer = isOffer(listing);
          if (newOffer && !oldOffer) {
            changed = true;
            kind = "new";
          } else if (listingIsAuction(listing) && !newOffer) changed = false;
          else if (listing.original_currency || old.original_currency)
            changed =
              listing.original_currency !== old.original_currency ||
              listing.original_price_minor !== old.original_price_minor;
          else
            changed =
              previous.price_usd_minor !== record.price_usd_minor ||
              previous.price_kgs_minor !== record.price_kgs_minor;
        }
        if (changed) {
          await this.database.insert(events).values({
            listing_id: listing.id,
            kind,
            data: listing,
            observed_at: observation,
            previous_usd_minor: comparable ? previous!.price_usd_minor : null,
            previous_kgs_minor: comparable ? previous!.price_kgs_minor : null,
            previous_original_price_minor: comparable ? previous!.original_price_minor : null,
            previous_original_currency: comparable ? previous!.original_currency : "",
          });
          emitted++;
        }
      }
      return emitted;
    });
  }
  async getListing(id: string, freshOnly = false): Promise<Listing | null> {
    const [row] = await this.database
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.id, id),
          freshOnly ? gte(listings.last_seen, nowSeconds() - FRESH_SECONDS) : undefined,
        ),
      );
    return row ? decodeListing(row) : null;
  }
  private async maxEvent(): Promise<number> {
    const [row] = await this.database
      .select({ value: sql<number>`COALESCE(MAX(${events.id}), 0)`.mapWith(Number) })
      .from(events);
    return row!.value;
  }
  private async nextRevision(previous?: bigint): Promise<bigint> {
    if (previous !== undefined) {
      const revision = previous + 1n;
      await this.database.execute(
        sql`SELECT setval('profile_revision_seq', GREATEST(last_value, ${revision.toString()}::bigint), true) FROM profile_revision_seq`,
      );
      return revision;
    }
    const result = await this.database.execute<{ value: string }>(
      sql`SELECT nextval('profile_revision_seq')::text AS value`,
    );
    return BigInt(result.rows[0]!.value);
  }
  async saveProfile(input: Profile): Promise<Profile> {
    const p = validateProfile(input);
    return this.transaction(async () => {
      const [previous] = await this.database
        .select()
        .from(profiles)
        .where(eq(profiles.user_id, p.user_id));
      const quietStart = previous ? previous.quiet_start_minute : p.quiet_start_minute;
      const quietEnd = previous ? previous.quiet_end_minute : p.quiet_end_minute;
      validateQuietHours(quietStart, quietEnd);
      const record = {
        ...p,
        revision: await this.nextRevision(previous?.revision),
        cursor: await this.maxEvent(),
        quiet_start_minute: quietStart,
        quiet_end_minute: quietEnd,
      };
      const { user_id: _userId, ...update } = record;
      const [saved] = await this.database
        .insert(profiles)
        .values(record)
        .onConflictDoUpdate({ target: profiles.user_id, set: update })
        .returning();
      return decodeProfile(saved!);
    });
  }
  async getProfile(userId: number): Promise<Profile | null> {
    const [row] = await this.database.select().from(profiles).where(eq(profiles.user_id, userId));
    return row ? decodeProfile(row) : null;
  }
  async monitoringProfiles(): Promise<Profile[]> {
    return (
      await this.database
        .select()
        .from(profiles)
        .where(eq(profiles.monitoring, true))
        .orderBy(asc(profiles.user_id))
    ).map(decodeProfile);
  }
  async setMonitoring(userId: number, enabled: boolean): Promise<Profile | null> {
    if (typeof enabled !== "boolean") throw new Error("Monitoring must be boolean");
    return this.transaction(async () => {
      const previous = await this.getProfile(userId);
      if (!previous) return null;
      const [row] = await this.database
        .update(profiles)
        .set({
          monitoring: enabled,
          revision: await this.nextRevision(BigInt(previous.revision)),
          cursor: enabled ? await this.maxEvent() : previous.cursor,
        })
        .where(eq(profiles.user_id, userId))
        .returning();
      return decodeProfile(row!);
    });
  }
  async setQuietHours(
    userId: number,
    start: number | null,
    end: number | null,
  ): Promise<Profile | null> {
    validateQuietHours(start, end);
    return this.transaction(async () => {
      const previous = await this.getProfile(userId);
      if (!previous) return null;
      const [row] = await this.database
        .update(profiles)
        .set({
          quiet_start_minute: start,
          quiet_end_minute: end,
          revision: await this.nextRevision(BigInt(previous.revision)),
        })
        .where(eq(profiles.user_id, userId))
        .returning();
      return decodeProfile(row!);
    });
  }
  async eventsAfter(cursor: number, limit = 200): Promise<ListingEvent[]> {
    if (limit <= 0) return [];
    return (
      await this.database
        .select()
        .from(events)
        .where(gt(events.id, cursor))
        .orderBy(asc(events.id))
        .limit(limit)
    ).map((row) => ({
      id: row.id,
      listing: makeListing({ ...row.data, observed_at: row.observed_at }),
      kind: row.kind,
      previous_usd_minor: row.previous_usd_minor,
      previous_kgs_minor: row.previous_kgs_minor,
      previous_original_price_minor: row.previous_original_price_minor,
      previous_original_currency: row.previous_original_currency,
    }));
  }
  async advanceCursor(userId: number, eventId: number, revision: string): Promise<boolean> {
    return this.transaction(
      async () =>
        (
          await this.database
            .update(profiles)
            .set({ cursor: eventId })
            .where(
              and(
                eq(profiles.user_id, userId),
                eq(profiles.revision, BigInt(revision)),
                lte(profiles.cursor, eventId),
              ),
            )
            .returning({ id: profiles.user_id })
        ).length === 1,
    );
  }
  /**
   * The conditions of a search. The editor counts makes and cities across the whole
   * market, so it can leave the city or the text query out of the counting.
   */
  private searchWhere(p: Profile, options?: { skipCity?: boolean; skipQuery?: boolean }): SQL {
    if (!["USD", "KGS"].includes(p.currency) || !Object.hasOwn(MARKETS, p.market))
      return sql`false`;
    const sources = [...approvedSources()];
    if (!sources.length) return sql`false`;
    const price = p.currency === "USD" ? listings.price_usd_minor : listings.price_kgs_minor;
    const now = nowSeconds();
    const cities = options?.skipCity ? [] : cityAlternatives(p.city);
    const clauses: (SQL | undefined)[] = [
      gt(price, 0),
      between(price, p.budget_min_minor, p.budget_max_minor),
      inArray(listings.availability, ["в наличии", "опубликовано"]),
      gte(listings.last_seen, now - FRESH_SECONDS),
      inArray(listings.source, sources),
      or(
        and(
          eq(listings.market, "KG"),
          isNull(listings.fx_expires_at),
          sql`COALESCE(${listings.data}->>'fx_date', '') = ''`,
        ),
        eq(listings.original_currency, p.currency),
        gt(listings.fx_expires_at, now),
      ),
      or(
        eq(listings.auction_status, ""),
        and(eq(listings.auction_status, "active"), gt(listings.auction_at, now)),
      ),
      sql`${listings.data}->>'price_kind' IN ('asking','buy_now')`,
      p.market !== "ALL" ? eq(listings.market, p.market) : undefined,
      p.allow_import === false || p.budget_scope === "total"
        ? eq(listings.market, "KG")
        : undefined,
      cities.length ? inArray(listings.normalized_city, cities) : undefined,
      p.body_type ? eq(listings.normalized_body_type, p.body_type) : undefined,
      p.transmission ? eq(listings.normalized_transmission, p.transmission) : undefined,
      p.year_min !== null ? gte(listings.vehicle_year, p.year_min) : undefined,
      p.year_max !== null ? lte(listings.vehicle_year, p.year_max) : undefined,
      p.mileage_max_km !== null ? lte(listings.mileage_km, p.mileage_max_km) : undefined,
    ];
    const groups = options?.skipQuery ? [] : queryGroups(p.query);
    if (!options?.skipQuery && p.query.trim() && !groups.length) return sql`false`;
    if (groups.length)
      clauses.push(
        or(
          ...groups.map((group) =>
            and(...group.map((word) => like(listings.normalized_text, `% ${word} %`))),
          ),
        ),
      );
    return and(...clauses)!;
  }
  async search(profile: Profile, limit = 5, offset = 0): Promise<Listing[]> {
    if (limit <= 0) return [];
    if (offset < 0) throw new Error("Offset must be nonnegative");
    return (
      await this.database
        .select()
        .from(listings)
        .where(this.searchWhere(profile))
        .orderBy(desc(listings.last_seen), desc(listings.first_seen), asc(listings.id))
        .limit(limit)
        .offset(offset)
    ).map(decodeListing);
  }
  async countMatches(profile: Profile): Promise<number> {
    const [row] = await this.database
      .select({ value: count() })
      .from(listings)
      .where(this.searchWhere(profile));
    return row!.value;
  }
  /**
   * The cities of the market and how many ads each one has. The editor offers the
   * cities as buttons, so the count leaves the chosen city out of the conditions.
   */
  async countCities(profile: Profile, limit = 40): Promise<{ city: string; matches: number }[]> {
    if (limit <= 0) return [];
    const rows = await this.database
      .select({
        city: sql<string>`MAX(${listings.data}->>'city')`,
        matches: count(),
      })
      .from(listings)
      .where(this.searchWhere(profile, { skipCity: true }))
      .groupBy(listings.normalized_city)
      .orderBy(desc(count()))
      .limit(limit);
    return rows
      .filter((row) => row.city.trim())
      .map((row) => ({ city: row.city.trim(), matches: Number(row.matches) }));
  }
  /**
   * The ads of every make of the market. The make comes from the marketplace
   * attributes, and the text query stays out of the count so that every make of
   * the list can be compared with the others.
   */
  async countMakes(profile: Profile, limit = 300): Promise<Map<string, number>> {
    if (limit <= 0) return new Map();
    const make = sql<string>`${listings.data}->'catalog_attributes'->>'make'`;
    const rows = await this.database
      .select({ make, matches: count() })
      .from(listings)
      .where(this.searchWhere(profile, { skipQuery: true }))
      .groupBy(make)
      .orderBy(desc(count()))
      .limit(limit);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const name = row.make?.trim();
      if (!name) continue;
      counts.set(name, Number(row.matches));
    }
    return counts;
  }
  /**
   * The ads a search returns, without the heavy listing payload. The normalised
   * title and the catalogue model are enough to tell which model an ad belongs
   * to, and the editor counts thousands of ads per make.
   */
  async searchModelRows(
    profile: Profile,
    limit = 2000,
  ): Promise<{ title: string; model: string }[]> {
    if (limit <= 0) return [];
    const rows = await this.database
      .select({
        title: listings.normalized_title,
        model: sql<string>`${listings.data}->'catalog_attributes'->>'model'`,
      })
      .from(listings)
      .where(this.searchWhere(profile))
      .orderBy(desc(listings.last_seen), desc(listings.first_seen), asc(listings.id))
      .limit(limit);
    return rows.map((row) => ({ title: row.title, model: row.model ?? "" }));
  }
  /**
   * Catalogue read with an explicit order. The public site needs price and mileage
   * ordering; the bot keeps its own freshness-first cursor over `search`.
   */
  async searchCatalog(
    profile: Profile,
    options: { limit: number; offset: number; sort: CatalogSort },
  ): Promise<Listing[]> {
    if (options.limit <= 0) return [];
    if (options.offset < 0) throw new Error("Offset must be nonnegative");
    const price = profile.currency === "USD" ? listings.price_usd_minor : listings.price_kgs_minor;
    const order: SQL[] =
      options.sort === "price_asc"
        ? [asc(price), desc(listings.last_seen), asc(listings.id)]
        : options.sort === "price_desc"
          ? [sql`${price} DESC NULLS LAST`, desc(listings.last_seen), asc(listings.id)]
          : options.sort === "mileage_asc"
            ? [
                sql`${listings.mileage_km} ASC NULLS LAST`,
                desc(listings.last_seen),
                asc(listings.id),
              ]
            : [desc(listings.last_seen), desc(listings.first_seen), asc(listings.id)];
    return (
      await this.database
        .select()
        .from(listings)
        .where(this.searchWhere(profile))
        .orderBy(...order)
        .limit(options.limit)
        .offset(options.offset)
    ).map(decodeListing);
  }
  /** Observed prices of one listing, oldest first; unknown prices stay unknown. */
  async priceHistory(listingId: string, limit = 24): Promise<PricePoint[]> {
    if (!listingId || limit <= 0) return [];
    const rows = await this.database
      .select({
        observed_at: events.observed_at,
        data: events.data,
      })
      .from(events)
      .where(and(eq(events.listing_id, listingId), eq(events.kind, "price_change")))
      .orderBy(desc(events.observed_at))
      .limit(limit);
    return rows.reverse().map((row) => ({
      observed_at: row.observed_at,
      price_usd_minor: row.data.price_usd_minor,
      price_kgs_minor: row.data.price_kgs_minor,
      original_price_minor: row.data.original_price_minor,
      original_currency: row.data.original_currency || "",
    }));
  }
  /** Makes of the same catalogue the public site shows, with the number of matching cars. */
  async brandFacets(profile: Profile, limit = 24): Promise<{ value: string; count: number }[]> {
    const make = sql`${listings.data}->'catalog_attributes'->>'make'`;
    const rows = await this.database
      .select({ value: sql<string>`${make}`, count: count() })
      .from(listings)
      .where(and(this.searchWhere(profile), sql`${make} <> ''`))
      .groupBy(make)
      .orderBy(desc(count()), asc(make))
      .limit(limit);
    return rows.map((row) => ({ value: row.value, count: row.count }));
  }
  async getDraft(userId: number): Promise<[string, Record<string, unknown>] | null> {
    const [row] = await this.database.select().from(drafts).where(eq(drafts.user_id, userId));
    return row ? [row.state, row.data] : null;
  }
  async setDraft(userId: number, state: string, data: Record<string, unknown>): Promise<void> {
    // Refuse JSON values PostgreSQL would silently lose through JSON.stringify.
    JSON.stringify(data, (_key, value: unknown) => {
      if (
        (typeof value === "number" && !Number.isFinite(value)) ||
        value === undefined ||
        typeof value === "bigint" ||
        typeof value === "function" ||
        typeof value === "symbol"
      )
        throw new Error("Invalid draft JSON value");
      return value;
    });
    await this.transaction(async () => {
      await this.database
        .insert(drafts)
        .values({ user_id: userId, state, data })
        .onConflictDoUpdate({ target: drafts.user_id, set: { state, data } });
    });
  }
  async clearDraft(userId: number): Promise<void> {
    await this.transaction(async () => {
      await this.database.delete(drafts).where(eq(drafts.user_id, userId));
    });
  }
  async getOwnerVehicle(userId: number): Promise<OwnerVehicle | null> {
    const [row] = await this.database
      .select()
      .from(ownerVehicles)
      .where(eq(ownerVehicles.user_id, userId));
    return row ? validateOwnerVehicle(row) : null;
  }
  async saveOwnerVehicle(input: OwnerVehicle): Promise<OwnerVehicle> {
    const card = validateOwnerVehicle(input);
    return this.transaction(async () => {
      const [saved] = await this.database
        .insert(ownerVehicles)
        .values(card)
        .onConflictDoUpdate({ target: ownerVehicles.user_id, set: card })
        .returning();
      return saved!;
    });
  }
  async deleteOwnerVehicle(userId: number): Promise<void> {
    await this.transaction(async () => {
      await this.database.delete(ownerVehicles).where(eq(ownerVehicles.user_id, userId));
    });
  }
  async deleteUser(userId: number): Promise<void> {
    await this.transaction(async () => {
      await this.database.delete(drafts).where(eq(drafts.user_id, userId));
      await this.database.delete(profiles).where(eq(profiles.user_id, userId));
      await this.database.delete(ownerVehicles).where(eq(ownerVehicles.user_id, userId));
      await this.database
        .delete(metadata)
        .where(like(metadata.key, `autodom:telegram:%:user:${userId}`));
    });
  }
  async getMeta(key: string, defaultValue: string | null = null): Promise<string | null> {
    const [row] = await this.database.select().from(metadata).where(eq(metadata.key, key));
    return row?.value ?? defaultValue;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.transaction(async () => {
      await this.database
        .insert(metadata)
        .values({ key, value })
        .onConflictDoUpdate({ target: metadata.key, set: { value } });
    });
  }
  async stats(): Promise<StoreStats> {
    const result = await this.database.execute<{
      listings: string;
      events: string;
      profiles: string;
      active_profiles: string;
      last_seen: number | null;
    }>(
      sql`SELECT (SELECT count(*) FROM listings) AS listings, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM profiles) AS profiles, (SELECT count(*) FROM profiles WHERE monitoring) AS active_profiles, (SELECT max(last_seen) FROM listings) AS last_seen`,
    );
    const row = result.rows[0]!;
    return {
      ...row,
      listings: Number(row.listings),
      events: Number(row.events),
      profiles: Number(row.profiles),
      active_profiles: Number(row.active_profiles),
    };
  }
  async sourceStats(): Promise<
    Record<string, { source: string; market: string; listings: number; last_seen: number | null }>
  > {
    const rows = await this.database
      .select({
        source: listings.source,
        market: listings.market,
        listings: count(),
        last_seen: sql<number | null>`max(${listings.last_seen})`,
      })
      .from(listings)
      .groupBy(listings.source, listings.market);
    return Object.fromEntries(rows.map((row) => [row.source, row]));
  }
  async requireEmpty(): Promise<void> {
    await this.database.execute(
      sql.raw(`LOCK TABLE ${DATA_TABLES.join(", ")} IN ACCESS EXCLUSIVE MODE`),
    );
    for (const table of DATA_TABLES) {
      const result = await this.database.execute(
        sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`,
      );
      if (result.rows.length) throw new Error("Refusing to overwrite existing database data");
    }
  }
  async resetSequences(eventSequence?: string, revisionSequence?: string): Promise<void> {
    await this.database.execute(
      sql`SELECT setval(pg_get_serial_sequence('events','id'), GREATEST(COALESCE((SELECT MAX(id) FROM events),0),${eventSequence ?? "0"}::bigint,1), GREATEST(COALESCE((SELECT MAX(id) FROM events),0),${eventSequence ?? "0"}::bigint) > 0)`,
    );
    await this.database.execute(
      sql`SELECT setval('profile_revision_seq', GREATEST(COALESCE((SELECT MAX(revision) FROM profiles),0),${revisionSequence ?? "0"}::bigint,1), GREATEST(COALESCE((SELECT MAX(revision) FROM profiles),0),${revisionSequence ?? "0"}::bigint) > 0)`,
    );
  }
}
