import { randomUUID } from "node:crypto";
import { Store } from "@autodom/storage";
import { PaymentStore } from "@autodom/storage/payments";
import { Registry } from "@prometheus-io/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ProductAnalytics } from "../src/analytics.js";
import { PaymentAnalytics } from "../src/analytics-payments.js";

let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Pool;
let url: string;
const database = `analytics_payments_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  let base = process.env.AUTODOM_TEST_DATABASE_URL;
  if (!base) {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    base = container.getConnectionUri();
  }
  admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE DATABASE "${database}"`);
  const address = new URL(base);
  address.pathname = `/${database}`;
  url = address.href;
});
afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end();
  await container?.stop();
});

it("replays only authoritative milestones once across restarts and never resurrects deleted analytics", async () => {
  const store = await Store.open(url);
  const ledger = new PaymentStore(store);
  await ProductAnalytics.migrate(url);
  let analytics = new ProductAnalytics(url, "diagnostic-shared-secret-at-least-32-bytes", "vin");
  let reader = new PaymentAnalytics(url, analytics, new Registry());
  const count = (name: string) =>
    analytics
      .getSnapshot()
      ?.events.filter((event) => event.window === "1d" && event.event === name)
      .reduce((sum, event) => sum + event.value, 0) ?? 0;
  try {
    const order = await ledger.createFinikReportOffer(
      {
        userId: 801,
        vin: "KMHDU41DBAU123456",
        product: "vin_report",
        reportKind: "korea",
        amount: 49900,
        title: "Diagnostic report",
        description: "Isolated verification, not a vehicle history",
        seller: "Diagnostic",
        executor: "Diagnostic",
        supportUrl: "https://example.com/support",
        terms: "Diagnostic only",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      "telegram",
    );
    await ledger.acceptOrder(order.id, order.userId);
    await ledger.setInvoice(order.id, "https://qr.finik.kg/diagnostic");
    await reader.refresh();
    await analytics.refresh();
    expect(count("payment_succeeded")).toBe(0);
    const receipt = {
      provider: "finik" as const,
      kind: "paid" as const,
      eventId: randomUUID(),
      chargeId: randomUUID(),
      orderId: order.id,
      userId: null,
      currency: "KGS",
      amount: 49900,
      occurredAt: new Date().toISOString(),
    };
    expect(await ledger.ingestEvent(receipt)).toBe("applied");
    expect(await ledger.ingestEvent(receipt)).toBe("duplicate");
    await ledger.beginReportDelivery(order.id, "diagnostic-pdf");
    await ledger.finishReportDelivery(order.id, 7);
    await reader.refresh();
    await reader.refresh();
    await analytics.refresh();
    expect(count("payment_succeeded")).toBe(1);
    expect(count("report_delivered")).toBe(1);
    // No observed client start exists: the journal must not fabricate one.
    expect(analytics.getSnapshot()?.funnels).toEqual([]);
    await reader.close();
    await analytics.close();
    analytics = new ProductAnalytics(url, "diagnostic-shared-secret-at-least-32-bytes", "vin");
    reader = new PaymentAnalytics(url, analytics, new Registry());
    await reader.refresh();
    await analytics.refresh();
    expect(count("payment_succeeded")).toBe(1);
    await ledger.requestRefund(order.id, order.amount, "Diagnostic refund");
    await ledger.confirmFinikReportRefund(order.id, 706854211, "diagnostic-reference");
    await reader.refresh();
    await analytics.refresh();
    expect(count("payment_refunded")).toBe(1);
    expect(count("payment_succeeded")).toBe(1);
    expect(await analytics.forget(order.userId)).toBe(true);
    await reader.refresh();
    await analytics.refresh();
    expect(count("payment_succeeded")).toBe(0);
    expect(count("payment_refunded")).toBe(0);
    expect((await ledger.getOrder(order.id))?.paymentStatus).toBe("refunded");
  } finally {
    await reader.close();
    await analytics.close();
    await store.close();
  }
});
