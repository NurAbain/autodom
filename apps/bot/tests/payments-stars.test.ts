import { finikPaymentId, type PaymentOrder } from "@autodom/core/payments";
import type { VinCheckResult } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
import { Api } from "grammy";
import { expect, it, vi } from "vitest";
import {
  VIN_REPORT_OWNER,
  VIN_REPORT_TELEGRAM_FINIK_TERMS,
  VIN_REPORT_TERMS,
} from "../src/payment-text.js";
import {
  type FinikGatewaySettings,
  loadVinReportStarsEnabled,
  loadVinReportTelegramFinikEnabled,
  PaymentService,
} from "../src/payments.js";

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
function fixture(
  options: {
    nativeFinikEnabled?: boolean;
    starsEnabled?: boolean;
    gateway?: FinikGatewaySettings;
    fetcher?: typeof fetch;
  } = {},
) {
  const store = {
    withLock: async <T>(_key: string, action: () => Promise<T>) => action(),
  } as unknown as Store;
  const api = new Api("12345:stars-fixture");
  const service = new PaymentService(
    store,
    options.gateway,
    options.fetcher ?? (async () => new Response("%PDF-1.7\nfixture")),
    false,
    options.nativeFinikEnabled ?? false,
  );
  service.configureStars(api, options.starsEnabled ?? true, "12345:stars-fixture");
  return { service, api };
}
function paidOrder(): PaymentOrder {
  return {
    id,
    userId: 42,
    vin,
    product: "vin_report",
    reportKind: "korea",
    provider: "telegram_stars",
    channel: "telegram",
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
      confirmedBy: null,
      confirmationReference: null,
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

const gateway = { url: "https://payments.autodom.kg", token: "server-only-fixture" };

function finikOrder(): PaymentOrder {
  return {
    ...paidOrder(),
    provider: "finik",
    amount: 49900,
    currency: "KGS",
    terms: VIN_REPORT_TELEGRAM_FINIK_TERMS,
    invoiceUrl: `https://qr.finik.kg/${id}?type=t`,
    paymentStatus: "unpaid",
    paidAt: null,
    chargeId: null,
    preCheckoutId: null,
  };
}

it("requires exact native Finik opt-in and never falls back to Stars when misconfigured", async () => {
  expect(loadVinReportTelegramFinikEnabled({})).toBe(false);
  expect(
    loadVinReportTelegramFinikEnabled({
      AUTODOM_VIN_REPORT_TELEGRAM_FINIK_ENABLED: "true",
    }),
  ).toBe(true);
  expect(() =>
    loadVinReportTelegramFinikEnabled({
      AUTODOM_VIN_REPORT_TELEGRAM_FINIK_ENABLED: "TRUE",
    }),
  ).toThrow();
  const { service } = fixture({ nativeFinikEnabled: true });
  const revision = service.forgetVinResult(42, vin);
  service.rememberVinResult(42, result, revision);
  expect(service.reportSalesEnabled).toBe(false);
  await expect(service.reportOffer(42, vin)).rejects.toMatchObject({ status: 503 });
});

it("keeps legacy Stars checkout approval independent of native Finik availability", async () => {
  const { service, api } = fixture({ nativeFinikEnabled: true });
  vi.spyOn(service.ledger, "reserveStarsCheckout").mockResolvedValue(true);
  const answer = vi.spyOn(api, "answerPreCheckoutQuery").mockResolvedValue(true);
  await service.approveStarsCheckout({
    id: "legacy-checkout",
    from: { id: 42, is_bot: false, first_name: "Buyer" },
    currency: "XTR",
    total_amount: 500,
    invoice_payload: id,
  });
  expect(answer.mock.calls[0]?.[1]).toBe(true);
});

it("creates an accepted native Finik invoice without Stars and reuses it without another charge", async () => {
  const order = finikOrder();
  order.invoiceUrl = null;
  order.acceptedAt = null;
  order.invoiceStatus = "offered";
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    expect(order.acceptedAt).not.toBeNull();
    expect(String(url)).toBe(`${gateway.url}/v1/autodom/report-invoices`);
    return Response.json({
      invoice_id: finikPaymentId(id),
      invoice_url: `https://qr.finik.kg/${id}?type=t`,
    });
  });
  const { service } = fixture({ nativeFinikEnabled: true, starsEnabled: false, gateway, fetcher });
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  vi.spyOn(service.ledger, "acceptOrder").mockImplementation(async () => {
    order.acceptedAt = new Date().toISOString();
    return { ...order };
  });
  vi.spyOn(service.ledger, "setInvoice").mockImplementation(async (_id, url) => {
    order.invoiceUrl = url;
    order.invoiceStatus = "pending";
  });
  const first = await service.checkout(42, id, true);
  const second = await service.checkout(42, id, true);
  expect(first.invoiceUrl).toBe(`https://qr.finik.kg/${id}?type=t`);
  expect(second.invoiceUrl).toBe(first.invoiceUrl);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(second.paymentStatus).toBe("unpaid");
});

it("never exposes bank or card choices for another buyer, a website order, or an ineligible order", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const { service } = fixture({ nativeFinikEnabled: true, starsEnabled: false, gateway, fetcher });
  const order = finikOrder();
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  await expect(service.paymentMethods(43, id)).rejects.toMatchObject({ status: 404 });
  order.channel = "web";
  await expect(service.cardPaymentUrl(42, id)).rejects.toMatchObject({ status: 404 });
  order.channel = "telegram";
  for (const change of [
    { acceptedAt: null },
    { paymentStatus: "paid" as const },
    { needsReview: true },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { refundPending: true },
  ]) {
    Object.assign(order, finikOrder(), change);
    await expect(service.paymentMethods(42, id)).rejects.toMatchObject({ status: 409 });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not return payment links if a receipt settles the order while the gateway responds", async () => {
  const order = finikOrder();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    order.paymentStatus = "paid";
    return Response.json({ card_url: "https://cards.bank.kg/pay/fixture" });
  });
  const { service } = fixture({ nativeFinikEnabled: true, starsEnabled: false, gateway, fetcher });
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  await expect(service.cardPaymentUrl(42, id)).rejects.toMatchObject({ status: 409 });
});

it("returns transaction-specific bank choices without marking paid and rejects unsafe card targets", async () => {
  const order = finikOrder();
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ invoice_url: order.invoiceUrl });
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${gateway.token}` });
    return Response.json({
      banks: [{ name: "Bank", url: "https://bank.kg/pay/fixture", logo_url: null }],
    });
  });
  const { service } = fixture({ nativeFinikEnabled: true, starsEnabled: false, gateway, fetcher });
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  expect(await service.paymentMethods(42, id)).toEqual({
    banks: [{ name: "Bank", url: "https://bank.kg/pay/fixture", logoUrl: null }],
  });
  expect((await service.ownedOrder(42, id)).paymentStatus).toBe("unpaid");
  for (const card_url of [
    "javascript:alert(1)",
    "https://127.0.0.1/pay",
    "https://bank.kg@evil.kg/pay",
    "https://bank.kg/pay%0aevil",
    "https://bank.kg:8443/pay",
  ]) {
    fetcher.mockResolvedValueOnce(Response.json({ card_url }));
    await expect(service.cardPaymentUrl(42, id)).rejects.toMatchObject({ status: 503 });
  }
});

it("leaves native Finik refunds pending for owner proof instead of refunding Stars", async () => {
  const order = { ...finikOrder(), paymentStatus: "paid" as const, chargeId: "finik-charge" };
  const { service, api } = fixture({ nativeFinikEnabled: true, starsEnabled: false, gateway });
  vi.spyOn(service.ledger, "getOrder").mockImplementation(async () => ({ ...order }));
  vi.spyOn(service.ledger, "requestRefund").mockImplementation(async () => {
    order.refundPending = true;
    return {
      id: "finik-refund",
      orderId: id,
      provider: "finik",
      amount: order.amount,
      reason: "Unable to deliver",
      status: "requested",
      createdAt: order.createdAt,
      confirmedBy: null,
      confirmationReference: null,
    };
  });
  const starsRefund = vi.spyOn(api, "refundStarPayment").mockResolvedValue(true);
  expect(await service.refundReport(VIN_REPORT_OWNER, id)).toMatchObject({
    paymentStatus: "paid",
    refundPending: true,
  });
  expect(starsRefund).not.toHaveBeenCalled();
});
