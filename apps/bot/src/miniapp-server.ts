import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvedSources,
  type Listing,
  listingPrice,
  listingUrlAllowed,
  MARKETS,
  money,
} from "@autodom/core";
import type { VinLookup } from "@autodom/core/vin";
import {
  disabledVinArchiveResult,
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  type VinArchiveLookup,
  type VinArchivePhotoLookup,
} from "@autodom/core/vin-archive";
import {
  readVinArchivePhotoRequest,
  readVinRequest,
  VinRequestError,
} from "@autodom/core/vin-request";
import type { Store } from "@autodom/storage";
import { listingText, type Reply } from "./conversation.js";
import { RequestError, readFlatJson } from "./http-body.js";
import { KOREAN_REPORT_EXAMPLE_PDF } from "./korean-report-example.js";
import { listingPhotoUrls } from "./media.js";
import { validateMiniAppData } from "./miniapp-auth.js";
import type { MiniAppCar } from "./miniapp-contract.js";
import { PaymentRequestError, type PaymentService } from "./payments.js";
import { handlePaymentRequest } from "./payments-http.js";
import { VIN_NOT_ENABLED } from "./vin-text.js";

async function readDialogueRequest(request: IncomingMessage): Promise<string> {
  const value = await readFlatJson(request, 8192);
  if (
    Object.keys(value).length !== 1 ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 2048 ||
    /[[\p{Cc}&&\p{ASCII}]--[\t\n\r]]/v.test(value.text)
  )
    throw new RequestError(400, "Нужен один непустой ответ text, не длиннее 2048 символов.");
  return value.text.trim();
}

function carView(listing: Listing, currency: string): MiniAppCar {
  const price = listingPrice(listing, currency);
  let priceText = price === null ? "Цена для сравнения недоступна" : money(price, currency);
  if (
    listing.original_price_minor !== null &&
    ["USD", "KGS", "KRW", "AED"].includes(listing.original_currency)
  ) {
    priceText = money(listing.original_price_minor, listing.original_currency);
    if (listing.original_currency !== currency && price !== null)
      priceText += ` (≈ ${money(price, currency)})`;
  }
  if (listing.price_kind === "buy_now") priceText = `Buy Now: ${priceText}`;
  return {
    id: listing.id,
    title: listing.title,
    url: listingUrlAllowed(listing.source, listing.url) ? listing.url : null,
    photoUrls: listingPhotoUrls(listing),
    price: priceText,
    year: listing.year,
    mileage: listing.mileage,
    transmission: listing.transmission,
    bodyType: listing.body_type,
    city: listing.city,
    market: MARKETS[listing.market as keyof typeof MARKETS] ?? listing.market,
    source: listing.source,
    observedAt: listing.observed_at,
    availability: listing.availability,
    detailsHtml: listingText(listing, currency),
    vin: listing.vin || null,
  };
}

export interface MiniAppServerOptions {
  store: Pick<Store, "getProfile" | "getListing">;
  token: string;
  publicUrl: string;
  host: string;
  port: number;
  assetsDirectory?: string;
  ready: () => Promise<boolean>;
  onError?: (error: unknown) => void;
  onRequest?: (observation: {
    route: string;
    method: "GET" | "POST" | "other";
    status: number | "aborted";
    durationSeconds: number;
  }) => void;
  checkVin?: VinLookup;
  checkVinArchive?: VinArchiveLookup;
  getVinArchivePhoto?: VinArchivePhotoLookup;
  /** Null rejects busy-user admission without applying the reply or queueing HTTP work. */
  dialogue?: (userId: number, text: string) => Promise<Reply[] | null>;
  payments?: PaymentService;
}

export async function startMiniAppServer(options: MiniAppServerOptions): Promise<Server> {
  const origin = new URL(options.publicUrl).origin;
  const directory = options.assetsDirectory ?? fileURLToPath(new URL("./public/", import.meta.url));
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [name, type] of [
    ["index.html", "text/html; charset=utf-8"],
    ["app.js", "text/javascript; charset=utf-8"],
    ["app.css", "text/css; charset=utf-8"],
    [`reports/${KOREAN_REPORT_EXAMPLE_PDF.filename}`, "application/pdf"],
  ] as const) {
    assets.set(name === "index.html" ? "/miniapp/" : `/miniapp/${name}`, {
      body: await readFile(join(directory, name)),
      type,
    });
  }
  const apiRoutes = [
    "/miniapp/api/car",
    "/miniapp/api/vin",
    "/miniapp/api/vin/archive-photos",
    "/miniapp/api/vin/archive-photo",
    "/miniapp/api/dialogue",
    "/miniapp/api/orders",
    "/miniapp/api/orders/checkout",
    "/miniapp/api/orders/cancel",
    "/miniapp/api/orders/report",
  ];

  function respond(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      let route = "unmatched";
      if (options.onRequest) {
        const started = performance.now();
        let observed = false;
        const observe = (status: number | "aborted") => {
          if (observed) return;
          observed = true;
          response.off("finish", onFinish);
          response.off("close", onClose);
          request.off("aborted", onAbort);
          try {
            options.onRequest?.({
              route,
              method:
                request.method === "GET" || request.method === "POST" ? request.method : "other",
              status,
              durationSeconds: (performance.now() - started) / 1000,
            });
          } catch {
            // An optional observer must never change HTTP delivery or error handling.
          }
        };
        const onFinish = () => observe(response.statusCode);
        const onClose = () => observe(response.writableFinished ? response.statusCode : "aborted");
        const onAbort = () => observe("aborted");
        response.once("finish", onFinish);
        response.once("close", onClose);
        request.once("aborted", onAbort);
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src blob: https://im.mashina.kg https://pictures.mashina.kg https://storage.mashina.kg https://s3.mashina.kg https://img5.lalafo.com https://ci.encar.com https://images.bid.cars https://mercury.bid.cars https://pluto.bid.car https://listings-prod.tcimg.net https://www.dubicars.com https://cs.copart.com; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      );
      void (async () => {
        const url = new URL(request.url ?? "/", origin);
        route =
          url.pathname === "/health" ||
          url.pathname === "/ready" ||
          url.pathname === "/miniapp" ||
          assets.has(url.pathname) ||
          apiRoutes.includes(url.pathname)
            ? url.pathname
            : "unmatched";
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
          if (asset.type === "application/pdf")
            response.setHeader(
              "Content-Disposition",
              `inline; filename="${KOREAN_REPORT_EXAMPLE_PDF.filename}"`,
            );
          response.writeHead(200, {
            "Content-Type": asset.type,
            "Content-Length": asset.body.length,
          });
          response.end(request.method === "HEAD" ? undefined : asset.body);
          return;
        }
        if (!apiRoutes.includes(url.pathname)) throw new RequestError(404, "Страница не найдена.");
        if (
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site"
        )
          throw new RequestError(403, "Откройте карточку из личного чата в Telegram.");
        const authorization = request.headers.authorization ?? "";
        const user = authorization.startsWith("tma ")
          ? validateMiniAppData(authorization.slice(4), options.token)
          : null;
        if (!user)
          throw new RequestError(
            401,
            "Сессия истекла. Закройте карточку и откройте её заново в Telegram.",
          );
        if (url.pathname.startsWith("/miniapp/api/orders")) {
          await handlePaymentRequest(request, response, url, user.id, options.payments);
          return;
        }
        if (url.pathname === "/miniapp/api/dialogue") {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            throw new RequestError(405, "Ответы принимаются только через POST.");
          }
          if (url.search) throw new RequestError(400, "Передайте ответ только в теле запроса.");
          const text = await readDialogueRequest(request);
          if (!options.dialogue)
            throw new RequestError(503, "Диалог недоступен. Откройте личный чат с ботом.");
          const replies = await options.dialogue(user.id, text);
          if (replies === null)
            throw new RequestError(429, "Предыдущий ответ ещё обрабатывается. Повторите позже.");
          if (!response.destroyed) respond(response, 200, { replies });
          return;
        }
        if (url.pathname === "/miniapp/api/vin/archive-photo") {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            throw new VinRequestError(
              405,
              "method_not_allowed",
              "Фото доступно только через POST.",
            );
          }
          if (url.search)
            throw new VinRequestError(
              400,
              "invalid_request",
              "Передайте запрос фото только в теле.",
            );
          const photoRequest = await readVinArchivePhotoRequest(request);
          const controller = new AbortController();
          const onClose = () => controller.abort();
          response.once("close", onClose);
          if (response.destroyed) controller.abort();
          try {
            if (!options.getVinArchivePhoto) throw new Error("Archive photos not enabled");
            const photo = await options.getVinArchivePhoto(photoRequest, controller.signal);
            if (
              !["image/jpeg", "image/png", "image/webp"].includes(photo.content_type) ||
              photo.bytes.byteLength === 0 ||
              photo.bytes.byteLength > VIN_ARCHIVE_PHOTO_MAX_BYTES
            )
              throw new Error("Invalid archive photo");
            if (!response.destroyed) {
              response.writeHead(200, {
                "Content-Type": photo.content_type,
                "Content-Length": photo.bytes.byteLength,
              });
              response.end(photo.bytes);
            }
          } catch {
            if (!response.destroyed) {
              options.onError?.(new Error("VIN archive photo API request failed"));
              respond(response, 503, {
                code: "vin_archive_photo_unavailable",
                error:
                  "Фото временно недоступно. Лот и события сохранены. Повторите поиск архивных фото.",
              });
            }
          } finally {
            response.off("close", onClose);
          }
          return;
        }
        if (
          url.pathname === "/miniapp/api/vin" ||
          url.pathname === "/miniapp/api/vin/archive-photos"
        ) {
          const archive = url.pathname === "/miniapp/api/vin/archive-photos";
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            throw new VinRequestError(
              405,
              "method_not_allowed",
              "Проверка VIN доступна только через POST.",
            );
          }
          if (url.search)
            throw new VinRequestError(
              400,
              "invalid_request",
              "Передайте один VIN только в теле запроса.",
            );
          const vin = await readVinRequest(request);
          const reportRevision = archive
            ? undefined
            : options.payments?.forgetVinResult(user.id, vin);
          if (archive && !options.checkVinArchive) {
            respond(response, 200, disabledVinArchiveResult(vin));
            return;
          }
          const lookup = archive ? options.checkVinArchive : options.checkVin;
          if (!lookup) {
            respond(response, 503, { code: "vin_not_enabled", error: VIN_NOT_ENABLED });
            return;
          }
          const controller = new AbortController();
          const onClose = () => controller.abort();
          response.once("close", onClose);
          if (response.destroyed) controller.abort();
          try {
            const result = await lookup(vin, controller.signal);
            if (result.vin !== vin) throw new Error("VIN result does not match the request");
            if (reportRevision !== undefined && "carhistory" in result)
              options.payments?.rememberVinResult(user.id, result, reportRevision);
            if (!response.destroyed)
              respond(
                response,
                200,
                archive
                  ? result
                  : {
                      ...result,
                      reportSalesEnabled: options.payments?.reportSalesEnabled ?? false,
                    },
              );
          } catch {
            if (!response.destroyed) {
              options.onError?.(
                new Error(archive ? "VIN archive API request failed" : "VIN API request failed"),
              );
              respond(response, 503, {
                code: archive ? "vin_archive_unavailable" : "vin_unavailable",
                error: archive
                  ? "Поиск архивных фото временно недоступен. Результат неизвестен; это не отсутствие истории. Повторите позже."
                  : "Проверка VIN временно недоступна. Результат неизвестен; это не отсутствие записей. Повторите позже.",
              });
            }
          } finally {
            response.off("close", onClose);
          }
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          throw new RequestError(405, "Карточка доступна только для чтения.");
        }
        const profile = await options.store.getProfile(user.id);
        if (!profile || profile.user_id !== user.id || profile.chat_id !== user.id)
          throw new RequestError(403, "Сначала сохраните поиск в личном чате с ботом.");
        const id = url.searchParams.get("id");
        if (
          !id ||
          id.length > 200 ||
          /[\p{Cc}]/u.test(id) ||
          url.searchParams.getAll("id").length !== 1
        )
          throw new RequestError(400, "Откройте карточку конкретного автомобиля из чата.");
        // A notification remains useful after filters change. Only freshness and source access
        // gate details; this route never searches or mutates the user's saved profile.
        const listing = await options.store.getListing(id, true);
        if (!listing || !approvedSources().includes(listing.source))
          throw new RequestError(
            404,
            "Объявление недоступно, устарело или источник выключен. Вернитесь в чат за свежими вариантами.",
          );
        respond(response, 200, carView(listing, profile.currency));
      })().catch((error: unknown) => {
        if (response.destroyed || response.headersSent) return;
        if (error instanceof VinRequestError)
          respond(response, error.status, { code: error.code, error: error.message });
        else if (error instanceof RequestError || error instanceof PaymentRequestError)
          respond(response, error.status, { error: error.message });
        else {
          options.onError?.(error);
          respond(response, 503, {
            error: "Сервис временно недоступен. Попробуйте открыть карточку позже.",
          });
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
