import { finikPaymentId, type PaymentOrder } from "@autodom/core/payments";
import { normalizeVin, type VinCheckResult } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
import { PaymentStore } from "@autodom/storage/payments";
import { AbortController as TelegramAbortController } from "abort-controller";
import { type Api, GrammyError } from "grammy";
import type { PreCheckoutQuery, Update } from "grammy/types";
import {
  paymentAmountText,
  paymentOrderStatus,
  VIN_REPORT_MAX_BYTES,
  VIN_REPORT_OWNER,
  VIN_REPORT_SLA_MS,
  VIN_REPORT_STARS,
  VIN_REPORT_TERMS,
} from "./payment-text.js";
import { hasKoreanVinRecord } from "./vin-text.js";

export function loadVinReportStarsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AUTODOM_VIN_REPORT_STARS_ENABLED;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("AUTODOM_VIN_REPORT_STARS_ENABLED must be true or false");
}

export class PaymentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FinikGatewaySettings {
  url: string;
  token: string;
}

export function loadFinikGatewaySettings(
  env: NodeJS.ProcessEnv = process.env,
): FinikGatewaySettings | undefined {
  const raw = env.AUTODOM_PAYMENTS_GATEWAY_URL?.trim();
  const token = env.AUTODOM_PAYMENTS_GATEWAY_TOKEN?.trim();
  if (!raw && !token) return undefined;
  if (!raw || !token)
    throw new Error(
      "AUTODOM_PAYMENTS_GATEWAY_URL and AUTODOM_PAYMENTS_GATEWAY_TOKEN are required together",
    );
  if ((env.AUTODOM_PAYMENTS_CALLBACK_TOKEN?.trim().length ?? 0) < 32)
    throw new Error(
      "Finik checkout requires AUTODOM_PAYMENTS_CALLBACK_TOKEN for durable payment receipts",
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AUTODOM_PAYMENTS_GATEWAY_URL must be an HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("AUTODOM_PAYMENTS_GATEWAY_URL must be an HTTP(S) origin without credentials");
  return { url: url.origin, token };
}

export function requirePaymentOrderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  )
    throw new PaymentRequestError(400, "Откройте конкретный заказ из раздела «Мои заказы».");
  return value;
}

async function gatewayReply(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing gateway response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8192) throw new Error("Oversized gateway response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class PaymentService {
  readonly ledger: PaymentStore;
  private starsApi?: Api;
  private starsEnabled = false;
  private starsToken?: string;
  private readonly koreanResults = new Map<
    string,
    { revision: number; expiresAt: number; eligible: boolean }
  >();
  private vinRevision = 0;

  configureStars(api: Api, enabled: boolean, token: string): void {
    if (!token) throw new Error("Stars requires the server Telegram token");
    this.starsApi = api;
    this.starsEnabled = enabled === true;
    this.starsToken = token;
  }

  get reportSalesEnabled(): boolean {
    return this.starsEnabled && !!this.starsApi;
  }

  forgetVinResult(userId: number, vin: string): number {
    const now = Date.now();
    for (const [id, result] of this.koreanResults) {
      if (result.expiresAt <= now) this.koreanResults.delete(id);
    }
    const key = `${userId}:${vin}`;
    this.koreanResults.delete(key);
    if (this.koreanResults.size >= 1000) {
      const oldest = this.koreanResults.keys().next().value;
      if (oldest !== undefined) this.koreanResults.delete(oldest);
    }
    const revision = ++this.vinRevision;
    this.koreanResults.set(key, { revision, expiresAt: now + 15 * 60 * 1000, eligible: false });
    return revision;
  }

  rememberVinResult(userId: number, result: VinCheckResult, revision: number): void {
    const vin = normalizeVin(result.vin);
    if (!vin || vin !== result.vin) return;
    const current = this.koreanResults.get(`${userId}:${vin}`);
    if (!current || current.revision !== revision || current.expiresAt <= Date.now()) return;
    current.eligible = hasKoreanVinRecord(result);
  }

  async reportOffer(userId: number, value: string): Promise<PaymentOrder> {
    if (!this.reportSalesEnabled)
      throw new PaymentRequestError(503, "Покупка PDF сейчас отключена.");
    const vin = normalizeVin(value);
    const eligibility = vin ? this.koreanResults.get(`${userId}:${vin}`) : undefined;
    if (!vin || !eligibility?.eligible || eligibility.expiresAt <= Date.now())
      throw new PaymentRequestError(
        409,
        "Сначала выполните свежую проверку этого VIN с корейской записью.",
      );
    return this.store.withLock(`autodom:report:offer:${userId}:${vin}`, async () => {
      const existing = await this.ledger.findOpenVinReport(userId, vin);
      if (existing) return existing;
      const me = await this.requireStarsApi().getMe();
      if (
        this.koreanResults.get(`${userId}:${vin}`) !== eligibility ||
        !eligibility.eligible ||
        eligibility.expiresAt <= Date.now()
      )
        throw new PaymentRequestError(
          409,
          "Проверка VIN обновилась. Повторите проверку перед покупкой.",
        );
      return this.ledger.createOffer({
        userId,
        vin,
        product: "vin_report",
        amount: VIN_REPORT_STARS,
        title: "Полный корейский PDF",
        description: `Полный корейский PDF по VIN ${vin}. Ручная выдача в течение ${VIN_REPORT_SLA_MS / 60_000} минут после оплаты.`,
        seller: `Autodom · владелец ${VIN_REPORT_OWNER}`,
        executor: `Владелец Autodom · ${VIN_REPORT_OWNER}`,
        supportUrl: `https://t.me/${me.username}?start=paysupport`,
        terms: VIN_REPORT_TERMS,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    });
  }

  private requireStarsApi(): Api {
    if (!this.starsApi) throw new PaymentRequestError(503, "Telegram-платежи недоступны.");
    return this.starsApi;
  }

  private requireOwner(actorId: number): void {
    if (actorId !== VIN_REPORT_OWNER)
      throw new PaymentRequestError(403, "Только владелец может выполнить это действие.");
  }

  private async reportPdf(fileId: string): Promise<Uint8Array> {
    if (!this.starsToken) throw new PaymentRequestError(503, "Загрузка PDF не настроена.");
    const controller = new TelegramAbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const file = await this.requireStarsApi()
      .getFile(fileId, controller.signal)
      .finally(() => clearTimeout(timer));
    if (
      !file.file_path ||
      !/^[a-zA-Z0-9_/-]+\.pdf$/iu.test(file.file_path) ||
      file.file_path.split("/").some((part) => !part || part === "..") ||
      (file.file_size !== undefined &&
        (!Number.isSafeInteger(file.file_size) ||
          file.file_size <= 0 ||
          file.file_size > VIN_REPORT_MAX_BYTES))
    )
      throw new PaymentRequestError(400, "Нужен PDF до 20 МБ с корректным Telegram file_path.");
    const response = await this.fetcher(
      `https://api.telegram.org/file/bot${this.starsToken}/${file.file_path}`,
      {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new PaymentRequestError(503, "Не удалось получить PDF из Telegram.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > VIN_REPORT_MAX_BYTES) throw new PaymentRequestError(400, "PDF больше 20 МБ.");
        chunks.push(value);
      }
      if (file.file_size !== undefined && size !== file.file_size)
        throw new PaymentRequestError(503, "Telegram передал неполный PDF. Повторите загрузку.");
      const bytes = Buffer.concat(chunks, size);
      if (size < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
        throw new PaymentRequestError(400, "Документ не является PDF.");
      return bytes;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async downloadReport(userId: number, orderId: string): Promise<Uint8Array> {
    return this.store.withLock(`autodom:report:operation:${orderId}`, async () => {
      const order = await this.ownedOrder(userId, orderId);
      if (
        order.product !== "vin_report" ||
        order.paymentStatus !== "paid" ||
        order.needsReview ||
        order.fulfillmentStatus !== "fulfilled" ||
        !order.reportFileId ||
        (await this.ledger.listRefunds(orderId)).some(
          (refund) => refund.status === "requested" || refund.status === "submitted",
        )
      )
        throw new PaymentRequestError(
          409,
          "PDF доступен только для выданного оплаченного заказа без возврата.",
        );
      return this.reportPdf(order.reportFileId);
    });
  }

  async approveStarsCheckout(query: PreCheckoutQuery): Promise<void> {
    const api = this.requireStarsApi();
    let approved = false;
    let timer: NodeJS.Timeout | undefined;
    let reservation: Promise<boolean> | undefined;
    try {
      requirePaymentOrderId(query.invoice_payload);
      if (this.reportSalesEnabled && !query.from.is_bot && query.currency === "XTR") {
        reservation = this.ledger.reserveStarsCheckout(
          query.invoice_payload,
          query.from.id,
          query.currency,
          query.total_amount,
          query.id,
        );
        approved = await Promise.race([
          reservation,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 5_000);
          }),
        ]);
      }
    } catch {
      approved = false;
    } finally {
      clearTimeout(timer);
    }
    const controller = new TelegramAbortController();
    const answerTimer = setTimeout(() => controller.abort(), 2_000);
    try {
      await api.answerPreCheckoutQuery(
        query.id,
        approved,
        approved
          ? {}
          : {
              error_message:
                "Заказ недоступен или уже ожидает оплату. Проверьте /orders; повторно не платите. Поддержка: /paysupport.",
            },
        controller.signal,
      );
      if (!approved && reservation) {
        // A confirmed decline cannot charge this query. Wait out a late DB commit
        // before releasing it; an uncertain Telegram answer never reaches here.
        if (await reservation)
          await this.ledger.releaseStarsCheckout(query.invoice_payload, query.id);
      }
    } finally {
      clearTimeout(answerTimer);
    }
  }

  async ingestTelegramPayment(update: Update): Promise<void> {
    const message = update.message;
    if (!message) return;
    const receipt = message.successful_payment ?? message.refunded_payment;
    if (!receipt) return;
    const refunded = !!message.refunded_payment;
    let orderId: string | null = null;
    try {
      orderId = requirePaymentOrderId(receipt.invoice_payload);
    } catch {
      /* Keep unknown payloads in the receipt ledger. */
    }
    await this.ledger.ingestEvent({
      provider: "telegram_stars",
      eventId: `${refunded ? "refund:" : "paid:"}${receipt.telegram_payment_charge_id}`,
      kind: refunded ? "refunded" : "paid",
      orderId,
      userId: message.chat.type === "private" ? message.chat.id : (message.from?.id ?? null),
      currency: receipt.currency,
      amount: receipt.total_amount,
      chargeId: receipt.telegram_payment_charge_id,
      occurredAt: new Date(message.date * 1000).toISOString(),
    });
  }

  async notifyPendingReports(): Promise<void> {
    const api = this.requireStarsApi();
    for (const order of await this.ledger.listPendingVinReports()) {
      await this.store.withLock(`autodom:report:notify:${order.id}`, async () => {
        const current = await this.ledger.getOrder(order.id);
        if (!current || current.adminNotifiedAt || current.paymentStatus !== "paid") return;
        const deadline = current.paidAt
          ? new Date(Date.parse(current.paidAt) + VIN_REPORT_SLA_MS).toISOString()
          : "требует проверки";
        const canDeliver =
          !current.needsReview && !current.refundPending && current.fulfillmentStatus === "ready";
        const instructions = canDeliver
          ? `Пришлите настоящий PDF документом с подписью:\n/deliver ${current.id} ${current.vin}\nЕсли выдать невозможно — полный возврат:\n/refund ${current.id}`
          : `Выдача приостановлена. Сначала проверьте состояние:\n/report ${current.id}`;
        await api.sendMessage(
          VIN_REPORT_OWNER,
          `Оплачен корейский PDF\nЗаказ: ${current.id}\nVIN: ${current.vin}\nПокупатель: ${current.userId}\nСумма: ${paymentAmountText(current)}\nВыдать до: ${deadline}\n${paymentOrderStatus(current)}\n\n${instructions}\nСтатус: /report ${current.id}`,
        );
        await this.ledger.markReportNotified(current.id);
      });
    }
  }

  async deliverReport(actorId: number, orderId: string, fileId: string): Promise<PaymentOrder> {
    this.requireOwner(actorId);
    requirePaymentOrderId(orderId);
    if (!fileId || fileId.length > 1024)
      throw new PaymentRequestError(400, "Нужен PDF-документ Telegram.");
    const api = this.requireStarsApi();
    return this.store.withLock(`autodom:report:operation:${orderId}`, async () => {
      const current = await this.ledger.getOrder(orderId);
      if (!current || current.product !== "vin_report")
        throw new PaymentRequestError(404, "PDF-заказ не найден.");
      if (current.fulfillmentStatus === "fulfilled") return current;
      if (
        current.fulfillmentStatus === "delivering" ||
        current.fulfillmentStatus === "delivery_unknown"
      )
        throw new PaymentRequestError(
          409,
          "Доставка уже начата или её исход неизвестен. Автоматическая повторная отправка запрещена.",
        );
      if (current.paymentStatus !== "paid" || current.needsReview || current.refundPending)
        throw new PaymentRequestError(
          409,
          "Выдача требует подтверждённой оплаты без возврата и расхождений.",
        );
      await this.reportPdf(fileId);
      const order = await this.ledger.beginReportDelivery(orderId, fileId);
      let messageId: number;
      try {
        const message = await api.sendDocument(order.userId, fileId, {
          caption: `Ваш полный корейский PDF\nVIN ${order.vin}\nЗаказ ${order.id}\nПоддержка: /paysupport`,
        });
        messageId = message.message_id;
      } catch (error) {
        await this.ledger.failReportDelivery(
          orderId,
          !(error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500),
        );
        throw new PaymentRequestError(
          503,
          "Доставка не подтверждена. Проверьте /report; при неизвестном исходе не отправляйте повторно.",
        );
      }
      // A database failure after Telegram success leaves 'delivering', never a safe-to-retry state.
      await this.ledger.finishReportDelivery(orderId, messageId);
      return this.ownedOrder(order.userId, orderId);
    });
  }

  async refundReport(actorId: number, orderId: string): Promise<PaymentOrder> {
    this.requireOwner(actorId);
    requirePaymentOrderId(orderId);
    const api = this.requireStarsApi();
    return this.store.withLock(`autodom:report:operation:${orderId}`, async () => {
      const order = await this.ledger.getOrder(orderId);
      if (!order || order.product !== "vin_report" || order.provider !== "telegram_stars")
        throw new PaymentRequestError(404, "PDF-заказ не найден.");
      if (order.paymentStatus === "refunded") return order;
      if (order.paymentStatus !== "paid" || !order.chargeId)
        throw new PaymentRequestError(409, "Нет однозначно подтверждённой оплаты для возврата.");
      if (order.fulfillmentStatus === "delivering") {
        // We hold the same cross-process operation lock as delivery. No send can
        // still be active; this reservation survived a terminated operation.
        await this.ledger.failReportDelivery(orderId, true);
      }
      const refund = await this.ledger.requestRefund(
        orderId,
        order.amount,
        "Полный возврат по решению владельца",
      );
      try {
        const confirmed = await api.refundStarPayment(order.userId, order.chargeId);
        if (confirmed !== true) throw new Error("Telegram did not confirm the refund");
      } catch {
        // Even an API rejection may follow an earlier ambiguous successful refund.
        throw new PaymentRequestError(
          503,
          "Возврат не подтверждён. Заявка сохранена, выдача заблокирована. Проверьте /report и повторите /refund для того же заказа.",
        );
      }
      await this.ledger.markRefund(refund.id, "confirmed");
      return this.ownedOrder(order.userId, orderId);
    });
  }

  async paymentSupport(userId: number, text: string): Promise<void> {
    const body = text.trim();
    if (!body || body.length > 2500)
      throw new PaymentRequestError(400, "Напишите /paysupport и вопрос (до 2500 символов).");
    const orders = (await this.ledger.listOrders(userId)).filter(
      (order) => order.product === "vin_report",
    );
    await this.requireStarsApi().sendMessage(
      VIN_REPORT_OWNER,
      `Поддержка платежей · покупатель ${userId}\n${orders
        .slice(0, 5)
        .map((order) => `${order.id}: ${paymentOrderStatus(order)}`)
        .join("\n")}\n\n${body}\n\nОтвет: /payreply ${userId} текст`,
    );
  }

  async paymentSupportReply(actorId: number, userId: number, text: string): Promise<void> {
    this.requireOwner(actorId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !text.trim() || text.length > 3000)
      throw new PaymentRequestError(400, "Используйте /payreply BUYER_ID текст.");
    if (!(await this.ledger.listOrders(userId)).some((order) => order.product === "vin_report"))
      throw new PaymentRequestError(404, "Покупатель PDF-заказа не найден.");
    await this.requireStarsApi().sendMessage(
      userId,
      `Поддержка Autodom:\n${text.trim()}\n\nОтветить: /paysupport текст`,
    );
  }

  constructor(
    private readonly store: Store,
    private readonly gateway?: FinikGatewaySettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.ledger = new PaymentStore(store);
  }

  async ownedOrder(userId: number, id: string): Promise<PaymentOrder> {
    requirePaymentOrderId(id);
    const order = await this.ledger.getOrder(id);
    if (!order || order.userId !== userId) throw new PaymentRequestError(404, "Заказ не найден.");
    return order;
  }

  async checkout(userId: number, id: string, acceptedTerms: boolean): Promise<PaymentOrder> {
    requirePaymentOrderId(id);
    if (acceptedTerms !== true)
      throw new PaymentRequestError(
        400,
        "Перед оплатой подтвердите состав заказа, цену и условия.",
      );
    return this.store.withLock(`autodom:payment:invoice:${id}`, async () => {
      let order = await this.ownedOrder(userId, id);
      if (order.paymentStatus !== "unpaid")
        throw new PaymentRequestError(
          409,
          "Оплата уже получена. Повторно оплачивать заказ не нужно.",
        );
      if (order.needsReview)
        throw new PaymentRequestError(
          409,
          "Платёж требует проверки. Не оплачивайте повторно; обратитесь в поддержку заказа.",
        );
      if (order.invoiceStatus === "cancelled" || Date.parse(order.expiresAt) <= Date.now())
        throw new PaymentRequestError(
          409,
          "Предложение больше не действует. Свяжитесь с исполнителем.",
        );
      if (order.product === "vin_report") {
        if (!this.reportSalesEnabled)
          throw new PaymentRequestError(503, "Покупка PDF сейчас отключена.");
        if (
          order.provider !== "telegram_stars" ||
          order.currency !== "XTR" ||
          order.amount !== VIN_REPORT_STARS ||
          !order.vin
        )
          throw new PaymentRequestError(409, "Некорректное предложение PDF.");
        if (order.invoiceUrl) return order;
        order = await this.ledger.acceptOrder(id, userId);
        try {
          const invoiceUrl = await this.requireStarsApi().createInvoiceLink(
            order.title,
            order.description,
            order.id,
            "",
            "XTR",
            [{ label: "Полный корейский PDF", amount: order.amount }],
          );
          const url = new URL(invoiceUrl);
          if (
            url.protocol !== "https:" ||
            url.hostname !== "t.me" ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !/^\/\$[A-Za-z0-9_-]+$/u.test(url.pathname)
          )
            throw new Error("Telegram did not return a native invoice URL");
          await this.ledger.setInvoice(id, invoiceUrl);
          return this.ownedOrder(userId, id);
        } catch {
          throw new PaymentRequestError(
            503,
            "Создание счёта не подтверждено. Заказ сохранён; проверьте /orders. Если уже платили, не платите повторно.",
          );
        }
      }
      if (order.product !== "inspection" || order.currency !== "KGS" || order.provider !== "finik")
        throw new PaymentRequestError(409, "Этот заказ нельзя оплатить через Finik.");
      if (order.invoiceUrl) return order;
      if (!this.gateway)
        throw new PaymentRequestError(
          503,
          "Оплата временно недоступна. Бесплатные функции работают без оплаты.",
        );
      order = await this.ledger.acceptOrder(id, userId);
      // Commit the immutable expected payment before the external operation. The same
      // merchant PaymentId is reused after an ambiguous timeout, never a fresh charge.
      try {
        const response = await this.fetcher(`${this.gateway.url}/v1/autodom/invoices`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.gateway.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            order_id: order.id,
            product: order.product,
            amount_minor: order.amount,
            currency: order.currency,
            description: order.description,
            expires_at: order.expiresAt,
          }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Gateway did not confirm invoice creation");
        }
        const body = await gatewayReply(response);
        if (
          !body ||
          typeof body !== "object" ||
          !("invoice_id" in body) ||
          body.invoice_id !== finikPaymentId(id) ||
          !("invoice_url" in body) ||
          typeof body.invoice_url !== "string"
        )
          throw new Error("Invalid gateway invoice confirmation");
        const url = new URL(body.invoice_url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          (url.hostname !== "qr.finik.kg" && url.hostname !== "beta.qr.finik.kg")
        )
          throw new Error("Unexpected Finik checkout origin");
        await this.ledger.setInvoice(id, url.href);
        return await this.ownedOrder(userId, id);
      } catch {
        // Do not expose gateway responses, credentials, or claim that an ambiguous
        // provider request proves no payment exists. The receipt ledger remains authoritative.
        throw new PaymentRequestError(
          503,
          "Не удалось подтвердить создание счёта. Проверьте статус заказа; если уже платили, не оплачивайте повторно.",
        );
      }
    });
  }
}
