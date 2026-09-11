import { approvedSources } from "./config.js";
import type { MetadataStore } from "./rates.js";
import { COVERAGE, SOURCES, type SourceSpec, VEHICLE_HISTORY_COVERAGE } from "./source-catalog.js";

const implementedSources = SOURCES.filter((source) => source.adapter === "implemented");

/** Offline planning report. Enabled means operator opt-in, not a provider license or live health. */
export function sourceCatalog() {
  const approved = approvedSources();
  return {
    access_notice:
      "Запись в реестре, публичная доступность и включение оператором не подтверждают право сбора/повторного показа. Стоимость unknown не равна нулю. Кандидаты не участвуют в сборе, поиске и уведомлениях.",
    sources: SOURCES.map((source) => ({
      ...source,
      enabled: source.adapter === "implemented" && approved.includes(source.id),
    })),
    coverage: COVERAGE.map((coverage) => {
      const sources = SOURCES.filter((source) => source.group === coverage.group);
      return {
        ...coverage,
        source_ids: sources.map((source) => source.id),
        implemented_sources: sources
          .filter((source) => source.adapter === "implemented")
          .map((source) => source.id),
        enabled_sources: sources
          .filter((source) => source.adapter === "implemented" && approved.includes(source.id))
          .map((source) => source.id),
      };
    }),
    vehicle_history: VEHICLE_HISTORY_COVERAGE.map((coverage) => ({
      ...coverage,
      official_report_access: "not_connected",
      enabled_listing_sources: coverage.listing_sources.filter((source) =>
        approved.includes(source.source_id),
      ),
    })),
  };
}

export function enabledSources(): readonly SourceSpec[] {
  const approved = approvedSources();
  return implementedSources.filter((source) => approved.includes(source.id));
}
export function enabledMarkets(): readonly string[] {
  return [...new Set(enabledSources().map((source) => source.market))];
}
export function listingUrlAllowed(sourceId: string, url: string): boolean {
  if (url.length > 600) return false;
  try {
    const parsed = new URL(url);
    const authority = /^https:\/\/([^/?#]*)/iu.exec(url)?.[1];
    return (
      authority !== undefined &&
      !authority.includes("@") &&
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (parsed.port === "" || parsed.port === "443") &&
      implementedSources.some(
        (source) => source.id === sourceId && source.hosts.includes(parsed.hostname),
      )
    );
  } catch {
    return false;
  }
}

export interface SourceStatus {
  source: string;
  name: string;
  market: string;
  enabled: boolean;
  listings: number;
  last_seen: number | null;
  last_sync: string | null;
  total: string | null;
  scope: string | null;
  error: string | null;
}
export interface SourceStatusStore extends MetadataStore {
  sourceStats(): Promise<Record<string, { listings: number; last_seen: number | null }>>;
}
export async function sourceStatus(store: SourceStatusStore): Promise<SourceStatus[]> {
  const counts = await store.sourceStats();
  const approved = approvedSources();
  const statuses: SourceStatus[] = [];
  // A caller may hold an advisory lease backed by one pg.Client.
  for (const source of implementedSources) {
    const prefix = `source:${source.id}:`;
    const observed = counts[source.id];
    const last_sync = await store.getMeta(`${prefix}last_sync_at`);
    const total = await store.getMeta(`${prefix}catalog_total`);
    const scope = await store.getMeta(`${prefix}scope`, "");
    const error = await store.getMeta(`${prefix}source_error`, "");
    statuses.push({
      source: source.id,
      name: source.name,
      market: source.market,
      enabled: approved.includes(source.id),
      listings: observed?.listings ?? 0,
      last_seen: observed?.last_seen ?? null,
      last_sync,
      total: total || null,
      scope,
      error,
    });
  }
  return statuses;
}
