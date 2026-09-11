import { SourceError } from "@autodom/core";
import type { Response } from "undici";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function retryAfterSeconds(value: string | null, now = Date.now() / 1000): number {
  if (value && /^\d{1,8}$/u.test(value)) return Math.max(60, Number(value));
  const instant = value ? Date.parse(value) / 1000 : Number.NaN;
  return Number.isFinite(instant) ? Math.max(60, Math.trunc(instant - now)) : 300;
}

export async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("Source returned an empty response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SourceError("Source response exceeds size limit");
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
