import { z } from "zod";
import { normalizeVin, VIN_SOURCE_URLS, type VinCheckResult, type VinLookup } from "./vin.js";

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
const resultSchema = z
  .object({
    vin: z.string(),
    checked_at: instant,
    carhistory: observation.extend({ source_url: z.literal(VIN_SOURCE_URLS.carhistory) }).strict(),
    car365: observation
      .extend({ source_url: z.literal(VIN_SOURCE_URLS.car365), data: record.nullable() })
      .strict(),
  })
  .strict();

export function createVinApiLookup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): VinLookup | undefined {
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
  const endpoint = new URL("/v1/vin/check", url).href;
  const authorization = `Bearer ${token}`;

  return async (value, callerSignal): Promise<VinCheckResult> => {
    const vin = normalizeVin(value);
    if (!vin)
      throw new RangeError("VIN must contain 17 ASCII letters and digits, without I, O or Q");
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
          Accept: "application/json",
        },
        body: JSON.stringify({ vin }),
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
      let body: string;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 64 * 1024) throw new Error("VIN API response too large");
          chunks.push(chunk.value);
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const result = resultSchema.parse(JSON.parse(body));
      if (
        result.vin !== vin ||
        (result.car365.data !== null && result.car365.data.vin !== vin) ||
        (result.car365.status === "available") !== (result.car365.data !== null) ||
        [result.carhistory, result.car365].some(
          (item) => (item.status === "disabled") !== (item.checked_at === null),
        )
      )
        throw new Error("VIN API result identity or observation state mismatch");
      return result;
    } catch {
      // Neither the credential, service URL nor an upstream error body reaches the user/logs.
      throw new Error("VIN API unavailable or returned an invalid result");
    }
  };
}
