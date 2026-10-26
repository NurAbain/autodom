import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  type DeliveryStatus,
  ServiceError,
  type SocialCampaign,
  type SocialCampaignDetail,
  type SocialCampaignInput,
  type SocialDelivery,
  type SocialPlatform,
  type SocialTarget,
  socialCampaignSchema,
} from "./contracts.js";
import {
  type InstagramCredentials,
  type InstagramPrivateClient,
  InstagramPrivateError,
} from "./instagram-private.js";

const LEADER_KEY = [1096111183, 1936682089] as const;
const uuidSchema = z.string().uuid();
const graphVersionSchema = z.string().regex(/^v[1-9][0-9]*\.[0-9]+$/);
type CampaignRow = {
  id: string;
  input: unknown;
  status: SocialCampaign["status"];
  created_at: Date;
  last_error: string | null;
};
type DeliveryRow = {
  id: string;
  campaign_id: string;
  target: unknown;
  status: DeliveryStatus;
  error: string | null;
  remote_id: string | null;
  updated_at: Date;
};
type PendingRow = DeliveryRow & { input: unknown };

type TokenReader = (projectId: string, platform: SocialPlatform) => Promise<string>;
type InstagramCredentialReader = (projectId: string) => Promise<InstagramCredentials>;
type InstagramSessionWriter = (
  projectId: string,
  session: Record<string, unknown>,
) => Promise<void>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceError(400, "Некорректные параметры запроса");
  return parsed.data;
}

function targetHost(platform: SocialPlatform, raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const allowed =
      platform === "instagram"
        ? ["instagram.com", "www.instagram.com"]
        : platform === "facebook"
          ? ["facebook.com", "www.facebook.com", "m.facebook.com"]
          : ["threads.net", "www.threads.net"];
    return allowed.includes(url.hostname);
  } catch {
    return false;
  }
}

export class SocialCampaignService {
  private ticking = false;
  private readonly graphVersion: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly token: TokenReader,
    private readonly sendEnabled: boolean,
    graphVersion = "v26.0",
    private readonly request: typeof fetch = fetch,
    private readonly instagram?: InstagramPrivateClient,
    private readonly instagramCredentials?: InstagramCredentialReader,
    private readonly saveInstagramSession?: InstagramSessionWriter,
  ) {
    this.graphVersion = graphVersionSchema.parse(graphVersion);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "Хранилище социальных кампаний временно недоступно");
    }
  }

  private async transaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const result = await work();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async init(): Promise<void> {
    return this.safe(async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS autodom_outreach.social_campaigns (
          id uuid PRIMARY KEY, input jsonb NOT NULL,
          project_id uuid NOT NULL REFERENCES autodom_outreach.projects(id) ON DELETE CASCADE,
          platform text NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
          status text NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','running','paused','completed','cancelled')),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_error text
        );
        CREATE TABLE IF NOT EXISTS autodom_outreach.social_deliveries (
          id uuid PRIMARY KEY,
          campaign_id uuid NOT NULL REFERENCES autodom_outreach.social_campaigns(id) ON DELETE CASCADE,
          target jsonb NOT NULL, position integer NOT NULL,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','sending','sent','failed','unknown','skipped')),
          error text, remote_id text, attempted_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          UNIQUE (campaign_id,position)
        );
        CREATE INDEX IF NOT EXISTS outreach_social_queue
          ON autodom_outreach.social_deliveries(campaign_id,status,position);
        CREATE TABLE IF NOT EXISTS autodom_outreach.social_contacts (
          project_id uuid NOT NULL REFERENCES autodom_outreach.projects(id) ON DELETE CASCADE,
          platform text NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
          target_id text NOT NULL, delivery_id uuid REFERENCES autodom_outreach.social_deliveries(id),
          reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (project_id,platform,target_id)
        );
        CREATE TABLE IF NOT EXISTS autodom_outreach.social_pacing (
          project_id uuid NOT NULL REFERENCES autodom_outreach.projects(id) ON DELETE CASCADE,
          platform text NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
          last_attempt timestamptz, next_allowed timestamptz, attempt_day date,
          attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), blocked boolean NOT NULL DEFAULT false,
          PRIMARY KEY (project_id,platform)
        );
      `);
    });
  }

  async create(input: SocialCampaignInput): Promise<SocialCampaign> {
    const parsed = parse(socialCampaignSchema, input);
    if (parsed.targets.some((target) => !targetHost(parsed.platform, target.url)))
      throw new ServiceError(400, "Ссылка цели не относится к выбранной платформе");
    const unique = new Set(parsed.targets.map((target) => target.externalId));
    if (unique.size !== parsed.targets.length)
      throw new ServiceError(400, "Одна публикация указана несколько раз");
    return this.safe(async () => {
      const exists = await this.pool.query("SELECT 1 FROM autodom_outreach.projects WHERE id=$1", [
        parsed.projectId,
      ]);
      if (!exists.rowCount) throw new ServiceError(404, "Проект не найден");
      if (parsed.platform === "instagram") await this.requireInstagram(parsed.projectId);
      else await this.token(parsed.projectId, parsed.platform);
      const id = randomUUID();
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          await client.query(
            `INSERT INTO autodom_outreach.social_campaigns(id,input,project_id,platform)
             VALUES ($1,$2,$3,$4)`,
            [id, JSON.stringify(parsed), parsed.projectId, parsed.platform],
          );
          await client.query(
            `INSERT INTO autodom_outreach.social_deliveries(id,campaign_id,target,position)
             SELECT (item->>'id')::uuid,$1,item->'target',(item->>'position')::integer
             FROM jsonb_array_elements($2::jsonb) item`,
            [
              id,
              JSON.stringify(
                parsed.targets.map((target, position) => ({ id: randomUUID(), target, position })),
              ),
            ],
          );
          await client.query(
            `INSERT INTO autodom_outreach.social_pacing(project_id,platform)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [parsed.projectId, parsed.platform],
          );
        });
      } finally {
        client.release();
      }
      return this.getCampaign(id);
    });
  }

  private async campaigns(id?: string): Promise<SocialCampaign[]> {
    const rows = await this.pool.query<
      CampaignRow & { counts: Partial<Record<DeliveryStatus, number>> }
    >(
      `SELECT c.*,COALESCE(t.counts,'{}'::jsonb) counts
       FROM autodom_outreach.social_campaigns c
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(status,amount) counts FROM (
           SELECT status,COUNT(*)::integer amount FROM autodom_outreach.social_deliveries
           WHERE campaign_id=c.id GROUP BY status
         ) grouped
       ) t ON true ${id ? "WHERE c.id=$1" : ""}
       ORDER BY c.created_at DESC,c.id DESC`,
      id ? [id] : [],
    );
    return rows.rows.map((row) => ({
      ...parse(socialCampaignSchema, row.input),
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      counts: {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        ...row.counts,
      },
      lastError: row.last_error,
    }));
  }

  private async getCampaign(id: string): Promise<SocialCampaign> {
    const campaign = (await this.campaigns(id))[0];
    if (!campaign) throw new ServiceError(404, "Кампания не найдена");
    return campaign;
  }

  async list(): Promise<SocialCampaign[]> {
    return this.safe(() => this.campaigns());
  }

  async detail(id: string): Promise<SocialCampaignDetail> {
    parse(uuidSchema, id);
    return this.safe(async () => {
      const campaign = await this.getCampaign(id);
      const rows = await this.pool.query<DeliveryRow>(
        "SELECT * FROM autodom_outreach.social_deliveries WHERE campaign_id=$1 ORDER BY position",
        [id],
      );
      const deliveries: SocialDelivery[] = rows.rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        target: parse(socialCampaignSchema.shape.targets.element, row.target) as SocialTarget,
        status: row.status,
        error: row.error,
        remoteId: row.remote_id,
        updatedAt: row.updated_at.toISOString(),
      }));
      const counts: SocialCampaign["counts"] = {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
      };
      for (const delivery of deliveries) counts[delivery.status]++;
      return { campaign: { ...campaign, counts }, deliveries };
    });
  }

  private endpoint(platform: SocialPlatform, path: string): string {
    const origin =
      platform === "threads"
        ? "https://graph.threads.net/v1.0"
        : platform === "instagram"
          ? `https://graph.instagram.com/${this.graphVersion}`
          : `https://graph.facebook.com/${this.graphVersion}`;
    return `${origin}/${path}`;
  }

  private async requireInstagram(projectId: string): Promise<InstagramCredentials> {
    if (!this.instagram || !this.instagramCredentials || !this.saveInstagramSession)
      throw new ServiceError(409, "Private API Instagram не настроен");
    return this.instagramCredentials(projectId);
  }

  private async checkToken(projectId: string, platform: SocialPlatform): Promise<void> {
    if (platform === "instagram") {
      const credentials = await this.requireInstagram(projectId);
      try {
        const checked = await this.instagram?.check(credentials);
        if (!checked) throw new ServiceError(409, "Private API Instagram не настроен");
        await this.saveInstagramSession?.(projectId, checked.session);
        return;
      } catch (error) {
        if (error instanceof InstagramPrivateError) throw new ServiceError(409, error.message);
        throw error;
      }
    }
    const token = await this.token(projectId, platform);
    let response: Response;
    try {
      response = await this.request(this.endpoint(platform, "me?fields=id"), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new ServiceError(409, "Не удалось проверить токен платформы");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(409, `Платформа отклонила токен (HTTP ${response.status})`);
    }
    await response.body?.cancel();
  }

  async action(
    id: string,
    action: "start" | "pause" | "cancel",
    confirmed: boolean,
  ): Promise<SocialCampaign> {
    parse(uuidSchema, id);
    parse(z.enum(["start", "pause", "cancel"]), action);
    return this.safe(async () => {
      const campaign = await this.getCampaign(id);
      if (["completed", "cancelled"].includes(campaign.status))
        throw new ServiceError(409, "Завершённую кампанию нельзя изменить");
      if (action === "start") {
        if (!confirmed) throw new ServiceError(400, "Требуется явное подтверждение публикации");
        if (!this.sendEnabled)
          throw new ServiceError(409, "Отправка отключена конфигурацией сервиса");
        await this.checkToken(campaign.projectId, campaign.platform);
      }
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          const locked = (
            await client.query<CampaignRow>(
              "SELECT * FROM autodom_outreach.social_campaigns WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (!locked) throw new ServiceError(404, "Кампания не найдена");
          if (["completed", "cancelled"].includes(locked.status))
            throw new ServiceError(409, "Завершённую кампанию нельзя изменить");
          if (action === "start" && !["draft", "paused"].includes(locked.status))
            throw new ServiceError(409, "Кампания уже запущена");
          if (action === "pause" && locked.status !== "running")
            throw new ServiceError(409, "Приостановить можно только запущенную кампанию");
          await client.query(
            "UPDATE autodom_outreach.social_campaigns SET status=$2,last_error=NULL WHERE id=$1",
            [id, action === "start" ? "running" : action === "pause" ? "paused" : "cancelled"],
          );
          if (action === "start")
            await client.query(
              "UPDATE autodom_outreach.social_pacing SET blocked=false WHERE project_id=$1 AND platform=$2",
              [campaign.projectId, campaign.platform],
            );
          if (action === "cancel")
            await client.query(
              "UPDATE autodom_outreach.social_deliveries SET status='skipped',error='Кампания отменена',updated_at=clock_timestamp() WHERE campaign_id=$1 AND status='pending'",
              [id],
            );
        });
      } finally {
        client.release();
      }
      return this.getCampaign(id);
    });
  }

  private async publish(
    projectId: string,
    platform: SocialPlatform,
    target: SocialTarget,
    text: string,
    token?: string,
  ): Promise<string> {
    if (platform === "instagram") {
      const credentials = await this.requireInstagram(projectId);
      try {
        const result = await this.instagram?.comment(credentials, target.externalId, text);
        if (!result) throw new ServiceError(409, "Private API Instagram не настроен");
        await this.saveInstagramSession?.(projectId, result.session);
        return result.remoteId;
      } catch (error) {
        if (error instanceof InstagramPrivateError)
          throw new ServiceError(error.kind === "unknown" ? 520 : 422, error.message);
        throw error;
      }
    }
    if (!token) throw new ServiceError(409, "Активный токен площадки не настроен");
    const form = new URLSearchParams({ message: text });
    let url = this.endpoint(platform, `${encodeURIComponent(target.externalId)}/comments`);
    if (platform === "threads") {
      url = this.endpoint(platform, "me/threads");
      form.delete("message");
      form.set("media_type", "TEXT");
      form.set("text", text);
      form.set("reply_to_id", target.externalId);
      form.set("auto_publish_text", "true");
    }
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      throw new ServiceError(520, "Результат публикации неизвестен");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(422, `Платформа отклонила комментарий (HTTP ${response.status})`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ServiceError(520, "Платформа приняла запрос, но результат неизвестен");
    }
    const id = z.object({ id: z.union([z.string().min(1), z.number()]) }).safeParse(data);
    if (!id.success) throw new ServiceError(520, "Платформа не вернула ID комментария");
    return String(id.data.id);
  }

  private async finish(client: pg.PoolClient): Promise<void> {
    await client.query(`UPDATE autodom_outreach.social_campaigns c SET status='completed'
      WHERE c.status='running' AND NOT EXISTS (
        SELECT 1 FROM autodom_outreach.social_deliveries d
        WHERE d.campaign_id=c.id AND d.status IN ('pending','sending'))`);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.safe(async () => {
        const client = await this.pool.connect();
        let held = false;
        try {
          held =
            (
              await client.query<{ locked: boolean }>(
                "SELECT pg_try_advisory_lock($1,$2) locked",
                LEADER_KEY.slice(),
              )
            ).rows[0]?.locked ?? false;
          if (!held) return;
          await this.transaction(client, async () => {
            const stale = await client.query<{ project_id: string; platform: SocialPlatform }>(`
              UPDATE autodom_outreach.social_deliveries d SET status='unknown',
                error='Публикация прервана: результат неизвестен, повтор запрещён',updated_at=clock_timestamp()
              FROM autodom_outreach.social_campaigns c
              WHERE d.campaign_id=c.id AND d.status='sending'
              RETURNING c.project_id,c.platform`);
            for (const row of stale.rows) {
              await client.query(
                "UPDATE autodom_outreach.social_campaigns SET status='paused',last_error='Есть публикация с неизвестным результатом' WHERE project_id=$1 AND platform=$2 AND status='running'",
                [row.project_id, row.platform],
              );
              await client.query(
                "UPDATE autodom_outreach.social_pacing SET blocked=true WHERE project_id=$1 AND platform=$2",
                [row.project_id, row.platform],
              );
            }
            await this.finish(client);
          });
          if (!this.sendEnabled) return;
          const pending = (
            await client.query<PendingRow>(`
              SELECT d.*,c.input FROM autodom_outreach.social_deliveries d
              JOIN autodom_outreach.social_campaigns c ON c.id=d.campaign_id
              JOIN autodom_outreach.social_pacing p
                ON p.project_id=c.project_id AND p.platform=c.platform
              WHERE c.status='running' AND d.status='pending' AND NOT p.blocked
                AND (p.next_allowed IS NULL OR p.next_allowed<=clock_timestamp())
                AND (p.attempt_day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date
                  OR p.attempts < (c.input->>'dailyLimit')::integer)
              ORDER BY c.created_at,d.position LIMIT 1`)
          ).rows[0];
          if (!pending) return;
          const input = parse(socialCampaignSchema, pending.input);
          const target = parse(socialCampaignSchema.shape.targets.element, pending.target);
          const reserved = await this.transaction(client, async () => {
            const contact = await client.query(
              `INSERT INTO autodom_outreach.social_contacts(project_id,platform,target_id,delivery_id)
               VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING target_id`,
              [input.projectId, input.platform, target.externalId, pending.id],
            );
            if (!contact.rowCount) {
              await client.query(
                "UPDATE autodom_outreach.social_deliveries SET status='skipped',error='Эта публикация уже использована в другой кампании',updated_at=clock_timestamp() WHERE id=$1",
                [pending.id],
              );
              await this.finish(client);
              return false;
            }
            const updated = await client.query(
              "UPDATE autodom_outreach.social_deliveries SET status='sending',attempted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status='pending' RETURNING id",
              [pending.id],
            );
            if (!updated.rowCount) return false;
            await client.query(
              `UPDATE autodom_outreach.social_pacing SET
                 last_attempt=clock_timestamp(),next_allowed=clock_timestamp()+$3*interval '1 second',
                 attempts=CASE WHEN attempt_day=(clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date THEN attempts+1 ELSE 1 END,
                 attempt_day=(clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date
               WHERE project_id=$1 AND platform=$2`,
              [input.projectId, input.platform, input.intervalSeconds],
            );
            return true;
          });
          if (!reserved) return;
          let status: DeliveryStatus = "sent";
          let remoteId: string | null = null;
          let error: string | null = null;
          try {
            const token =
              input.platform === "instagram"
                ? undefined
                : await this.token(input.projectId, input.platform);
            remoteId = await this.publish(
              input.projectId,
              input.platform,
              target,
              input.text,
              token,
            );
          } catch (failure) {
            status =
              failure instanceof ServiceError && failure.status === 422 ? "failed" : "unknown";
            error = failure instanceof Error ? failure.message : "Результат публикации неизвестен";
          }
          await this.transaction(client, async () => {
            await client.query(
              "UPDATE autodom_outreach.social_deliveries SET status=$2,error=$3,remote_id=$4,updated_at=clock_timestamp() WHERE id=$1 AND status='sending'",
              [pending.id, status, error, remoteId],
            );
            if (status !== "sent") {
              await client.query(
                "UPDATE autodom_outreach.social_campaigns SET status='paused',last_error=$3 WHERE project_id=$1 AND platform=$2 AND status='running'",
                [input.projectId, input.platform, error],
              );
              await client.query(
                "UPDATE autodom_outreach.social_pacing SET blocked=true WHERE project_id=$1 AND platform=$2",
                [input.projectId, input.platform],
              );
            }
            await this.finish(client);
          });
        } finally {
          if (held)
            await client
              .query("SELECT pg_advisory_unlock($1,$2)", LEADER_KEY.slice())
              .catch(() => undefined);
          client.release();
        }
      });
    } finally {
      this.ticking = false;
    }
  }
}
