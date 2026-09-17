import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  type DeliveryStatus,
  type InstagramWatch,
  type InstagramWatchInput,
  type InstagramWatchUpdate,
  instagramWatchInputSchema,
  instagramWatchUpdateSchema,
  ServiceError,
} from "./contracts.js";
import {
  type InstagramCredentials,
  type InstagramMedia,
  type InstagramPrivateClient,
  InstagramPrivateError,
} from "./instagram-private.js";

const POLL_INTERVAL_MS = 5 * 60_000;
const LEADER_KEY = [1096111183, 1229867348] as const;
const uuidSchema = z.string().uuid();
type WatchRow = {
  id: string;
  project_id: string;
  input: unknown;
  status: InstagramWatch["status"];
  created_at: Date;
  last_poll_at: Date | null;
  last_error: string | null;
  counts: Partial<Record<DeliveryStatus, number>>;
};
type PendingRow = {
  id: string;
  watch_id: string;
  project_id: string;
  media_id: string;
  input: unknown;
};
type CredentialReader = (projectId: string) => Promise<InstagramCredentials>;
type SessionWriter = (projectId: string, session: Record<string, unknown>) => Promise<void>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError(400, "Некорректные параметры мониторинга Instagram");
  return result.data;
}

export class InstagramWatchService {
  private ticking = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly instagram?: InstagramPrivateClient,
    private readonly credentials?: CredentialReader,
    private readonly saveSession?: SessionWriter,
    private readonly sendEnabled = false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "Хранилище мониторинга Instagram временно недоступно");
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
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS autodom_outreach.instagram_watches (
          id uuid PRIMARY KEY,
          project_id uuid NOT NULL REFERENCES autodom_outreach.projects(id) ON DELETE CASCADE,
          input jsonb NOT NULL,
          status text NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','running','paused','completed','cancelled')),
          next_poll_at timestamptz,
          last_poll_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          last_error text
        );
        CREATE TABLE IF NOT EXISTS autodom_outreach.instagram_observations (
          id uuid PRIMARY KEY,
          watch_id uuid NOT NULL REFERENCES autodom_outreach.instagram_watches(id) ON DELETE CASCADE,
          account text NOT NULL,
          media_id text NOT NULL,
          media jsonb NOT NULL,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','sending','sent','failed','unknown','skipped')),
          error text,
          remote_id text,
          attempted_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          UNIQUE (watch_id,media_id)
        );
        CREATE INDEX IF NOT EXISTS outreach_instagram_watch_queue
          ON autodom_outreach.instagram_observations(watch_id,status,updated_at);
        CREATE TABLE IF NOT EXISTS autodom_outreach.instagram_watch_pacing (
          watch_id uuid PRIMARY KEY REFERENCES autodom_outreach.instagram_watches(id) ON DELETE CASCADE,
          last_attempt timestamptz,
          next_allowed timestamptz,
          attempt_day date,
          attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          blocked boolean NOT NULL DEFAULT false
        );
      `);
    });
  }

  private watch(row: WatchRow): InstagramWatch {
    return {
      ...parse(instagramWatchInputSchema, row.input),
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      lastPollAt: row.last_poll_at?.toISOString() ?? null,
      lastError: row.last_error,
      counts: {
        pending: 0,
        sending: 0,
        sent: 0,
        failed: 0,
        unknown: 0,
        skipped: 0,
        ...row.counts,
      },
    };
  }

  private async rows(id?: string): Promise<InstagramWatch[]> {
    const rows = await this.pool.query<WatchRow>(
      `SELECT w.*,COALESCE(t.counts,'{}'::jsonb) counts
       FROM autodom_outreach.instagram_watches w
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(status,amount) counts FROM (
           SELECT status,COUNT(*)::integer amount
           FROM autodom_outreach.instagram_observations
           WHERE watch_id=w.id GROUP BY status
         ) grouped
       ) t ON true
       ${id ? "WHERE w.id=$1" : ""}
       ORDER BY w.created_at DESC,w.id DESC`,
      id ? [id] : [],
    );
    return rows.rows.map((row) => this.watch(row));
  }

  private async get(id: string): Promise<InstagramWatch> {
    parse(uuidSchema, id);
    const watch = (await this.rows(id))[0];
    if (!watch) throw new ServiceError(404, "Мониторинг Instagram не найден");
    return watch;
  }

  async list(): Promise<InstagramWatch[]> {
    return this.safe(() => this.rows());
  }

  async create(input: InstagramWatchInput): Promise<InstagramWatch> {
    const parsed = parse(instagramWatchInputSchema, input);
    return this.safe(async () => {
      const project = await this.pool.query("SELECT 1 FROM autodom_outreach.projects WHERE id=$1", [
        parsed.projectId,
      ]);
      if (!project.rowCount) throw new ServiceError(404, "Проект не найден");
      const id = randomUUID();
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          await client.query(
            `INSERT INTO autodom_outreach.instagram_watches(id,project_id,input)
             VALUES ($1,$2,$3)`,
            [id, parsed.projectId, JSON.stringify(parsed)],
          );
          await client.query(
            "INSERT INTO autodom_outreach.instagram_watch_pacing(watch_id) VALUES ($1)",
            [id],
          );
        });
      } finally {
        client.release();
      }
      return this.get(id);
    });
  }

  async update(id: string, input: InstagramWatchUpdate): Promise<InstagramWatch> {
    parse(uuidSchema, id);
    const parsed = parse(instagramWatchUpdateSchema, input);
    return this.safe(async () => {
      const current = await this.get(id);
      if (["completed", "cancelled"].includes(current.status))
        throw new ServiceError(409, "Завершённый мониторинг нельзя изменить");
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          const updated = await client.query(
            `UPDATE autodom_outreach.instagram_watches
             SET input=$2,last_error=NULL WHERE id=$1`,
            [id, JSON.stringify({ projectId: current.projectId, ...parsed })],
          );
          if (!updated.rowCount) throw new ServiceError(404, "Мониторинг Instagram не найден");
          await client.query(
            `UPDATE autodom_outreach.instagram_observations
             SET status='skipped',error='Аккаунт или тип публикации удалён из мониторинга',
                 updated_at=$2
             WHERE watch_id=$1 AND status='pending'
               AND (NOT (account=ANY($3::text[])) OR NOT (media->>'mediaType'=ANY($4::text[])))`,
            [id, this.now(), parsed.accounts, parsed.mediaTypes],
          );
        });
      } finally {
        client.release();
      }
      return this.get(id);
    });
  }

  async action(
    id: string,
    action: "start" | "pause" | "cancel",
    confirmed: boolean,
  ): Promise<InstagramWatch> {
    parse(uuidSchema, id);
    return this.safe(async () => {
      const watch = await this.get(id);
      if (["completed", "cancelled"].includes(watch.status))
        throw new ServiceError(409, "Завершённый мониторинг нельзя изменить");
      if (action === "start") {
        if (!confirmed)
          throw new ServiceError(400, "Требуется явное подтверждение автокомментариев");
        if (!this.sendEnabled)
          throw new ServiceError(409, "Автокомментарии отключены конфигурацией сервиса");
        if (!this.instagram || !this.credentials || !this.saveSession)
          throw new ServiceError(409, "Private API Instagram не настроен");
        try {
          const checked = await this.instagram.check(await this.credentials(watch.projectId));
          await this.saveSession(watch.projectId, checked.session);
        } catch (error) {
          if (error instanceof InstagramPrivateError) throw new ServiceError(409, error.message);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await this.transaction(client, async () => {
          const locked = (
            await client.query<{ status: InstagramWatch["status"] }>(
              "SELECT status FROM autodom_outreach.instagram_watches WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (!locked) throw new ServiceError(404, "Мониторинг Instagram не найден");
          if (["completed", "cancelled"].includes(locked.status))
            throw new ServiceError(409, "Завершённый мониторинг нельзя изменить");
          if (action === "start" && !["draft", "paused"].includes(locked.status))
            throw new ServiceError(409, "Мониторинг уже запущен");
          if (action === "pause" && locked.status !== "running")
            throw new ServiceError(409, "Приостановить можно только запущенный мониторинг");
          await client.query(
            `UPDATE autodom_outreach.instagram_watches
             SET status=$2,last_error=NULL,next_poll_at=CASE WHEN $2='running' THEN $3 ELSE next_poll_at END
             WHERE id=$1`,
            [
              id,
              action === "start" ? "running" : action === "pause" ? "paused" : "cancelled",
              this.now(),
            ],
          );
          if (action === "start")
            await client.query(
              "UPDATE autodom_outreach.instagram_watch_pacing SET blocked=false WHERE watch_id=$1",
              [id],
            );
          if (action === "cancel")
            await client.query(
              `UPDATE autodom_outreach.instagram_observations
               SET status='skipped',error='Мониторинг отменён',updated_at=$2
               WHERE watch_id=$1 AND status='pending'`,
              [id, this.now()],
            );
        });
      } finally {
        client.release();
      }
      return this.get(id);
    });
  }

  private async pause(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE autodom_outreach.instagram_watches
       SET status='paused',last_error=$2 WHERE id=$1 AND status='running'`,
      [id, message],
    );
    await this.pool.query(
      "UPDATE autodom_outreach.instagram_watch_pacing SET blocked=true WHERE watch_id=$1",
      [id],
    );
  }

  private observationStatus(
    media: InstagramMedia,
    now: Date,
  ): {
    status: "pending" | "skipped";
    error: string | null;
  } {
    const age = now.getTime() - new Date(media.takenAt).getTime();
    if (age < -5 * 60_000)
      return { status: "skipped", error: "Время публикации находится в будущем" };
    return { status: "pending", error: null };
  }

  private async discover(): Promise<void> {
    if (!this.instagram || !this.credentials || !this.saveSession) return;
    const now = this.now();
    const row = (
      await this.pool.query<WatchRow>(
        `SELECT w.*,'{}'::jsonb counts FROM autodom_outreach.instagram_watches w
         WHERE status='running' AND (next_poll_at IS NULL OR next_poll_at <= $1)
         ORDER BY COALESCE(next_poll_at,created_at),id LIMIT 1`,
        [now],
      )
    ).rows[0];
    if (!row) return;
    const watch = this.watch(row);
    try {
      let credentials = await this.credentials(watch.projectId);
      for (const account of watch.accounts) {
        const result = await this.instagram.discover(credentials, account);
        await this.saveSession(watch.projectId, result.session);
        credentials = { ...credentials, session: result.session };
        for (const media of result.media) {
          if (!watch.mediaTypes.includes(media.mediaType)) continue;
          const state = this.observationStatus(media, now);
          await this.pool.query(
            `INSERT INTO autodom_outreach.instagram_observations
              (id,watch_id,account,media_id,media,status,error,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (watch_id,media_id) DO NOTHING`,
            [
              randomUUID(),
              watch.id,
              account,
              media.id,
              JSON.stringify(media),
              state.status,
              state.error,
              now,
            ],
          );
        }
      }
      await this.pool.query(
        `UPDATE autodom_outreach.instagram_watches
         SET last_poll_at=$2,next_poll_at=$3,last_error=NULL WHERE id=$1`,
        [watch.id, now, new Date(now.getTime() + POLL_INTERVAL_MS)],
      );
    } catch (error) {
      await this.pause(
        watch.id,
        error instanceof InstagramPrivateError
          ? error.message
          : "Проверка Instagram завершилась ошибкой",
      );
    }
  }

  private async reserve(): Promise<PendingRow | undefined> {
    const now = this.now();
    const client = await this.pool.connect();
    try {
      return await this.transaction(client, async () => {
        const row = (
          await client.query<PendingRow>(
            `SELECT o.id,o.watch_id,o.media_id,w.project_id,w.input
             FROM autodom_outreach.instagram_observations o
             JOIN autodom_outreach.instagram_watches w ON w.id=o.watch_id
             JOIN autodom_outreach.instagram_watch_pacing p ON p.watch_id=w.id
             WHERE o.status='pending' AND w.status='running' AND NOT p.blocked
               AND (p.next_allowed IS NULL OR p.next_allowed <= $1)
               AND (p.attempt_day IS DISTINCT FROM $1::date
                    OR p.attempts < (w.input->>'dailyLimit')::integer)
             ORDER BY (o.media->>'takenAt')::timestamptz,o.updated_at,o.id
             FOR UPDATE OF o,p SKIP LOCKED LIMIT 1`,
            [now],
          )
        ).rows[0];
        if (!row) return undefined;
        const input = parse(instagramWatchInputSchema, row.input);
        await client.query(
          `UPDATE autodom_outreach.instagram_observations
           SET status='sending',attempted_at=$2,updated_at=$2 WHERE id=$1`,
          [row.id, now],
        );
        await client.query(
          `UPDATE autodom_outreach.instagram_watch_pacing
           SET last_attempt=$2::timestamptz,next_allowed=$3::timestamptz,
               attempts=CASE WHEN attempt_day=($2::timestamptz)::date THEN attempts+1 ELSE 1 END,
               attempt_day=($2::timestamptz)::date
           WHERE watch_id=$1`,
          [row.watch_id, now, new Date(now.getTime() + input.intervalSeconds * 1000)],
        );
        return row;
      });
    } finally {
      client.release();
    }
  }

  private async deliver(): Promise<void> {
    if (!this.instagram || !this.credentials || !this.saveSession) return;
    const pending = await this.reserve();
    if (!pending) return;
    const input = parse(instagramWatchInputSchema, pending.input);
    try {
      const result = await this.instagram.comment(
        await this.credentials(pending.project_id),
        pending.media_id,
        input.commentText,
      );
      await this.saveSession(pending.project_id, result.session);
      await this.pool.query(
        `UPDATE autodom_outreach.instagram_observations
         SET status='sent',remote_id=$2,error=NULL,updated_at=$3 WHERE id=$1`,
        [pending.id, result.remoteId, this.now()],
      );
    } catch (error) {
      const unknown = !(error instanceof InstagramPrivateError) || error.kind === "unknown";
      await this.pool.query(
        `UPDATE autodom_outreach.instagram_observations
         SET status=$2,error=$3,updated_at=$4 WHERE id=$1`,
        [
          pending.id,
          unknown ? "unknown" : "failed",
          error instanceof InstagramPrivateError
            ? error.message
            : "Результат комментария неизвестен",
          this.now(),
        ],
      );
      await this.pause(
        pending.watch_id,
        unknown
          ? "Результат комментария неизвестен; автоматический повтор запрещён"
          : error.message,
      );
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.sendEnabled) return;
    this.ticking = true;
    const leader = await this.pool.connect();
    let held = false;
    try {
      held =
        (
          await leader.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1,$2) locked",
            LEADER_KEY.slice(),
          )
        ).rows[0]?.locked ?? false;
      if (!held) return;
      const recovered = await this.pool.query<{ watch_id: string }>(
        `UPDATE autodom_outreach.instagram_observations
         SET status='unknown',error='Публикация прервана: результат неизвестен, повтор запрещён',
             updated_at=$1
         WHERE status='sending' RETURNING watch_id`,
        [this.now()],
      );
      for (const row of recovered.rows)
        await this.pause(row.watch_id, "Есть комментарий с неизвестным результатом");
      await this.discover();
      await this.deliver();
    } finally {
      if (held)
        await leader
          .query("SELECT pg_advisory_unlock($1,$2)", LEADER_KEY.slice())
          .catch(() => undefined);
      leader.release();
      this.ticking = false;
    }
  }
}
