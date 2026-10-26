import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Impit } from "impit";
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
import { createLalafoClient, type LalafoSession, readLalafoSession } from "./lalafo-session.js";

const ORIGIN = "https://lalafo.kg";
const TIMEOUT = 20_000;
const nativeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const listingSchema = z.object({
  id: nativeId,
  user_id: nativeId,
  country_id: z.number().int(),
  status_id: z.number().int(),
  hide_chat: z.boolean(),
  submit_request: z.unknown().refine((value) => value !== undefined),
  url: z.string().min(1),
});
const mediaUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  });
const uploadSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      thumbnail: mediaUrl,
      link: mediaUrl,
      width: nativeId,
      height: nativeId,
    }),
  )
  .min(1);
const acknowledgementSchema = z.object({
  message: z.object({
    kind: z.number().int(),
    created: nativeId,
    payload: z.string(),
    origin: nativeId.optional(),
    recipient: nativeId.optional(),
    id: z.union([nativeId, z.string().min(1).max(200)]).optional(),
  }),
});
type Transport = { session: LalafoSession; client: Impit };
type Connection = { socket: Socket; socketId: string; close(): void };

function listingUrl(value: string, relative = false): { id: number; path: string } {
  try {
    // URL.port hides an explicit :443; reject noncanonical authorities before parsing.
    if (!(relative && /^\/[^/]/.test(value)) && !value.startsWith(`${ORIGIN}/`))
      throw new Error("Noncanonical authority");
    const url = relative ? new URL(value, ORIGIN) : new URL(value);
    const match = /^\/[^/]+\/ads\/[^/]+-id-([1-9][0-9]*)\/?$/.exec(url.pathname);
    const id = Number(match?.[1]);
    if (
      url.protocol === "https:" &&
      url.hostname === "lalafo.kg" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match &&
      nativeId.safeParse(id).success &&
      String(id) === match[1]
    )
      return { id, path: url.pathname.replace(/\/$/, "") };
  } catch {
    // Never include a supplied URL (which may contain credentials) in the error.
  }
  throw new DeliveryError("Неподдерживаемая ссылка объявления Lalafo.", "failed", false);
}

/** First-party HTTP chat protocol; no chat creation, read receipts, or socket message emits. */
export class LalafoMessenger implements Messenger {
  readonly source = "lalafo.kg" as const;
  private cached: { serialized: string; client: Promise<Impit> } | undefined;

  constructor(private readonly sessionFile: string) {}

  private async transport(): Promise<Transport> {
    try {
      // Re-read the private file on every operation; a replacement invalidates tokens, jar and proxy.
      const session = await readLalafoSession(this.sessionFile);
      const serialized = JSON.stringify(session);
      if (this.cached?.serialized !== serialized) {
        this.cached = { serialized, client: createLalafoClient(session) };
      }
      return { session, client: await this.cached.client };
    } catch {
      this.cached = undefined;
      throw new DeliveryError(
        "Сессия Lalafo отсутствует или небезопасна. Выполните вход заново.",
        "failed",
      );
    }
  }

  private async request(
    transport: Transport,
    path: string,
    body?: unknown,
    socketId?: string,
    delivering = false,
  ): Promise<unknown> {
    const { session, client } = transport;
    const multipart = body instanceof FormData;
    try {
      const response = await client.fetch(`${ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Origin: ORIGIN,
          "User-Agent": session.userAgent,
          Authorization: `Bearer ${session.token}`,
          device: "pc",
          language: "ru_RU",
          "country-id": "12",
          "request-id": randomUUID(),
          "user-hash": session.userHash,
          ...(body === undefined ? {} : { "device-fingerprint": session.deviceFingerprint }),
          ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }),
          ...(socketId === undefined ? {} : { "socket-id": socketId }),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT),
        timeout: TIMEOUT,
        redirect: "manual",
      });
      if (!response.ok) {
        // Discard provider bodies: they may contain signed media URLs or authentication details.
        void response.body?.cancel().catch(() => {});
        throw new DeliveryError(
          `Lalafo HTTP ${response.status}. Отправка остановлена; проверьте сессию и ограничения аккаунта.`,
          delivering && !(response.status >= 400 && response.status < 500) ? "unknown" : "failed",
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(
        delivering
          ? "Нет достоверного подтверждения Lalafo. Возможна доставка; повтор запрещён до ручной проверки."
          : "Lalafo не ответила корректно. Сообщение не отправлялось.",
        delivering ? "unknown" : "failed",
      );
    }
  }

  private async connect(session: LalafoSession): Promise<Connection> {
    const agent = new HttpsProxyAgent(session.proxyUrl);
    let socket: Socket;
    try {
      socket = io("https://websocket.lalafo.com", {
        path: "/chat-ws/socket.io",
        transports: ["websocket"],
        query: { token: session.accessToken, userHash: session.userHash },
        extraHeaders: { Origin: ORIGIN, "User-Agent": session.userAgent },
        transportOptions: { websocket: { agent } },
        reconnection: false,
        timeout: TIMEOUT,
        autoConnect: false,
      });
    } catch {
      agent.destroy();
      throw new DeliveryError("Не удалось подключить чат Lalafo.", "failed");
    }
    const { promise, resolve, reject } = Promise.withResolvers<Connection>();
    const close = () => {
      socket.removeAllListeners();
      socket.disconnect();
      agent.destroy();
    };
    const timer = setTimeout(fail, TIMEOUT);
    function fail() {
      clearTimeout(timer);
      close();
      reject(
        new DeliveryError("Lalafo не подтвердила подключение чата. Проверьте сессию.", "failed"),
      );
    }
    const onMessage = (value: unknown) => {
      const result = z
        .object({ ref: z.literal("SocketConnection"), socketId: z.string().min(1).max(512) })
        .safeParse(value);
      if (!result.success) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("connect_error", fail);
      socket.off("disconnect", fail);
      resolve({ socket, socketId: result.data.socketId, close });
    };
    socket.on("message", onMessage);
    socket.once("connect_error", fail);
    socket.once("disconnect", fail);
    try {
      socket.connect();
    } catch {
      fail();
    }
    return promise;
  }

  async check(): Promise<SourceStatus> {
    let connection: Connection | undefined;
    try {
      const transport = await this.transport();
      const profile = z
        .object({ id: nativeId })
        .safeParse(
          await this.request(
            transport,
            `/api/user/v3/profiles?user_id=${transport.session.userId}`,
          ),
        );
      if (!profile.success || profile.data.id !== transport.session.userId)
        throw new DeliveryError("Lalafo не подтвердила аккаунт текущей сессии.", "failed");
      connection = await this.connect(transport.session);
      return {
        source: this.source,
        ready: true,
        message:
          "Сессия и подключение чата проверены без отправки сообщений. Это не разрешение площадки на рекламу.",
      };
    } catch (error) {
      return {
        source: this.source,
        ready: false,
        message:
          error instanceof DeliveryError ? error.message : "Не удалось проверить сессию Lalafo.",
      };
    } finally {
      connection?.close();
    }
  }

  private async details(transport: Transport, id: number) {
    const parsed = listingSchema.safeParse(
      await this.request(transport, `/api/search/v3/feed/details/${id}?expand=url`),
    );
    if (!parsed.success || parsed.data.id !== id)
      throw new DeliveryError("Не удалось подтвердить объявление и продавца Lalafo.", "failed");
    const listing = parsed.data;
    const canonical = listingUrl(listing.url, true);
    if (canonical.id !== id)
      throw new DeliveryError("Lalafo вернула другое объявление. Отправка остановлена.", "failed");
    if (
      listing.country_id !== 12 ||
      listing.status_id !== 2 ||
      listing.hide_chat ||
      listing.submit_request !== null ||
      listing.user_id === transport.session.userId
    )
      throw new DeliveryError(
        "Объявление Lalafo неактивно, принадлежит отправителю или не принимает сообщения в чат.",
        "failed",
        false,
      );
    return { listing, canonical };
  }

  async resolve(candidate: Candidate): Promise<Recipient> {
    if (candidate.source !== this.source)
      throw new DeliveryError("Неверная площадка объявления Lalafo.", "failed", false);
    const target = listingUrl(candidate.url);
    const { listing, canonical } = await this.details(await this.transport(), target.id);
    if (canonical.path !== target.path)
      throw new DeliveryError(
        "Ссылка не совпадает с подтверждённым объявлением Lalafo.",
        "failed",
        false,
      );
    return { id: String(listing.user_id), listingId: String(listing.id) };
  }

  private async upload(transport: Transport, adId: number, image: OutreachImage) {
    const body = new FormData();
    body.append(
      "image_file",
      new Blob([image.bytes], { type: image.mime }),
      image.mime === "image/png" ? "offer.png" : "offer.jpg",
    );
    body.append("ad_id", String(adId));
    const parsed = uploadSchema.safeParse(
      await this.request(transport, "/api/upload/upload/v3/chats/upload", body),
    );
    if (!parsed.success)
      throw new DeliveryError(
        "Lalafo не подтвердила загрузку фото. Сообщение не отправлено.",
        "failed",
      );
    const imageData = parsed.data[0]!;
    return {
      ref: "MediaEntity",
      name: imageData.name,
      type: 1,
      origin: imageData.link,
      thumbnail: imageData.thumbnail,
      width: imageData.width,
      height: imageData.height,
      size: image.bytes.length,
    };
  }

  async send(
    recipient: Recipient,
    text: string,
    image: OutreachImage | null,
  ): Promise<{ remoteId: string | null }> {
    const sellerId = Number(recipient.id);
    const adId = Number(recipient.listingId);
    if (
      !nativeId.safeParse(sellerId).success ||
      String(sellerId) !== recipient.id ||
      !nativeId.safeParse(adId).success ||
      String(adId) !== recipient.listingId
    )
      throw new DeliveryError("Неверный идентификатор продавца или объявления Lalafo.", "failed");
    const transport = await this.transport();
    // Revalidate at the mutation boundary: a previously resolved seller or chat setting may change.
    const { listing } = await this.details(transport, adId);
    if (listing.user_id !== sellerId)
      throw new DeliveryError(
        "Продавец объявления Lalafo изменился. Отправка остановлена.",
        "failed",
      );
    const connection = await this.connect(transport.session);
    let textAcknowledged = false;
    try {
      // Upload is not delivery. A failed upload must leave the seller completely untouched.
      const media = image ? await this.upload(transport, adId, image) : null;
      const post = async (kind: 1 | 2, payload: string) => {
        if (!connection.socket.connected)
          throw new DeliveryError(
            "Подключение чата Lalafo закрыто. Отправка остановлена.",
            "failed",
          );
        const result = acknowledgementSchema.safeParse(
          await this.request(
            transport,
            "/api/chat/v4/message/send",
            {
              ref: "Message",
              feedType: 1,
              feedId: { adId, userId1: sellerId, userId2: transport.session.userId },
              message: {
                ref: "MessageEntity",
                type: 1,
                kind,
                origin: transport.session.userId,
                recipient: sellerId,
                created: Math.floor(Date.now() / 1000),
                payload,
                media: kind === 2 && media ? [media] : [],
              },
              ack: randomUUID(),
            },
            connection.socketId,
            true,
          ),
        );
        if (
          !result.success ||
          result.data.message.kind !== kind ||
          result.data.message.payload !== payload ||
          (result.data.message.origin !== undefined &&
            result.data.message.origin !== transport.session.userId) ||
          (result.data.message.recipient !== undefined &&
            result.data.message.recipient !== sellerId)
        )
          throw new DeliveryError(
            "Неизвестное подтверждение Lalafo; повтор запрещён до ручной проверки.",
            "unknown",
          );
        return result.data.message.id === undefined ? null : String(result.data.message.id);
      };
      const textId = await post(1, text);
      textAcknowledged = true;
      // Lalafo has no photo caption: these are two separately acknowledged messages.
      const photoId = media ? await post(2, media.origin) : null;
      return { remoteId: photoId ?? textId };
    } catch (error) {
      if (textAcknowledged)
        throw new DeliveryError(
          "Текст подтверждён Lalafo, но отправка фото не подтверждена. Частичная доставка; не повторяйте отправку до ручной проверки.",
          "unknown",
        );
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(
        "Подготовка сообщения Lalafo не завершена. Сообщение не отправлено.",
        "failed",
      );
    } finally {
      connection.close();
    }
  }
}
