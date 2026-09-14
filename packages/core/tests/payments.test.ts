import { describe, expect, it } from "vitest";
import {
  finikPaymentId,
  parseFinikPaymentId,
  validatePaymentAmount,
  validatePaymentEvent,
  validatePaymentOffer,
  validatePaymentTimestamp,
} from "../src/payments.js";

describe("Finik merchant identity and exact monetary boundaries", () => {
  it("round trips only canonical lowercase merchant UUIDs", () => {
    const id = "fd5ab9a9-1bf0-4f23-9b3d-8f22353a40c5";
    expect(finikPaymentId(id)).toBe("ad_fd5ab9a91bf04f239b3d8f22353a40c5");
    expect(parseFinikPaymentId(finikPaymentId(id))).toBe(id);
    expect(parseFinikPaymentId("other_fd5ab9a91bf04f239b3d8f22353a40c5")).toBeNull();
    expect(parseFinikPaymentId(finikPaymentId(id).toUpperCase())).toBeNull();
    expect(() => finikPaymentId(id.toUpperCase())).toThrow();
  });
  it("rejects rounded and unsafe monetary input", () => {
    for (const amount of [
      0,
      -100,
      1.1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() => validatePaymentAmount(amount)).toThrow();
    expect(() => validatePaymentAmount(101, true)).toThrow();
  });
  it("rejects timezone ambiguity and calendar rollover", () => {
    expect(() => validatePaymentTimestamp("2026-02-30T12:00:00Z")).toThrow();
    expect(() => validatePaymentTimestamp("2026-09-12T12:00:00")).toThrow();
    expect(() => validatePaymentTimestamp("2026-09-12T24:00:00Z")).toThrow();
  });
});

describe("Stars rail validation", () => {
  it("requires a canonical VIN only for digital reports without scaling whole Stars", () => {
    const report = {
      userId: 1,
      product: "vin_report" as const,
      vin: "KMHCT41DADU123456",
      amount: 500,
      title: "Report",
      description: "Korean PDF",
      seller: "Seller",
      executor: "Owner",
      supportUrl: "https://example.com/support",
      terms: "PDF within 60 minutes or full refund",
      expiresAt: "2026-09-14T12:00:00Z",
    };
    validatePaymentOffer(report);
    expect(() => validatePaymentOffer({ ...report, vin: report.vin.toLowerCase() })).toThrow();
    expect(() => validatePaymentOffer({ ...report, vin: null })).toThrow();
    expect(() => validatePaymentOffer({ ...report, amount: 0.5 })).toThrow();
    expect(() => validatePaymentOffer({ ...report, product: "inspection" })).toThrow();
    expect(() =>
      validatePaymentOffer({
        ...report,
        product: "inspection",
        vin: null,
        amount: 501,
      }),
    ).toThrow();
  });
  it("requires a buyer on Stars receipts and preserves Finik's paid-only transport", () => {
    const event = {
      provider: "telegram_stars" as const,
      kind: "refunded" as const,
      eventId: "refund:charge",
      orderId: null,
      userId: 1,
      chargeId: "charge",
      currency: "XTR",
      amount: 500,
      occurredAt: "2026-09-14T12:00:00Z",
    };
    validatePaymentEvent(event);
    expect(() => validatePaymentEvent({ ...event, userId: null })).toThrow();
    expect(() => validatePaymentEvent({ ...event, userId: 1.1 })).toThrow();
    expect(() => validatePaymentEvent({ ...event, provider: "finik", userId: null })).toThrow();
    expect(() => validatePaymentEvent({ ...event, provider: "finik", kind: "paid" })).toThrow();
  });
});
