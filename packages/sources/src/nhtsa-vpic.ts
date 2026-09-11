import { type NhtsaVpicRecord, normalizeVin, SourceError, SourceRateLimited } from "@autodom/core";
import { fetch } from "undici";
import { readBody, retryAfterSeconds } from "./http-response.js";

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new SourceError("NHTSA text schema changed");
  const result = value.trim();
  if (result.length > 512) throw new SourceError("NHTSA text exceeds supported length");
  return result || null;
}

function modelYear(value: unknown): number | null {
  const literal = text(value);
  if (literal === null) return null;
  if (!/^[0-9]{4}$/u.test(literal) || Number(literal) < 1886) {
    throw new SourceError("NHTSA model year is not a supported integer year");
  }
  return Number(literal);
}

export function parseNhtsaVpicRecord(body: string, vin: string): NhtsaVpicRecord | null {
  const expectedVin = normalizeVin(vin);
  if (!expectedVin) throw new SourceError("NHTSA requires a valid VIN");
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("Malformed NHTSA response", { cause });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SourceError("NHTSA response schema changed");
  }
  const envelope = data as Record<string, unknown>;
  if (
    envelope.Count !== 1 ||
    !Array.isArray(envelope.Results) ||
    envelope.Results.length !== 1 ||
    envelope.error != null ||
    envelope.errors != null
  ) {
    throw new SourceError("NHTSA result envelope is invalid");
  }
  const record: unknown = envelope.Results[0];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new SourceError("NHTSA record schema changed");
  }
  const fields = record as Record<string, unknown>;
  if (fields.VIN !== expectedVin || fields.error != null || fields.errors != null) {
    throw new SourceError("NHTSA record identity or schema mismatch");
  }
  const errorCode = text(fields.ErrorCode);
  if (errorCode === null || !/^[0-9]+(?:\s*,\s*[0-9]+)*$/u.test(errorCode)) {
    throw new SourceError("NHTSA decode status is invalid");
  }
  const result: NhtsaVpicRecord = {
    vin: expectedVin,
    make: text(fields.Make),
    model: text(fields.Model),
    model_year: modelYear(fields.ModelYear),
    body_class: text(fields.BodyClass),
    fuel_type: text(fields.FuelTypePrimary),
    plant_country: text(fields.PlantCountry),
  };
  // Numeric decode errors include partial and unsupported VINs, never vehicle-history findings.
  if (errorCode.split(",").some((code) => Number(code) !== 0)) return null;
  if (errorCode !== "0") throw new SourceError("NHTSA decode status is ambiguous");
  // A manufacturer-only WMI identification is not a useful successful vehicle decode.
  if (!result.make || (!result.model && result.model_year === null)) {
    throw new SourceError("NHTSA successful decode has no useful vehicle identity");
  }
  return result;
}

export async function checkNhtsaVpic(
  vin: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<NhtsaVpicRecord | null> {
  const normalizedVin = normalizeVin(vin);
  if (!normalizedVin) throw new SourceError("NHTSA requires a valid VIN");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new SourceError("NHTSA request timeout must be a positive integer");
  }
  const combined = AbortSignal.any([
    AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
    ...(signal ? [signal] : []),
  ]);
  combined.throwIfAborted();
  // Public technical data only: fixed HTTPS endpoint, no Korean proxies, redirects or retries.
  const response = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${normalizedVin}?format=json`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: combined,
    },
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw new SourceRateLimited(retryAfterSeconds(response.headers.get("retry-after")));
    }
    throw new SourceError(`NHTSA: HTTP ${response.status}`);
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    await response.body?.cancel();
    throw new SourceError("NHTSA response is not JSON");
  }
  const body = await readBody(response);
  combined.throwIfAborted();
  return parseNhtsaVpicRecord(body, normalizedVin);
}
