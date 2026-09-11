import type { IncomingMessage } from "node:http";
import { normalizeVin } from "./vin.js";

export class VinRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VinRequestError";
  }
}

const MAX_BODY_BYTES = 1024;

export async function readVinRequest(request: IncomingMessage): Promise<string> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new VinRequestError(415, "unsupported_media_type", "Send VIN as application/json.");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new VinRequestError(
      415,
      "unsupported_encoding",
      "Compressed request bodies are not supported.",
    );
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES)
    throw new VinRequestError(413, "body_too_large", "VIN request exceeds 1024 bytes.");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: VinRequestError) => {
      cleanup();
      chunks.length = 0;
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        fail(new VinRequestError(413, "body_too_large", "VIN request exceeds 1024 bytes."));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = () =>
      fail(new VinRequestError(400, "request_interrupted", "VIN request was interrupted."));
    const onAborted = onError;
    const timer = setTimeout(
      () => fail(new VinRequestError(408, "request_timeout", "VIN request body timed out.")),
      10_000,
    );
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    if (request.destroyed) onAborted();
  });
  let value: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // Match one complete string member before JSON.parse can erase duplicate keys,
    // including escaped duplicates. JSON.parse enforces JSON escapes/whitespace.
    if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/u.test(body))
      throw new Error();
    value = JSON.parse(body);
  } catch {
    throw new VinRequestError(400, "invalid_json", "Expected one JSON string member named vin.");
  }
  const vin =
    value && typeof value === "object" && "vin" in value && typeof value.vin === "string"
      ? normalizeVin(value.vin)
      : null;
  if (!vin)
    throw new VinRequestError(
      400,
      "invalid_vin",
      "VIN must contain 17 letters and digits, without I, O or Q.",
    );
  return vin;
}
