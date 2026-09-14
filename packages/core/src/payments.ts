export type PaymentProvider = "finik" | "telegram_stars";
export type PaymentProduct = "inspection" | "vin_report";
export type PaymentCurrency = "KGS" | "XTR";

export interface PaymentOfferInput {
  userId: number;
  product: PaymentProduct;
  vin?: string | null;
  amount: number;
  title: string;
  description: string;
  seller: string;
  supportUrl: string;
  terms: string;
  expiresAt: string;
  executor: string;
}
export interface PaymentOrder extends PaymentOfferInput {
  id: string;
  vin: string | null;
  paidAt: string | null;
  reportFileId: string | null;
  reportMessageId: number | null;
  deliveredAt: string | null;
  adminNotifiedAt: string | null;
  preCheckoutId: string | null;
  refundPending: boolean;
  provider: PaymentProvider;
  currency: PaymentCurrency;
  createdAt: string;
  acceptedAt: string | null;
  invoiceUrl: string | null;
  invoiceStatus: "offered" | "pending" | "cancelled";
  paymentStatus: "unpaid" | "paid" | "refunded";
  fulfillmentStatus: "ready" | "delivering" | "delivery_unknown" | "fulfilled" | "cancelled";
  chargeId: string | null;
  needsReview: boolean;
}
export interface PaymentEvent {
  provider: PaymentProvider;
  eventId: string;
  kind: "paid" | "refunded";
  orderId: string | null;
  userId: number | null;
  currency: string;
  amount: number;
  chargeId: string;
  occurredAt: string;
}
export interface PaymentRefund {
  id: string;
  orderId: string;
  provider: PaymentProvider;
  amount: number;
  reason: string;
  status: "requested" | "submitted" | "failed" | "confirmed";
  createdAt: string;
  confirmedBy: number | null;
  confirmationReference: string | null;
}

/** Digital Finik orders are website-only; they must not enter Telegram checkout. */
export function isWebVinReport(order: Pick<PaymentOrder, "product" | "provider">): boolean {
  return order.product === "vin_report" && order.provider === "finik";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function finikPaymentId(id: string): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid payment order ID");
  return `ad_${id.replaceAll("-", "")}`;
}
export function parseFinikPaymentId(text: string): string | null {
  if (typeof text !== "string" || !/^ad_[0-9a-f]{32}$/u.test(text)) return null;
  const id = text.slice(3);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
export function validatePaymentAmount(amount: number, invoice = false): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || (invoice && amount % 100 !== 0))
    throw new Error(
      "Payment amount must be exact positive minor units; invoices require whole som",
    );
}
export function validatePaymentText(value: string, name: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[[\p{Cc}&&\p{ASCII}]--[\t\n\r]]/v.test(value)
  )
    throw new Error(`Invalid payment ${name}`);
}
export function validatePaymentTimestamp(value: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Payment timestamp must be ISO with an explicit timezone");
  const local = new Date(`${value.slice(0, 19)}Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error("Invalid payment date");
}
export function validatePaymentUrl(value: string, support = false): void {
  validatePaymentText(value, "URL", 2048);
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(support && url.protocol === "mailto:" && url.pathname.includes("@")))
  )
    throw new Error("Payment URL must use HTTPS or a support mailto address without credentials");
}
/** Future expiry is checked only on offer creation/acceptance, not on financial restore. */
export function validatePaymentOffer(input: PaymentOfferInput): void {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId <= 0 ||
    (input.product !== "inspection" && input.product !== "vin_report")
  )
    throw new Error("Invalid payment buyer or product");
  if (
    input.product === "vin_report"
      ? typeof input.vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/u.test(input.vin)
      : input.vin != null
  )
    throw new Error("Invalid payment VIN");
  validatePaymentAmount(input.amount, input.product === "inspection");
  validatePaymentText(input.title, "title", 300);
  validatePaymentText(input.description, "description", 300);
  validatePaymentText(input.seller, "seller", 300);
  validatePaymentText(input.executor, "executor", 300);
  validatePaymentText(input.terms, "terms", 10000);
  validatePaymentUrl(input.supportUrl, true);
  validatePaymentTimestamp(input.expiresAt);
}
export function validatePaymentEvent(event: PaymentEvent): void {
  if (
    event.provider === "finik"
      ? event.kind !== "paid" || event.userId !== null
      : event.provider !== "telegram_stars" ||
        (event.kind !== "paid" && event.kind !== "refunded") ||
        !Number.isSafeInteger(event.userId) ||
        event.userId === null ||
        event.userId <= 0
  )
    throw new Error("Invalid payment event provider, kind or buyer");
  if (event.orderId !== null) finikPaymentId(event.orderId);
  validatePaymentText(event.eventId, "event ID", 300);
  validatePaymentText(event.chargeId, "charge ID", 300);
  validatePaymentText(event.currency, "currency", 16);
  validatePaymentAmount(event.amount);
  validatePaymentTimestamp(event.occurredAt);
}
