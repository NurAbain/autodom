import { readFile, stat } from "node:fs/promises";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import {
  type Candidate,
  DeliveryError,
  type Messenger,
  type OutreachImage,
  type Recipient,
  type SourceStatus,
} from "./contracts.js";

const ORIGIN = "https://mashina.kg";
const API = `${ORIGIN}/api/mbank-proxy/v1`;
const TIMEOUT = 20_000;
const sessionSchema = z
  .object({
    accessToken: z
      .string()
      .min(16)
      .max(16384)
      .regex(/^[A-Za-z0-9._~-]+$/),
  })
  .strict();
const nativeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const listingSchema = z.object({
  id: nativeId,
  user_id: nativeId,
  slug: z.string(),
  status: z.string(),
  is_owner: z.boolean().optional(),
  is_my_ad: z.boolean().optional(),
});
const uploadSchema = z.object({
  images: z.array(z.object({ image_id: nativeId, upload_url: z.string().url() })).length(1),
});

/** Uses the first-party web protocol observed on /messages, not a public/partner API. */
export class MashinaMessenger implements Messenger {
  readonly source = "mashina.kg" as const;
  constructor(private readonly sessionFile: string) {}

  private async cookie(): Promise<string> {
    try {
      const info = await stat(this.sessionFile);
      if (
        !info.isFile() ||
        info.size > 32768 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error("Unsafe session file");
      const session = sessionSchema.parse(JSON.parse(await readFile(this.sessionFile, "utf8")));
      return `access_token=${session.accessToken}`;
    } catch {
      throw new DeliveryError(
        "Сессия Mashina отсутствует или небезопасна. Нужен JSON accessToken в файле с правами 0600.",
        "failed",
      );
    }
  }

  private async request(cookie: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          "X-Project-Id": "1",
          "Accept-Language": "ru",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: "error",
      });
    } catch {
      throw new DeliveryError("Mashina недоступна. Сообщение ещё не отправлялось.", "failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeliveryError(
        `Mashina HTTP ${response.status}. Обновите сессию или дождитесь снятия ограничения; обход ограничений не выполняется.`,
        "failed",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new DeliveryError("Неизвестный формат ответа Mashina.", "failed");
    }
  }

  private async connect(cookie: string): Promise<Socket> {
    const socket = io("https://api.mashina.kg", {
      path: "/api/chat/socket.io/",
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie, Origin: ORIGIN },
      // Node's withCredentials cookie jar replaces the explicit session header.
      reconnection: false,
      timeout: TIMEOUT,
      autoConnect: false,
    });
    const { promise, resolve, reject } = Promise.withResolvers<Socket>();
    const timer = setTimeout(fail, TIMEOUT);
    function fail() {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
      reject(
        new DeliveryError(
          "Не удалось подключить чат Mashina. Проверьте сессию и доступ к площадке.",
          "failed",
        ),
      );
    }
    socket.once("connect_error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("connect_error", fail);
      resolve(socket);
    });
    socket.connect();
    return promise;
  }

  async check(): Promise<SourceStatus> {
    try {
      const cookie = await this.cookie();
      const profile = await this.request(cookie, "/profile/me");
      if (!profile || typeof profile !== "object") throw new Error("Invalid profile");
      const socket = await this.connect(cookie);
      socket.disconnect();
      return {
        source: this.source,
        ready: true,
        message: "Сессия и подключение чата проверены. Это не разрешение площадки на рекламу.",
      };
    } catch (error) {
      return {
        source: this.source,
        ready: false,
        message:
          error instanceof DeliveryError ? error.message : "Не удалось проверить сессию Mashina.",
      };
    }
  }

  async resolve(candidate: Candidate): Promise<Recipient> {
    const url = new URL(candidate.url);
    const slug = /^\/details\/([a-z0-9-]+)\/?$/.exec(url.pathname)?.[1];
    if (
      candidate.source !== this.source ||
      url.protocol !== "https:" ||
      !["mashina.kg", "www.mashina.kg"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !slug
    )
      throw new DeliveryError("Неподдерживаемая ссылка объявления Mashina.", "failed", false);
    return this.listing(await this.cookie(), slug);
  }

  private async listing(cookie: string, slug: string, sellerId?: string): Promise<Recipient> {
    if (!/^[a-z0-9-]+$/.test(slug))
      throw new DeliveryError("Неверный идентификатор объявления Mashina.", "failed", false);
    const data = listingSchema.safeParse(
      await this.request(cookie, `/ads/${encodeURIComponent(slug)}/detail`),
    );
    if (!data.success || data.data.slug !== slug)
      throw new DeliveryError("Не удалось подтвердить продавца и объявление Mashina.", "failed");
    if (data.data.status !== "active" || data.data.is_owner || data.data.is_my_ad)
      throw new DeliveryError("Объявление неактивно или принадлежит отправителю.", "failed", false);
    if (sellerId !== undefined && String(data.data.user_id) !== sellerId)
      throw new DeliveryError("Продавец объявления Mashina изменился.", "failed", false);
    return { id: String(data.data.user_id), listingId: data.data.slug };
  }

  private async upload(cookie: string, image: OutreachImage): Promise<number> {
    const parsed = uploadSchema.safeParse(
      await this.request(cookie, "/chats/images/presign", {
        images: [{ content_type: image.mime }],
      }),
    );
    if (!parsed.success)
      throw new DeliveryError("Mashina не выдала адрес загрузки фото.", "failed");
    const entry = parsed.data.images[0]!;
    const url = new URL(entry.upload_url);
    // Signed upload URLs are issued by the authenticated first-party endpoint. No credentials follow them.
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/(?:^|\.)(?:mashina\.kg|amazonaws\.com|cloudflarestorage\.com)$/.test(url.hostname)
    )
      throw new DeliveryError(
        "Неподтверждённый домен загрузки Mashina. Отправка остановлена.",
        "failed",
      );
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": image.mime },
        body: image.bytes,
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Upload failed");
      await response.body?.cancel();
    } catch {
      throw new DeliveryError("Фото не загружено в Mashina. Сообщение не отправлено.", "failed");
    }
    await this.request(cookie, "/chats/images/confirm", { image_ids: [entry.image_id] });
    return entry.image_id;
  }

  async send(
    recipient: Recipient,
    text: string,
    image: OutreachImage | null,
  ): Promise<{ remoteId: string | null }> {
    const id = Number(recipient.id);
    if (!nativeId.safeParse(id).success || String(id) !== recipient.id)
      throw new DeliveryError("Неверный идентификатор продавца.", "failed");
    const cookie = await this.cookie();
    await this.listing(cookie, recipient.listingId, recipient.id);
    const imageId = image ? await this.upload(cookie, image) : null;
    const socket = await this.connect(cookie);
    try {
      // Recheck after photo preparation and socket connection, using the socket's session.
      await this.listing(cookie, recipient.listingId, recipient.id);
      // One emit only. A timeout/disconnect after emission is ambiguous, never a retry signal.
      const { promise, resolve, reject } = Promise.withResolvers<{ remoteId: string | null }>();
      socket.timeout(TIMEOUT).emit(
        "chat:message:send",
        {
          to_user: id,
          content: text,
          temp_id: Date.now(),
          ...(imageId === null ? {} : { image_ids: [imageId] }),
        },
        (error: Error | null, ack: unknown) => {
          if (error) {
            reject(
              new DeliveryError(
                "Нет подтверждения отправки Mashina. Возможна доставка; повтор запрещён до ручной проверки.",
                "unknown",
              ),
            );
            return;
          }
          const result = z
            .object({ ok: z.boolean(), message: z.object({ id: nativeId }).optional() })
            .safeParse(ack);
          if (!result.success) {
            reject(
              new DeliveryError(
                "Неизвестное подтверждение Mashina; повтор запрещён до ручной проверки.",
                "unknown",
              ),
            );
            return;
          }
          if (!result.data.ok) {
            reject(
              new DeliveryError(
                "Mashina отклонила сообщение. Проверьте ограничения аккаунта.",
                "failed",
              ),
            );
            return;
          }
          resolve({ remoteId: result.data.message ? String(result.data.message.id) : null });
        },
      );
      return await promise;
    } finally {
      socket.disconnect();
    }
  }
}
