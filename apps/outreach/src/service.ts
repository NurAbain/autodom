import { randomUUID } from "node:crypto";
import {
  listingPrice,
  listingSchema,
  normalizeCity,
  purchaseEligible,
  queryGroups,
} from "@autodom/core";
import type pg from "pg";
import { z } from "zod";
import {
  type AudienceFilter,
  type Campaign,
  type CampaignDetail,
  type CampaignInput,
  type Candidate,
  type ConnectionInput,
  campaignSchema,
  DEFAULT_PROJECT_ID,
  DeliveryError,
  type DeliveryStatus,
  filterSchema,
  type MarketingPlatform,
  type MarketingProject,
  type Messenger,
  type OutreachImage,
  type OutreachSource,
  type ProjectConnection,
  type ProjectInput,
  platformSchema,
  projectInputSchema,
  type Recipient,
  ServiceError,
  sourceSchema,
} from "./contracts.js";
import type { InstagramCredentials } from "./instagram-private.js";
import { CredentialVault } from "./vault.js";

const FRESH_HOURS = 48;
const LEADER_KEY = [1096111183, 1869968498] as const;
const uuidSchema = z.string().uuid();
const identitySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);
const reasonSchema = z.string().trim().min(1).max(500);
type CampaignRow = {
  id: string;
  input: CampaignInput;
  status: Campaign["status"];
  created_at: Date;
  last_error: string | null;
};
type DeliveryRow = {
  id: string;
  campaign_id: string;
  candidate: Candidate;
  recipient_id: string | null;
  status: DeliveryStatus;
  error: string | null;
  remote_id: string | null;
  updated_at: Date;
};
type PendingRow = DeliveryRow & { input: CampaignInput };
type ProjectRow = {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
};
type ConnectionRow = {
  project_id: string;
  platform: MarketingPlatform;
  account_label: string;
  login: string;
  auth: ProjectConnection["auth"];
  credential: Buffer | null;
  enabled: boolean;
  updated_at: Date;
};
const instagramCredentialSchema = z
  .object({
    version: z.literal(1),
    password: z.string().min(8).max(16_384),
    session: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400, "Некорректные параметры запроса");
  return result.data;
}
function validUrl(raw: string, source: OutreachSource): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === source || url.hostname === `www.${source}`)
    );
  } catch {
    return false;
  }
}

export class OutreachService {
  private ticking = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly messengers: ReadonlyMap<OutreachSource, Messenger>,
    private readonly sendEnabled: boolean,
    private readonly vault: CredentialVault = new CredentialVault(),
  ) {}

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "Хранилище рассылок временно недоступно");
    }
  }

  private async transaction<T>(client: pg.PoolClient, operation: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async init(): Promise<void> {
    return this.safe(async () => {
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          // Serialize only outreach DDL; never touch the shared catalog schema.
          await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
            LEADER_KEY[0],
            LEADER_KEY[1] + 1,
          ]);
          const schema = await client.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='autodom_outreach') AS exists",
          );
          if (!schema.rows[0]?.exists) await client.query("CREATE SCHEMA autodom_outreach");
          await client.query(`
            CREATE TABLE IF NOT EXISTS autodom_outreach.projects (
              id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
              description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
              created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
              updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
            );
            INSERT INTO autodom_outreach.projects(id,name,description)
              VALUES ('${DEFAULT_PROJECT_ID}','Autodom','Основной проект привлечения клиентов')
              ON CONFLICT (id) DO NOTHING;
            CREATE TABLE IF NOT EXISTS autodom_outreach.connections (
              project_id uuid NOT NULL REFERENCES autodom_outreach.projects(id) ON DELETE CASCADE,
              platform text NOT NULL CHECK (platform IN ('mashina.kg','lalafo.kg','instagram','facebook','threads')),
              account_label text NOT NULL CHECK (length(account_label) BETWEEN 1 AND 120),
              login text NOT NULL DEFAULT '' CHECK (length(login) <= 200),
              auth text NOT NULL CHECK (auth IN ('server_session','credentials','access_token')),
              credential bytea, enabled boolean NOT NULL DEFAULT true,
              updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
              PRIMARY KEY (project_id,platform)
            );
            CREATE TABLE IF NOT EXISTS autodom_outreach.images (
              id uuid PRIMARY KEY, mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
              bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
              created_at timestamptz NOT NULL DEFAULT clock_timestamp()
            );
            CREATE TABLE IF NOT EXISTS autodom_outreach.campaigns (
              id uuid PRIMARY KEY, input jsonb NOT NULL,
              project_id uuid REFERENCES autodom_outreach.projects(id),
              source text NOT NULL CHECK (source IN ('mashina.kg','lalafo.kg')),
              image_id uuid REFERENCES autodom_outreach.images(id),
              status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed','cancelled')),
              created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_error text
            );
            ALTER TABLE autodom_outreach.campaigns ADD COLUMN IF NOT EXISTS project_id uuid
              REFERENCES autodom_outreach.projects(id);
            UPDATE autodom_outreach.campaigns SET project_id='${DEFAULT_PROJECT_ID}' WHERE project_id IS NULL;
            ALTER TABLE autodom_outreach.campaigns ALTER COLUMN project_id SET NOT NULL;
            UPDATE autodom_outreach.campaigns SET input=jsonb_set(input,'{projectId}',to_jsonb(project_id::text))
              WHERE NOT (input ? 'projectId');
            CREATE TABLE IF NOT EXISTS autodom_outreach.deliveries (
              id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES autodom_outreach.campaigns(id),
              candidate jsonb NOT NULL, position integer NOT NULL,
              recipient_id text, status text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed','unknown','skipped')),
              error text, remote_id text, attempted_at timestamptz,
              updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
              UNIQUE (campaign_id, position)
            );
            CREATE INDEX IF NOT EXISTS outreach_deliveries_queue
              ON autodom_outreach.deliveries(campaign_id, status, position);
            CREATE TABLE IF NOT EXISTS autodom_outreach.contacts (
              source text NOT NULL CHECK (source IN ('mashina.kg','lalafo.kg')), recipient_id text NOT NULL,
              delivery_id uuid REFERENCES autodom_outreach.deliveries(id),
              reserved_at timestamptz, suppressed boolean NOT NULL DEFAULT false, reason text,
              PRIMARY KEY (source, recipient_id)
            );
            CREATE TABLE IF NOT EXISTS autodom_outreach.source_pacing (
              source text PRIMARY KEY CHECK (source IN ('mashina.kg','lalafo.kg')),
              last_attempt timestamptz, next_allowed timestamptz,
              attempt_day date, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
              blocked boolean NOT NULL DEFAULT false
            );
            INSERT INTO autodom_outreach.source_pacing(source) VALUES ('mashina.kg'), ('lalafo.kg')
              ON CONFLICT DO NOTHING;
          `);
          for (const source of this.messengers.keys())
            await client.query(
              `INSERT INTO autodom_outreach.connections
                (project_id,platform,account_label,auth,enabled)
               VALUES ($1,$2,$3,'server_session',true)
               ON CONFLICT (project_id,platform) DO UPDATE SET
                 account_label=EXCLUDED.account_label,auth='server_session',enabled=true,
                 updated_at=clock_timestamp()`,
              [DEFAULT_PROJECT_ID, source, `${source} · серверная сессия`],
            );
        });
      } finally {
        client.release();
      }
    });
  }
  private project(row: ProjectRow): MarketingProject {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listProjects(): Promise<MarketingProject[]> {
    return this.safe(async () => {
      const rows = await this.pool.query<ProjectRow>(
        "SELECT * FROM autodom_outreach.projects ORDER BY created_at,id",
      );
      return rows.rows.map((row) => this.project(row));
    });
  }

  async createProject(input: ProjectInput): Promise<MarketingProject> {
    const parsed = parse(projectInputSchema, input);
    return this.safe(async () => {
      const id = randomUUID();
      const row = (
        await this.pool.query<ProjectRow>(
          `INSERT INTO autodom_outreach.projects(id,name,description)
           VALUES ($1,$2,$3) RETURNING *`,
          [id, parsed.name, parsed.description],
        )
      ).rows[0];
      if (!row) throw new ServiceError(503, "Проект не был сохранён");
      return this.project(row);
    });
  }

  private async projectById(id: string): Promise<MarketingProject> {
    parse(uuidSchema, id);
    const row = (
      await this.pool.query<ProjectRow>("SELECT * FROM autodom_outreach.projects WHERE id=$1", [id])
    ).rows[0];
    if (!row) throw new ServiceError(404, "Проект не найден");
    return this.project(row);
  }

  private async connection(row: ConnectionRow): Promise<ProjectConnection> {
    const messenger =
      row.platform === "mashina.kg" || row.platform === "lalafo.kg"
        ? this.messengers.get(row.platform)
        : undefined;
    let ready = false;
    let message = "Подключение выключено";
    if (row.enabled && row.auth === "server_session" && messenger) {
      try {
        const checked = await messenger.check();
        ready = checked.ready;
        message = checked.message;
      } catch {
        message = "Серверная сессия недоступна";
      }
    } else if (row.enabled && row.auth === "access_token" && row.credential) {
      ready = this.vault.configured;
      message = ready
        ? "Токен сохранён; доступ проверяется перед запуском"
        : "Хранилище ключей не настроено";
    } else if (
      row.enabled &&
      row.platform === "instagram" &&
      row.auth === "credentials" &&
      row.credential &&
      row.login
    ) {
      ready = this.vault.configured;
      message = ready
        ? "Логин и пароль сохранены; сессия проверяется перед запуском"
        : "Хранилище ключей не настроено";
    } else if (row.enabled && row.auth === "credentials" && row.credential) {
      message =
        "Данные сохранены, но площадке нужна серверная сессия. Выполните безопасный вход на сервере.";
    } else if (row.enabled) {
      message = "Секрет доступа не настроен";
    }
    return {
      projectId: row.project_id,
      platform: row.platform,
      accountLabel: row.account_label,
      login: row.login,
      auth: row.auth,
      credentialConfigured: Boolean(row.credential) || row.auth === "server_session",
      enabled: row.enabled,
      ready,
      message,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async projectDetail(
    id: string,
  ): Promise<{ project: MarketingProject; connections: ProjectConnection[] }> {
    return this.safe(async () => {
      const project = await this.projectById(id);
      const rows = await this.pool.query<ConnectionRow>(
        "SELECT * FROM autodom_outreach.connections WHERE project_id=$1 ORDER BY platform",
        [id],
      );
      return {
        project,
        connections: await Promise.all(rows.rows.map((row) => this.connection(row))),
      };
    });
  }

  async upsertConnection(projectId: string, input: ConnectionInput): Promise<ProjectConnection> {
    parse(uuidSchema, projectId);
    const parsed = parse(
      z.object({
        platform: platformSchema,
        accountLabel: z.string().trim().min(1).max(120),
        login: z.string().trim().max(200),
        secret: z.string().min(8).max(16_384).optional(),
        enabled: z.boolean(),
      }),
      input,
    );
    return this.safe(async () => {
      await this.projectById(projectId);
      const current = (
        await this.pool.query<ConnectionRow>(
          "SELECT * FROM autodom_outreach.connections WHERE project_id=$1 AND platform=$2",
          [projectId, parsed.platform],
        )
      ).rows[0];
      if (!current && !parsed.secret)
        throw new ServiceError(400, "Для нового подключения укажите секрет доступа");
      let credential = current?.credential ?? null;
      let auth = current?.auth;
      if (parsed.secret) {
        if (!this.vault.configured)
          throw new ServiceError(409, "Серверное шифрование секретов не настроено");
        if (parsed.platform === "instagram") {
          if (!parsed.login) throw new ServiceError(400, "Для Instagram укажите логин аккаунта");
          credential = this.vault.seal(
            JSON.stringify({ version: 1, password: parsed.secret, session: null }),
            `${projectId}:${parsed.platform}`,
          );
          auth = "credentials";
        } else {
          credential = this.vault.seal(parsed.secret, `${projectId}:${parsed.platform}`);
          auth =
            parsed.platform === "facebook" || parsed.platform === "threads"
              ? "access_token"
              : "credentials";
        }
      }
      if (!auth) throw new ServiceError(400, "Способ авторизации не определён");
      const row = (
        await this.pool.query<ConnectionRow>(
          `INSERT INTO autodom_outreach.connections
            (project_id,platform,account_label,login,auth,credential,enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (project_id,platform) DO UPDATE SET
             account_label=EXCLUDED.account_label,login=EXCLUDED.login,auth=EXCLUDED.auth,
             credential=EXCLUDED.credential,enabled=EXCLUDED.enabled,updated_at=clock_timestamp()
           RETURNING *`,
          [
            projectId,
            parsed.platform,
            parsed.accountLabel,
            parsed.login,
            auth,
            credential,
            parsed.enabled,
          ],
        )
      ).rows[0];
      if (!row) throw new ServiceError(503, "Подключение не было сохранено");
      return this.connection(row);
    });
  }

  private async requireConnection(
    projectId: string,
    platform: MarketingPlatform,
    ready: boolean,
  ): Promise<ProjectConnection> {
    const row = (
      await this.pool.query<ConnectionRow>(
        "SELECT * FROM autodom_outreach.connections WHERE project_id=$1 AND platform=$2",
        [projectId, platform],
      )
    ).rows[0];
    if (!row || !row.enabled) throw new ServiceError(409, "Площадка не подключена к проекту");
    const connection = await this.connection(row);
    if (ready && !connection.ready)
      throw new ServiceError(409, `Подключение не готово: ${connection.message}`);
    return connection;
  }

  async accessToken(projectId: string, platform: MarketingPlatform): Promise<string> {
    parse(uuidSchema, projectId);
    parse(platformSchema, platform);
    return this.safe(async () => {
      const row = (
        await this.pool.query<ConnectionRow>(
          "SELECT * FROM autodom_outreach.connections WHERE project_id=$1 AND platform=$2",
          [projectId, platform],
        )
      ).rows[0];
      if (!row?.enabled || row.auth !== "access_token" || !row.credential)
        throw new ServiceError(409, "Активный токен площадки не настроен");
      if (!this.vault.configured) throw new ServiceError(409, "Хранилище ключей не настроено");
      try {
        return this.vault.open(row.credential, `${projectId}:${platform}`);
      } catch {
        throw new ServiceError(409, "Секрет подключения повреждён или зашифрован другим ключом");
      }
    });
  }

  async instagramCredentials(projectId: string): Promise<InstagramCredentials> {
    parse(uuidSchema, projectId);
    return this.safe(async () => {
      const row = (
        await this.pool.query<ConnectionRow>(
          "SELECT * FROM autodom_outreach.connections WHERE project_id=$1 AND platform='instagram'",
          [projectId],
        )
      ).rows[0];
      if (!row?.enabled || row.auth !== "credentials" || !row.credential || !row.login)
        throw new ServiceError(409, "Активный логин Instagram не настроен");
      if (!this.vault.configured) throw new ServiceError(409, "Хранилище ключей не настроено");
      try {
        const secret = instagramCredentialSchema.parse(
          JSON.parse(this.vault.open(row.credential, `${projectId}:instagram`)),
        );
        return { username: row.login, password: secret.password, session: secret.session };
      } catch {
        throw new ServiceError(409, "Данные Instagram повреждены или зашифрованы другим ключом");
      }
    });
  }

  async saveInstagramSession(projectId: string, session: Record<string, unknown>): Promise<void> {
    parse(uuidSchema, projectId);
    const parsedSession = z.record(z.string(), z.unknown()).parse(session);
    if (JSON.stringify(parsedSession).length > 200_000)
      throw new ServiceError(400, "Сессия Instagram слишком большая");
    return this.safe(async () => {
      const credentials = await this.instagramCredentials(projectId);
      const credential = this.vault.seal(
        JSON.stringify({ version: 1, password: credentials.password, session: parsedSession }),
        `${projectId}:instagram`,
      );
      const updated = await this.pool.query(
        `UPDATE autodom_outreach.connections SET credential=$2,updated_at=clock_timestamp()
         WHERE project_id=$1 AND platform='instagram' AND auth='credentials' AND enabled=true`,
        [projectId, credential],
      );
      if (!updated.rowCount) throw new ServiceError(409, "Активный логин Instagram не настроен");
    });
  }

  async preview(filter: AudienceFilter): Promise<{ candidates: Candidate[]; freshHours: number }> {
    const input = parse(filterSchema, filter);
    return this.safe(async () => ({
      candidates: await this.audience(input),
      freshHours: FRESH_HOURS,
    }));
  }

  private async audience(filter: AudienceFilter): Promise<Candidate[]> {
    const groups = queryGroups(filter.query);
    if (filter.query && !groups.length) return [];
    const values: unknown[] = [filter.source];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const price = filter.currency === "USD" ? "price_usd_minor" : "price_kgs_minor";
    const clauses = [
      "source = $1",
      "market = 'KG'",
      "availability IN ('в наличии','опубликовано')",
      "COALESCE(NULLIF(data->'catalog_attributes'->>'publication_status',''), 'active') = 'active'",
      `last_seen >= EXTRACT(EPOCH FROM statement_timestamp()) - ${FRESH_HOURS * 3600}`,
      "data->>'price_kind' IN ('asking','buy_now')",
      `${price} > 0`,
    ];
    if (filter.city) clauses.push(`normalized_city = ${bind(normalizeCity(filter.city))}`);
    if (filter.yearMin !== null) clauses.push(`vehicle_year >= ${bind(filter.yearMin)}`);
    if (filter.yearMax !== null) clauses.push(`vehicle_year <= ${bind(filter.yearMax)}`);
    if (filter.priceMin !== null)
      clauses.push(`${price} >= (${bind(String(filter.priceMin))}::numeric * 100)`);
    if (filter.priceMax !== null)
      clauses.push(`${price} <= (${bind(String(filter.priceMax))}::numeric * 100)`);
    if (groups.length)
      clauses.push(
        `(${groups
          .map(
            (words) =>
              `(${words
                .map((word) => `strpos(normalized_text, ${bind(` ${word} `)}) > 0`)
                .join(" AND ")})`,
          )
          .join(" OR ")})`,
      );
    // Keyset batches allow malformed/unavailable JSON or foreign URLs to be excluded
    // without truncating an otherwise eligible audience at the requested limit.
    const candidates: Candidate[] = [];
    let cursor: { last_seen: number; id: string } | null = null;
    while (candidates.length < filter.limit) {
      const pageValues = [...values];
      let after = "";
      if (cursor) {
        pageValues.push(cursor.last_seen, cursor.id);
        after = ` AND (last_seen, id) < ($${pageValues.length - 1}, $${pageValues.length})`;
      }
      const rows = await this.pool.query<{
        id: string;
        data: unknown;
        last_seen: number;
        now: string;
      }>(
        `SELECT id, data, last_seen, EXTRACT(EPOCH FROM statement_timestamp()) AS now
         FROM public.listings WHERE ${clauses.join(" AND ")}${after}
         ORDER BY last_seen DESC, id DESC LIMIT 250`,
        pageValues,
      );
      for (const row of rows.rows) {
        const parsed = listingSchema.safeParse(row.data);
        if (!parsed.success) continue;
        const listing = parsed.data;
        const now = Number(row.now);
        if (
          listing.source !== filter.source ||
          listing.market !== "KG" ||
          !validUrl(listing.url, filter.source) ||
          !purchaseEligible(listing, now)
        )
          continue;
        const minor = listingPrice(listing, filter.currency, now);
        if (minor === null || minor <= 0) continue;
        candidates.push({
          listingId: row.id,
          source: filter.source,
          title: listing.title,
          url: listing.url,
          city: listing.city,
          year: listing.year,
          price: minor / 100,
          currency: filter.currency,
        });
        if (candidates.length === filter.limit) break;
      }
      if (rows.rows.length < 250) break;
      const last = rows.rows[rows.rows.length - 1]!;
      cursor = { last_seen: last.last_seen, id: last.id };
    }
    return candidates;
  }

  async create(input: CampaignInput): Promise<Campaign> {
    const parsed = parse(campaignSchema, input);
    return this.safe(async () => {
      await this.projectById(parsed.projectId);
      await this.requireConnection(parsed.projectId, parsed.filter.source, false);
      if (
        parsed.imageId &&
        !(
          await this.pool.query("SELECT 1 FROM autodom_outreach.images WHERE id=$1", [
            parsed.imageId,
          ])
        ).rowCount
      )
        throw new ServiceError(400, "Изображение не найдено");
      const candidates = await this.audience(parsed.filter);
      if (!candidates.length) throw new ServiceError(400, "Нет подходящих свежих объявлений");
      const id = randomUUID();
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          await client.query(
            `INSERT INTO autodom_outreach.campaigns(id,input,project_id,source,image_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [id, JSON.stringify(parsed), parsed.projectId, parsed.filter.source, parsed.imageId],
          );
          await client.query(
            `INSERT INTO autodom_outreach.deliveries(id,campaign_id,candidate,position)
            SELECT (item->>'id')::uuid, $1, item->'candidate', (item->>'position')::integer
            FROM jsonb_array_elements($2::jsonb) AS item`,
            [
              id,
              JSON.stringify(
                candidates.map((candidate, position) => ({
                  id: randomUUID(),
                  candidate,
                  position,
                })),
              ),
            ],
          );
        });
      } finally {
        client.release();
      }
      return this.getCampaign(id);
    });
  }

  private async campaigns(id?: string): Promise<Campaign[]> {
    const rows = await this.pool.query<
      CampaignRow & { counts: Partial<Record<DeliveryStatus, number>> }
    >(
      `
      SELECT c.*, COALESCE(t.counts, '{}'::jsonb) AS counts
      FROM autodom_outreach.campaigns c
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(status, amount) AS counts FROM (
          SELECT status, COUNT(*)::integer AS amount FROM autodom_outreach.deliveries
          WHERE campaign_id=c.id GROUP BY status
        ) n
      ) t ON true ${id ? "WHERE c.id=$1" : ""} ORDER BY c.created_at DESC, c.id DESC`,
      id ? [id] : [],
    );
    return rows.rows.map((row) => ({
      ...row.input,
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      lastError: row.last_error,
      counts: { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, ...row.counts },
    }));
  }

  private async getCampaign(id: string): Promise<Campaign> {
    const found = (await this.campaigns(id))[0];
    if (!found) throw new ServiceError(404, "Кампания не найдена");
    return found;
  }

  async list(): Promise<Campaign[]> {
    return this.safe(() => this.campaigns());
  }

  async detail(id: string): Promise<CampaignDetail> {
    parse(uuidSchema, id);
    return this.safe(async () => {
      const found = await this.getCampaign(id);
      const rows = await this.pool.query<DeliveryRow>(
        "SELECT * FROM autodom_outreach.deliveries WHERE campaign_id=$1 ORDER BY position",
        [id],
      );
      // Counts and deliveries share the same snapshot for the detail view.
      const counts: Campaign["counts"] = {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
      };
      for (const row of rows.rows) counts[row.status]++;
      return {
        campaign: { ...found, counts },
        deliveries: rows.rows.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          candidate: row.candidate,
          recipientId: row.recipient_id,
          status: row.status,
          error: row.error,
          remoteId: row.remote_id,
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    });
  }

  async action(
    id: string,
    action: "start" | "pause" | "cancel",
    confirmed: boolean,
  ): Promise<Campaign> {
    parse(uuidSchema, id);
    parse(z.enum(["start", "pause", "cancel"]), action);
    parse(z.boolean(), confirmed);
    return this.safe(async () => {
      const existing = await this.getCampaign(id);
      if (existing.status === "completed" || existing.status === "cancelled")
        throw new ServiceError(409, "Завершённую кампанию нельзя изменить");
      if (action === "start") {
        if (!confirmed) throw new ServiceError(400, "Требуется явное подтверждение отправки");
        if (!this.sendEnabled)
          throw new ServiceError(409, "Отправка отключена конфигурацией сервиса");
        await this.requireConnection(existing.projectId, existing.filter.source, true);
        const messenger = this.messengers.get(existing.filter.source);
        if (!messenger || messenger.source !== existing.filter.source)
          throw new ServiceError(409, "Транспорт площадки не настроен");
        try {
          const status = await messenger.check();
          if (!status.ready || status.source !== existing.filter.source)
            throw new Error("not ready");
        } catch {
          throw new ServiceError(409, "Аккаунт площадки не готов к отправке");
        }
      }
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          const row = (
            await client.query<CampaignRow>(
              "SELECT * FROM autodom_outreach.campaigns WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0]!;
          if (row.status === "completed" || row.status === "cancelled")
            throw new ServiceError(409, "Завершённую кампанию нельзя изменить");
          if (action === "start" && row.status !== "draft" && row.status !== "paused")
            throw new ServiceError(409, "Кампания уже запущена");
          if (action === "pause" && row.status !== "running")
            throw new ServiceError(409, "Приостановить можно только запущенную кампанию");
          if (action === "start") {
            const remaining = await client.query(
              "SELECT 1 FROM autodom_outreach.deliveries WHERE campaign_id=$1 AND status IN ('pending','sending') LIMIT 1",
              [id],
            );
            if (!remaining.rowCount)
              throw new ServiceError(409, "В кампании нет ожидающих отправок");
          }
          await client.query(
            "UPDATE autodom_outreach.campaigns SET status=$2,last_error=NULL WHERE id=$1",
            [id, action === "start" ? "running" : action === "pause" ? "paused" : "cancelled"],
          );
          if (action === "start")
            await client.query(
              "UPDATE autodom_outreach.source_pacing SET blocked=false WHERE source=$1",
              [row.input.filter.source],
            );
          if (action === "cancel")
            await client.query(
              "UPDATE autodom_outreach.deliveries SET status='skipped',error='Кампания отменена',updated_at=clock_timestamp() WHERE campaign_id=$1 AND status='pending'",
              [id],
            );
        });
      } finally {
        client.release();
      }
      return this.getCampaign(id);
    });
  }

  async putImage(mime: "image/jpeg" | "image/png", bytes: Buffer): Promise<string> {
    parse(z.enum(["image/jpeg", "image/png"]), mime);
    if (!Buffer.isBuffer(bytes) || bytes.length > 5 * 1024 * 1024 || bytes.length < 8)
      throw new ServiceError(400, "Изображение должно быть JPEG или PNG размером до 5 МБ");
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((mime === "image/png" && !png) || (mime === "image/jpeg" && !jpeg))
      throw new ServiceError(400, "Содержимое изображения не соответствует формату");
    return this.safe(async () => {
      const id = randomUUID();
      await this.pool.query(
        "INSERT INTO autodom_outreach.images(id,mime,bytes) VALUES ($1,$2,$3)",
        [id, mime, bytes],
      );
      return id;
    });
  }

  async getImage(id: string): Promise<OutreachImage | null> {
    parse(uuidSchema, id);
    return this.safe(
      async () =>
        (
          await this.pool.query<OutreachImage>(
            "SELECT id,mime,bytes FROM autodom_outreach.images WHERE id=$1",
            [id],
          )
        ).rows[0] ?? null,
    );
  }

  async suppress(source: OutreachSource, recipientId: string, reason: string): Promise<void> {
    parse(sourceSchema, source);
    parse(identitySchema, recipientId);
    const cleanReason = parse(reasonSchema, reason);
    return this.safe(async () => {
      await this.pool.query(
        `INSERT INTO autodom_outreach.contacts(source,recipient_id,suppressed,reason)
        VALUES ($1,$2,true,$3) ON CONFLICT(source,recipient_id)
        DO UPDATE SET suppressed=true,reason=EXCLUDED.reason`,
        [source, recipientId, cleanReason],
      );
    });
  }

  private async pauseSource(
    client: pg.PoolClient,
    source: OutreachSource,
    message: string,
  ): Promise<void> {
    await client.query(
      "UPDATE autodom_outreach.campaigns SET status='paused',last_error=$2 WHERE source=$1 AND status='running'",
      [source, message],
    );
    await client.query("UPDATE autodom_outreach.source_pacing SET blocked=true WHERE source=$1", [
      source,
    ]);
  }

  private async finishEmpty(client: pg.PoolClient): Promise<void> {
    await client.query(`UPDATE autodom_outreach.campaigns c SET status='completed'
      WHERE c.status='running' AND NOT EXISTS (
        SELECT 1 FROM autodom_outreach.deliveries d WHERE d.campaign_id=c.id AND d.status IN ('pending','sending'))`);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.safe(async () => {
        const client = await this.pool.connect();
        let held = false;
        let alive = true;
        const lost = (): void => {
          alive = false;
        };
        client.on("error", lost);
        client.on("end", lost);
        try {
          held = (
            await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock($1,$2) AS locked",
              LEADER_KEY.slice(),
            )
          ).rows[0]!.locked;
          if (!held || !alive) return;
          // A sending row under exclusive leadership belongs to a dead predecessor.
          // Its contact reservation and pacing charge are deliberately never released.
          await this.transaction(client, async () => {
            const stale = await client.query<{ source: OutreachSource }>(`
              UPDATE autodom_outreach.deliveries d SET status='unknown',
                error='Отправка прервана: результат неизвестен, повтор запрещён',updated_at=clock_timestamp()
              FROM autodom_outreach.campaigns c WHERE d.campaign_id=c.id AND d.status='sending'
              RETURNING c.source`);
            for (const source of new Set(stale.rows.map((row) => row.source)))
              await this.pauseSource(
                client,
                source,
                "Найдена прерванная отправка с неизвестным результатом",
              );
          });
          await this.finishEmpty(client);
          if (!this.sendEnabled || !alive) return;
          const selected = await client.query<PendingRow>(`
            SELECT d.*,c.input FROM autodom_outreach.deliveries d
            JOIN autodom_outreach.campaigns c ON c.id=d.campaign_id
            JOIN autodom_outreach.source_pacing p ON p.source=c.source
            WHERE c.status='running' AND d.status='pending' AND NOT p.blocked
              AND (p.next_allowed IS NULL OR p.next_allowed <= clock_timestamp())
              AND (p.last_attempt IS NULL OR p.last_attempt + (c.input->>'intervalSeconds')::integer * interval '1 second' <= clock_timestamp())
              AND (p.attempt_day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date
                OR p.attempts < (c.input->>'dailyLimit')::integer)
            ORDER BY c.created_at,d.position,c.id LIMIT 1`);
          const pending = selected.rows[0];
          if (!pending || !alive) return;
          const source = pending.input.filter.source;
          const messenger = this.messengers.get(source);
          if (!messenger || messenger.source !== source) {
            await this.transaction(client, () =>
              this.pauseSource(client, source, "Транспорт площадки не настроен"),
            );
            return;
          }
          let recipient: Recipient;
          try {
            const ready = await messenger.check();
            if (!alive) return;
            if (!ready.ready || ready.source !== source) throw new Error("not ready");
            // Verify the lock connection after network I/O and before the next call.
            await client.query("SELECT 1");
            if (!alive) return;
            recipient = await messenger.resolve(pending.candidate);
            parse(identitySchema, recipient.id);
            parse(identitySchema, recipient.listingId);
          } catch (error) {
            if (!alive) return;
            await this.transaction(client, async () => {
              await client.query(
                "UPDATE autodom_outreach.deliveries SET status='failed',error='Не удалось проверить аккаунт или определить продавца',updated_at=clock_timestamp() WHERE id=$1 AND status='pending'",
                [pending.id],
              );
              if (!(error instanceof DeliveryError && error.outcome === "failed" && !error.pause))
                await this.pauseSource(
                  client,
                  source,
                  "Ошибка подготовки отправки; требуется проверка аккаунта",
                );
              await this.finishEmpty(client);
            });
            return;
          }
          if (!alive) return;
          const image = pending.input.imageId
            ? ((
                await client.query<OutreachImage>(
                  "SELECT id,mime,bytes FROM autodom_outreach.images WHERE id=$1",
                  [pending.input.imageId],
                )
              ).rows[0] ?? null)
            : null;
          if (pending.input.imageId && !image)
            throw new ServiceError(503, "Изображение кампании недоступно");
          const reserved = await this.reserve(client, pending, recipient);
          if (!reserved || !alive) {
            await this.finishEmpty(client);
            return;
          }
          // This is the last awaited operation before invoking the transport. A
          // pause/cancel after reservation may still have an in-flight result.
          const permission = await client.query<{ allowed: boolean }>(
            `
            SELECT (c.status='running' AND NOT t.suppressed AND NOT p.blocked) AS allowed
            FROM autodom_outreach.deliveries d JOIN autodom_outreach.campaigns c ON c.id=d.campaign_id
            JOIN autodom_outreach.contacts t ON t.source=c.source AND t.recipient_id=d.recipient_id AND t.delivery_id=d.id
            JOIN autodom_outreach.source_pacing p ON p.source=c.source
            WHERE d.id=$1 AND d.status='sending'`,
            [pending.id],
          );
          if (!alive) return;
          if (!permission.rows[0]?.allowed) {
            await client.query(
              "UPDATE autodom_outreach.deliveries SET status='skipped',error='Отправка остановлена или контакт исключён',updated_at=clock_timestamp() WHERE id=$1 AND status='sending'",
              [pending.id],
            );
            await this.finishEmpty(client);
            return;
          }
          let outcome: "sent" | "failed" | "unknown" = "sent";
          let remoteId: string | null = null;
          let pause = false;
          try {
            const response = await messenger.send(recipient, pending.input.text, image);
            remoteId = parse(identitySchema.nullable(), response.remoteId);
          } catch (error) {
            outcome = error instanceof DeliveryError ? error.outcome : "unknown";
            pause = !(error instanceof DeliveryError && error.outcome === "failed" && !error.pause);
          }
          if (!alive) return;
          await this.transaction(client, async () => {
            const message =
              outcome === "sent"
                ? null
                : outcome === "failed"
                  ? "Площадка отклонила отправку; автоматический повтор запрещён"
                  : "Результат отправки неизвестен; автоматический повтор запрещён";
            await client.query(
              "UPDATE autodom_outreach.deliveries SET status=$2,remote_id=$3,error=$4,updated_at=clock_timestamp() WHERE id=$1 AND status='sending'",
              [pending.id, outcome, remoteId, message],
            );
            if (pause && message) await this.pauseSource(client, source, message);
            await this.finishEmpty(client);
          });
        } finally {
          if (held && alive) {
            try {
              await client.query("SELECT pg_advisory_unlock($1,$2)", LEADER_KEY.slice());
            } catch {
              alive = false;
            }
          }
          client.removeListener("error", lost);
          client.removeListener("end", lost);
          client.release(!alive);
        }
      });
    } finally {
      this.ticking = false;
    }
  }

  private async reserve(
    client: pg.PoolClient,
    pending: PendingRow,
    recipient: Recipient,
  ): Promise<boolean> {
    return this.transaction(client, async () => {
      // Campaign first, pacing second: action() uses the same lock order.
      const current = (
        await client.query<CampaignRow>(
          "SELECT * FROM autodom_outreach.campaigns WHERE id=$1 FOR UPDATE",
          [pending.campaign_id],
        )
      ).rows[0]!;
      if (current.status !== "running") return false;
      const source = pending.input.filter.source;
      const pacing = await client.query<{ allowed: boolean }>(
        `
        SELECT (NOT blocked AND (next_allowed IS NULL OR next_allowed <= clock_timestamp())
          AND (last_attempt IS NULL OR last_attempt + $2 * interval '1 second' <= clock_timestamp())
          AND (attempt_day IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date OR attempts < $3)) AS allowed
        FROM autodom_outreach.source_pacing WHERE source=$1 FOR UPDATE`,
        [source, pending.input.intervalSeconds, pending.input.dailyLimit],
      );
      if (!pacing.rows[0]?.allowed) return false;
      await client.query(
        "INSERT INTO autodom_outreach.contacts(source,recipient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [source, recipient.id],
      );
      const contact = (
        await client.query<{ suppressed: boolean; delivery_id: string | null }>(
          "SELECT suppressed,delivery_id FROM autodom_outreach.contacts WHERE source=$1 AND recipient_id=$2 FOR UPDATE",
          [source, recipient.id],
        )
      ).rows[0]!;
      if (contact.suppressed || contact.delivery_id) {
        await client.query(
          "UPDATE autodom_outreach.deliveries SET status='skipped',recipient_id=$2,error=$3,updated_at=clock_timestamp() WHERE id=$1 AND status='pending'",
          [
            pending.id,
            recipient.id,
            contact.suppressed
              ? "Продавец в списке исключений"
              : "Продавцу уже зарезервирована отправка в этой или другой кампании",
          ],
        );
        return false;
      }
      const updated = await client.query(
        "UPDATE autodom_outreach.deliveries SET status='sending',recipient_id=$2,attempted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status='pending' RETURNING id",
        [pending.id, recipient.id],
      );
      if (!updated.rowCount) return false;
      await client.query(
        "UPDATE autodom_outreach.contacts SET delivery_id=$3,reserved_at=clock_timestamp() WHERE source=$1 AND recipient_id=$2",
        [source, recipient.id, pending.id],
      );
      // Charge before the network call, including crashes, unknown and failed
      // outcomes. The server clock and Bishkek date survive process restarts.
      await client.query(
        `UPDATE autodom_outreach.source_pacing SET
        last_attempt=clock_timestamp(), next_allowed=clock_timestamp() + $2 * interval '1 second',
        attempts=CASE WHEN attempt_day=(clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date THEN attempts+1 ELSE 1 END,
        attempt_day=(clock_timestamp() AT TIME ZONE 'Asia/Bishkek')::date WHERE source=$1`,
        [source, pending.input.intervalSeconds],
      );
      return true;
    });
  }
}
