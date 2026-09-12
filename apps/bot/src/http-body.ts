import type { IncomingMessage } from "node:http";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonText(request: IncomingMessage, maxBytes: number): Promise<string> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "Отправьте запрос в формате JSON.");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new RequestError(415, "Сжатые запросы не поддерживаются.");
  if (Number(request.headers["content-length"]) > maxBytes) {
    request.resume();
    throw new RequestError(413, "Запрос слишком большой.");
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
    };
    const fail = (status: number, message: string) => {
      cleanup();
      chunks.length = 0;
      request.resume();
      reject(new RequestError(status, message));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail(413, "Запрос слишком большой.");
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = () => fail(400, "Не удалось прочитать запрос. Попробуйте ещё раз.");
    const timer = setTimeout(() => fail(408, "Время отправки запроса истекло."), 10_000);
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
    if (request.destroyed) onError();
  });
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RequestError(400, "Нужен корректный UTF-8 JSON.");
  }
}

/** Payment and dialogue bodies are flat objects; reject ambiguous duplicate members. */
export function parseFlatJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const keys = Object.keys(value);
    const seen = new Set<string>();
    for (const match of text.matchAll(/(?:^\s*\{|,)\s*("(?:[^"\\]|\\.)*")\s*:/gu)) {
      const key = JSON.parse(match[1]!) as string;
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    if (seen.size !== keys.length) throw new Error();
    for (const item of Object.values(value)) {
      if (item !== null && !["string", "number", "boolean"].includes(typeof item))
        throw new Error();
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new RequestError(400, "Нужен JSON-объект без вложенных или повторяющихся полей.");
  }
}

export async function readFlatJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return parseFlatJson(await readJsonText(request, maxBytes));
}
