import { createHash, randomUUID } from "node:crypto";
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
import { normalizeVin, VIN_PROVIDERS, type VinLookup } from "@autodom/core/vin";
import { VIN_ARCHIVE_PHOTO_MAX_BYTES, type VinArchivePhotoLookup } from "@autodom/core/vin-archive";
import {
  readVinArchivePhotoRequest,
  readVinRequest,
  VinRequestError,
} from "@autodom/core/vin-request";
import type { Store } from "@autodom/storage";
import { z } from "zod";
import {
  type AnalyticsEvent,
  type AnalyticsRecorder,
  NON_PURCHASE_REASONS,
  PURCHASE_REASONS,
} from "./analytics-contract.js";
import type { BotMode } from "./bot-mode.js";
import { listingText, type Reply } from "./conversation.js";
import { RequestError, readFlatJson } from "./http-body.js";
import { KOREAN_REPORT_EXAMPLE_PDF } from "./korean-report-example.js";
import { listingPhotoUrls } from "./media.js";
import { validateMiniAppData } from "./miniapp-auth.js";
import type { MiniAppCar } from "./miniapp-contract.js";
import { forwardFullMiniApp } from "./miniapp-proxy.js";
import { CARFAX_REPORT_FINIK_MINOR, VIN_REPORT_FINIK_MINOR } from "./payment-text.js";
import { PaymentRequestError, type PaymentService } from "./payments.js";
import { handlePaymentRequest } from "./payments-http.js";
import { confirmedVinReportKind, VIN_NOT_ENABLED } from "./vin-text.js";
import type { WebReportAuth } from "./web-report-auth.js";
import { handleWebReportRequest } from "./web-report-http.js";

const analyticsNonce = z.string().uuid();
const analyticsVin = z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/u);
const clientAnalyticsBody = z.union([
  z.object({ event: z.literal("miniapp_opened"), nonce: analyticsNonce }).strict(),
  z
    .object({
      event: z.enum(["report_sample_opened", "report_checkout_started"]),
      nonce: analyticsNonce,
      vin: analyticsVin,
    })
    .strict(),
  z
    .object({
      event: z.literal("report_checkout_started"),
      nonce: analyticsNonce,
      orderId: analyticsNonce,
    })
    .strict(),
  z
    .object({
      event: z.literal("feedback_submitted"),
      nonce: analyticsNonce,
      polarity: z.literal("negative"),
      reason: z.enum(NON_PURCHASE_REASONS),
      vin: analyticsVin,
    })
    .strict(),
  z
    .object({
      event: z.literal("feedback_submitted"),
      nonce: analyticsNonce,
      polarity: z.literal("positive"),
      reason: z.enum(PURCHASE_REASONS),
      orderId: analyticsNonce,
    })
    .strict(),
]);

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
  mode?: BotMode;
  reportBotUrl?: string;
  fullBotUrl?: string;
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
  getVinArchivePhoto?: VinArchivePhotoLookup;
  /** Null rejects busy-user admission without applying the reply or queueing HTTP work. */
  dialogue?: (userId: number, text: string) => Promise<Reply[] | null>;
  payments?: PaymentService;
  analytics?: AnalyticsRecorder;
  webReportAuth?: WebReportAuth;
}

export async function startMiniAppServer(options: MiniAppServerOptions): Promise<Server> {
  const mode = options.mode ?? "full";
  const reportBotUrl = mode === "full" ? options.reportBotUrl : undefined;
  const payments = reportBotUrl ? undefined : options.payments;
  const origin = new URL(options.publicUrl).origin;
  const directory = options.assetsDirectory ?? fileURLToPath(new URL("./public/", import.meta.url));
  const assets = new Map<string, { body: Buffer; type: string }>();
  // Short-lived evidence from real authenticated lookups, never browser assertions.
  // Digest keys keep VINs and Telegram identities out of this telemetry cache.
  const offers = new Map<string, { expiresAt: number; reportKind: "korea" | "carfax" | null }>();
  const offerKey = (actorId: number, vin: string) =>
    createHash("sha256").update(`${actorId}:${vin}`).digest("hex");
  const record = (event: AnalyticsEvent): void => {
    try {
      void options.analytics?.record(event).catch(() => {});
    } catch {
      // Optional telemetry cannot break the action it observes.
    }
  };
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
  if (options.webReportAuth) {
    for (const [name, type] of [
      ["index.html", "text/html; charset=utf-8"],
      ["app.js", "text/javascript; charset=utf-8"],
      ["app.css", "text/css; charset=utf-8"],
    ]) {
      assets.set(name === "index.html" ? "/reports/" : `/reports/${name}`, {
        body: await readFile(join(directory, "report-site", name!)),
        type: type!,
      });
    }
  }
  const apiRoutes = [
    "/miniapp/api/config",
    "/miniapp/api/car",
    "/miniapp/api/vin",
    "/miniapp/api/vin/archive-photo",
    "/miniapp/api/dialogue",
    "/miniapp/api/orders",
    "/miniapp/api/orders/checkout",
    "/miniapp/api/orders/cancel",
    "/miniapp/api/orders/report",
    "/miniapp/api/orders/payment-methods",
    "/miniapp/api/orders/card-payment",
    "/miniapp/api/analytics",
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
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src blob: https://images.averspay.kg https://im.mashina.kg https://pictures.mashina.kg https://storage.mashina.kg https://s3.mashina.kg https://img5.lalafo.com https://ci.encar.com https://images.bid.cars https://mercury.bid.cars https://pluto.bid.car https://listings-prod.tcimg.net https://www.dubicars.com https://cs.copart.com; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      );
      void (async () => {
        const url = new URL(request.url ?? "/", origin);
        if (
          options.fullBotUrl &&
          (url.pathname === "/full/miniapp" || url.pathname.startsWith("/full/miniapp/"))
        ) {
          await forwardFullMiniApp(
            request,
            response,
            options.fullBotUrl,
            `${url.pathname}${url.search}`,
          );
          return;
        }
        if (url.pathname === "/reports" || url.pathname.startsWith("/reports/")) {
          response.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
          );
          response.setHeader("X-Frame-Options", "DENY");
          if (
            url.pathname === "/reports" &&
            (request.method === "GET" || request.method === "HEAD")
          ) {
            response.writeHead(308, { Location: `/reports/${url.search}` }).end();
            return;
          }
          if (url.pathname.startsWith("/reports/api/")) {
            route = "/reports/api";
            if (!options.webReportAuth || !options.payments)
              throw new RequestError(503, "Сайт заказов сейчас недоступен.");
            await handleWebReportRequest(
              request,
              response,
              url,
              origin,
              options.webReportAuth,
              options.payments,
              options.checkVin,
            );
            return;
          }
        }
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
        if (url.pathname === "/miniapp/api/config") {
          if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            throw new RequestError(405, "Настройки доступны только через GET.");
          }
          respond(response, 200, {
            mode,
            analyticsEnabled: !!options.analytics,
            ...(reportBotUrl ? { reportBotUrl } : {}),
          });
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
        if (url.pathname === "/miniapp/api/analytics") {
          if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            throw new RequestError(405, "Отзывы принимаются только через POST.");
          }
          if (url.search) throw new RequestError(400, "Передайте данные только в теле запроса.");
          const parsed = clientAnalyticsBody.safeParse(await readFlatJson(request, 512));
          if (!parsed.success) throw new RequestError(400, "Недопустимое событие или причина.");
          if (!options.analytics) {
            respond(response, 200, { enabled: false });
            return;
          }
          const data = parsed.data;
          if (data.event === "miniapp_opened") {
            record({
              actorId: user.id,
              event: data.event,
              surface: "miniapp",
              flow: "navigation",
              dedupeKey: `miniapp:${data.nonce}:${data.event}`,
            });
          } else {
            let vin: string;
            let reportKind: "korea" | "carfax";
            if ("orderId" in data) {
              const order = await payments?.ownedOrder(user.id, data.orderId);
              if (
                !order ||
                order.product !== "vin_report" ||
                !order.vin ||
                normalizeVin(order.vin) !== order.vin ||
                !order.reportKind ||
                (data.event === "feedback_submitted" &&
                  (order.paymentStatus !== "paid" || !order.paidAt))
              )
                throw new RequestError(409, "Нужен ваш подтверждённый заказ отчёта.");
              vin = order.vin;
              reportKind = order.reportKind;
            } else {
              vin = data.vin;
              const evidence = offers.get(offerKey(user.id, vin));
              if (!evidence?.reportKind || evidence.expiresAt <= Date.now())
                throw new RequestError(409, "Сначала проверьте VIN и наличие отчёта.");
              reportKind = evidence.reportKind;
            }
            record({
              actorId: user.id,
              event: data.event,
              surface: "miniapp",
              flow: "report",
              contextKey: vin,
              reportKind,
              dedupeKey:
                data.event === "feedback_submitted"
                  ? `feedback:${vin}:${data.polarity}`
                  : `miniapp:${data.nonce}:${data.event}`,
              ...(data.event === "feedback_submitted"
                ? { outcome: data.polarity, reason: data.reason }
                : {}),
            });
          }
          respond(response, 200, { enabled: true });
          return;
        }
        if (
          mode === "vin" &&
          (url.pathname === "/miniapp/api/car" || url.pathname === "/miniapp/api/dialogue")
        )
          throw new RequestError(404, "В этом боте доступна только проверка VIN и отчёты.");
        if (url.pathname.startsWith("/miniapp/api/orders")) {
          if (reportBotUrl) {
            respond(response, 409, {
              error: "Заказы и оплата доступны в VIN-боте.",
              reportBotUrl,
            });
            return;
          }
          await handlePaymentRequest(request, response, url, user.id, payments);
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
                error: "Фото временно недоступно. Лот и события сохранены. Повторите проверку VIN.",
              });
            }
          } finally {
            response.off("close", onClose);
          }
          return;
        }
        if (url.pathname === "/miniapp/api/vin") {
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
          const attempt = randomUUID();
          const evidenceKey = options.analytics ? offerKey(user.id, vin) : undefined;
          const evidence = {
            expiresAt: Date.now() + 15 * 60 * 1000,
            reportKind: null as "korea" | "carfax" | null,
          };
          if (evidenceKey) {
            for (const [key, value] of offers) {
              if (value.expiresAt <= Date.now()) offers.delete(key);
            }
            offers.delete(evidenceKey);
            if (offers.size >= 1000) offers.delete(offers.keys().next().value!);
            offers.set(evidenceKey, evidence);
          }
          const reportRevision = payments?.forgetVinResult(user.id, vin);
          const lookup = options.checkVin;
          if (!lookup) {
            respond(response, 503, { code: "vin_not_enabled", error: VIN_NOT_ENABLED });
            return;
          }
          record({
            actorId: user.id,
            event: "vin_submitted",
            surface: "miniapp",
            flow: "report",
            contextKey: vin,
            dedupeKey: `miniapp:${attempt}:vin_submitted`,
          });
          const controller = new AbortController();
          const onClose = () => controller.abort();
          response.once("close", onClose);
          if (response.destroyed) controller.abort();
          try {
            const result = await lookup(vin, controller.signal);
            if (result.vin !== vin) throw new Error("VIN result does not match the request");
            if (reportRevision !== undefined)
              payments?.rememberVinResult(user.id, result, reportRevision);
            const reportKind = confirmedVinReportKind(result);
            if (evidenceKey && offers.get(evidenceKey) === evidence)
              evidence.reportKind = reportKind;
            const statuses = VIN_PROVIDERS.map((provider) => result[provider]?.status);
            const archiveSources = result.archives?.sources ?? [];
            for (const source of archiveSources) {
              if (source.status === "disabled") continue;
              if (source.lots.length) statuses.push("available");
              if (source.status !== "no_photos") statuses.push(source.status);
            }
            const found = statuses.includes("available");
            const unavailable = statuses.includes("unavailable");
            record({
              actorId: user.id,
              event: "vin_completed",
              surface: "miniapp",
              flow: "report",
              contextKey: vin,
              dedupeKey: `miniapp:${attempt}:vin_completed`,
              outcome: found
                ? unavailable || archiveSources.some((source) => source.partial)
                  ? "partial"
                  : "available"
                : unavailable
                  ? "unavailable"
                  : "not_found",
            });
            if (!response.destroyed && reportKind)
              record({
                actorId: user.id,
                event: "report_offered",
                surface: "miniapp",
                flow: "report",
                contextKey: vin,
                reportKind,
                outcome: "available",
                dedupeKey: `report_offer:${vin}:${reportKind}`,
              });
            if (!response.destroyed)
              respond(response, 200, {
                ...result,
                reportSalesEnabled:
                  reportKind === "carfax"
                    ? (payments?.carfaxReportSalesEnabled ?? false)
                    : reportKind === "korea" && (payments?.reportSalesEnabled ?? false),
                reportPrice:
                  reportKind === "carfax"
                    ? { amount: CARFAX_REPORT_FINIK_MINOR, currency: "KGS" }
                    : reportKind === "korea"
                      ? (payments?.reportPrice ??
                        (reportBotUrl ? { amount: VIN_REPORT_FINIK_MINOR, currency: "KGS" } : null))
                      : null,
                reportKind,
              });
          } catch {
            record({
              actorId: user.id,
              event: "vin_completed",
              surface: "miniapp",
              flow: "report",
              contextKey: vin,
              dedupeKey: `miniapp:${attempt}:vin_completed`,
              outcome: "error",
            });
            if (!response.destroyed) {
              options.onError?.(new Error("VIN API request failed"));
              respond(response, 503, {
                code: "vin_unavailable",
                error:
                  "Проверка VIN временно недоступна. Результат неизвестен; это не отсутствие записей. Повторите позже.",
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
        record({
          actorId: user.id,
          event: "listing_opened",
          surface: "miniapp",
          flow: "buyer",
          outcome: "success",
          dedupeKey: `miniapp:${randomUUID()}:listing_opened`,
        });
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
