import { setTimeout as delay } from "node:timers/promises";
import type { SourceStatus } from "@autodom/core";
import {
  type DocumentTransport,
  enabledSources,
  RateBook,
  type Settings,
  SourceError,
  type SourcePage,
  SourceRateLimited,
  type SourceSpec,
  sourceStatus,
} from "@autodom/core";
import { fetchSourcePage } from "@autodom/sources";
import type { Store, StoreStats } from "@autodom/storage";

export interface CollectionStatus extends StoreStats {
  sources: SourceStatus[];
}

export async function recordPage(
  store: Store,
  source: SourceSpec,
  page: SourcePage,
  observedAt = Date.now() / 1000,
): Promise<number> {
  if (
    page.listings.some(
      (listing) => listing.source !== source.id || listing.market !== source.market,
    )
  ) {
    throw new SourceError("A catalog page contains another source or market");
  }
  return store.withLock(`autodom:source:${source.id}`, async () => {
    const prefix = `source:${source.id}:`;
    const priorScope = await store.getMeta(`${prefix}scope`, "");
    if (page.page > 1 && priorScope && priorScope !== page.scope) {
      await store.transaction(async () => {
        await store.setMeta(`${prefix}crawl_next_page`, "1");
        await store.setMeta(`${prefix}full_scan_completed_at`, "0");
      });
      throw new SourceError("Source search scope changed; restart from the first page");
    }
    return store.transaction(async () => {
      const pagesKey = `${prefix}catalog_pages`;
      const pages =
        !page.pages_exact && priorScope === page.scope
          ? Math.max(page.pages, Number(await store.getMeta(pagesKey, "1")))
          : page.pages;
      const count = await store.upsertListings(page.listings, observedAt);
      await store.setMeta(`${prefix}catalog_total`, page.total === null ? "" : String(page.total));
      await store.setMeta(pagesKey, String(pages));
      await store.setMeta(`${prefix}scope`, page.scope);
      await store.setMeta(
        `${prefix}last_sync_at`,
        `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
      );
      await store.setMeta(`${prefix}source_error`, "");
      return count;
    });
  });
}

async function collectPage(
  store: Store,
  source: SourceSpec,
  pageNumber: number,
  transport: DocumentTransport,
  rates: RateBook,
): Promise<SourcePage> {
  let page = await fetchSourcePage(source.id, { page: pageNumber, transport });
  const observedAt = Date.now() / 1000;
  if (source.market !== "KG") {
    await store.withLock("autodom:fx-rates", () => rates.refresh());
    page = { ...page, listings: page.listings.map((listing) => rates.convert(listing)) };
  }
  await recordPage(store, source, page, observedAt);
  return page;
}

export async function syncPages(
  store: Store,
  pages: number,
  transport: DocumentTransport,
  crawlDelay = 2,
  signal?: AbortSignal,
): Promise<CollectionStatus> {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 10_000)
    throw new Error("--pages must be between 1 and 10000");
  const rates = new RateBook(store, transport);
  const outcomes = await Promise.all(
    enabledSources().map(async (source) => {
      const prefix = `source:${source.id}:`;
      try {
        return await store.tryWithLock(`autodom:source:${source.id}`, async () => {
          for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
            signal?.throwIfAborted();
            if (pageNumber > 1) await delay(crawlDelay * 1000, undefined, signal ? { signal } : {});
            const page = await collectPage(store, source, pageNumber, transport, rates);
            const nextPage = Math.max(
              pageNumber + 1,
              Number(await store.getMeta(`${prefix}crawl_next_page`, "1")),
            );
            await store.setMeta(`${prefix}crawl_next_page`, String(nextPage));
            if (pageNumber >= page.pages) {
              await store.setMeta(`${prefix}full_scan_completed_at`, String(Date.now() / 1000));
              break;
            }
          }
          return true;
        });
      } catch (error) {
        signal?.throwIfAborted();
        await store.setMeta(
          `${prefix}source_error`,
          error instanceof Error ? error.name : "CollectionError",
        );
        return false;
      }
    }),
  );
  if (!outcomes.some(Boolean))
    throw new SourceError("No enabled source could be updated; inspect per-source status");
  return { ...(await store.stats()), sources: await sourceStatus(store) };
}

/** One durable source tick; returns the delay until that source can do useful work again. */
export async function collectTick(
  store: Store,
  source: SourceSpec,
  settings: Settings,
  transport: DocumentTransport,
  rates: RateBook,
  signal: AbortSignal,
): Promise<number> {
  const prefix = `source:${source.id}:`;
  const result = await store.tryWithLock(`autodom:source:${source.id}`, async () => {
    const now = Date.now() / 1000;
    const pausedUntil = Number(await store.getMeta(`${prefix}paused_until`, "0"));
    if (pausedUntil > now) return pausedUntil - now;
    try {
      const nextRefresh = Number(await store.getMeta(`${prefix}next_refresh_at`, "0"));
      if (now >= nextRefresh) {
        for (let pageNumber = 1; pageNumber <= settings.refresh_pages; pageNumber += 1) {
          signal.throwIfAborted();
          const page = await collectPage(store, source, pageNumber, transport, rates);
          if (pageNumber >= page.pages) break;
          await delay(settings.crawl_delay * 1000, undefined, { signal });
        }
        await store.setMeta(
          `${prefix}next_refresh_at`,
          String(Date.now() / 1000 + settings.refresh_seconds),
        );
      }
      let nextPage = Number(await store.getMeta(`${prefix}crawl_next_page`, "1"));
      const pages = Number(await store.getMeta(`${prefix}catalog_pages`, "1"));
      let completed = Number(await store.getMeta(`${prefix}full_scan_completed_at`, "0"));
      if (nextPage > pages) {
        if (!completed) {
          completed = Date.now() / 1000;
          await store.setMeta(`${prefix}full_scan_completed_at`, String(completed));
        }
        if (Date.now() / 1000 - completed < settings.full_refresh_seconds)
          return Math.min(30, settings.refresh_seconds);
        nextPage = 1;
        await store.setMeta(`${prefix}crawl_next_page`, "1");
        await store.setMeta(`${prefix}full_scan_completed_at`, "0");
      }
      signal.throwIfAborted();
      const page = await collectPage(store, source, nextPage, transport, rates);
      await store.setMeta(`${prefix}crawl_next_page`, String(nextPage + 1));
      if (nextPage >= page.pages)
        await store.setMeta(`${prefix}full_scan_completed_at`, String(Date.now() / 1000));
      return settings.crawl_delay;
    } catch (error) {
      signal.throwIfAborted();
      const pause =
        error instanceof SourceRateLimited
          ? Math.max(settings.refresh_seconds, error.retry_after)
          : settings.refresh_seconds;
      await store.setMeta(
        `${prefix}source_error`,
        error instanceof Error ? error.name : "CollectionError",
      );
      await store.setMeta(`${prefix}paused_until`, String(Date.now() / 1000 + pause));
      return pause;
    }
  });
  return result ?? settings.crawl_delay;
}
