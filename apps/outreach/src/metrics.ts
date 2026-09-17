import { Counter, collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";
import type pg from "pg";

const entityKinds = ["marketplace_campaign", "social_campaign", "instagram_watch"] as const;
const entityStatuses = ["draft", "running", "paused", "completed", "cancelled"] as const;
const deliveryStatuses = ["pending", "sending", "sent", "failed", "unknown", "skipped"] as const;
export const outreachTickComponents = ["marketplace", "social", "instagram_watch"] as const;
export type OutreachTickComponent = (typeof outreachTickComponents)[number];

type EntityRow = {
  kind: (typeof entityKinds)[number];
  status: (typeof entityStatuses)[number];
  error: boolean;
  amount: number;
};
type DeliveryRow = {
  kind: (typeof entityKinds)[number];
  status: (typeof deliveryStatuses)[number];
  amount: number;
};

export class OutreachMetrics {
  readonly registry = new Registry();
  private readonly entities: Gauge<"kind" | "status" | "error">;
  private readonly deliveries: Gauge<"kind" | "status">;
  private readonly tickSuccess: Gauge<"component">;
  private readonly tickTimestamp: Gauge<"component">;
  private readonly tickErrors: Counter<"component">;

  constructor(private readonly pool: pg.Pool) {
    this.registry.setDefaultLabels({ application: "autodom", role: "outreach" });
    collectDefaultMetrics({ register: this.registry, prefix: "autodom_" });
    this.entities = new Gauge({
      name: "autodom_outreach_entities",
      help: "Campaigns and Instagram watches by state; error is true when last_error is present",
      labelNames: ["kind", "status", "error"],
      registers: [this.registry],
    });
    this.deliveries = new Gauge({
      name: "autodom_outreach_deliveries",
      help: "Marketplace, social, and Instagram delivery observations by state",
      labelNames: ["kind", "status"],
      registers: [this.registry],
    });
    this.tickSuccess = new Gauge({
      name: "autodom_outreach_queue_tick_success",
      help: "Whether the latest queue tick completed without an infrastructure error",
      labelNames: ["component"],
      registers: [this.registry],
    });
    this.tickTimestamp = new Gauge({
      name: "autodom_outreach_queue_tick_timestamp_seconds",
      help: "Unix timestamp of the latest completed queue tick",
      labelNames: ["component"],
      registers: [this.registry],
    });
    this.tickErrors = new Counter({
      name: "autodom_outreach_queue_tick_errors_total",
      help: "Queue tick infrastructure errors",
      labelNames: ["component"],
      registers: [this.registry],
    });
    for (const component of outreachTickComponents) {
      this.tickSuccess.set({ component }, 0);
      this.tickTimestamp.set({ component }, 0);
    }
  }

  recordTick(component: OutreachTickComponent, success: boolean): void {
    this.tickSuccess.set({ component }, success ? 1 : 0);
    this.tickTimestamp.set({ component }, Date.now() / 1000);
    if (!success) this.tickErrors.inc({ component });
  }

  private async collectDatabaseState(): Promise<void> {
    const [entities, deliveries] = await Promise.all([
      this.pool.query<EntityRow>(`
        SELECT kind,status,(last_error IS NOT NULL) error,COUNT(*)::integer amount
        FROM (
          SELECT 'marketplace_campaign'::text kind,status,last_error FROM autodom_outreach.campaigns
          UNION ALL
          SELECT 'social_campaign'::text kind,status,last_error FROM autodom_outreach.social_campaigns
          UNION ALL
          SELECT 'instagram_watch'::text kind,status,last_error FROM autodom_outreach.instagram_watches
        ) state
        GROUP BY kind,status,error
      `),
      this.pool.query<DeliveryRow>(`
        SELECT kind,status,COUNT(*)::integer amount
        FROM (
          SELECT 'marketplace_campaign'::text kind,status FROM autodom_outreach.deliveries
          UNION ALL
          SELECT 'social_campaign'::text kind,status FROM autodom_outreach.social_deliveries
          UNION ALL
          SELECT 'instagram_watch'::text kind,status FROM autodom_outreach.instagram_observations
        ) state
        GROUP BY kind,status
      `),
    ]);
    this.entities.reset();
    this.deliveries.reset();
    for (const kind of entityKinds)
      for (const status of entityStatuses)
        for (const error of [false, true])
          this.entities.set({ kind, status, error: String(error) }, 0);
    for (const kind of entityKinds)
      for (const status of deliveryStatuses) this.deliveries.set({ kind, status }, 0);
    for (const row of entities.rows)
      this.entities.set(
        { kind: row.kind, status: row.status, error: String(row.error) },
        row.amount,
      );
    for (const row of deliveries.rows)
      this.deliveries.set({ kind: row.kind, status: row.status }, row.amount);
  }

  async render(): Promise<string> {
    await this.collectDatabaseState();
    return this.registry.metrics();
  }
}
