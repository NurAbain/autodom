import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvedSources,
  type Listing,
  listingPrice,
  listingUrlAllowed,
  MARKETS,
  money,
  normalize,
  purchaseEligible,
} from "@autodom/core";
import type { Store } from "@autodom/storage";
import { type Api, GrammyError } from "grammy";
import type { InlineQueryResult } from "grammy/types";
import { type Conversation, listingText, type Reply } from "./conversation.js";
import { listingPhotoUrl } from "./media.js";
import { type MiniAppUser, validateMiniAppData } from "./miniapp-auth.js";
import type { MiniAppCar, MiniAppCars, MiniAppSession } from "./miniapp-contract.js";

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
    throw new RequestError(415, "Ожидается JSON.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) {
      request.resume();
      throw new RequestError(413, "Запрос слишком большой.");
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Return the same bounded response for malformed JSON and non-object bodies.
  }
  throw new RequestError(400, "Некорректный запрос.");
}

function carView(listing: Listing, currency: string): MiniAppCar {
  const price = listingPrice(listing, currency);
  const original = listing.original_price_minor;
  let priceText = price === null ? "Цена для сравнения недоступна" : money(price, currency);
  if (original !== null && ["USD", "KGS", "KRW"].includes(listing.original_currency)) {
    priceText = money(original, listing.original_currency);
    if (listing.original_currency !== currency && price !== null)
      priceText += ` (≈ ${money(price, currency)})`;
  }
  if (listing.price_kind === "buy_now") priceText = `Buy Now: ${priceText}`;
  return {
    id: listing.id,
    title: listing.title.slice(0, 140),
    url: listingUrlAllowed(listing.source, listing.url) ? listing.url : null,
    photoUrl: listingPhotoUrl(listing),
    price: priceText,
    year: listing.year,
    mileage: listing.mileage.slice(0, 80),
    transmission: listing.transmission.slice(0, 80),
    bodyType: listing.body_type.slice(0, 80),
    city: listing.city.slice(0, 80),
    market: MARKETS[listing.market as keyof typeof MARKETS] ?? listing.market,
    source: listing.source,
    observedAt: listing.observed_at,
    detailsHtml: listingText(listing, currency),
  };
}

export interface MiniAppServerOptions {
  store: Store;
  conversation: Conversation;
  api: Api;
  token: string;
  publicUrl: string;
  port: number;
  host: string;
  assetsDirectory?: string;
  ready: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export async function startMiniAppServer(options: MiniAppServerOptions) {
  const { store, conversation, api, token } = options;
  const origin = new URL(options.publicUrl).origin;
  const directory = options.assetsDirectory ?? fileURLToPath(new URL("./public/", import.meta.url));
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [name, type] of [
    ["index.html", "text/html; charset=utf-8"],
    ["app.js", "text/javascript; charset=utf-8"],
    ["app.css", "text/css; charset=utf-8"],
  ] as const) {
    assets.set(name === "index.html" ? "/miniapp/" : `/miniapp/${name}`, {
      body: await readFile(join(directory, name)),
      type,
    });
  }

  async function session(user: MiniAppUser, replies?: Reply[]): Promise<MiniAppSession> {
    const current = replies ?? (await conversation.current(user.id));
    const profile = await store.getProfile(user.id);
    const draft = await store.getDraft(user.id);
    return { user, profile, draftState: draft?.[0] ?? null, replies: current };
  }

  async function availableCar(id: unknown): Promise<Listing> {
    if (typeof id !== "string" || !id || id.length > 200 || /[\p{Cc}]/u.test(id))
      throw new RequestError(400, "Некорректный идентификатор автомобиля.");
    const listing = await store.getListing(id, true);
    const availability = listing ? normalize(listing.availability) : "";
    if (
      !listing ||
      !approvedSources().includes(listing.source) ||
      !purchaseEligible(listing) ||
      (availability !== "в наличии" &&
        !(listing.market !== "KG" && availability === "опубликовано"))
    )
      throw new RequestError(404, "Объявление недоступно, устарело или источник выключен.");
    return listing;
  }

  function respond(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src https:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      );
      void (async () => {
        const url = new URL(request.url ?? "/", origin);
        if (request.method === "GET" && url.pathname === "/health") {
          respond(response, 200, { healthy: true });
          return;
        }
        if (request.method === "GET" && url.pathname === "/ready") {
          const ready = await options.ready();
          respond(response, ready ? 200 : 503, { ready });
          return;
        }
        if (
          (request.method === "GET" || request.method === "HEAD") &&
          url.pathname === "/miniapp"
        ) {
          response.writeHead(308, { Location: `/miniapp/${url.search}` });
          response.end();
          return;
        }
        const asset = assets.get(url.pathname);
        if (asset && (request.method === "GET" || request.method === "HEAD")) {
          response.writeHead(200, {
            "Content-Type": asset.type,
            "Content-Length": asset.body.length,
          });
          response.end(request.method === "HEAD" ? undefined : asset.body);
          return;
        }
        if (!url.pathname.startsWith("/miniapp/api/"))
          throw new RequestError(404, "Страница не найдена.");
        if (
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site"
        )
          throw new RequestError(403, "Откройте приложение в Telegram.");
        const authorization = request.headers.authorization ?? "";
        const user = authorization.startsWith("tma ")
          ? validateMiniAppData(authorization.slice(4), token)
          : null;
        if (!user)
          throw new RequestError(
            401,
            "Сессия истекла. Закройте и заново откройте Mini App в Telegram.",
          );
        if (request.method !== "GET" && request.method !== "POST")
          throw new RequestError(405, "Метод не поддерживается.");
        const body = request.method === "POST" ? await jsonBody(request) : null;
        // Bot updates and Mini App requests share the same cross-process user lock.
        const result = await store.withLock(`autodom:user:${user.id}`, async () => {
          if (url.pathname === "/miniapp/api/session" && request.method === "GET")
            return session(user);
          if (url.pathname === "/miniapp/api/action" && body) {
            if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 4096)
              throw new RequestError(400, "Введите значение или выберите действие.");
            return session(user, await conversation.handle(user.id, user.id, body.input));
          }
          const profile = await store.getProfile(user.id);
          if (!profile)
            throw new RequestError(409, "Сначала подтвердите согласие и сохраните поиск.");
          if (url.pathname === "/miniapp/api/cars" && request.method === "GET") {
            const rawOffset = url.searchParams.get("offset") ?? "0";
            if (!/^\d{1,7}$/u.test(rawOffset) || Number(rawOffset) > 1_000_000)
              throw new RequestError(400, "Некорректная страница каталога.");
            const offset = Number(rawOffset);
            const revision = url.searchParams.get("revision");
            if ((revision !== null && revision !== profile.revision) || (offset > 0 && !revision))
              throw new RequestError(409, "Поиск изменился. Обновите каталог.");
            return store.transaction(async (): Promise<MiniAppCars> => {
              const total = await store.countMatches(profile);
              const listings = await store.search(profile, 12, offset);
              return {
                cars: listings.map((listing) => carView(listing, profile.currency)),
                total,
                offset,
                nextOffset:
                  listings.length && offset + listings.length < total
                    ? offset + listings.length
                    : null,
                revision: profile.revision,
              };
            }, "snapshot");
          }
          if (url.pathname === "/miniapp/api/car" && request.method === "GET")
            return carView(await availableCar(url.searchParams.get("id")), profile.currency);
          if (url.pathname === "/miniapp/api/share" && body) {
            const listing = await availableCar(body.id);
            if (!listingUrlAllowed(listing.source, listing.url))
              throw new RequestError(404, "Ссылка на объявление недоступна.");
            // Deliberately independent of the user's private profile and budget.
            const text = listingText(listing, "USD");
            const photo = listingPhotoUrl(listing);
            const id = createHash("sha256").update(listing.id).digest("hex");
            const article: InlineQueryResult = {
              type: "article",
              id,
              title: listing.title.slice(0, 140),
              url: listing.url,
              ...(photo ? { thumbnail_url: photo } : {}),
              input_message_content: {
                message_text: text,
                parse_mode: "HTML",
                link_preview_options: photo
                  ? { url: photo, prefer_large_media: true, show_above_text: true }
                  : { is_disabled: true },
              },
            };
            const result: InlineQueryResult =
              photo && /\.jpe?g$/iu.test(new URL(photo).pathname) && text.length <= 1024
                ? {
                    type: "photo",
                    id,
                    photo_url: photo,
                    thumbnail_url: photo,
                    caption: text,
                    parse_mode: "HTML",
                    reply_markup: {
                      inline_keyboard: [[{ text: "Объявление у источника", url: listing.url }]],
                    },
                  }
                : article;
            const prepared = await api.savePreparedInlineMessage(user.id, result, {
              allow_user_chats: true,
              allow_group_chats: true,
              allow_channel_chats: true,
            });
            return { id: prepared.id, expiresAt: prepared.expiration_date };
          }
          throw new RequestError(404, "Действие не найдено.");
        });
        respond(response, 200, result);
      })().catch((error: unknown) => {
        if (response.destroyed || response.headersSent) return;
        if (error instanceof RequestError)
          respond(response, error.status, { error: error.message });
        else if (error instanceof GrammyError && error.error_code === 429) {
          const seconds = error.parameters.retry_after ?? 30;
          response.setHeader("Retry-After", String(seconds));
          respond(response, 429, {
            error: `Telegram просит подождать ${seconds} сек. перед повторной отправкой.`,
          });
        } else {
          options.onError?.(error);
          respond(response, 503, { error: "Сервис временно недоступен. Попробуйте ещё раз." });
        }
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
