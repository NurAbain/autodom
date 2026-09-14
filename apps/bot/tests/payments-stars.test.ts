import type { PaymentOrder } from "@autodom/core/payments";
import type { VinCheckResult } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
import { Api } from "grammy";
import { expect, it, vi } from "vitest";
import { VIN_REPORT_OWNER, VIN_REPORT_TERMS } from "../src/payment-text.js";
import { loadVinReportStarsEnabled, PaymentService } from "../src/payments.js";

const id = "00000000-0000-4000-8000-000000000042";
const vin = "KMHDU41DBAU123456";
const result: VinCheckResult = {
  vin,
  checked_at: 1,
  carhistory: { status: "available", source_url: "https://www.carhistory.or.kr/", checked_at: 1 },
  car365: {
    status: "unavailable",
    source_url: "https://www.car365.go.kr/",
    checked_at: 1,
    data: null,
  },
};
function fixture() {
  const store = {
    withLock: async <T>(_key: string, action: () => Promise<T>) => action(),
  } as unknown as Store;
  const api = new Api("12345:stars-fixture");
  const service = new PaymentService(
    store,
    undefined,
    async () => new Response("%PDF-1.7\nfixture"),
  );
  service.configureStars(api, true, "12345:stars-fixture");
  return { service, api };
}
function paidOrder(): PaymentOrder {
  return {
    id,
    userId: 42,
    vin,
    product: "vin_report",
    provider: "telegram_stars",
    currency: "XTR",
    amount: 500,
    title: "Корейский PDF",
    description: "PDF",
    seller: "Autodom",
    executor: "Autodom",
    supportUrl: "https://t.me/autodom_fixture?start=paysupport",
    terms: VIN_REPORT_TERMS,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-09-14T00:00:00.000Z",
    acceptedAt: "2026-09-14T00:00:01.000Z",
    paidAt: "2026-09-14T00:00:02.000Z",
    invoiceUrl: "https://t.me/$fixture",
    invoiceStatus: "pending",
    paymentStatus: "paid",
    fulfillmentStatus: "ready",
    chargeId: "fixture-charge",
    needsReview: false,
    preCheckoutId: "fixture-checkout",
    reportFileId: null,
    reportMessageId: null,
    deliveredAt: null,
    adminNotifiedAt: null,
    refundPending: false,
  };
}

it("requires exact opt-in and rejects misspelled sales configuration", () => {
  expect(loadVinReportStarsEnabled({})).toBe(false);
  expect(loadVinReportStarsEnabled({ AUTODOM_VIN_REPORT_STARS_ENABLED: "true" })).toBe(true);
  expect(() => loadVinReportStarsEnabled({ AUTODOM_VIN_REPORT_STARS_ENABLED: "TRUE" })).toThrow();
});

it("does not restore eligibility when an older Korean lookup completes after a newer lookup began", async () => {
  const { service } = fixture();
  const older = service.forgetVinResult(42, vin);
  service.forgetVinResult(42, vin);
  service.rememberVinResult(42, result, older);
  await expect(service.reportOffer(42, vin)).rejects.toMatchObject({ status: 409 });
});

it("never grants another buyer the first buyer's Korean eligibility", async () => {
  const { service } = fixture();
  const revision = service.forgetVinResult(42, vin);
  service.rememberVinResult(42, result, revision);
  await expect(service.reportOffer(43, vin)).rejects.toMatchObject({ status: 409 });
});

it("rejects unauthorized delivery, refund, support reply, and another buyer's PDF download", async () => {
  const { service } = fixture();
  vi.spyOn(service.ledger, "getOrder").mockResolvedValue(paidOrder());
  await expect(service.deliverReport(43, id, "pdf-file")).rejects.toMatchObject({ status: 403 });
  await expect(service.refundReport(43, id)).rejects.toMatchObject({ status: 403 });
  await expect(service.paymentSupportReply(43, 42, "hello")).rejects.toMatchObject({ status: 403 });
  await expect(service.downloadReport(43, id)).rejects.toMatchObject({ status: 404 });
});

it("requires explicit terms even for the buyer of an existing invoice", async () => {
  const { service } = fixture();
  await expect(service.checkout(42, id, false)).rejects.toMatchObject({ status: 400 });
});

it("keeps an ambiguous refund pending and only confirms it on a successful retry", async () => {
  const { service, api } = fixture();
  const order = paidOrder();
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  vi.spyOn(service.ledger, "requestRefund").mockImplementation(async () => {
    order.refundPending = true;
    return {
      id: "refund-fixture",
      orderId: id,
      provider: "telegram_stars",
      amount: 500,
      reason: "Unable to deliver",
      status: "requested",
      createdAt: order.createdAt,
    };
  });
  vi.spyOn(service.ledger, "markRefund").mockImplementation(async (_id, state) => {
    if (state === "confirmed") {
      order.paymentStatus = "refunded";
      order.refundPending = false;
    }
  });
  vi.spyOn(api, "refundStarPayment")
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce(true);
  await expect(service.refundReport(VIN_REPORT_OWNER, id)).rejects.toMatchObject({ status: 503 });
  expect(await service.ownedOrder(42, id)).toMatchObject({
    paymentStatus: "paid",
    refundPending: true,
  });
  expect(await service.refundReport(VIN_REPORT_OWNER, id)).toMatchObject({
    paymentStatus: "refunded",
    refundPending: false,
  });
});

it("blocks a second PDF send after an ambiguous Telegram outcome", async () => {
  const { service, api } = fixture();
  const order = paidOrder();
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  vi.spyOn(service.ledger, "beginReportDelivery").mockImplementation(async (_id, fileId) => {
    order.fulfillmentStatus = "delivering";
    order.reportFileId = fileId;
    return { ...order };
  });
  vi.spyOn(service.ledger, "failReportDelivery").mockImplementation(async (_id, uncertain) => {
    order.fulfillmentStatus = uncertain ? "delivery_unknown" : "ready";
  });
  vi.spyOn(api, "getFile").mockResolvedValue({
    file_id: "pdf-file",
    file_unique_id: "unique",
    file_path: "documents/file_1.pdf",
    file_size: 16,
  });
  const send = vi
    .spyOn(api, "sendDocument")
    .mockRejectedValue(new Error("Connection lost after send"));
  await expect(service.deliverReport(VIN_REPORT_OWNER, id, "pdf-file")).rejects.toMatchObject({
    status: 503,
  });
  expect(await service.ownedOrder(42, id)).toMatchObject({ fulfillmentStatus: "delivery_unknown" });
  await expect(service.deliverReport(VIN_REPORT_OWNER, id, "pdf-file")).rejects.toMatchObject({
    status: 409,
  });
  expect(send).toHaveBeenCalledTimes(1);
});
