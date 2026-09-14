import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ENCAR_HISTORY_MAX_LISTINGS,
  type EncarHistory,
  encarListingUrl,
  normalizeVin,
  SourceError,
} from "@autodom/core";
import { checkEncarHistory, EncarIdentityError } from "./encar-history.js";
import type { VinSession } from "./vin-session.js";

const MAX_CACHE_BYTES = 1024 * 1024;

interface CacheEntry {
  vin: string;
  ids: string[];
  discoveredAt: number;
}

export interface EncarHistoryLookupOptions {
  cachePath?: string;
  ttlMs?: number;
  maxEntries?: number;
}

/** Persists discovery hints only; every returned advertisement requires fresh official VIN proof. */
export class EncarHistoryLookup {
  private readonly cachePath: string | undefined;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private initialization: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: EncarHistoryLookupOptions = {}) {
    this.cachePath = options.cachePath;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
    if (
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs <= 0 ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries <= 0 ||
      (this.cachePath !== undefined && this.cachePath.length === 0)
    ) {
      throw new SourceError("Invalid Encar cache configuration");
    }
  }

  initialize(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  async check(vin: string, session: VinSession): Promise<EncarHistory | null> {
    const normalizedVin = normalizeVin(vin);
    if (!normalizedVin) throw new SourceError("Encar history requires a valid VIN");
    await this.initialize();
    const now = Date.now();
    let pruned = false;
    for (const [key, entry] of this.entries) {
      if (entry.discoveredAt > now || now - entry.discoveredAt >= this.ttlMs) {
        this.entries.delete(key);
        pruned = true;
      }
    }
    if (pruned) await this.save();
    const cached = this.entries.get(normalizedVin);
    if (cached) {
      let history: EncarHistory | null = null;
      try {
        history = await checkEncarHistory(normalizedVin, session, cached.ids);
      } catch (error) {
        if (!(error instanceof EncarIdentityError)) throw error;
      }
      // Partial rechecks must not erase previously confirmed, unvisited discovery hints.
      if (history) return history;
      this.entries.delete(normalizedVin);
      await this.save();
    }

    // Reuse the caller's transport deadline; invalid cached evidence does not start a new budget.
    const discoveredAt = Date.now();
    const history = await checkEncarHistory(normalizedVin, session);
    if (history) {
      this.entries.delete(normalizedVin);
      this.entries.set(normalizedVin, {
        vin: normalizedVin,
        ids: history.listings.map((listing) => listing.id),
        discoveredAt,
      });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      await this.save();
    }
    return history;
  }

  async close(): Promise<void> {
    await this.initialize();
    await this.writes;
  }

  private async load(): Promise<void> {
    if (this.cachePath === undefined) return;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      let file: FileHandle | undefined;
      try {
        file = await open(
          this.cachePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (file) {
        try {
          const metadata = await file.stat();
          if (!metadata.isFile()) throw new SourceError("Encar cache requires a regular file");
          if (metadata.size <= MAX_CACHE_BYTES) {
            // A bounded read also handles files that grow after stat without unbounded allocation.
            const buffer = Buffer.alloc(metadata.size + 1);
            let bytes = 0;
            while (bytes < buffer.length) {
              const result = await file.read(buffer, bytes, buffer.length - bytes, null);
              if (result.bytesRead === 0) break;
              bytes += result.bytesRead;
            }
            if (bytes <= metadata.size) this.restore(buffer.toString("utf8", 0, bytes));
          }
        } finally {
          await file.close();
        }
      }
      // Verify writable persistent storage now, and replace old permissions/invalid contents safely.
      await this.persist();
    } catch {
      throw new SourceError("Unable to initialize Encar ID cache storage");
    }
  }

  private restore(contents: string): void {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== 2 || data.version !== 1 || !Array.isArray(data.entries))
      return;
    const now = Date.now();
    const restored = new Map<string, CacheEntry>();
    for (const value of data.entries) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const entry = value as Record<string, unknown>;
      if (
        Object.keys(entry).length !== 3 ||
        typeof entry.vin !== "string" ||
        normalizeVin(entry.vin) !== entry.vin ||
        typeof entry.discoveredAt !== "number" ||
        !Number.isSafeInteger(entry.discoveredAt) ||
        entry.discoveredAt <= 0 ||
        entry.discoveredAt > now ||
        !Array.isArray(entry.ids) ||
        entry.ids.length === 0 ||
        entry.ids.length > ENCAR_HISTORY_MAX_LISTINGS ||
        entry.ids.some((id) => typeof id !== "string" || !encarListingUrl(id)) ||
        new Set(entry.ids).size !== entry.ids.length ||
        restored.has(entry.vin)
      )
        return;
      restored.set(entry.vin, {
        vin: entry.vin,
        ids: entry.ids as string[],
        discoveredAt: entry.discoveredAt,
      });
    }
    const fresh = [...restored.values()]
      .filter((entry) => now - entry.discoveredAt < this.ttlMs)
      .sort((left, right) => left.discoveredAt - right.discoveredAt)
      .slice(-this.maxEntries);
    for (const entry of fresh) this.entries.set(entry.vin, entry);
  }

  private save(): Promise<void> {
    if (this.cachePath === undefined) return Promise.resolve();
    const pending = this.writes
      .then(() => this.persist())
      .catch(() => {
        throw new SourceError("Unable to persist Encar ID cache storage");
      });
    // The current caller observes the failure; later writes may recover independently.
    this.writes = pending.catch(() => undefined);
    return pending;
  }

  private async persist(): Promise<void> {
    if (this.cachePath === undefined) return;
    const contents = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    if (Buffer.byteLength(contents) > MAX_CACHE_BYTES)
      throw new SourceError("Encar ID cache exceeds storage limit");
    const temporary = join(
      dirname(this.cachePath),
      `.${basename(this.cachePath)}.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(contents, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.cachePath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }
}
