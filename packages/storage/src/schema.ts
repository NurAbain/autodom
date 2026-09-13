import type { Listing } from "@autodom/core";
import type { CatalogFilter } from "@autodom/core/catalog-filter";
import type { OwnerCurrency, OwnerPurpose, PropertyType } from "@autodom/core/owner-vehicle";
import type { PaymentEvent, PaymentOrder, PaymentRefund } from "@autodom/core/payments";
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
  uniqueIndex,
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
    normalized_title: text("normalized_title").notNull().default(""),
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
    catalog_filter: jsonb("catalog_filter")
      .$type<CatalogFilter>()
      .notNull()
      .default(sql`'{"vehicles":[],"options":{},"ranges":{},"below_market_percent":null}'::jsonb`),
  },
  (table) => [
    check("profiles_currency", sql`${table.currency} IN ('USD','KGS')`),
    check(
      "profiles_budget",
      sql`${table.budget_min_minor} >= 0 AND ${table.budget_max_minor} >= ${table.budget_min_minor} AND ${table.budget_max_minor} > 0`,
    ),
    check("profiles_market", sql`${table.market} IN ('KG','KR','US','AE','ALL')`),
    check("profiles_budget_scope", sql`${table.budget_scope} IN ('car','total')`),
    check("profiles_catalog_filter", sql`jsonb_typeof(${table.catalog_filter}) = 'object'`),
    check(
      "profiles_quiet_hours",
      sql`(${table.quiet_start_minute} IS NULL AND ${table.quiet_end_minute} IS NULL) OR (${table.quiet_start_minute} IS NOT NULL AND ${table.quiet_end_minute} IS NOT NULL AND ${table.quiet_start_minute} BETWEEN 0 AND 1439 AND ${table.quiet_end_minute} BETWEEN 0 AND 1439 AND ${table.quiet_start_minute} != ${table.quiet_end_minute})`,
    ),
  ],
);
export const ownerVehicles = pgTable(
  "owner_vehicles",
  {
    user_id: bigint("user_id", { mode: "number" }).primaryKey(),
    chat_id: bigint("chat_id", { mode: "number" }).notNull(),
    purpose: text("purpose").$type<OwnerPurpose>().notNull(),
    make_model: text("make_model").notNull(),
    year: integer("year").notNull(),
    mileage_km: bigint("mileage_km", { mode: "number" }),
    sale_price_minor: money("sale_price_minor"),
    sale_currency: text("sale_currency").$type<OwnerCurrency>(),
    property_city: text("property_city"),
    property_type: text("property_type").$type<PropertyType>(),
    cash_minor: money("cash_minor"),
    cash_currency: text("cash_currency").$type<OwnerCurrency>(),
    monthly_minor: money("monthly_minor"),
    monthly_currency: text("monthly_currency").$type<OwnerCurrency>(),
    consent_at: doublePrecision("consent_at").notNull(),
    updated_at: doublePrecision("updated_at").notNull(),
  },
  (table) => [
    check("owner_purpose", sql`${table.purpose} IN ('sale','property','downpayment')`),
    check(
      "owner_vehicle",
      sql`length(trim(${table.make_model})) BETWEEN 1 AND 120 AND ${table.year} BETWEEN 1900 AND 2100 AND (${table.mileage_km} IS NULL OR ${table.mileage_km} BETWEEN 0 AND 10000000)`,
    ),
    check(
      "owner_sale_money",
      sql`(${table.sale_price_minor} IS NULL AND ${table.sale_currency} IS NULL) OR (${table.sale_price_minor} IS NOT NULL AND ${table.sale_price_minor} > 0 AND ${table.sale_currency} IS NOT NULL AND ${table.sale_currency} IN ('USD','KGS'))`,
    ),
    check(
      "owner_cash_money",
      sql`(${table.cash_minor} IS NULL AND ${table.cash_currency} IS NULL) OR (${table.cash_minor} IS NOT NULL AND ${table.cash_minor} >= 0 AND ${table.cash_currency} IS NOT NULL AND ${table.cash_currency} IN ('USD','KGS'))`,
    ),
    check(
      "owner_monthly_money",
      sql`(${table.monthly_minor} IS NULL AND ${table.monthly_currency} IS NULL) OR (${table.monthly_minor} IS NOT NULL AND ${table.monthly_minor} >= 0 AND ${table.monthly_currency} IS NOT NULL AND ${table.monthly_currency} IN ('USD','KGS'))`,
    ),
    check(
      "owner_property",
      sql`(${table.property_city} IS NULL OR length(trim(${table.property_city})) BETWEEN 1 AND 80) AND (${table.property_type} IS NULL OR ${table.property_type} IN ('apartment','house','land','commercial','any')) AND (${table.purpose} = 'sale' OR (${table.property_city} IS NOT NULL AND ${table.property_type} IS NOT NULL))`,
    ),
    check(
      "owner_consent",
      sql`${table.consent_at} > 0 AND ${table.updated_at} >= ${table.consent_at}`,
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
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: text("id").primaryKey(),
    user_id: money("user_id").notNull(),
    product: text("product").$type<PaymentOrder["product"]>().notNull(),
    provider: text("provider").$type<PaymentOrder["provider"]>().notNull(),
    currency: text("currency").$type<PaymentOrder["currency"]>().notNull(),
    amount: money("amount").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    seller: text("seller").notNull(),
    support_url: text("support_url").notNull(),
    terms: text("terms").notNull(),
    executor: text("executor").notNull(),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull(),
    accepted_at: text("accepted_at"),
    invoice_url: text("invoice_url"),
    invoice_status: text("invoice_status").$type<PaymentOrder["invoiceStatus"]>().notNull(),
    payment_status: text("payment_status").$type<PaymentOrder["paymentStatus"]>().notNull(),
    fulfillment_status: text("fulfillment_status")
      .$type<PaymentOrder["fulfillmentStatus"]>()
      .notNull(),
    charge_id: text("charge_id"),
    needs_review: boolean("needs_review").notNull(),
  },
  (table) => [
    index("payment_orders_buyer").on(table.user_id, table.created_at),
    uniqueIndex("payment_orders_charge").on(table.provider, table.charge_id),
    check(
      "payment_orders_kind",
      sql`${table.provider} = 'finik' AND ${table.product} = 'inspection' AND ${table.currency} = 'KGS'`,
    ),
    check(
      "payment_orders_amount",
      sql`${table.amount} BETWEEN 1 AND 9007199254740991 AND ${table.amount} % 100 = 0`,
    ),
    check("payment_orders_buyer_id", sql`${table.user_id} BETWEEN 1 AND 9007199254740991`),
    check(
      "payment_orders_state",
      sql`${table.invoice_status} IN ('offered','pending','cancelled') AND ${table.payment_status} IN ('unpaid','paid') AND ${table.fulfillment_status} IN ('ready','fulfilled','cancelled')`,
    ),
    check(
      "payment_orders_capture",
      sql`(${table.payment_status} = 'unpaid' AND ${table.charge_id} IS NULL) OR (${table.payment_status} = 'paid' AND ${table.charge_id} IS NOT NULL AND ${table.accepted_at} IS NOT NULL)`,
    ),
    check(
      "payment_orders_fulfillment",
      sql`${table.fulfillment_status} <> 'fulfilled' OR ${table.payment_status} = 'paid'`,
    ),
  ],
);
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").$type<PaymentEvent["provider"]>().notNull(),
    event_id: text("event_id").notNull(),
    charge_id: text("charge_id").notNull(),
    order_id: text("order_id"),
    fingerprint: text("fingerprint").notNull(),
    data: jsonb("data").$type<PaymentEvent>().notNull(),
    outcome: text("outcome").$type<"applied" | "review">().notNull(),
    review_reason: text("review_reason"),
    received_at: text("received_at").notNull(),
  },
  (table) => [
    uniqueIndex("payment_events_fingerprint").on(table.fingerprint),
    index("payment_events_transaction").on(table.provider, table.event_id),
    index("payment_events_charge").on(table.provider, table.charge_id),
    check("payment_events_provider", sql`${table.provider} = 'finik'`),
    check(
      "payment_events_outcome",
      sql`(${table.outcome} = 'applied' AND ${table.review_reason} IS NULL) OR (${table.outcome} = 'review' AND ${table.review_reason} IS NOT NULL)`,
    ),
  ],
);
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: text("id").primaryKey(),
    order_id: text("order_id")
      .notNull()
      .references(() => paymentOrders.id),
    provider: text("provider").$type<PaymentRefund["provider"]>().notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    status: text("status").$type<PaymentRefund["status"]>().notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    note: text("note"),
  },
  (table) => [
    index("payment_refunds_order").on(table.order_id),
    uniqueIndex("payment_refunds_active")
      .on(table.order_id)
      .where(sql`${table.status} = 'requested'`),
    check(
      "payment_refunds_kind",
      sql`${table.provider} = 'finik' AND ${table.status} IN ('requested','submitted','failed')`,
    ),
    check("payment_refunds_amount", sql`${table.amount} BETWEEN 1 AND 9007199254740991`),
  ],
);
export const schema = {
  listings,
  events,
  profiles,
  drafts,
  metadata,
  owner_vehicles: ownerVehicles,
  payment_orders: paymentOrders,
  payment_events: paymentEvents,
  payment_refunds: paymentRefunds,
};
export const LEGACY_DATA_TABLES = ["listings", "events", "profiles", "drafts", "metadata"] as const;
export const OWNER_DATA_TABLES = [...LEGACY_DATA_TABLES, "owner_vehicles"] as const;
export const DATA_TABLES = [
  ...OWNER_DATA_TABLES,
  "payment_orders",
  "payment_events",
  "payment_refunds",
] as const;
export type DataTable = (typeof DATA_TABLES)[number];
