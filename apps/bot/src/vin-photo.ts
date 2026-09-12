import { normalizeVin } from "@autodom/core/vin";
import { z } from "zod";

export const VIN_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_OCR_OUTPUT = 64 * 1024;
const MAX_CONCURRENT_PHOTOS = 2;
const ocrResultSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            text: z.string().max(512),
            confidence: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
let activePhotos = 0;

export interface VinPhotoFile {
  filePath: string;
  fileSize?: number;
}
export type PhotoRecognizer = (file: VinPhotoFile) => Promise<readonly string[]>;

export class VinPhotoError extends Error {
  constructor(public readonly reason: "busy" | "invalid" | "unavailable") {
    super(`VIN photo ${reason}`);
    this.name = "VinPhotoError";
  }
}

/** Whitespace/hyphens may separate OCR characters; ambiguous letters are never replaced. */
export function extractVinCandidates(text: string): string[] {
  const candidates = new Set<string>();
  for (const line of text
    .slice(0, MAX_OCR_OUTPUT)
    .toUpperCase()
    .split(/[\r\n]+/u)) {
    for (const group of line.split(/[^A-Z0-9\t -]+/u)) {
      const tokens = group.match(/[A-Z0-9]+/gu) ?? [];
      for (let start = 0; start < tokens.length; start++) {
        let value = "";
        for (let end = start; end < tokens.length && value.length < 17; end++) {
          value += tokens[end];
          if (value.length !== 17) continue;
          const vin = normalizeVin(value);
          if (vin) candidates.add(vin);
          if (candidates.size === 5) return [...candidates];
        }
      }
    }
  }
  return [...candidates];
}

function validDimensions(width: number, height: number): boolean {
  return (
    width > 0 && height > 0 && width <= 12000 && height <= 12000 && width * height <= MAX_PIXELS
  );
}

function validateImage(bytes: Buffer): "image/jpeg" | "image/png" {
  if (bytes.length < 24 || bytes.length > VIN_PHOTO_MAX_BYTES) throw new VinPhotoError("invalid");
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString("ascii", 12, 16) === "IHDR" &&
      validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    )
      return "image/png";
    throw new VinPhotoError("invalid");
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new VinPhotoError("invalid");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (
        size >= 8 &&
        validDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      )
        return "image/jpeg";
      break;
    }
    offset += size;
  }
  throw new VinPhotoError("invalid");
}

async function downloadPhoto(
  token: string,
  file: VinPhotoFile,
  signal: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  // Only the relative photo path returned by Telegram getFile is accepted. No redirects or custom authority.
  if (
    !/^photos\/[A-Za-z0-9_-]+\.(?:jpe?g|png)$/u.test(file.filePath) ||
    (file.fileSize !== undefined &&
      (!Number.isSafeInteger(file.fileSize) ||
        file.fileSize <= 0 ||
        file.fileSize > VIN_PHOTO_MAX_BYTES))
  )
    throw new VinPhotoError("invalid");
  const response = await fetch(
    `https://api.telegram.org/file/bot${encodeURIComponent(token)}/${file.filePath}`,
    {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    },
  );
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    !response.body ||
    (length !== null && (!/^\d+$/u.test(length) || Number(length) > VIN_PHOTO_MAX_BYTES))
  ) {
    await response.body?.cancel();
    throw new VinPhotoError("invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > VIN_PHOTO_MAX_BYTES) throw new VinPhotoError("invalid");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function createPhotoRecognizer(
  telegramToken: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): PhotoRecognizer | undefined {
  const rawUrl = env.AUTODOM_OCR_API_URL ?? "";
  const apiToken = env.AUTODOM_OCR_API_TOKEN ?? "";
  if (!rawUrl && !apiToken) return undefined;
  if (!rawUrl || !/^[\x21-\x7e]{32,256}$/u.test(apiToken))
    throw new Error("Configure both AUTODOM_OCR_API_URL and a strong AUTODOM_OCR_API_TOKEN");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("AUTODOM_OCR_API_URL must be a valid service origin");
  }
  if (
    !/^https?:\/\/[^/?#@\\\s]+\/?$/iu.test(rawUrl) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("AUTODOM_OCR_API_URL must be an HTTP(S) origin without credentials or a path");
  const endpoint = new URL("/v1/ocr/recognize", url).href;
  const authorization = `Bearer ${apiToken}`;

  return async (file) => {
    if (activePhotos >= MAX_CONCURRENT_PHOTOS) throw new VinPhotoError("busy");
    activePhotos++;
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const bytes = await downloadPhoto(telegramToken, file, requestSignal);
      const contentType = validateImage(bytes);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body: bytes,
        redirect: "error",
        signal: requestSignal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new VinPhotoError(
          response.status === 429
            ? "busy"
            : [400, 413, 415].includes(response.status)
              ? "invalid"
              : "unavailable",
        );
      }
      const length = response.headers.get("content-length");
      if (
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json" ||
        !response.body ||
        (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_OCR_OUTPUT))
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new VinPhotoError("unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let body: string;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_OCR_OUTPUT) throw new VinPhotoError("unavailable");
          chunks.push(chunk.value);
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const result = ocrResultSchema.parse(JSON.parse(body));
      // This score is a heuristic, not calibrated accuracy; the owner must still confirm.
      return extractVinCandidates(
        result.lines
          .filter((line) => line.confidence >= 0.8)
          .map((line) => line.text)
          .join("\n"),
      );
    } catch (error) {
      // Never expose the Telegram download URL, OCR credentials or upstream response/errors.
      throw error instanceof VinPhotoError ? error : new VinPhotoError("unavailable");
    } finally {
      activePhotos--;
    }
  };
}
