import { finikPaymentId, type PaymentOrder } from "@autodom/core/payments";
import type { Store } from "@autodom/storage";
import { PaymentStore } from "@autodom/storage/payments";

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
