import { Gauge, type Registry } from "@prometheus-io/client";
import pg from "pg";
import type { AnalyticsEventName, AnalyticsRecorder } from "./analytics-contract.js";

interface LedgerRow {
  id: string;
  user_id: string;
  vin: string;
  report_kind: "korea" | "carfax";
  channel: "telegram" | "web";
  created_at: string;
  accepted_at: string | null;
  paid_at: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
}

/** Read confirmed business state, including changes made by webhooks and operator CLI.
 * Replays use original ledger timestamps and stable event keys; no polling inflation.
 * This connection never writes the financial tables or holds their business locks.
 */
export class PaymentAnalytics {
  private readonly pool: pg.Pool;
  private flight: Promise<void> | undefined;
  private cursor = "";
  private readonly success: Gauge;
  private readonly timestamp: Gauge;

  constructor(
    databaseUrl: string,
    private readonly analytics: AnalyticsRecorder,
    registry: Registry,
  ) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1500,
      statement_timeout: 2000,
      query_timeout: 2500,
      idleTimeoutMillis: 10000,
    });
    this.pool.on("error", () => this.success.set(0));
    this.success = new Gauge({
      name: "autodom_product_ledger_collection_success",
      help: "Last financial analytics sweep completed",
      registers: [registry],
    });
    this.timestamp = new Gauge({
      name: "autodom_product_ledger_collection_timestamp_seconds",
      help: "Last completed financial analytics sweep",
      registers: [registry],
    });
    this.success.set(0);
    this.timestamp.set(0);
  }

  refresh(): Promise<void> {
    this.flight ??= this.collect().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }

  private async collect(): Promise<void> {
    try {
      // At most 200 orders per tick. A long sweep resumes at the cursor next tick.
      // Customers deleted from analytics remain suppressed by the recorder.
      const { rows } = await this.pool.query<LedgerRow>(
        `
        SELECT o.id, o.user_id, o.vin, coalesce(o.report_kind,'korea') AS report_kind,
          o.channel, o.created_at, o.accepted_at, o.paid_at, o.delivered_at,
          CASE WHEN o.payment_status = 'refunded' THEN coalesce(
            (SELECT min(e.data->>'occurredAt') FROM payment_events e
              WHERE e.order_id=o.id AND e.outcome='applied' AND e.data->>'kind'='refunded'),
            (SELECT min(r.updated_at) FROM payment_refunds r
              WHERE r.order_id=o.id AND r.status='confirmed')) END AS refunded_at
        FROM payment_orders o
        WHERE o.product='vin_report' AND o.id > $1 AND NOT o.needs_review
          AND (o.created_at >= $2 OR o.paid_at >= $2 OR o.delivered_at >= $2
            OR EXISTS (SELECT 1 FROM payment_refunds r WHERE r.order_id=o.id AND r.updated_at >= $2))
        ORDER BY o.id LIMIT 200`,
        [this.cursor, new Date(Date.now() - 90 * 86400000).toISOString()],
      );
      for (const row of rows) {
        const milestones: [AnalyticsEventName, string | null][] = [
          ["order_created", row.created_at],
          ["terms_accepted", row.accepted_at],
          ["payment_succeeded", row.paid_at],
          ["report_delivered", row.delivered_at],
          ["payment_refunded", row.refunded_at],
        ];
        for (const [event, timestamp] of milestones) {
          if (!timestamp) continue;
          const occurredAt = new Date(timestamp);
          if (
            !Number.isFinite(occurredAt.getTime()) ||
            occurredAt.getTime() < Date.now() - 90 * 86400000
          )
            continue;
          await this.analytics.record({
            actorId: Number(row.user_id),
            contextKey: row.vin,
            event,
            surface: row.channel === "web" ? "web" : "system",
            flow: "report",
            reportKind: row.report_kind,
            dedupeKey: `ledger:${row.id}:${event}`,
            occurredAt,
          });
        }
      }
      if (rows.length < 200) {
        this.cursor = "";
        this.success.set(1);
        this.timestamp.set(Date.now() / 1000);
      } else {
        this.cursor = rows.at(-1)!.id;
      }
    } catch {
      this.success.set(0);
    }
  }

  async close(): Promise<void> {
    await this.flight;
    await this.pool.end();
  }
}
