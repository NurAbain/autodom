import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MARKETS, makeListing, makeProfile } from "@autodom/core";
import { type OwnerVehicle, validateOwnerVehicle } from "@autodom/core/owner-vehicle";
import {
  finikPaymentId,
  type PaymentEvent,
  validatePaymentAmount,
  validatePaymentEvent,
  validatePaymentOffer,
  validatePaymentText,
  validatePaymentTimestamp,
  validatePaymentUrl,
} from "@autodom/core/payments";
import { getTableColumns, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { decodePaymentOrder, paymentEventFingerprint } from "./payments.js";
import {
  DATA_TABLES,
  type DataTable,
  LEGACY_DATA_TABLES,
  OWNER_DATA_TABLES,
  type paymentOrders,
  schema,
} from "./schema.js";
import { Store, validateProfile, validateQuietHours } from "./store.js";

const FORMAT = "autodom-postgresql";
const VERSION = 1;
const SCHEMA_VERSION = 5;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeNumber(value: unknown): number {
  const number = Number(value);
  if (!(typeof value === "string" || typeof value === "number") || !Number.isSafeInteger(number))
    throw new Error("Snapshot integer exceeds the supported exact range");
  return number;
}
/** Validate every row before parameterized Drizzle SQL insertion; never interpolate snapshot SQL. */
export async function insertSnapshotRow(
  store: Store,
  table: DataTable,
  row: Record<string, unknown>,
): Promise<void> {
  const columns: Record<string, PgColumn> = getTableColumns(schema[table]);
  const names = Object.keys(columns);
  if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name)))
    throw new Error(`Invalid ${table} snapshot columns`);
  for (const [name, column] of Object.entries(columns)) {
    const value = row[name];
    if (value === null) {
      if (column.notNull) throw new Error(`Missing ${table}.${name}`);
      continue;
    }
    if (column.dataType === "json") {
      if (!object(value)) throw new Error(`Invalid ${table}.${name} JSON`);
    } else if (column.dataType === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Invalid ${table}.${name} boolean`);
    } else if (column.dataType === "bigint" || column.columnType === "PgBigInt53") {
      if (
        typeof value !== "string" ||
        !/^-?\d+$/u.test(value) ||
        BigInt(value) < -(1n << 63n) ||
        BigInt(value) >= 1n << 63n
      )
        throw new Error(`Invalid ${table}.${name} bigint`);
      if (name !== "revision") safeNumber(value);
    } else if (column.dataType === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (column.columnType === "PgInteger" && !Number.isInteger(value))
      )
        throw new Error(`Invalid ${table}.${name} number`);
    } else if (typeof value !== "string") throw new Error(`Invalid ${table}.${name} text`);
  }
  if (table === "listings" || table === "events") {
    const data = makeListing(row.data as Parameters<typeof makeListing>[0]);
    if (data.id !== (table === "listings" ? row.id : row.listing_id))
      throw new Error("Listing identity does not match its snapshot row");
    if (data.market === "ALL" || !Object.hasOwn(MARKETS, data.market))
      throw new Error("Invalid listing market");
  }
  if (table === "profiles") {
    const p = validateProfile(
      makeProfile({
        ...row,
        user_id: safeNumber(row.user_id),
        chat_id: safeNumber(row.chat_id),
        budget_min_minor: safeNumber(row.budget_min_minor),
        budget_max_minor: safeNumber(row.budget_max_minor),
        cursor: safeNumber(row.cursor),
        revision: String(row.revision),
      } as Parameters<typeof makeProfile>[0]),
    );
    validateQuietHours(p.quiet_start_minute, p.quiet_end_minute);
  }
  if (table === "owner_vehicles") {
    const card = { ...row };
    for (const name of [
      "user_id",
      "chat_id",
      "mileage_km",
      "sale_price_minor",
      "cash_minor",
      "monthly_minor",
    ])
      if (card[name] !== null) card[name] = safeNumber(card[name]);
    validateOwnerVehicle(card as unknown as OwnerVehicle);
  }
  if (table === "payment_orders") {
    const order = decodePaymentOrder({
      ...row,
      user_id: safeNumber(row.user_id),
      amount: safeNumber(row.amount),
    } as typeof paymentOrders.$inferSelect);
    finikPaymentId(order.id);
    validatePaymentOffer(order);
    validatePaymentTimestamp(order.createdAt);
    if (order.acceptedAt !== null) {
      validatePaymentTimestamp(order.acceptedAt);
      if (
        Date.parse(order.acceptedAt) < Date.parse(order.createdAt) ||
        Date.parse(order.acceptedAt) >= Date.parse(order.expiresAt)
      )
        throw new Error("Invalid order acceptance timestamp");
    }
    if (order.invoiceUrl !== null) {
      validatePaymentUrl(order.invoiceUrl);
      if (!order.acceptedAt) throw new Error("Invoice requires accepted order");
    }
    if (order.chargeId !== null) validatePaymentText(order.chargeId, "charge ID", 300);
    if (
      (order.invoiceStatus === "offered" && order.acceptedAt !== null) ||
      (order.invoiceStatus === "pending" && order.acceptedAt === null)
    )
      throw new Error("Invalid order invoice state");
  }
  if (table === "payment_events") {
    const event = row.data as unknown as PaymentEvent;
    validatePaymentEvent(event);
    finikPaymentId(String(row.id));
    validatePaymentTimestamp(String(row.received_at));
    if (
      row.provider !== event.provider ||
      row.event_id !== event.eventId ||
      row.charge_id !== event.chargeId ||
      row.order_id !== event.orderId ||
      row.fingerprint !== paymentEventFingerprint(event)
    )
      throw new Error("Payment event identity does not match its snapshot row");
    if (row.review_reason !== null)
      validatePaymentText(String(row.review_reason), "review reason", 300);
  }
  if (table === "payment_refunds") {
    finikPaymentId(String(row.id));
    finikPaymentId(String(row.order_id));
    validatePaymentAmount(safeNumber(row.amount));
    validatePaymentText(String(row.reason), "refund reason", 2000);
    validatePaymentTimestamp(String(row.created_at));
    validatePaymentTimestamp(String(row.updated_at));
    if (Date.parse(String(row.updated_at)) < Date.parse(String(row.created_at)))
      throw new Error("Invalid refund timestamp");
    if (row.note !== null) validatePaymentText(String(row.note), "refund note", 2000);
  }
  const values = names.map((name) =>
    columns[name]!.dataType === "json"
      ? sql`${JSON.stringify(row[name])}::jsonb`
      : sql`${row[name]}`,
  );
  await store.database.execute(
    sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
      names.map((name) => sql.identifier(name)),
      sql`, `,
    )}) VALUES (${sql.join(values, sql`, `)})`,
  );
}

export async function backup(store: Store, destination: string): Promise<void> {
  const path = resolve(destination);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    const hash = createHash("sha256");
    const counts: Record<DataTable, number> = {
      listings: 0,
      events: 0,
      profiles: 0,
      drafts: 0,
      metadata: 0,
      owner_vehicles: 0,
      payment_orders: 0,
      payment_events: 0,
      payment_refunds: 0,
    };
    const emit = async (value: unknown, digest = true) => {
      const line = `${JSON.stringify(value)}\n`;
      if (digest) hash.update(line);
      await file.writeFile(line);
    };
    await store.transaction(async () => {
      await emit({
        format: FORMAT,
        version: VERSION,
        schema_version: SCHEMA_VERSION,
        tables: DATA_TABLES,
      });
      for (const table of DATA_TABLES) {
        // Server cursor bounds memory independently of catalog size, within one MVCC snapshot.
        await store.database.execute(
          sql`DECLARE snapshot_rows NO SCROLL CURSOR FOR SELECT * FROM ${sql.identifier(table)} ORDER BY ${sql.identifier(table === "metadata" ? "key" : table === "profiles" || table === "drafts" || table === "owner_vehicles" ? "user_id" : "id")}`,
        );
        try {
          for (;;) {
            const result = await store.database.execute(sql`FETCH FORWARD 200 FROM snapshot_rows`);
            if (result.rows.length === 0) break;
            for (const row of result.rows) {
              await emit({ table, row });
              counts[table]++;
            }
          }
        } finally {
          await store.database.execute(sql`CLOSE snapshot_rows`);
        }
      }
      const sequenceRows = await store.database.execute<{ name: string; value: string }>(
        sql`SELECT 'events' AS name, CASE WHEN is_called THEN last_value ELSE 0 END::text AS value FROM events_id_seq UNION ALL SELECT 'revisions' AS name, CASE WHEN is_called THEN last_value ELSE 0 END::text AS value FROM profile_revision_seq`,
      );
      await emit({
        sequences: Object.fromEntries(sequenceRows.rows.map((row) => [row.name, row.value])),
      });
      await emit({ end: true, counts, sha256: hash.digest("hex") }, false);
    }, "snapshot");
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(path);
    throw error;
  }
  await file.close();
}

async function* snapshotLines(input: ReadStream): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of input) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      yield line;
    }
  }
  pending += decoder.decode();
  if (pending !== "") throw new Error("Truncated snapshot line");
}

export async function restore(snapshot: string, databaseUrl: string): Promise<void> {
  const input = createReadStream(snapshot);
  let store: Store | undefined;
  try {
    const iterator = snapshotLines(input);
    const first = await iterator.next();
    if (first.done) throw new Error("Not an Autodom snapshot");
    const header: unknown = JSON.parse(first.value);
    if (
      !object(header) ||
      header.format !== FORMAT ||
      header.version !== VERSION ||
      ![1, 2, 3, 4, SCHEMA_VERSION].includes(header.schema_version as number) ||
      JSON.stringify(header.tables) !==
        JSON.stringify(
          header.schema_version === SCHEMA_VERSION
            ? DATA_TABLES
            : header.schema_version === 4
              ? OWNER_DATA_TABLES
              : LEGACY_DATA_TABLES,
        )
    )
      throw new Error("Unsupported Autodom snapshot format");
    const snapshotTables: readonly DataTable[] =
      header.schema_version === SCHEMA_VERSION
        ? DATA_TABLES
        : header.schema_version === 4
          ? OWNER_DATA_TABLES
          : LEGACY_DATA_TABLES;
    store = await Store.open(databaseUrl);
    const target = store;
    await target.transaction(async () => {
      await target.requireEmpty();
      const hash = createHash("sha256").update(`${first.value}\n`);
      const counts: Record<DataTable, number> = {
        listings: 0,
        events: 0,
        profiles: 0,
        drafts: 0,
        metadata: 0,
        owner_vehicles: 0,
        payment_orders: 0,
        payment_events: 0,
        payment_refunds: 0,
      };
      let finished = false;
      let sequences: Record<string, unknown> | undefined;
      let lastTable = 0;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const line = next.value;
        if (finished || !line) throw new Error("Invalid or trailing snapshot record");
        const record: unknown = JSON.parse(line);
        if (!object(record)) throw new Error("Invalid snapshot record");
        if (record.end === true) {
          const declaredCounts = record.counts;
          if (
            !sequences ||
            record.sha256 !== hash.digest("hex") ||
            !object(declaredCounts) ||
            Object.keys(declaredCounts).length !== snapshotTables.length ||
            snapshotTables.some((table) => declaredCounts[table] !== counts[table])
          )
            throw new Error("Incomplete or corrupt snapshot");
          finished = true;
          continue;
        }
        hash.update(`${line}\n`);
        if (Object.hasOwn(record, "sequences")) {
          const declaredSequences = record.sequences;
          if (
            sequences ||
            !object(declaredSequences) ||
            Object.keys(record).length !== 1 ||
            Object.keys(declaredSequences).length !== 2 ||
            ["events", "revisions"].some(
              (name) =>
                typeof declaredSequences[name] !== "string" ||
                !/^\d+$/u.test(declaredSequences[name] as string),
            )
          )
            throw new Error("Invalid snapshot sequences");
          sequences = declaredSequences;
          continue;
        }
        const table = record.table as DataTable;
        if (
          sequences ||
          !snapshotTables.includes(table) ||
          !object(record.row) ||
          Object.keys(record).length !== 2
        )
          throw new Error("Unknown snapshot table or record");
        const index = snapshotTables.indexOf(table);
        if (index < lastTable) throw new Error("Snapshot tables are out of order");
        lastTable = index;
        let row = record.row;
        if (header.schema_version === 2 && table === "profiles") {
          // Validate the historical column before discarding it from the current profile.
          if (typeof row.ads_consent !== "boolean")
            throw new Error("Invalid profiles snapshot columns for schema version 2");
          const { ads_consent: _removed, ...current } = row;
          row = current;
        }
        await insertSnapshotRow(target, table, row);
        counts[table]++;
      }
      if (!finished || !sequences) throw new Error("Truncated Autodom snapshot");
      const invalidFinancialState = await target.database.execute(sql`
        SELECT id FROM payment_orders o
        WHERE (o.payment_status = 'paid' AND NOT EXISTS (
          SELECT 1 FROM payment_events e WHERE e.order_id = o.id AND e.charge_id = o.charge_id
            AND e.data->>'currency' = o.currency AND (e.data->>'amount')::numeric = o.amount
            AND (e.outcome = 'applied' OR e.review_reason = 'late_or_cancelled_payment')
        )) OR EXISTS (
          SELECT 1 FROM payment_refunds r WHERE r.order_id = o.id
          GROUP BY r.order_id HAVING o.payment_status <> 'paid'
            OR sum(CASE WHEN r.status <> 'failed' THEN r.amount ELSE 0 END) > o.amount
            OR max(r.amount) > o.amount
        )
        OR (NOT o.needs_review AND EXISTS (
          SELECT 1 FROM payment_events e WHERE e.outcome = 'review' AND (
            e.order_id = o.id OR e.charge_id = o.charge_id OR EXISTS (
              SELECT 1 FROM payment_events related
              WHERE related.order_id = o.id AND related.provider = e.provider
                AND (related.event_id = e.event_id OR related.charge_id = e.charge_id)
            )
          )
        ))
        UNION ALL
        SELECT e.id FROM payment_events e
        WHERE (e.outcome = 'applied' OR e.review_reason = 'late_or_cancelled_payment') AND NOT EXISTS (
          SELECT 1 FROM payment_orders o WHERE o.id = e.order_id AND o.charge_id = e.charge_id
            AND o.payment_status = 'paid'
        )
        LIMIT 1
      `);
      if (invalidFinancialState.rows.length) throw new Error("Inconsistent financial snapshot");
      await target.resetSequences(sequences.events as string, sequences.revisions as string);
    });
  } finally {
    input.destroy();
    await store?.close();
  }
}
