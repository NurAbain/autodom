import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeVin } from "@autodom/core/vin";

export const VIN_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_OCR_OUTPUT = 64 * 1024;
const MAX_CONCURRENT_PHOTOS = 2;
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

function validateImage(bytes: Buffer): void {
  if (bytes.length < 24 || bytes.length > VIN_PHOTO_MAX_BYTES) throw new VinPhotoError("invalid");
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString("ascii", 12, 16) === "IHDR" &&
      validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    )
      return;
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
        return;
      break;
    }
    offset += size;
  }
  throw new VinPhotoError("invalid");
}

async function downloadPhoto(token: string, file: VinPhotoFile): Promise<Buffer> {
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
      signal: AbortSignal.timeout(10_000),
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
  const bytes = Buffer.concat(chunks, size);
  validateImage(bytes);
  return bytes;
}

export function createPhotoRecognizer(token: string): PhotoRecognizer {
  return async (file) => {
    if (activePhotos >= MAX_CONCURRENT_PHOTOS) throw new VinPhotoError("busy");
    activePhotos++;
    let directory: string | undefined;
    try {
      const bytes = await downloadPhoto(token, file);
      directory = await mkdtemp(join(tmpdir(), "autodom-vin-"));
      const input = join(directory, "photo");
      await writeFile(input, bytes, { mode: 0o600 });
      const text = await new Promise<string>((resolve, reject) => {
        execFile(
          "tesseract",
          [input, "stdout", "-l", "eng", "--psm", "11"],
          {
            timeout: 12_000,
            killSignal: "SIGKILL",
            maxBuffer: MAX_OCR_OUTPUT,
            encoding: "utf8",
            env: { ...process.env, OMP_THREAD_LIMIT: "1" },
            shell: false,
          },
          (error, stdout) => {
            if (error) reject(new VinPhotoError("unavailable"));
            else resolve(stdout);
          },
        );
      });
      return extractVinCandidates(text);
    } catch (error) {
      // Never expose fetch/subprocess errors: Telegram's credential is part of the download URL.
      throw error instanceof VinPhotoError ? error : new VinPhotoError("unavailable");
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        activePhotos--;
      }
    }
  };
}
