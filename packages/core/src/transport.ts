import { approvedSources } from "./config.js";
import type { SourcePage } from "./models.js";

export class SourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceError";
  }
}

export class SourceRateLimited extends SourceError {
  constructor(readonly retry_after: number) {
    super(`Source rate limit; collection paused for ${retry_after} seconds`);
    this.name = "SourceRateLimited";
  }
}

export function requireSourceAccess(source: string): void {
  if (!approvedSources().includes(source)) {
    throw new SourceError(`${source}: automated access is disabled pending source permission`);
  }
}

export interface RequestOutcome {
  source: string;
  tier: string;
  outcome: "success" | "error" | "rate_limited";
}

export interface DocumentOptions {
  source: string;
  page?: number;
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  payload?: unknown;
  signal?: AbortSignal;
}
export interface DocumentRequest<T> {
  url: string;
  parse: (text: string) => T;
  options: DocumentOptions;
}
export interface DocumentTransport {
  fetchDocument<T>(url: string, parse: (text: string) => T, options: DocumentOptions): Promise<T>;
  fetchDocuments<T>(requests: readonly DocumentRequest<T>[]): Promise<T[]>;
}
export interface FetchPageOptions {
  page?: number;
  transport: DocumentTransport;
}
export type SourceFetcher = (options: FetchPageOptions) => Promise<SourcePage>;
