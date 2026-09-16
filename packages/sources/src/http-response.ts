import { SourceError } from "@autodom/core";
import { VIN_ARCHIVE_PHOTO_MAX_BYTES, type VinArchivePhoto } from "@autodom/core/vin-archive";
import type { ImpitResponse } from "impit";
import type { Response } from "undici";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function retryAfterSeconds(value: string | null, now = Date.now() / 1000): number {
  if (value && /^\d{1,8}$/u.test(value)) return Math.max(60, Number(value));
  const instant = value ? Date.parse(value) / 1000 : Number.NaN;
  return Number.isFinite(instant) ? Math.max(60, Math.trunc(instant - now)) : 300;
}

export async function readBody(
  response: Response | ImpitResponse,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("Source returned an empty response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SourceError("Source response exceeds size limit");
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abort = Promise.withResolvers<never>();
  const onAbort = () => abort.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([promise, abort.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function imageContentType(bytes: Uint8Array): VinArchivePhoto["content_type"] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export async function readImageProbe(
  response: Response | ImpitResponse,
  signal: AbortSignal,
): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const prefix = new Uint8Array(12);
  let length = 0;
  try {
    while (length < prefix.length) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      const take = Math.min(prefix.length - length, chunk.value.byteLength);
      prefix.set(chunk.value.subarray(0, take), length);
      length += take;
    }
    return imageContentType(prefix.subarray(0, length)) !== null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readImage(
  response: Response | ImpitResponse,
  signal: AbortSignal,
): Promise<VinArchivePhoto> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("Source returned an empty image body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const declared = response.headers.get("content-length");
    const expected = declared !== null && /^\d+$/u.test(declared) ? Number(declared) : null;
    if (
      response.status !== 200 ||
      response.headers.has("content-range") ||
      (declared !== null && (expected === null || !Number.isSafeInteger(expected))) ||
      (expected !== null && expected > VIN_ARCHIVE_PHOTO_MAX_BYTES)
    )
      throw new SourceError("Source returned an invalid image response");
    while (true) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > VIN_ARCHIVE_PHOTO_MAX_BYTES)
        throw new SourceError("Source image exceeds size limit");
      if (chunk.value.byteLength) chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    if (expected !== null && length !== expected)
      throw new SourceError("Source image is truncated");
    const bytes = Buffer.concat(chunks, length);
    const content_type = imageContentType(bytes);
    const declaredType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      !content_type ||
      (declaredType && declaredType !== "application/octet-stream" && declaredType !== content_type)
    )
      throw new SourceError("Source did not return a supported raster image");
    const complete =
      content_type === "image/jpeg"
        ? length >= 4 && bytes[length - 2] === 0xff && bytes[length - 1] === 0xd9
        : content_type === "image/png"
          ? length >= 33 &&
            bytes.readUInt32BE(length - 12) === 0 &&
            bytes.readUInt32BE(length - 8) === 0x49454e44 &&
            bytes.readUInt32BE(length - 4) === 0xae426082
          : length >= 20 && bytes.readUInt32LE(4) + 8 === length;
    if (!complete) throw new SourceError("Source image is truncated");
    return { bytes, content_type };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
