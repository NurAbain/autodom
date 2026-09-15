import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isWebVinReport, type PaymentEvent, VIN_REPORT_KINDS } from "@autodom/core/payments";
import { z } from "zod";
import { RequestError, readFlatJson } from "./http-body.js";
import { PaymentRequestError, type PaymentService } from "./payments.js";

const orderId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const checkoutBody = z.object({ orderId, acceptTerms: z.literal(true) }).strict();
const cancellationBody = z.object({ orderId }).strict();
const reportBody = z
  .object({
    vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/u),
    reportKind: z.enum(VIN_REPORT_KINDS).default("korea"),
  })
  .strict();
const eventBody = z
  .object({
    provider: z.literal("finik"),
    eventId: z.string().min(1).max(200),
    kind: z.literal("paid"),
    orderId: orderId.nullable(),
    userId: z.null(),
    currency: z.string().min(1).max(10),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    chargeId: z.string().min(1).max(200),
    occurredAt: z
      .string()
      .max(60)
      .refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export async function handlePaymentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  userId: number,
  payments: PaymentService | undefined,
): Promise<void> {
  const listing = url.pathname === "/miniapp/api/orders";
  const report = url.pathname === "/miniapp/api/orders/report";
  const download = report && request.method === "GET";
  if (!download && url.search)
    throw new RequestError(400, "Параметры заказа передаются только в теле запроса.");
  const method = listing || download ? "GET" : "POST";
  if (request.method !== method) {
    response.setHeader("Allow", report ? "GET, POST" : method);
    throw new RequestError(405, "Недопустимый метод для заказа.");
  }
  if (!payments)
    throw new RequestError(
      503,
      "Заказы временно недоступны. Бесплатные функции не требуют оплаты.",
    );
  if (listing) {
    json(response, 200, {
      orders: (await payments.ledger.listOrders(userId)).filter((order) => !isWebVinReport(order)),
      reportSalesEnabled: payments.reportSalesEnabled,
      reportPrice: payments.reportPrice,
      carfaxReportSalesEnabled: payments.carfaxReportSalesEnabled,
      carfaxReportPrice: payments.carfaxReportPrice,
    });
    return;
  }
  if (download) {
    const keys = [...url.searchParams.keys()];
    const parsed = orderId.safeParse(url.searchParams.get("orderId"));
    if (keys.length !== 1 || keys[0] !== "orderId" || !parsed.success)
      throw new RequestError(400, "Нужен только идентификатор orderId.");
    const bytes = await payments.downloadReport(userId, parsed.data);
    if (!response.destroyed) {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": bytes.byteLength,
        "Content-Disposition": 'inline; filename="vin-report.pdf"',
      });
      response.end(bytes);
    }
    return;
  }
  const raw = await readFlatJson(request, 512);
  if (report) {
    const parsed = reportBody.safeParse(raw);
    if (!parsed.success) throw new RequestError(400, "Нужны VIN и допустимый вид отчёта.");
    const order = await payments.reportOffer(
      userId,
      parsed.data.vin,
      "telegram",
      parsed.data.reportKind,
    );
    if (!response.destroyed) json(response, 200, { order });
    return;
  }
  if (url.pathname === "/miniapp/api/orders/checkout") {
    const parsed = checkoutBody.safeParse(raw);
    if (!parsed.success)
      throw new RequestError(400, "Нужны только orderId и явное подтверждение acceptTerms: true.");
    const order = await payments.checkout(userId, parsed.data.orderId, parsed.data.acceptTerms);
    if (!response.destroyed) json(response, 200, { order });
    return;
  }
  const parsed = cancellationBody.safeParse(raw);
  if (!parsed.success) throw new RequestError(400, "Нужен только идентификатор orderId.");
  if (url.pathname === "/miniapp/api/orders/payment-methods") {
    const methods = await payments.paymentMethods(userId, parsed.data.orderId);
    if (!response.destroyed) json(response, 200, methods);
    return;
  }
  if (url.pathname === "/miniapp/api/orders/card-payment") {
    const cardUrl = await payments.cardPaymentUrl(userId, parsed.data.orderId);
    if (!response.destroyed) json(response, 200, { cardUrl });
    return;
  }
  await payments.ownedOrder(userId, parsed.data.orderId);
  if (!(await payments.ledger.cancelOffer(parsed.data.orderId, userId)))
    throw new PaymentRequestError(
      409,
      "Счёт уже создан или заказ оплачен. Для отмены услуги свяжитесь с исполнителем.",
    );
  json(response, 200, { order: await payments.ownedOrder(userId, parsed.data.orderId) });
}

export interface PaymentListenerSettings {
  token: string;
  host: string;
  port: number;
}

export function loadPaymentListenerSettings(
  env: NodeJS.ProcessEnv = process.env,
): PaymentListenerSettings | undefined {
  const token = env.AUTODOM_PAYMENTS_CALLBACK_TOKEN?.trim();
  if (!token) return undefined;
  if (token.length < 32)
    throw new Error("AUTODOM_PAYMENTS_CALLBACK_TOKEN must have at least 32 characters");
  const raw = env.AUTODOM_PAYMENTS_CALLBACK_PORT ?? "8081";
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AUTODOM_PAYMENTS_CALLBACK_PORT must be a valid TCP port");
  const host = env.AUTODOM_PAYMENTS_CALLBACK_HOST?.trim() || "127.0.0.1";
  if (/[\s/?#@]/u.test(host)) throw new Error("AUTODOM_PAYMENTS_CALLBACK_HOST is invalid");
  return { token, host, port };
}

export async function startPaymentListener(
  payments: PaymentService,
  settings: PaymentListenerSettings,
): Promise<Server> {
  const expected = createHash("sha256").update(settings.token).digest();
  const server = createServer(
    { requestTimeout: 12_000, headersTimeout: 5_000 },
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      void (async () => {
        if (request.url !== "/v1/payments/finik/events") throw new RequestError(404, "Not found");
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new RequestError(405, "Method not allowed");
        }
        const supplied = request.headers.authorization ?? "";
        if (
          !supplied.startsWith("Bearer ") ||
          !timingSafeEqual(expected, createHash("sha256").update(supplied.slice(7)).digest())
        )
          throw new RequestError(401, "Unauthorized");
        const value = eventBody.safeParse(await readFlatJson(request, 8192));
        if (!value.success) throw new RequestError(400, "Invalid payment event");
        const event: PaymentEvent = value.data;
        // This commit, not a browser redirect or merely receiving an HTTP request,
        // is the acknowledgment boundary for Finik's at-least-once delivery.
        const result = await payments.ledger.ingestEvent(event);
        if (!response.destroyed) json(response, 200, { received: true, result });
      })().catch((error: unknown) => {
        if (response.destroyed || response.headersSent) return;
        if (error instanceof RequestError) json(response, error.status, { error: error.message });
        else json(response, 503, { error: "Payment event not committed; retry required" });
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
