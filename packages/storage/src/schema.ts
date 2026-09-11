import type { Listing } from "@autodom/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
export const listings = pgTable(
  "listings",
  {
    id: text("id").primaryKey(),
    data: jsonb("data").$type<Listing>().notNull(),
    price_usd_minor: money("price_usd_minor"),
    price_kgs_minor: money("price_kgs_minor"),
    availability: text("availability").notNull(),
    normalized_text: text("normalized_text").notNull(),
    first_seen: doublePrecision("first_seen").notNull(),
    last_seen: doublePrecision("last_seen").notNull(),
    source: text("source").notNull().default("mashina.kg"),
    market: text("market").notNull().default("KG"),
    original_currency: text("original_currency").notNull().default(""),
    original_price_minor: money("original_price_minor"),
    fx_expires_at: doublePrecision("fx_expires_at"),
    normalized_city: text("normalized_city").notNull().default(""),
    normalized_body_type: text("normalized_body_type").notNull().default(""),
    normalized_transmission: text("normalized_transmission").notNull().default(""),
    vehicle_year: integer("vehicle_year"),
    mileage_km: bigint("mileage_km", { mode: "number" }),
    auction_status: text("auction_status").notNull().default(""),
    auction_at: doublePrecision("auction_at"),
  },
  (table) => [
    index("listings_recent").on(table.last_seen.desc(), table.first_seen.desc(), table.id),
    index("listings_source").on(table.source, table.market, table.last_seen),
    index("listings_preferences").on(
      table.normalized_city,
      table.normalized_body_type,
      table.normalized_transmission,
      table.vehicle_year,
      table.mileage_km,
    ),
    index("listings_auction").on(table.auction_status, table.auction_at),
  ],
);
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    listing_id: text("listing_id")
      .notNull()
      .references(() => listings.id),
    kind: text("kind").$type<"new" | "price_change">().notNull(),
    data: jsonb("data").$type<Listing>().notNull(),
    previous_usd_minor: money("previous_usd_minor"),
    previous_kgs_minor: money("previous_kgs_minor"),
    observed_at: doublePrecision("observed_at").notNull(),
    previous_original_price_minor: money("previous_original_price_minor"),
    previous_original_currency: text("previous_original_currency").notNull().default(""),
  },
  (table) => [check("events_kind", sql`${table.kind} IN ('new', 'price_change')`)],
);
export const profiles = pgTable(
  "profiles",
  {
    user_id: bigint("user_id", { mode: "number" }).primaryKey(),
    chat_id: bigint("chat_id", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    budget_min_minor: money("budget_min_minor").notNull(),
    budget_max_minor: money("budget_max_minor").notNull(),
    query: text("query").notNull(),
    monitoring: boolean("monitoring").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    cursor: bigint("cursor", { mode: "number" }).notNull(),
    quiet_start_minute: integer("quiet_start_minute"),
    quiet_end_minute: integer("quiet_end_minute"),
    market: text("market").notNull().default("KG"),
    city: text("city").notNull().default(""),
    budget_scope: text("budget_scope").notNull().default("car"),
    body_type: text("body_type").notNull().default(""),
    year_min: integer("year_min"),
    mileage_max_km: integer("mileage_max_km"),
    transmission: text("transmission").notNull().default(""),
    use_case: text("use_case").notNull().default(""),
    allow_import: boolean("allow_import"),
    purchase_by: text("purchase_by").notNull().default(""),
  },
  (table) => [
    check("profiles_currency", sql`${table.currency} IN ('USD','KGS')`),
    check(
      "profiles_budget",
      sql`${table.budget_min_minor} >= 0 AND ${table.budget_max_minor} >= ${table.budget_min_minor} AND ${table.budget_max_minor} > 0`,
    ),
    check("profiles_market", sql`${table.market} IN ('KG','KR','US','ALL')`),
    check("profiles_budget_scope", sql`${table.budget_scope} IN ('car','total')`),
    check(
      "profiles_quiet_hours",
      sql`(${table.quiet_start_minute} IS NULL AND ${table.quiet_end_minute} IS NULL) OR (${table.quiet_start_minute} IS NOT NULL AND ${table.quiet_end_minute} IS NOT NULL AND ${table.quiet_start_minute} BETWEEN 0 AND 1439 AND ${table.quiet_end_minute} BETWEEN 0 AND 1439 AND ${table.quiet_start_minute} != ${table.quiet_end_minute})`,
    ),
  ],
);
export const drafts = pgTable("drafts", {
  user_id: bigint("user_id", { mode: "number" }).primaryKey(),
  state: text("state").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
});
export const metadata = pgTable("metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export const schema = { listings, events, profiles, drafts, metadata };
export const DATA_TABLES = ["listings", "events", "profiles", "drafts", "metadata"] as const;
export type DataTable = (typeof DATA_TABLES)[number];
