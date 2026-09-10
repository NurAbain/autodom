import { DatabaseSync } from "node:sqlite";
import { makeListing, makeProfile } from "@autodom/core";
import { getTableColumns } from "drizzle-orm";
import { DATA_TABLES, type DataTable, schema } from "./schema.js";
import { insertSnapshotRow } from "./snapshots.js";
import { listingRecord, type Store } from "./store.js";

const SOURCE_METADATA: Record<string, true> = {
  catalog_total: true,
  catalog_pages: true,
  last_sync_at: true,
  source_error: true,
  crawl_next_page: true,
  full_scan_completed_at: true,
};
type LegacyRow = Record<string, string | number | bigint | null | Uint8Array>;
function number(value: unknown): number {
  if (
    !(typeof value === "bigint" || typeof value === "number") ||
    !Number.isFinite(Number(value)) ||
    (typeof value === "bigint" && !Number.isSafeInteger(Number(value)))
  )
    throw new Error("Legacy number cannot be represented without data loss");
  return Number(value);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid legacy text");
  return value;
}
function boolean(value: unknown): boolean {
  if (value === 1n || value === 1) return true;
  if (value === 0n || value === 0) return false;
  throw new Error("Invalid legacy boolean");
}
function parseData(value: unknown, draft = false): Record<string, unknown> {
  // Node 24 exposes the original decimal token, before JSON's lossy Number conversion.
  const parsed: unknown = JSON.parse(
    text(value),
    (key: string, item: unknown, context?: { source?: string }) => {
      if (draft && (key === "revision" || key.endsWith("_revision")) && typeof item === "number") {
        if (!context?.source || !/^\d+$/u.test(context.source))
          throw new Error("Invalid legacy draft revision");
        return context.source;
      }
      if (
        typeof item === "number" &&
        (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
      )
        throw new Error("Legacy JSON number cannot be represented without data loss");
      return item;
    },
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Legacy JSON must be an object");
  return parsed as Record<string, unknown>;
}
function snapshotShape(table: DataTable, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(getTableColumns(schema[table]))) {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing legacy ${table}.${name}`);
    result[name] =
      value !== null && (column.dataType === "bigint" || column.columnType === "PgBigInt53")
        ? String(value)
        : value;
  }
  return result;
}

export async function importSqlite(path: string, store: Store): Promise<Record<string, number>> {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec("BEGIN");
    const version = Number(source.prepare("PRAGMA user_version").get()?.user_version);
    if (!Number.isInteger(version) || version < 1 || version > 5)
      throw new Error(`Unsupported SQLite schema version: ${version}`);
    const integrity = source.prepare("PRAGMA integrity_check").all();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== "ok" ||
      source.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Legacy SQLite integrity validation failed");
    const tableNames = source
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (
      tableNames.length !== DATA_TABLES.length ||
      DATA_TABLES.some((table) => !tableNames.includes(table))
    )
      throw new Error("Unsupported legacy SQLite tables");
    const counts: Record<string, number> = {
      listings: 0,
      events: 0,
      profiles: 0,
      drafts: 0,
      metadata: 0,
    };
    await store.transaction(async () => {
      await store.requireEmpty();
      for (const table of DATA_TABLES) {
        const statement = source.prepare(
          `SELECT * FROM ${table} ORDER BY ${table === "metadata" ? "key" : table === "profiles" || table === "drafts" ? "user_id" : "id"}`,
        );
        statement.setReadBigInts(true);
        for (const entry of statement.iterate()) {
          const row = entry as LegacyRow;
          let values: Record<string, unknown>;
          if (table === "listings") {
            const listing = makeListing(parseData(row.data) as Parameters<typeof makeListing>[0]);
            if (listing.id !== row.id) throw new Error("Legacy listing identity mismatch");
            const record = listingRecord(listing, number(row.last_seen), number(row.first_seen));
            values = { ...record };
            // v4→v5 recomputed purchase eligibility, while existing v5 cached prices remain intact.
            if (version === 5) {
              values.price_usd_minor =
                row.price_usd_minor === null ? null : number(row.price_usd_minor);
              values.price_kgs_minor =
                row.price_kgs_minor === null ? null : number(row.price_kgs_minor);
            }
            // Text and source columns are persisted state; filters are deliberately backfilled from data.
            for (const key of [
              "availability",
              "normalized_text",
              "source",
              "market",
              "original_currency",
            ] as const)
              if (row[key] !== undefined) values[key] = text(row[key]);
            for (const key of ["original_price_minor", "fx_expires_at"] as const)
              if (row[key] !== undefined) values[key] = row[key] === null ? null : number(row[key]);
          } else if (table === "events") {
            const observation = number(row.observed_at);
            const listing = makeListing({
              ...parseData(row.data),
              observed_at: observation,
            } as Parameters<typeof makeListing>[0]);
            values = {
              id: number(row.id),
              listing_id: text(row.listing_id),
              kind: text(row.kind),
              data: listing,
              previous_usd_minor:
                row.previous_usd_minor === null ? null : number(row.previous_usd_minor),
              previous_kgs_minor:
                row.previous_kgs_minor === null ? null : number(row.previous_kgs_minor),
              observed_at: observation,
              previous_original_price_minor:
                row.previous_original_price_minor == null
                  ? null
                  : number(row.previous_original_price_minor),
              previous_original_currency:
                row.previous_original_currency == null ? "" : text(row.previous_original_currency),
            };
          } else if (table === "profiles") {
            const fields: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row))
              fields[key] =
                key === "revision"
                  ? String(value)
                  : key === "monitoring" || (key === "allow_import" && value !== null)
                    ? boolean(value)
                    : typeof value === "bigint"
                      ? number(value)
                      : value;
            values = { ...makeProfile(fields as Parameters<typeof makeProfile>[0]) };
          } else if (table === "drafts") {
            values = {
              user_id: number(row.user_id),
              state: text(row.state),
              data: parseData(row.data, true),
            };
          } else {
            const key = text(row.key);
            if (version <= 2 && Object.hasOwn(SOURCE_METADATA, key)) {
              const namespaced = `source:mashina.kg:${key}`;
              if (source.prepare("SELECT 1 FROM metadata WHERE key = ?").get(namespaced)) continue;
              values = { key: namespaced, value: text(row.value) };
            } else values = { key, value: text(row.value) };
          }
          await insertSnapshotRow(store, table, snapshotShape(table, values));
          counts[table] = counts[table]! + 1;
        }
      }
      const sequence = source
        .prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
        .get();
      let highWater = "0";
      if (sequence) {
        const statement = source.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'");
        statement.setReadBigInts(true);
        const value = statement.get()?.seq;
        if (value !== undefined) {
          if (typeof value !== "bigint" || value < 0n)
            throw new Error("Invalid legacy event sequence");
          highWater = value.toString();
        }
      }
      await store.resetSequences(highWater);
    });
    source.exec("ROLLBACK");
    return counts;
  } finally {
    source.close();
  }
}
