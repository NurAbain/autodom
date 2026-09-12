import { type AutoDevRecord, normalizeVin, SourceError, SourceRateLimited } from "@autodom/core";
import { fetch } from "undici";
import { readBody, retryAfterSeconds } from "./http-response.js";

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new SourceError("Auto.dev text schema changed");
  const result = value.trim();
  if (result.length > 512) throw new SourceError("Auto.dev text exceeds supported length");
  return result || null;
}

function modelYear(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1886 || value > 9999) {
    throw new SourceError("Auto.dev model year is not a supported integer year");
  }
  return value;
}

function parseRecord(body: string, vin: string): AutoDevRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SourceError("Malformed Auto.dev response");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SourceError("Auto.dev response schema changed");
  }
  const fields = data as Record<string, unknown>;
  if (
    fields.vin !== vin ||
    typeof fields.vinValid !== "boolean" ||
    fields.error != null ||
    fields.errors != null
  ) {
    throw new SourceError("Auto.dev response identity or schema mismatch");
  }
  if (!fields.vinValid) return null;
  if (typeof fields.ambiguous !== "boolean") {
    throw new SourceError("Auto.dev decoding ambiguity is unknown");
  }
  const vehicle = fields.vehicle;
  if (
    vehicle != null &&
    (typeof vehicle !== "object" ||
      Array.isArray(vehicle) ||
      (vehicle as Record<string, unknown>).vin !== vin)
  ) {
    throw new SourceError("Auto.dev nested vehicle identity mismatch");
  }
  const details = vehicle as Record<string, unknown> | null | undefined;
  const year = modelYear(fields.year);
  const vehicleYear = modelYear(details?.year);
  if (year !== null && vehicleYear !== null && year !== vehicleYear) {
    throw new SourceError("Auto.dev model years disagree");
  }
  // Explicit allowlist: upstream also returns private account metadata and links to paid APIs.
  // checksum=false is legitimate for European VINs; vinValid is the structural verdict.
  const result: AutoDevRecord = {
    vin,
    make: text(fields.make) ?? text(details?.make),
    model: text(fields.model) ?? text(details?.model),
    model_year: vehicleYear ?? year,
    trim: text(fields.trim),
    body_class: text(fields.body),
    engine: text(fields.engine),
    drive: text(fields.drive),
    transmission: text(fields.transmission),
    origin_country: text(fields.origin),
    ambiguous: fields.ambiguous,
  };
  if (!result.make || (!result.model && result.model_year === null)) return null;
  return result;
}

export async function checkAutoDev(
  vin: string,
  apiKey: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<AutoDevRecord | null> {
  const normalizedVin = normalizeVin(vin);
  if (!normalizedVin) throw new SourceError("Auto.dev requires a valid VIN");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new SourceError("Auto.dev request timeout must be a positive integer");
  }
  const combined = AbortSignal.any([
    AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
    ...(signal ? [signal] : []),
  ]);
  combined.throwIfAborted();
  const response = await fetch(`https://api.auto.dev/vin/${normalizedVin}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    signal: combined,
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (response.status === 429) {
      throw new SourceRateLimited(retryAfterSeconds(response.headers.get("retry-after")));
    }
    throw new SourceError(`Auto.dev: HTTP ${response.status}`);
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    await response.body?.cancel();
    throw new SourceError("Auto.dev response is not JSON");
  }
  const body = await readBody(response);
  combined.throwIfAborted();
  return parseRecord(body, normalizedVin);
}
