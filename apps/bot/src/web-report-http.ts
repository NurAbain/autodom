import type { IncomingMessage, ServerResponse } from "node:http";
import { isWebVinReport } from "@autodom/core/payments";
import { normalizeVin, type VinLookup } from "@autodom/core/vin";
import { z } from "zod";
import { RequestError, readFlatJson } from "./http-body.js";
import { VIN_REPORT_FINIK_MINOR, VIN_REPORT_WEB_TERMS } from "./payment-text.js";
import { type PaymentService, requirePaymentOrderId } from "./payments.js";
import { confirmedVinReportKind } from "./vin-text.js";
import type { WebReportAuth } from "./web-report-auth.js";

const empty = z.object({}).strict();
const vinBody = z.object({ vin: z.string().max(80) }).strict();
const orderBody = z.object({ orderId: z.string().uuid() }).strict();
const checkoutBody = orderBody.extend({ acceptTerms: z.literal(true) }).strict();
const codeBody = z.object({ code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/u) }).strict();
const supportBody = z.object({ message: z.string().trim().min(1).max(2500) }).strict();
const routes = new Map([
  ["/reports/api/session", "GET"],
  ["/reports/api/login", "POST"],
  ["/reports/api/login/confirm", "POST"],
  ["/reports/api/logout", "POST"],
  ["/reports/api/vin", "POST"],
  ["/reports/api/orders", "GET"],
  ["/reports/api/orders/report", "GET, POST"],
  ["/reports/api/orders/checkout", "POST"],
  ["/reports/api/orders/cancel", "POST"],
  ["/reports/api/support", "POST"],
]);

export async function handleWebReportRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  auth: WebReportAuth,
  payments: PaymentService,
  checkVin?: VinLookup,
): Promise<void> {
  const method = routes.get(url.pathname);
  if (!method) throw new RequestError(404, "Страница не найдена.");
  if (!method.split(", ").includes(request.method ?? "")) {
    response.setHeader("Allow", method);
    throw new RequestError(405, "Недопустимый метод.");
  }
  if (
    (request.method === "POST" && request.headers.origin !== origin) ||
    (request.headers.origin && request.headers.origin !== origin) ||
    request.headers["sec-fetch-site"] === "cross-site"
  )
    throw new RequestError(403, "Откройте заказ на сайте Autodom в исходном браузере.");
  const download = url.pathname === "/reports/api/orders/report" && request.method === "GET";
  if (url.search && !download)
    throw new RequestError(400, "Параметры передаются только в теле запроса.");
  const secure = origin.startsWith("https:");
  const prefix = secure ? "__Secure-" : "";
  const sessionName = `${prefix}autodom_report_session`;
  const loginName = `${prefix}autodom_report_login`;
  const cookies = new Map(
    (request.headers.cookie ?? "").split(";").map((item) => {
      const [name, ...value] = item.trim().split("=");
      return [name!, value.join("=")];
    }),
  );
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/reports; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const json = (value: unknown) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  const raw = request.method === "POST" ? await readFlatJson(request, 12_000) : undefined;
  const parse = <T>(schema: z.ZodType<T>): T => {
    const value = schema.safeParse(raw);
    if (!value.success) throw new RequestError(400, "Некорректные параметры запроса.");
    return value.data;
  };
  if (url.pathname === "/reports/api/login") {
    parse(empty);
    const login = auth.beginLogin();
    response.setHeader(
      "Set-Cookie",
      cookie(loginName, `${login.loginId}.${login.loginSecret}`, 600),
    );
    json({ loginUrl: login.loginUrl, expiresAt: login.expiresAt });
    return;
  }
  if (url.pathname === "/reports/api/login/confirm") {
    const { code } = parse(codeBody);
    const challenge = /^([0-9a-f]{32})\.([0-9a-f]{64})$/u.exec(cookies.get(loginName) ?? "");
    if (!challenge) throw new RequestError(401, "Начните вход в этом браузере заново.");
    const login = await auth.completeLogin(challenge[1]!, challenge[2]!, code);
    await auth.logout(cookies.get(sessionName) ?? "");
    response.setHeader("Set-Cookie", [
      cookie(sessionName, login.sessionToken, 30 * 24 * 60 * 60),
      cookie(loginName, "", 0),
    ]);
    json({ authenticated: true });
    return;
  }
  if (url.pathname === "/reports/api/logout") {
    parse(empty);
    await auth.logout(cookies.get(sessionName) ?? "");
    response.setHeader("Set-Cookie", [cookie(sessionName, "", 0), cookie(loginName, "", 0)]);
    response.writeHead(204).end();
    return;
  }
  const userId = await auth.authenticate(cookies.get(sessionName) ?? "");
  if (url.pathname === "/reports/api/session") {
    json({
      authenticated: userId !== null,
      ...(userId !== null ? { userId } : {}),
      salesEnabled: payments.webReportSalesEnabled,
      priceLabel: `${VIN_REPORT_FINIK_MINOR / 100} сом`,
      terms: VIN_REPORT_WEB_TERMS,
      supportUrl: "https://t.me/autokgbot?start=paysupport",
    });
    return;
  }
  if (userId === null)
    throw new RequestError(401, "Войдите через одноразовый код из личного чата бота.");
  if (url.pathname === "/reports/api/orders") {
    json({
      orders: (await payments.ledger.listOrders(userId)).filter(isWebVinReport),
      reportSalesEnabled: payments.webReportSalesEnabled,
    });
    return;
  }
  if (url.pathname === "/reports/api/vin") {
    const vin = normalizeVin(parse(vinBody).vin);
    if (!vin) throw new RequestError(400, "Введите VIN из 17 символов без I, O и Q.");
    const revision = payments.forgetVinResult(userId, vin, "web");
    if (!checkVin) throw new RequestError(503, "Бесплатная проверка VIN сейчас недоступна.");
    const controller = new AbortController();
    const onClose = () => controller.abort();
    response.once("close", onClose);
    try {
      const result = await checkVin(vin, controller.signal);
      if (result.vin !== vin) throw new Error("VIN result mismatch");
      payments.rememberVinResult(userId, result, revision, "web");
      const eligible = confirmedVinReportKind(result) !== null;
      if (!response.destroyed)
        json({
          vin,
          eligible,
          summary: eligible
            ? "Полный отчёт найден. Посмотрите образец PDF и условия доступа."
            : "Наличие полного отчёта не подтверждено: покупка недоступна. Пустой результат или ошибка не доказывают отсутствие истории.",
        });
    } finally {
      response.off("close", onClose);
    }
    return;
  }
  if (download) {
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("orderId"))
      throw new RequestError(400, "Нужен только идентификатор orderId.");
    const bytes = await payments.downloadReport(
      userId,
      requirePaymentOrderId(url.searchParams.get("orderId")),
      "web",
    );
    if (!response.destroyed) {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": bytes.byteLength,
        "Content-Disposition": 'attachment; filename="vin-report.pdf"',
      });
      response.end(bytes);
    }
    return;
  }
  if (url.pathname === "/reports/api/orders/report") {
    json({ order: await payments.reportOffer(userId, parse(vinBody).vin, "web") });
    return;
  }
  if (url.pathname === "/reports/api/orders/checkout") {
    const value = parse(checkoutBody);
    json({ order: await payments.checkout(userId, value.orderId, value.acceptTerms, "web") });
    return;
  }
  if (url.pathname === "/reports/api/orders/cancel") {
    const { orderId } = parse(orderBody);
    await payments.ownedOrder(userId, orderId, "web");
    if (!(await payments.ledger.cancelOffer(orderId, userId)))
      throw new RequestError(409, "Счёт уже принят или оплачен. Обратитесь в поддержку заказа.");
    json({ order: await payments.ownedOrder(userId, orderId, "web") });
    return;
  }
  await payments.paymentSupport(userId, parse(supportBody).message);
  response.writeHead(204).end();
}
