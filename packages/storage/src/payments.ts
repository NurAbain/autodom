import { createHash, randomUUID } from "node:crypto";
import {
  finikPaymentId,
  isWebVinReport,
  type PaymentChannel,
  type PaymentEvent,
  type PaymentOfferInput,
  type PaymentOrder,
  type PaymentProvider,
  type PaymentRefund,
  VIN_REPORT_KINDS,
  type VinReportKind,
  validatePaymentAmount,
  validatePaymentEvent,
  validatePaymentOffer,
  validatePaymentText,
  validatePaymentTimestamp,
  validatePaymentUrl,
} from "@autodom/core/payments";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { paymentEvents, paymentOrders, paymentRefunds, webReportSessions } from "./schema.js";
import type { Store } from "./store.js";

const orderColumns = {
  ...getTableColumns(paymentOrders),
  // Single-table projections strip column qualifiers; this id must reference the outer order.
  refund_pending: sql<boolean>`EXISTS (
    SELECT 1 FROM payment_refunds r WHERE r.order_id = ${paymentOrders}.${sql.identifier(paymentOrders.id.name)}
      AND r.status IN ('requested','submitted')
  )`.as("refund_pending"),
};

export function decodePaymentOrder(
  row: typeof paymentOrders.$inferSelect & { refund_pending?: boolean },
): PaymentOrder {
  return {
    id: row.id,
    userId: row.user_id,
    product: row.product,
    reportKind: row.product === "vin_report" ? (row.report_kind ?? "korea") : null,
    provider: row.provider,
    channel: row.channel,
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
    vin: row.vin,
    paidAt: row.paid_at,
    reportFileId: row.report_file_id,
    reportMessageId: row.report_message_id,
    deliveredAt: row.delivered_at,
    adminNotifiedAt: row.admin_notified_at,
    preCheckoutId: row.pre_checkout_id,
    refundPending: row.refund_pending ?? false,
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
    confirmedBy: row.confirmed_by,
    confirmationReference: row.confirmation_reference,
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
    return this.insertOffer(
      input,
      input.product === "vin_report" ? "telegram_stars" : "finik",
      "telegram",
    );
  }

  async createFinikReportOffer(
    input: PaymentOfferInput,
    channel: PaymentChannel,
  ): Promise<PaymentOrder> {
    if (input.product !== "vin_report" || input.amount % 100 !== 0)
      throw new Error("PDF reports require a whole-som Finik quote");
    return this.insertOffer(input, "finik", channel);
  }

  private async insertOffer(
    input: PaymentOfferInput,
    provider: PaymentProvider,
    channel: PaymentChannel,
  ): Promise<PaymentOrder> {
    validatePaymentOffer(input);
    if (channel !== "telegram" && channel !== "web") throw new Error("Invalid payment channel");
    const reportKind = input.product === "vin_report" ? (input.reportKind ?? "korea") : null;
    if (reportKind === "carfax" && (provider !== "finik" || channel !== "telegram"))
      throw new Error("CARFAX reports require Finik and Telegram");
    if (input.product === "vin_photos" && (provider !== "finik" || channel !== "telegram"))
      throw new Error("VIN photos require Finik and Telegram");
    if (Date.parse(input.expiresAt) <= Date.now()) throw new Error("Payment offer has expired");
    return this.store.transaction(async () => {
      if (input.product === "vin_report") {
        const existing = await this.findOpenVinReport(
          input.userId,
          input.vin!,
          provider,
          channel,
          reportKind!,
        );
        if (existing) return existing;
      }
      if (input.product === "vin_photos") {
        const existing = await this.findOpenVinPhotos(input.userId, input.vin!);
        if (existing) return existing;
      }
      const [row] = await this.store.database
        .insert(paymentOrders)
        .values({
          id: randomUUID(),
          user_id: input.userId,
          product: input.product,
          report_kind: reportKind,
          provider,
          channel,
          currency: provider === "telegram_stars" ? "XTR" : "KGS",
          vin: input.vin ?? null,
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
      .select(orderColumns)
      .from(paymentOrders)
      .where(eq(paymentOrders.id, id));
    return row ? decodePaymentOrder(row) : null;
  }
  async listOrders(userId: number): Promise<PaymentOrder[]> {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid payment buyer");
    return (
      await this.store.database
        .select(orderColumns)
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
        order.paymentStatus !== "unpaid" ||
        order.needsReview
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
    // Only authenticated server receipts reach this boundary; discrepancies remain durable.
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
      const sameKind = previous.filter((row) => row.data.kind === event.kind);
      // Telegram can replay the same receipt in a distinct update with a new timestamp.
      if (
        event.provider === "telegram_stars" &&
        sameKind.some(
          (row) =>
            row.outcome === "applied" &&
            row.data.orderId === event.orderId &&
            row.data.userId === event.userId &&
            row.data.currency === event.currency &&
            row.data.amount === event.amount &&
            row.data.chargeId === event.chargeId,
        )
      )
        return "duplicate";
      let reason: string | null = null;
      let capture = false;
      let refund = false;
      if (sameKind.length || previous.some((row) => row.event_id === event.eventId))
        reason = "conflicting_transaction_or_charge";
      else if (!order) reason = "unknown_order";
      else if (event.provider !== order.provider) reason = "provider_mismatch";
      else if (event.provider === "telegram_stars" && event.userId !== order.userId)
        reason = "buyer_mismatch";
      else if (event.currency !== order.currency || event.amount !== order.amount)
        reason = "amount_or_currency_mismatch";
      else if (!order.acceptedAt) reason = "unaccepted_order";
      else if (event.kind === "refunded") {
        if (
          !captured ||
          captured.id !== order.id ||
          order.chargeId !== event.chargeId ||
          !["paid", "refunded"].includes(order.paymentStatus)
        )
          reason = "refund_without_capture";
        else if (
          Math.floor(Date.parse(event.occurredAt) / 1000) <
          Math.floor(Date.parse(order.paidAt!) / 1000)
        )
          reason = "refund_precedes_capture";
        else refund = true;
      } else if (captured) reason = "conflicting_transaction_or_charge";
      else if (order.paymentStatus !== "unpaid") reason = "additional_charge";
      else if (order.provider === "telegram_stars" && !order.preCheckoutId)
        reason = "unreserved_checkout";
      else {
        capture = true;
        const receiptTime = Date.parse(event.occurredAt);
        const acceptanceTime = Date.parse(order.acceptedAt);
        if (
          (order.provider === "finik" && Date.now() >= Date.parse(order.expiresAt)) ||
          receiptTime >= Date.parse(order.expiresAt) ||
          order.invoiceStatus === "cancelled" ||
          order.fulfillmentStatus === "cancelled"
        )
          reason = "late_or_cancelled_payment";
        else if (
          order.provider === "telegram_stars"
            ? Math.floor(receiptTime / 1000) < Math.floor(acceptanceTime / 1000)
            : receiptTime < acceptanceTime
        ) {
          reason = "receipt_precedes_acceptance";
          capture = false;
        }
      }
      if (order && capture)
        await this.store.database
          .update(paymentOrders)
          .set({
            payment_status: "paid",
            charge_id: event.chargeId,
            paid_at: event.occurredAt,
            needs_review: order.needsReview || reason !== null,
            ...(order.product === "vin_photos" && !order.needsReview && reason === null
              ? { fulfillment_status: "fulfilled" as const, delivered_at: event.occurredAt }
              : {}),
          })
          .where(eq(paymentOrders.id, order.id));
      if (order && refund) {
        await this.store.database
          .update(paymentOrders)
          .set({
            payment_status: "refunded",
            fulfillment_status: ["fulfilled", "delivering", "delivery_unknown"].includes(
              order.fulfillmentStatus,
            )
              ? order.fulfillmentStatus
              : "cancelled",
          })
          .where(eq(paymentOrders.id, order.id));
        await this.store.database
          .update(paymentRefunds)
          .set({
            status: "confirmed",
            updated_at: now(),
            note: "Authenticated Telegram refund receipt",
          })
          .where(
            and(
              eq(paymentRefunds.order_id, order.id),
              inArray(paymentRefunds.status, ["requested", "submitted"]),
            ),
          );
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
      return refund && order?.paymentStatus === "refunded" ? "duplicate" : outcome;
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
        order.product !== "inspection" ||
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
      if (
        (order.product === "vin_report" || order.product === "vin_photos") &&
        (amount !== order.amount || order.fulfillmentStatus === "delivering")
      )
        throw new Error("VIN purchases require full refund without an active delivery");
      const refunds = await this.store.database
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.order_id, orderId));
      if (order.product === "vin_report" || order.product === "vin_photos") {
        const pending = refunds.find(
          (refund) => refund.status === "requested" || refund.status === "submitted",
        );
        if (pending) return decodeRefund(pending);
      }
      if (refunds.some((refund) => refund.status === "requested"))
        throw new Error("Refund request already active");
      const reserved = refunds
        .filter((refund) => refund.status === "submitted" || refund.status === "confirmed")
        .reduce((total, refund) => total + BigInt(refund.amount), 0n);
      if (reserved + BigInt(amount) > BigInt(order.amount))
        throw new Error("Refund requests exceed captured amount");
      const timestamp = now();
      const [row] = await this.store.database
        .insert(paymentRefunds)
        .values({
          id: randomUUID(),
          order_id: orderId,
          provider: order.provider,
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
  async markRefund(
    id: string,
    state: "submitted" | "failed" | "confirmed",
    note?: string,
  ): Promise<void> {
    if (!["submitted", "failed", "confirmed"].includes(state))
      throw new Error("Invalid refund request state");
    if (note !== undefined) validatePaymentText(note, "refund note", 2000);
    await this.store.transaction(async () => {
      const refund = await this.getRefund(id);
      if (!refund) throw new Error("Refund request not found");
      if (refund.status === state) return;
      if (
        refund.status !== "requested" &&
        !(refund.provider === "telegram_stars" && refund.status === "submitted")
      )
        throw new Error("Refund request is already terminal");
      if (state === "confirmed") {
        const order = await this.getOrder(refund.orderId);
        if (
          refund.provider !== "telegram_stars" ||
          !order ||
          order.provider !== refund.provider ||
          refund.amount !== order.amount ||
          order.paymentStatus !== "paid" ||
          order.fulfillmentStatus === "delivering"
        )
          throw new Error("Refund confirmation requires full captured Stars payment");
        await this.store.database
          .update(paymentOrders)
          .set({
            payment_status: "refunded",
            fulfillment_status: order.fulfillmentStatus === "fulfilled" ? "fulfilled" : "cancelled",
          })
          .where(eq(paymentOrders.id, order.id));
      }
      await this.store.database
        .update(paymentRefunds)
        .set({ status: state, note: note ?? null, updated_at: now() })
        .where(eq(paymentRefunds.id, id));
    });
  }

  async confirmFinikReportRefund(
    orderId: string,
    actorId: number,
    reference: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error("Invalid refund operator");
    validatePaymentText(reference, "Finik refund confirmation", 300);
    await this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        (order.product !== "vin_report" && order.product !== "vin_photos") ||
        order.provider !== "finik" ||
        !order.chargeId
      )
        throw new Error("Refund confirmation requires a captured Finik VIN purchase");
      const refunds = await this.listRefunds(orderId);
      const confirmed = refunds.find((refund) => refund.status === "confirmed");
      if (confirmed) {
        if (confirmed.confirmationReference !== reference || confirmed.confirmedBy !== actorId)
          throw new Error("Refund confirmation is immutable");
        return;
      }
      const pending = refunds.find(
        (refund) => refund.status === "requested" || refund.status === "submitted",
      );
      if (
        order.paymentStatus !== "paid" ||
        order.fulfillmentStatus === "delivering" ||
        !pending ||
        pending.amount !== order.amount
      )
        throw new Error("A full refund must be requested before recording its confirmation");
      await this.store.database
        .update(paymentOrders)
        .set({
          payment_status: "refunded",
          fulfillment_status: order.fulfillmentStatus === "fulfilled" ? "fulfilled" : "cancelled",
        })
        .where(eq(paymentOrders.id, orderId));
      await this.store.database
        .update(paymentRefunds)
        .set({
          status: "confirmed",
          confirmed_by: actorId,
          confirmation_reference: reference,
          updated_at: now(),
        })
        .where(eq(paymentRefunds.id, pending.id));
    });
  }

  async createWebSession(tokenHash: string, userId: number, expiresAt: string): Promise<void> {
    validatePaymentTimestamp(expiresAt);
    if (
      !/^[0-9a-f]{64}$/u.test(tokenHash) ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      Date.parse(expiresAt) <= Date.now()
    )
      throw new Error("Invalid website session");
    await this.store.transaction(async () => {
      await this.store.database
        .delete(webReportSessions)
        .where(lte(webReportSessions.expires_at, now()));
      await this.store.database.insert(webReportSessions).values({
        token_hash: tokenHash,
        user_id: userId,
        created_at: now(),
        expires_at: expiresAt,
      });
    });
  }

  async getWebSessionUser(tokenHash: string): Promise<number | null> {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return null;
    const [session] = await this.store.database
      .select({ userId: webReportSessions.user_id })
      .from(webReportSessions)
      .where(
        and(eq(webReportSessions.token_hash, tokenHash), gt(webReportSessions.expires_at, now())),
      );
    return session?.userId ?? null;
  }

  async deleteWebSession(tokenHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) return;
    await this.store.database
      .delete(webReportSessions)
      .where(eq(webReportSessions.token_hash, tokenHash));
  }

  async findOpenVinReport(
    userId: number,
    vin: string,
    provider: PaymentProvider,
    channel: PaymentChannel,
    reportKind: VinReportKind = "korea",
  ): Promise<PaymentOrder | null> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[A-HJ-NPR-Z0-9]{17}$/u.test(vin))
      throw new Error("Invalid report buyer or VIN");
    if (
      (provider !== "finik" && provider !== "telegram_stars") ||
      (channel !== "telegram" && channel !== "web") ||
      !VIN_REPORT_KINDS.includes(reportKind) ||
      (reportKind === "carfax" && (provider !== "finik" || channel !== "telegram"))
    )
      throw new Error("Invalid report provider or channel");
    const rows = await this.store.database
      .select(orderColumns)
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.user_id, userId),
          eq(paymentOrders.vin, vin),
          eq(paymentOrders.product, "vin_report"),
          eq(paymentOrders.provider, provider),
          eq(paymentOrders.channel, channel),
          sql`coalesce(${paymentOrders.report_kind}, 'korea') = ${reportKind}`,
          ne(paymentOrders.payment_status, "refunded"),
          ne(paymentOrders.invoice_status, "cancelled"),
          ne(paymentOrders.fulfillment_status, "cancelled"),
        ),
      )
      .orderBy(desc(paymentOrders.created_at), desc(paymentOrders.id));
    const row = rows.find(
      (item) =>
        item.payment_status !== "unpaid" ||
        item.pre_checkout_id ||
        item.needs_review ||
        Date.parse(item.expires_at) > Date.now(),
    );
    return row ? decodePaymentOrder(row) : null;
  }

  async findOpenVinPhotos(userId: number, vin: string): Promise<PaymentOrder | null> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[A-HJ-NPR-Z0-9]{17}$/u.test(vin))
      throw new Error("Invalid photo buyer or VIN");
    const rows = await this.store.database
      .select(orderColumns)
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.user_id, userId),
          eq(paymentOrders.vin, vin),
          eq(paymentOrders.product, "vin_photos"),
          eq(paymentOrders.provider, "finik"),
          eq(paymentOrders.channel, "telegram"),
          ne(paymentOrders.payment_status, "refunded"),
          ne(paymentOrders.invoice_status, "cancelled"),
          ne(paymentOrders.fulfillment_status, "cancelled"),
        ),
      )
      .orderBy(desc(paymentOrders.created_at), desc(paymentOrders.id));
    const row = rows.find(
      (item) =>
        item.payment_status === "paid" ||
        item.needs_review ||
        Date.parse(item.expires_at) > Date.now(),
    );
    return row ? decodePaymentOrder(row) : null;
  }

  async hasPhotoAccess(userId: number, vin: string): Promise<boolean> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[A-HJ-NPR-Z0-9]{17}$/u.test(vin))
      return false;
    const [row] = await this.store.database
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.user_id, userId),
          eq(paymentOrders.vin, vin),
          eq(paymentOrders.product, "vin_photos"),
          eq(paymentOrders.provider, "finik"),
          eq(paymentOrders.channel, "telegram"),
          eq(paymentOrders.currency, "KGS"),
          eq(paymentOrders.amount, 19900),
          isNull(paymentOrders.report_kind),
          eq(paymentOrders.payment_status, "paid"),
          eq(paymentOrders.invoice_status, "pending"),
          eq(paymentOrders.fulfillment_status, "fulfilled"),
          sql`NOT EXISTS (
            SELECT 1 FROM payment_refunds r WHERE r.order_id = ${paymentOrders.id}
              AND r.status IN ('requested','submitted')
          )`,
          sql`${paymentOrders.accepted_at} IS NOT NULL AND ${paymentOrders.charge_id} IS NOT NULL AND ${paymentOrders.paid_at} IS NOT NULL`,
          eq(paymentOrders.needs_review, false),
        ),
      )
      .limit(1);
    return !!row;
  }

  async reserveStarsCheckout(
    orderId: string,
    userId: number,
    currency: string,
    amount: number,
    queryId: string,
  ): Promise<boolean> {
    validatePaymentText(queryId, "precheckout ID", 300);
    return this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        order.provider !== "telegram_stars" ||
        order.product !== "vin_report" ||
        order.userId !== userId ||
        currency !== "XTR" ||
        amount !== order.amount ||
        !order.acceptedAt ||
        order.invoiceStatus !== "pending" ||
        order.paymentStatus !== "unpaid" ||
        order.fulfillmentStatus !== "ready" ||
        order.needsReview ||
        Date.parse(order.expiresAt) <= Date.now()
      )
        return false;
      if (order.preCheckoutId) return order.preCheckoutId === queryId;
      const [used] = await this.store.database
        .select({ id: paymentOrders.id })
        .from(paymentOrders)
        .where(eq(paymentOrders.pre_checkout_id, queryId))
        .limit(1);
      if (used) return false;
      await this.store.database
        .update(paymentOrders)
        .set({ pre_checkout_id: queryId })
        .where(eq(paymentOrders.id, orderId));
      return true;
    });
  }

  /** Caller must first receive a successful, explicit Telegram checkout rejection. */
  async releaseStarsCheckout(orderId: string, queryId: string): Promise<void> {
    finikPaymentId(orderId);
    validatePaymentText(queryId, "precheckout ID", 300);
    await this.store.transaction(async () => {
      await this.store.database
        .update(paymentOrders)
        .set({ pre_checkout_id: null })
        .where(
          and(
            eq(paymentOrders.id, orderId),
            eq(paymentOrders.provider, "telegram_stars"),
            eq(paymentOrders.payment_status, "unpaid"),
            eq(paymentOrders.pre_checkout_id, queryId),
          ),
        );
    });
  }

  async listPendingVinReports(): Promise<PaymentOrder[]> {
    return (
      await this.store.database
        .select(orderColumns)
        .from(paymentOrders)
        .where(
          and(
            inArray(paymentOrders.product, ["vin_report", "vin_photos"]),
            eq(paymentOrders.payment_status, "paid"),
            isNull(paymentOrders.admin_notified_at),
          ),
        )
        .orderBy(asc(paymentOrders.paid_at), asc(paymentOrders.id))
        .limit(100)
    ).map(decodePaymentOrder);
  }

  async markReportNotified(orderId: string): Promise<void> {
    await this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        (order.product !== "vin_report" && order.product !== "vin_photos") ||
        order.paymentStatus === "unpaid"
      )
        throw new Error("Notification requires a captured VIN purchase");
      if (!order.adminNotifiedAt)
        await this.store.database
          .update(paymentOrders)
          .set({ admin_notified_at: now() })
          .where(eq(paymentOrders.id, orderId));
    });
  }

  async finishWebReportDelivery(orderId: string, fileId: string): Promise<PaymentOrder> {
    validatePaymentText(fileId, "report file ID", 1024);
    return this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        !isWebVinReport(order) ||
        order.paymentStatus !== "paid" ||
        order.needsReview ||
        order.refundPending
      )
        throw new Error("Website report is not available for delivery");
      if (order.fulfillmentStatus === "fulfilled") {
        if (order.reportFileId !== fileId) throw new Error("Delivered PDF is immutable");
        return order;
      }
      if (order.fulfillmentStatus !== "ready")
        throw new Error("Website report delivery is not ready");
      const [row] = await this.store.database
        .update(paymentOrders)
        .set({
          fulfillment_status: "fulfilled",
          report_file_id: fileId,
          delivered_at: now(),
        })
        .where(eq(paymentOrders.id, orderId))
        .returning();
      return decodePaymentOrder(row!);
    });
  }

  async beginReportDelivery(orderId: string, fileId: string): Promise<PaymentOrder> {
    validatePaymentText(fileId, "report file ID", 1024);
    return this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        order.product !== "vin_report" ||
        order.channel !== "telegram" ||
        order.paymentStatus !== "paid" ||
        order.needsReview ||
        order.fulfillmentStatus !== "ready"
      )
        throw new Error("Report is not available for delivery");
      if ((await this.listRefunds(orderId)).some((refund) => refund.status !== "failed"))
        throw new Error("Report has an active refund");
      const [row] = await this.store.database
        .update(paymentOrders)
        .set({ fulfillment_status: "delivering", report_file_id: fileId })
        .where(eq(paymentOrders.id, orderId))
        .returning();
      return decodePaymentOrder(row!);
    });
  }

  async finishReportDelivery(orderId: string, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error("Invalid report document message ID");
    await this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        order.product !== "vin_report" ||
        order.channel !== "telegram" ||
        !order.reportFileId
      )
        throw new Error("Report delivery not reserved");
      if (order.fulfillmentStatus === "fulfilled" && order.reportMessageId === messageId) return;
      if (order.fulfillmentStatus !== "delivering")
        throw new Error("Report delivery is not active");
      await this.store.database
        .update(paymentOrders)
        .set({
          fulfillment_status: "fulfilled",
          report_message_id: messageId,
          delivered_at: now(),
        })
        .where(eq(paymentOrders.id, orderId));
    });
  }

  async failReportDelivery(orderId: string, uncertain: boolean): Promise<void> {
    if (typeof uncertain !== "boolean") throw new Error("Invalid delivery failure");
    await this.store.transaction(async () => {
      const order = await this.getOrder(orderId);
      if (
        !order ||
        order.product !== "vin_report" ||
        order.channel !== "telegram" ||
        order.fulfillmentStatus !== "delivering"
      )
        throw new Error("Report delivery is not active");
      await this.store.database
        .update(paymentOrders)
        .set({
          fulfillment_status: uncertain
            ? "delivery_unknown"
            : order.paymentStatus === "refunded"
              ? "cancelled"
              : "ready",
          report_file_id: uncertain ? order.reportFileId : null,
        })
        .where(eq(paymentOrders.id, orderId));
    });
  }
}
