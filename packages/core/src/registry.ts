import { approvedSources } from "./config.js";
import type { MetadataStore } from "./rates.js";

export interface SourceSpec {
  id: string;
  name: string;
  market: string;
  hosts: readonly string[];
}
export const SOURCES: readonly SourceSpec[] = [
  { id: "mashina.kg", name: "Mashina.kg", market: "KG", hosts: ["mashina.kg"] },
  { id: "encar.com", name: "Encar", market: "KR", hosts: ["fem.encar.com"] },
  { id: "truecar.com", name: "TrueCar", market: "US", hosts: ["www.truecar.com"] },
  { id: "bid.cars", name: "Bid.Cars · Copart / IAAI", market: "US", hosts: ["bid.cars"] },
];

export function enabledSources(): readonly SourceSpec[] {
  const approved = approvedSources();
  return SOURCES.filter((source) => approved.includes(source.id));
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
      SOURCES.some((source) => source.id === sourceId && source.hosts.includes(parsed.hostname))
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
  for (const source of SOURCES) {
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
