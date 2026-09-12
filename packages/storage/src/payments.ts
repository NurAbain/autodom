import { createHash, randomUUID } from "node:crypto";
import {
  finikPaymentId,
  type PaymentEvent,
  type PaymentOfferInput,
  type PaymentOrder,
  type PaymentRefund,
  validatePaymentAmount,
  validatePaymentEvent,
  validatePaymentOffer,
  validatePaymentText,
  validatePaymentUrl,
} from "@autodom/core/payments";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { paymentEvents, paymentOrders, paymentRefunds } from "./schema.js";
import type { Store } from "./store.js";

export function decodePaymentOrder(row: typeof paymentOrders.$inferSelect): PaymentOrder {
  return {
    id: row.id,
    userId: row.user_id,
    product: row.product,
    provider: row.provider,
    currency: row.currency,
    amount: row.amount,
    title: row.title,
    description: row.description,
    seller: row.seller,
    supportUrl: row.support_url,
    terms: row.terms,
    executor: row.executor,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    invoiceUrl: row.invoice_url,
    invoiceStatus: row.invoice_status,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    chargeId: row.charge_id,
    needsReview: row.needs_review,
  };
}
function decodeRefund(row: typeof paymentRefunds.$inferSelect): PaymentRefund {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    amount: row.amount,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}
/** Fixed field order makes receipt identity independent of JSON object key order. */
export function paymentEventFingerprint(event: PaymentEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.provider,
        event.eventId,
        event.kind,
        event.orderId,
        event.userId,
        event.currency,
        event.amount,
        event.chargeId,
        event.occurredAt,
      ]),
    )
    .digest("hex");
}
const now = () => new Date().toISOString();

export class PaymentStore {
  constructor(private readonly store: Store) {}

  async createOffer(input: PaymentOfferInput): Promise<PaymentOrder> {
    validatePaymentOffer(input);
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("Inspection offer has expired");
    return this.store.transaction(async () => {
      const [row] = await this.store.database
        .insert(paymentOrders)
        .values({
          id: randomUUID(),
          user_id: input.userId,
          product: input.product,
          provider: "finik",
          currency: "KGS",
          amount: input.amount,
          title: input.title,
          description: input.description,
          seller: input.seller,
          support_url: input.supportUrl,
          terms: input.terms,
          executor: input.executor,
          expires_at: new Date(input.expiresAt).toISOString(),
          created_at: now(),
          accepted_at: null,
          invoice_url: null,
          invoice_status: "offered",
          payment_status: "unpaid",
          fulfillment_status: "ready",
          charge_id: null,
          needs_review: false,
        })
        .returning();
      return decodePaymentOrder(row!);
    });
  }
  async getOrder(id: string): Promise<PaymentOrder | null> {
    finikPaymentId(id);
    const [row] = await this.store.database
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, id));
    return row ? decodePaymentOrder(row) : null;
  }
  async listOrders(userId: number): Promise<PaymentOrder[]> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid payment buyer");
    return (
      await this.store.database
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.user_id, userId))
        .orderBy(desc(paymentOrders.created_at), desc(paymentOrders.id))
        .limit(100)
    ).map(decodePaymentOrder);
  }
  async acceptOrder(id: string, userId: number): Promise<PaymentOrder> {
    return this.store.transaction(async () => {
      const order = await this.getOrder(id);
      if (!order || order.userId !== userId) throw new Error("Inspection offer not found");
      validatePaymentOffer(order);
      const acceptedAt = Date.now();
      if (
        Date.parse(order.expiresAt) <= acceptedAt ||
        order.invoiceStatus === "cancelled" ||
        order.fulfillmentStatus === "cancelled" ||
        order.paymentStatus !== "unpaid"
      )
        throw new Error("Inspection offer cannot be accepted");
      if (order.acceptedAt) return order;
      const [row] = await this.store.database
        .update(paymentOrders)
        .set({ accepted_at: new Date(acceptedAt).toISOString(), invoice_status: "pending" })
        .where(eq(paymentOrders.id, id))
        .returning();
      return decodePaymentOrder(row!);
    });
  }
  async setInvoice(id: string, url: string): Promise<void> {
    validatePaymentUrl(url);
    await this.store.transaction(async () => {
      const order = await this.getOrder(id);
      if (!order?.acceptedAt || order.invoiceStatus !== "pending")
        throw new Error("Order has no accepted invoice");
      if (order.invoiceUrl && order.invoiceUrl !== url)
        throw new Error("Issued invoice is immutable");
      if (!order.invoiceUrl)
        await this.store.database
          .update(paymentOrders)
          .set({ invoice_url: url })
          .where(eq(paymentOrders.id, id));
    });
  }
  async ingestEvent(event: PaymentEvent): Promise<"applied" | "duplicate" | "review"> {
    // Reject malformed transport input explicitly; well-formed authenticated discrepancies are durable.
    validatePaymentEvent(event);
    event = { ...event, occurredAt: new Date(event.occurredAt).toISOString() };
    const fingerprint = paymentEventFingerprint(event);
    return this.store.transaction(async () => {
      const previous = await this.store.database
        .select()
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.provider, event.provider),
            or(
              eq(paymentEvents.event_id, event.eventId),
              eq(paymentEvents.charge_id, event.chargeId),
            ),
          ),
        );
      if (previous.some((row) => row.fingerprint === fingerprint)) return "duplicate";
      const order = event.orderId ? await this.getOrder(event.orderId) : null;
      const [captured] = await this.store.database
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.provider, event.provider),
            eq(paymentOrders.charge_id, event.chargeId),
          ),
        );
      let reason: string | null = null;
      let capture = false;
      if (previous.length || captured) reason = "conflicting_transaction_or_charge";
      else if (!order) reason = "unknown_order";
      else if (event.currency !== order.currency || event.amount !== order.amount)
        reason = "amount_or_currency_mismatch";
      else if (!order.acceptedAt) reason = "unaccepted_order";
      else if (order.paymentStatus !== "unpaid") reason = "additional_charge";
      else {
        capture = true;
        if (
          Date.now() >= Date.parse(order.expiresAt) ||
          Date.parse(event.occurredAt) >= Date.parse(order.expiresAt) ||
          order.invoiceStatus === "cancelled" ||
          order.fulfillmentStatus === "cancelled"
        )
          reason = "late_or_cancelled_payment";
        else if (Date.parse(event.occurredAt) < Date.parse(order.acceptedAt))
          reason = "receipt_precedes_acceptance";
      }
      if (reason === "receipt_precedes_acceptance") capture = false;
      if (order && capture) {
        await this.store.database
          .update(paymentOrders)
          .set({
            payment_status: "paid",
            charge_id: event.chargeId,
            needs_review: order.needsReview || reason !== null,
          })
          .where(eq(paymentOrders.id, order.id));
      }
      if (reason) {
        const affected = [
          ...new Set(
            [order?.id, captured?.id, ...previous.map((row) => row.order_id)].filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ];
        if (affected.length)
          await this.store.database
            .update(paymentOrders)
            .set({ needs_review: true })
            .where(inArray(paymentOrders.id, affected));
      }
      const outcome = reason ? "review" : "applied";
      await this.store.database.insert(paymentEvents).values({
        id: randomUUID(),
        provider: event.provider,
        event_id: event.eventId,
        charge_id: event.chargeId,
        order_id: event.orderId,
        fingerprint,
        data: event,
        outcome,
        review_reason: reason,
        received_at: now(),
      });
      return outcome;
    });
  }
  async cancelOffer(id: string, userId: number): Promise<boolean> {
    return this.store.transaction(async () => {
      const order = await this.getOrder(id);
      if (!order || order.userId !== userId || order.acceptedAt || order.paymentStatus !== "unpaid")
        return false;
      await this.store.database
        .update(paymentOrders)
        .set({ invoice_status: "cancelled", fulfillment_status: "cancelled" })
        .where(eq(paymentOrders.id, id));
      return true;
    });
  }
  async completeInspection(id: string): Promise<boolean> {
    return this.store.transaction(async () => {
      const order = await this.getOrder(id);
      if (
        !order ||
        order.paymentStatus !== "paid" ||
        order.needsReview ||
        order.fulfillmentStatus === "cancelled"
      )
        return false;
      if (order.fulfillmentStatus !== "fulfilled")
        await this.store.database
          .update(paymentOrders)
          .set({ fulfillment_status: "fulfilled" })
          .where(eq(paymentOrders.id, id));
      return true;
    });
  }
  async requestRefund(orderId: string, amount: number, reason: string): Promise<PaymentRefund> {
    validatePaymentAmount(amount);
    validatePaymentText(reason, "refund reason", 2000);
    return this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (!order || order.paymentStatus !== "paid")
        throw new Error("Refund requires captured payment");
      const refunds = await this.store.database
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.order_id, orderId));
      if (refunds.some((refund) => refund.status === "requested"))
        throw new Error("Refund request already active");
      const reserved = refunds
        .filter((refund) => refund.status === "submitted")
        .reduce((total, refund) => total + BigInt(refund.amount), 0n);
      if (reserved + BigInt(amount) > BigInt(order.amount))
        throw new Error("Refund requests exceed captured amount");
      const timestamp = now();
      const [row] = await this.store.database
        .insert(paymentRefunds)
        .values({
          id: randomUUID(),
          order_id: orderId,
          provider: "finik",
          amount,
          reason,
          status: "requested",
          created_at: timestamp,
          updated_at: timestamp,
          note: null,
        })
        .returning();
      return decodeRefund(row!);
    });
  }
  async getRefund(id: string): Promise<PaymentRefund | null> {
    finikPaymentId(id);
    const [row] = await this.store.database
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.id, id));
    return row ? decodeRefund(row) : null;
  }
  async listRefunds(orderId?: string): Promise<PaymentRefund[]> {
    if (orderId !== undefined) finikPaymentId(orderId);
    return (
      await this.store.database
        .select()
        .from(paymentRefunds)
        .where(orderId === undefined ? undefined : eq(paymentRefunds.order_id, orderId))
        .orderBy(desc(paymentRefunds.created_at), desc(paymentRefunds.id))
    ).map(decodeRefund);
  }
  async markRefund(id: string, state: "submitted" | "failed", note?: string): Promise<void> {
    if (state !== "submitted" && state !== "failed")
      throw new Error("Invalid refund request state");
    if (note !== undefined) validatePaymentText(note, "refund note", 2000);
    await this.store.transaction(async () => {
      const refund = await this.getRefund(id);
      if (!refund) throw new Error("Refund request not found");
      if (refund.status === state) return;
      if (refund.status !== "requested") throw new Error("Refund request is already terminal");
      await this.store.database
        .update(paymentRefunds)
        .set({ status: state, note: note ?? null, updated_at: now() })
        .where(eq(paymentRefunds.id, id));
    });
  }
}
