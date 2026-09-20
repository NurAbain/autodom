import { z } from "zod";

export const sourceSchema = z.enum(["mashina.kg", "lalafo.kg"]);
export type OutreachSource = z.infer<typeof sourceSchema>;
export const platformSchema = z.enum([
  "mashina.kg",
  "lalafo.kg",
  "instagram",
  "facebook",
  "threads",
]);
export type MarketingPlatform = z.infer<typeof platformSchema>;
export const socialPlatformSchema = z.enum(["instagram", "facebook", "threads"]);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
export const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const projectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(""),
  })
  .strict();
export type ProjectInput = z.infer<typeof projectInputSchema>;
export interface MarketingProject extends ProjectInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export const connectionInputSchema = z
  .object({
    platform: platformSchema,
    accountLabel: z.string().trim().min(1).max(120),
    login: z.string().trim().max(200).default(""),
    secret: z.string().min(8).max(16_384).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type ConnectionAuth = "server_session" | "credentials" | "access_token";
export interface ProjectConnection {
  projectId: string;
  platform: MarketingPlatform;
  accountLabel: string;
  login: string;
  auth: ConnectionAuth;
  credentialConfigured: boolean;
  enabled: boolean;
  ready: boolean;
  message: string;
  updatedAt: string;
}
export const propertyVehicleSelectionSchema = z
  .object({
    vehicleIds: z
      .array(z.string().regex(/^[1-9]\d{0,18}$/u))
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, "Автомобиль выбран несколько раз"),
  })
  .strict();
export type PropertyVehicleSelectionInput = z.infer<typeof propertyVehicleSelectionSchema>;
export interface PropertyVehicleCandidate {
  id: string;
  purpose: "property" | "downpayment";
  makeModel: string;
  year: number;
  mileageKm: number | null;
  salePriceMinor: number | null;
  saleCurrency: "USD" | "KGS" | null;
  propertyCity: string;
  propertyType: "apartment" | "house" | "land" | "commercial" | "any";
  cashMinor: number | null;
  cashCurrency: "USD" | "KGS" | null;
  monthlyMinor: number | null;
  monthlyCurrency: "USD" | "KGS" | null;
  updatedAt: string;
  selected: boolean;
}
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
    projectId: z.string().uuid(),
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
export const socialTargetSchema = z
  .object({
    externalId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_:-]+$/),
    url: z.string().url().max(2000),
    mediaType: z.enum(["photo", "video", "text"]),
  })
  .strict();
export type SocialTarget = z.infer<typeof socialTargetSchema>;
export const socialCampaignSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    platform: socialPlatformSchema,
    text: z.string().trim().min(1).max(2000),
    targets: z.array(socialTargetSchema).min(1).max(100),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    dailyLimit: z.number().int().min(1).max(500).default(20),
  })
  .strict();
export type SocialCampaignInput = z.infer<typeof socialCampaignSchema>;
export interface SocialCampaign extends SocialCampaignInput {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  counts: Record<DeliveryStatus, number>;
  lastError: string | null;
}
export interface SocialDelivery {
  id: string;
  campaignId: string;
  target: SocialTarget;
  status: DeliveryStatus;
  error: string | null;
  remoteId: string | null;
  updatedAt: string;
}
export interface SocialCampaignDetail {
  campaign: SocialCampaign;
  deliveries: SocialDelivery[];
}
export const instagramUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(30)
  .regex(/^[a-z0-9._]+$/);
const instagramWatchSettingsShape = {
  name: z.string().trim().min(1).max(100),
  commentText: z.string().trim().min(1).max(2000),
  accounts: z
    .array(instagramUsernameSchema)
    .min(1)
    .max(100)
    .refine(
      (accounts) => new Set(accounts).size === accounts.length,
      "Аккаунт указан несколько раз",
    ),
  mediaTypes: z
    .array(z.enum(["photo", "video"]))
    .min(1)
    .max(2),
  intervalSeconds: z.number().int().min(300).max(86400).default(300),
  dailyLimit: z.number().int().min(1).max(100).default(10),
} satisfies z.ZodRawShape;
export const instagramWatchInputSchema = z
  .object({
    projectId: z.string().uuid(),
    ...instagramWatchSettingsShape,
  })
  .strict();
export const instagramWatchUpdateSchema = z.object(instagramWatchSettingsShape).strict();
export type InstagramWatchInput = z.infer<typeof instagramWatchInputSchema>;
export type InstagramWatchUpdate = z.infer<typeof instagramWatchUpdateSchema>;
export interface InstagramWatch extends InstagramWatchInput {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  lastPollAt: string | null;
  lastError: string | null;
  counts: Record<DeliveryStatus, number>;
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
