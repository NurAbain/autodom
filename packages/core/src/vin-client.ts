import { z } from "zod";
import {
  ENCAR_HISTORY_MAX_LISTINGS,
  ENCAR_HISTORY_MAX_PHOTOS,
  encarHistoryDiscoveryUrl,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinLookup,
} from "./vin.js";
import {
  CARWAY_ARCHIVE_MAX_PHOTOS,
  isVinArchiveLotUrl,
  isVinArchivePhotoUrl,
  parseVinArchivePhotoRequest,
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  VIN_ARCHIVE_PROVIDERS,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchivePhoto,
  type VinArchivePhotoLookup,
  type VinArchiveResult,
} from "./vin-archive.js";

const status = z.enum(["available", "not_found", "unavailable", "disabled"]);
const instant = z.number().nonnegative().max(8_640_000_000_000);
const observation = z.object({ status, checked_at: instant.nullable() });
const record = z
  .object({
    vin: z.string(),
    model: z.string().max(512).nullable(),
    last_mileage_km: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    export_date: z.iso.date().nullable(),
    first_registration_date: z.iso.date().nullable(),
    total_loss: z.boolean().nullable(),
  })
  .strict();
const nhtsaRecord = z
  .object({
    vin: z.string(),
    make: z.string().max(512).nullable(),
    model: z.string().max(512).nullable(),
    model_year: z.number().int().min(1886).max(9999).nullable(),
    body_class: z.string().max(512).nullable(),
    fuel_type: z.string().max(512).nullable(),
    plant_country: z.string().max(512).nullable(),
  })
  .strict();
const autoDevRecord = z
  .object({
    vin: z.string(),
    make: z.string().max(512).nullable(),
    model: z.string().max(512).nullable(),
    model_year: z.number().int().min(1886).max(9999).nullable(),
    trim: z.string().max(512).nullable(),
    body_class: z.string().max(512).nullable(),
    engine: z.string().max(512).nullable(),
    drive: z.string().max(512).nullable(),
    transmission: z.string().max(512).nullable(),
    origin_country: z.string().max(512).nullable(),
    ambiguous: z.boolean(),
  })
  .strict();
const detailText = z.string().min(1).max(512);
const listingDetails = z
  .object({
    make: detailText.optional(),
    model: detailText.optional(),
    model_year: z.number().int().min(1886).max(9999).optional(),
    first_registration_date: z
      .union([z.iso.date(), z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)])
      .optional(),
    odometer: z
      .object({
        value: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
        unit: z.enum(["km", "mi"]).nullable(),
        status: detailText.optional(),
      })
      .strict()
      .optional(),
    primary_damage: detailText.optional(),
    secondary_damage: detailText.optional(),
    loss_type: detailText.optional(),
    title: detailText.optional(),
    start_status: detailText.optional(),
    keys_present: z.boolean().optional(),
    engine: detailText.optional(),
    transmission: detailText.optional(),
    fuel: detailText.optional(),
    drive: detailText.optional(),
    body_style: detailText.optional(),
    color: detailText.optional(),
    location: detailText.optional(),
    seller_type: detailText.optional(),
    asking_price: z
      .object({
        amount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        currency: z.enum(["USD", "KRW", "AED"]),
      })
      .strict()
      .optional(),
  })
  .strict();
const listingReport = z
  .object({
    kind: z.enum(["inspection", "diagnostic", "insurance"]),
    status: z.enum(["available", "not_found", "unavailable"]),
    source_url: z.string().url().max(2048),
    partial: z.boolean(),
    checked_at: instant.int(),
    report_date: z.iso.date().nullable(),
    facts: z
      .array(
        z
          .object({
            section: z.string().max(64),
            label: z.string().min(1).max(96),
            value: z.string().min(1).max(384),
          })
          .strict(),
      )
      .max(80),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      (report.status === "available") !== report.facts.length > 0 ||
      (report.status === "unavailable" && !report.partial) ||
      (report.status === "not_found" && (report.partial || report.report_date !== null))
    )
      context.addIssue({ code: "custom", message: "Invalid source report state" });
  });
const listingReports = z
  .array(listingReport)
  .max(3)
  .refine(
    (reports) => new Set(reports.map((report) => report.kind)).size === reports.length,
    "Duplicate source report kind",
  );

const encarListing = z
  .object({
    id: z.string().regex(/^[1-9]\d{0,9}$/u),
    vin: z.string(),
    source_url: z.string().max(128),
    model: z.string().max(512).nullable(),
    mileage_km: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    advertisement_status: z.enum(["ADVERTISE", "SOLD"]).nullable(),
    created_at: z.iso.datetime({ local: true }).nullable(),
    first_advertised_at: z.iso.datetime({ local: true }).nullable(),
    modified_at: z.iso.datetime({ local: true }).nullable(),
    re_registered: z.boolean().nullable(),
    photo_urls: z.array(z.string().max(256)).max(ENCAR_HISTORY_MAX_PHOTOS),
    details: listingDetails.optional(),
    reports: listingReports.optional(),
  })
  .strict()
  .superRefine((listing, context) => {
    if (
      listing.source_url !== encarListingUrl(listing.id) ||
      listing.photo_urls.some((url) => !isEncarPhotoUrl(url, listing.id)) ||
      new Set(listing.photo_urls).size !== listing.photo_urls.length ||
      listing.reports?.some(
        (report) =>
          report.source_url !== listing.source_url &&
          !(
            report.kind === "inspection" &&
            report.source_url === `https://api.encar.com/legacy/usedcar/inspect/${listing.id}`
          ) &&
          !(
            report.kind === "diagnostic" &&
            report.source_url === `https://api.encar.com/legacy/usedcar/diagnosis/${listing.id}`
          ),
      )
    )
      context.addIssue({ code: "custom", message: "Untrusted Encar advertisement links" });
  });
const encarRecord = z
  .object({
    vin: z.string(),
    discovery_url: z.string().max(128),
    listings: z.array(encarListing).min(1).max(ENCAR_HISTORY_MAX_LISTINGS),
    partial: z.boolean(),
  })
  .strict()
  .superRefine((history, context) => {
    if (
      history.discovery_url !== encarHistoryDiscoveryUrl(history.vin) ||
      history.listings.some((listing) => listing.vin !== history.vin) ||
      (history.listings.some((listing) => listing.reports?.some((report) => report.partial)) &&
        !history.partial) ||
      new Set(history.listings.map((listing) => listing.id)).size !== history.listings.length
    )
      context.addIssue({ code: "custom", message: "Encar history identity mismatch" });
  });

function createApiTransport(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal | undefined,
  maxResponseBytes: number,
  accept = "application/json",
):
  | ((body: unknown, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; contentType: string }>)
  | undefined {
  const rawUrl = env.AUTODOM_VIN_API_URL?.trim() ?? "";
  const token = env.AUTODOM_VIN_API_TOKEN?.trim() ?? "";
  if (!rawUrl && !token) return undefined;
  if (!rawUrl || token.length < 32 || /\s/u.test(token))
    throw new Error("Configure both AUTODOM_VIN_API_URL and a strong AUTODOM_VIN_API_TOKEN");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("AUTODOM_VIN_API_URL must be a valid service origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("AUTODOM_VIN_API_URL must be an HTTP(S) origin without credentials or a path");
  const endpoint = new URL(path, url).href;
  const authorization = `Bearer ${token}`;

  return async (body, callerSignal) => {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(45_000),
      ...(signal ? [signal] : []),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: accept,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("VIN API request failed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("VIN API response missing");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxResponseBytes) throw new Error("VIN API response too large");
          chunks.push(chunk.value);
        }
        return { bytes: Buffer.concat(chunks, bytes), contentType };
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      // Neither the credential, service URL nor an upstream error body reaches the user/logs.
      throw new Error("VIN API unavailable or returned an invalid result");
    }
  };
}

function createApiLookup<T extends { vin: string }>(
  path: string,
  parse: (value: unknown, vin: string) => T,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal | undefined,
  maxResponseBytes: number,
): ((vin: string, signal?: AbortSignal) => Promise<T>) | undefined {
  const transport = createApiTransport(path, env, signal, maxResponseBytes);
  if (!transport) return undefined;
  return async (value, callerSignal) => {
    const vin = normalizeVin(value);
    if (!vin)
      throw new RangeError("VIN must contain 17 ASCII letters and digits, without I, O or Q");
    try {
      const response = await transport({ vin }, callerSignal);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
      const result = parse(JSON.parse(body), vin);
      if (result.vin !== vin) throw new Error("VIN API result identity mismatch");
      return result;
    } catch {
      throw new Error("VIN API unavailable or returned an invalid result");
    }
  };
}

const archiveEventSchema = z
  .object({
    status: z.enum(["sold", "ended"]),
    auction_at: instant.int().nullable(),
    auction_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable(),
    final_bid_usd_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();

const archiveLotSchema = z
  .object({
    auction: z.enum(["copart", "iaai", "emiratesauction", "copart_uae"]),
    lot_id: z.string().regex(/^[1-9]\d{0,11}$/u),
    source_url: z.string(),
    events: z.array(archiveEventSchema).max(200),
    photos: z.array(z.string().max(2048)).max(200),
    photos_complete: z.boolean(),
    details: listingDetails.optional(),
    reports: listingReports.optional(),
  })
  .strict();
const archiveResultSchema = z
  .object({
    vin: z.string(),
    checked_at: instant.int(),
    coverage: z.literal("indexed_lots_only"),
    sources: z
      .array(
        z
          .object({
            provider: z.enum(VIN_ARCHIVE_PROVIDERS),
            status: z.enum(["available", "no_photos", "not_found", "unavailable", "disabled"]),
            source_url: z.string(),
            checked_at: instant.int().nullable(),
            partial: z.boolean(),
            lots: z.array(archiveLotSchema).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(VIN_ARCHIVE_PROVIDERS.length),
  })
  .strict();

function validateVinArchiveResult(result: VinArchiveResult, vin: string): void {
  if (
    result.vin !== vin ||
    new Set(result.sources.map((source) => source.provider)).size !== result.sources.length
  )
    throw new Error("Invalid archive identity");
  for (const source of result.sources) {
    const hasPhotos = source.lots.some((lot) => lot.photos.length > 0);
    if (
      source.source_url !== VIN_ARCHIVE_SOURCE_URLS[source.provider] ||
      (source.checked_at !== null && source.checked_at > result.checked_at) ||
      (source.status === "disabled") !== (source.checked_at === null) ||
      (source.status === "available") !== hasPhotos ||
      (source.status === "no_photos" && (!source.lots.length || hasPhotos)) ||
      (["disabled", "not_found", "unavailable"].includes(source.status) &&
        source.lots.length > 0) ||
      (["disabled", "not_found"].includes(source.status) && source.partial) ||
      (source.status === "unavailable" && !source.partial)
    )
      throw new Error("Invalid archive observation state");
    const lotIds = new Set<string>();
    for (const lot of source.lots) {
      const key = `${lot.auction}:${lot.lot_id}`;
      if (
        lotIds.has(key) ||
        !isVinArchiveLotUrl(lot.source_url, source.provider, lot.auction, lot.lot_id, vin) ||
        lot.photos.some(
          (photo) => !isVinArchivePhotoUrl(photo, source.provider, lot.auction, lot.lot_id, vin),
        ) ||
        new Set(lot.photos).size !== lot.photos.length ||
        (!lot.photos_complete && !source.partial) ||
        lot.reports?.some(
          (report) => report.source_url !== lot.source_url || (report.partial && !source.partial),
        )
      )
        throw new Error("Invalid archive lot provenance or state");
      if (
        source.provider === "carway"
          ? lot.events.length !== 0 ||
            lot.photos.length > CARWAY_ARCHIVE_MAX_PHOTOS ||
            lot.photos_complete ||
            !source.partial
          : lot.events.length === 0
      )
        throw new Error("Invalid archive evidence or completeness");
      for (const event of lot.events) {
        const date = event.auction_date;
        const parsedDate = date === null ? null : new Date(`${date}T00:00:00Z`);
        if (
          (event.auction_at !== null && event.auction_at > (source.checked_at ?? 0)) ||
          (parsedDate !== null &&
            (!Number.isFinite(parsedDate.getTime()) ||
              parsedDate.toISOString().slice(0, 10) !== date ||
              date! > new Date((source.checked_at ?? 0) * 1000).toISOString().slice(0, 10)))
        )
          throw new Error("Invalid archive event date");
      }
      lotIds.add(key);
    }
  }
}
const resultSchema = z
  .object({
    vin: z.string(),
    checked_at: instant,
    carhistory: observation.extend({ source_url: z.literal(VIN_SOURCE_URLS.carhistory) }).strict(),
    car365: observation
      .extend({ source_url: z.literal(VIN_SOURCE_URLS.car365), data: record.nullable() })
      .strict(),
    encar: observation
      .extend({ source_url: z.literal(VIN_SOURCE_URLS.encar), data: encarRecord.nullable() })
      .strict()
      .optional(),
    nhtsa_vpic: observation
      .extend({ source_url: z.literal(VIN_SOURCE_URLS.nhtsa_vpic), data: nhtsaRecord.nullable() })
      .strict()
      .optional(),
    autodev: observation
      .extend({ source_url: z.literal(VIN_SOURCE_URLS.autodev), data: autoDevRecord.nullable() })
      .strict()
      .optional(),
    archives: archiveResultSchema.optional(),
  })
  .strict();

function parseVinResult(value: unknown, vin: string): VinCheckResult {
  const result = resultSchema.parse(value);
  for (const provider of VIN_PROVIDERS) {
    const item = result[provider];
    if (
      item !== undefined &&
      ((item.status === "disabled") !== (item.checked_at === null) ||
        ("data" in item &&
          ((item.status === "available") !== (item.data !== null) ||
            (item.data !== null && item.data.vin !== vin))))
    )
      throw new Error("VIN API observation identity or state mismatch");
    if (
      result.archives &&
      (provider === "carhistory" || provider === "car365" || provider === "encar") &&
      item !== undefined &&
      item.status !== "disabled" &&
      item.status !== "not_found"
    )
      throw new Error("VIN API archives violate Korean-first routing");
  }
  if (result.archives) validateVinArchiveResult(result.archives, vin);
  return result;
}

export function createVinApiLookup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): VinLookup | undefined {
  return createApiLookup("/v1/vin/check", parseVinResult, env, signal, 2 * 1024 * 1024);
}

export function createVinArchivePhotoApiLookup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): VinArchivePhotoLookup | undefined {
  const transport = createApiTransport(
    "/v1/vin/archive-photo",
    env,
    signal,
    VIN_ARCHIVE_PHOTO_MAX_BYTES,
    "image/jpeg, image/png, image/webp",
  );
  if (!transport) return undefined;
  return async (value, callerSignal): Promise<VinArchivePhoto> => {
    const request = parseVinArchivePhotoRequest(value);
    const { bytes, contentType } = await transport(request, callerSignal);
    const jpeg =
      contentType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    const png =
      contentType === "image/png" &&
      bytes.length >= 8 &&
      bytes[0] === 137 &&
      bytes[1] === 80 &&
      bytes[2] === 78 &&
      bytes[3] === 71 &&
      bytes[4] === 13 &&
      bytes[5] === 10 &&
      bytes[6] === 26 &&
      bytes[7] === 10;
    const webp =
      contentType === "image/webp" &&
      bytes.length >= 12 &&
      bytes[0] === 82 &&
      bytes[1] === 73 &&
      bytes[2] === 70 &&
      bytes[3] === 70 &&
      bytes[8] === 87 &&
      bytes[9] === 69 &&
      bytes[10] === 66 &&
      bytes[11] === 80;
    if (!jpeg && !png && !webp) throw new Error("VIN API unavailable or returned an invalid photo");
    return { bytes, content_type: contentType as VinArchivePhoto["content_type"] };
  };
}
