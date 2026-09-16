import { z } from "zod";

export const sourceSchema = z.enum(["mashina.kg", "lalafo.kg"]);
export type OutreachSource = z.infer<typeof sourceSchema>;
export const filterSchema = z
  .object({
    source: sourceSchema,
    query: z.string().trim().max(120).default(""),
    city: z.string().trim().max(80).default(""),
    yearMin: z.number().int().min(1900).max(2100).nullable().default(null),
    yearMax: z.number().int().min(1900).max(2100).nullable().default(null),
    currency: z.enum(["USD", "KGS"]).default("USD"),
    priceMin: z.number().nonnegative().max(1e10).nullable().default(null),
    priceMax: z.number().nonnegative().max(1e10).nullable().default(null),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict()
  .refine(
    (v) => v.yearMin === null || v.yearMax === null || v.yearMin <= v.yearMax,
    "Неверный диапазон годов",
  )
  .refine(
    (v) => v.priceMin === null || v.priceMax === null || v.priceMin <= v.priceMax,
    "Неверный диапазон цен",
  );
export type AudienceFilter = z.infer<typeof filterSchema>;
export const campaignSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(2000),
    imageId: z.string().uuid().nullable().default(null),
    filter: filterSchema,
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    dailyLimit: z.number().int().min(1).max(500).default(20),
  })
  .strict();
export type CampaignInput = z.infer<typeof campaignSchema>;
export type CampaignStatus = "draft" | "running" | "paused" | "completed" | "cancelled";
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "skipped";
export interface Candidate {
  listingId: string;
  source: OutreachSource;
  title: string;
  url: string;
  city: string;
  year: number | null;
  price: number | null;
  currency: "USD" | "KGS";
}
export interface Campaign extends CampaignInput {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  counts: Record<DeliveryStatus, number>;
  lastError: string | null;
}
export interface Delivery {
  id: string;
  campaignId: string;
  candidate: Candidate;
  recipientId: string | null;
  status: DeliveryStatus;
  error: string | null;
  remoteId: string | null;
  updatedAt: string;
}
export interface CampaignDetail {
  campaign: Campaign;
  deliveries: Delivery[];
}
export interface OutreachImage {
  id: string;
  mime: "image/jpeg" | "image/png";
  bytes: Buffer<ArrayBuffer>;
}
export interface Recipient {
  id: string;
  /** Provider lookup key: the canonical ad slug for Mashina, numeric ad ID for Lalafo. */
  listingId: string;
}
export interface SourceStatus {
  source: OutreachSource;
  ready: boolean;
  message: string;
}
export interface Messenger {
  readonly source: OutreachSource;
  check(): Promise<SourceStatus>;
  resolve(candidate: Candidate): Promise<Recipient>;
  send(
    recipient: Recipient,
    text: string,
    image: OutreachImage | null,
  ): Promise<{ remoteId: string | null }>;
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: "failed" | "unknown",
    readonly pause: boolean = true,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
