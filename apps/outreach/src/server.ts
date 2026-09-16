import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import {
  campaignSchema,
  filterSchema,
  type Messenger,
  type OutreachSource,
  ServiceError,
  type SourceStatus,
  sourceSchema,
} from "./contracts.js";
import { OutreachService } from "./service.js";

export interface ServerOptions {
  host: string;
  port: number;
  origin: string;
  username: string;
  password: string;
  pool: pg.Pool;
  messengers: ReadonlyMap<OutreachSource, Messenger>;
  sendEnabled: boolean;
}
const imageSchema = z
  .object({
    mime: z.enum(["image/jpeg", "image/png"]),
    data: z
      .string()
      .min(4)
      .max(7_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
const suppressSchema = z
  .object({
    source: sourceSchema,
    recipientId: z.string().min(1).max(512),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

async function jsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json")
    throw new ServiceError(415, "Требуется application/json");
  if (Number(request.headers["content-length"] ?? 0) > limit)
    throw new ServiceError(413, "Слишком большой запрос");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > limit) throw new ServiceError(413, "Слишком большой запрос");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError(400, "Некорректный JSON");
  }
}

export async function startOutreachServer(
  options: ServerOptions,
): Promise<{ server: Server; close: () => Promise<void> }> {
  if (
    !options.username ||
    /[:\r\n]/.test(options.username) ||
    options.password.length < 32 ||
    /[\r\n]/.test(options.password)
  )
    throw new Error("Configure a nonempty admin username and a 32+ character admin password");
  const origin = new URL(options.origin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== options.origin ||
    origin.username ||
    origin.password
  )
    throw new Error("Configure an exact HTTP(S) admin origin without path");
  const authHash = createHash("sha256")
    .update(`Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`)
    .digest();
  const assets = new Map<string, { mime: string; bytes: Buffer }>();
  for (const [path, file, mime] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ]) {
    assets.set(path!, {
      mime: mime!,
      bytes: await readFile(fileURLToPath(new URL(`../web/${file}`, import.meta.url))),
    });
  }
  const service = new OutreachService(options.pool, options.messengers, options.sendEnabled);
  await service.init();
  let statuses: { expires: number; promise: Promise<SourceStatus[]> } | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activeTick: Promise<void> | undefined;
  const runTick = () => {
    activeTick = service
      .tick()
      .catch(() => {
        console.error("Outreach queue unavailable; no automatic delivery retry.");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(runTick, 1000);
      });
  };
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      void (async () => {
        const path = new URL(request.url ?? "/", options.origin).pathname;
        const method = request.method;
        if ((method === "GET" || method === "HEAD") && path === "/health") {
          await options.pool.query("SELECT 1");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ healthy: !stopped, service: "autodom-outreach" }));
          return;
        }
        const supplied = createHash("sha256")
          .update(request.headers.authorization ?? "")
          .digest();
        if (!timingSafeEqual(authHash, supplied)) {
          response.setHeader("WWW-Authenticate", 'Basic realm="Autodom outreach", charset="UTF-8"');
          throw new ServiceError(401, "Требуется вход администратора");
        }
        if (method !== "GET" && method !== "HEAD" && method !== "POST")
          throw new ServiceError(405, "Метод не поддерживается");
        if (method === "POST" && request.headers.origin !== options.origin)
          throw new ServiceError(403, "Недопустимый источник запроса");
        const asset = assets.get(path);
        if (asset && (method === "GET" || method === "HEAD")) {
          response.setHeader("Content-Type", asset.mime);
          response.end(asset.bytes);
          return;
        }
        let result: unknown;
        if (method === "GET" && path === "/api/status") {
          if (!statuses || statuses.expires <= Date.now())
            statuses = {
              expires: Date.now() + 60_000,
              promise: Promise.all(
                sourceSchema.options.map(async (source) => {
                  const messenger = options.messengers.get(source);
                  if (!messenger)
                    return {
                      source,
                      ready: false,
                      message:
                        source === "lalafo.kg"
                          ? "Укажите приватный файл сессии Lalafo (login-lalafo) и проверьте доступ."
                          : "Укажите приватный файл сессии Mashina и проверьте доступ.",
                    };
                  try {
                    return await messenger.check();
                  } catch {
                    return { source, ready: false, message: "Не удалось проверить подключение." };
                  }
                }),
              ),
            };
          result = { sendEnabled: options.sendEnabled, sources: await statuses.promise };
        } else if (path === "/api/preview" && method === "POST") {
          result = await service.preview(filterSchema.parse(await jsonBody(request, 16_384)));
        } else if (path === "/api/campaigns" && method === "POST") {
          result = {
            campaign: await service.create(campaignSchema.parse(await jsonBody(request, 32_768))),
          };
        } else if (path === "/api/campaigns" && method === "GET") {
          result = { campaigns: await service.list() };
        } else if (path === "/api/images" && method === "POST") {
          const data = imageSchema.parse(await jsonBody(request, 7_100_000));
          result = { id: await service.putImage(data.mime, Buffer.from(data.data, "base64")) };
        } else if (path === "/api/suppress" && method === "POST") {
          const data = suppressSchema.parse(await jsonBody(request, 4096));
          await service.suppress(data.source, data.recipientId, data.reason);
          result = { ok: true };
        } else {
          const detail = /^\/api\/campaigns\/([0-9a-f-]{36})$/.exec(path);
          const action = /^\/api\/campaigns\/([0-9a-f-]{36})\/(start|pause|cancel)$/.exec(path);
          const image = /^\/api\/images\/([0-9a-f-]{36})$/.exec(path);
          if (detail && method === "GET") result = await service.detail(detail[1]!);
          else if (action && method === "POST") {
            const body = z
              .object({ confirmed: z.boolean().default(false) })
              .strict()
              .parse(await jsonBody(request, 1024));
            result = {
              campaign: await service.action(
                action[1]!,
                action[2] as "start" | "pause" | "cancel",
                body.confirmed,
              ),
            };
            statuses = undefined;
          } else if (image && (method === "GET" || method === "HEAD")) {
            const stored = await service.getImage(image[1]!);
            if (!stored) throw new ServiceError(404, "Фото не найдено");
            response.setHeader("Content-Type", stored.mime);
            response.end(stored.bytes);
            return;
          } else throw new ServiceError(404, "Страница не найдена");
        }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(result));
      })().catch((error) => {
        if (response.headersSent || response.destroyed) {
          response.destroy();
          return;
        }
        response.statusCode =
          error instanceof ServiceError ? error.status : error instanceof z.ZodError ? 400 : 503;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({
            error:
              error instanceof ServiceError
                ? error.message
                : error instanceof z.ZodError
                  ? "Проверьте поля формы и диапазоны значений"
                  : "Сервис временно недоступен. Проверьте подключение к БД.",
          }),
        );
        request.resume();
      });
    },
  );
  const started = Promise.withResolvers<void>();
  server.once("error", started.reject);
  server.listen(options.port, options.host, started.resolve);
  await started.promise;
  server.off("error", started.reject);
  runTick();
  return {
    server,
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeIdleConnections();
      await Promise.all([closed.promise, activeTick]);
    },
  };
}
