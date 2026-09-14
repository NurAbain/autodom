import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PaymentStore } from "@autodom/storage/payments";
import { PaymentRequestError } from "./payments.js";

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 1000;
const MAX_ATTEMPTS = 5;
const LOGIN_ID = /^[0-9a-f]{32}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = /^[A-HJ-NP-Z2-9]{8}$/u;

interface PendingLogin {
  secretDigest: Buffer;
  expiresAt: number;
  failedAttempts: number;
  identity?: { userId: number; code: string; codeDigest: Buffer };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class WebReportAuth {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly botUsername: string;

  constructor(
    private readonly ledger: PaymentStore,
    botUsername: string,
  ) {
    this.botUsername = botUsername.replace(/^@/u, "");
  }

  beginLogin(): { loginId: string; loginSecret: string; loginUrl: string; expiresAt: string } {
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(this.botUsername))
      throw new PaymentRequestError(503, "Вход через Telegram сейчас недоступен.");
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(id);
    }
    if (this.pending.size >= MAX_PENDING)
      throw new PaymentRequestError(429, "Слишком много запросов на вход. Попробуйте позже.");
    let loginId: string;
    do {
      loginId = randomBytes(16).toString("hex");
    } while (this.pending.has(loginId));
    const loginSecret = randomBytes(32).toString("hex");
    const expiresAt = now + LOGIN_TTL_MS;
    this.pending.set(loginId, { secretDigest: digest(loginSecret), expiresAt, failedAttempts: 0 });
    return {
      loginId,
      loginSecret,
      loginUrl: `https://t.me/${this.botUsername}?start=web_report_${loginId}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  issueCode(loginId: string, userId: number): { code: string; expiresAt: string } {
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new PaymentRequestError(400, "Некорректный пользователь Telegram.");
    const pending = this.requirePending(loginId);
    if (pending.identity && pending.identity.userId !== userId)
      throw new PaymentRequestError(403, "Этот запрос на вход уже связан с другим пользователем.");
    if (!pending.identity) {
      // The 32-symbol alphabet divides the byte range evenly: no modulo bias.
      const code = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % 32]!).join("");
      pending.identity = { userId, code, codeDigest: digest(code) };
    }
    return { code: pending.identity.code, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  async completeLogin(
    loginId: string,
    loginSecret: string,
    code: string,
  ): Promise<{ sessionToken: string; userId: number; expiresAt: string }> {
    const pending = this.requirePending(loginId);
    if (
      typeof loginSecret !== "string" ||
      !TOKEN.test(loginSecret) ||
      !timingSafeEqual(pending.secretDigest, digest(loginSecret))
    )
      throw new PaymentRequestError(401, "Вход нужно завершить в том браузере, где он был начат.");
    if (!pending.identity)
      throw new PaymentRequestError(409, "Сначала запросите код в личном чате Telegram-бота.");
    if (
      typeof code !== "string" ||
      !CODE.test(code) ||
      !timingSafeEqual(pending.identity.codeDigest, digest(code))
    ) {
      pending.failedAttempts += 1;
      if (pending.failedAttempts >= MAX_ATTEMPTS) {
        this.pending.delete(loginId);
        throw new PaymentRequestError(429, "Попытки ввода кода исчерпаны. Начните вход заново.");
      }
      throw new PaymentRequestError(401, "Неверный код входа.");
    }
    const userId = pending.identity.userId;
    // Consume before the first await, including when persistence fails: no parallel replay.
    this.pending.delete(loginId);
    const sessionToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.ledger.createWebSession(digest(sessionToken).toString("hex"), userId, expiresAt);
    return { sessionToken, userId, expiresAt };
  }

  async authenticate(sessionToken: string): Promise<number | null> {
    if (typeof sessionToken !== "string" || !TOKEN.test(sessionToken)) return null;
    const userId = await this.ledger.getWebSessionUser(digest(sessionToken).toString("hex"));
    return userId !== null && Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  }

  async logout(sessionToken: string): Promise<void> {
    if (typeof sessionToken !== "string" || !TOKEN.test(sessionToken)) return;
    await this.ledger.deleteWebSession(digest(sessionToken).toString("hex"));
  }

  private requirePending(loginId: string): PendingLogin {
    if (typeof loginId !== "string" || !LOGIN_ID.test(loginId))
      throw new PaymentRequestError(400, "Некорректный запрос на вход.");
    const pending = this.pending.get(loginId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(loginId);
      throw new PaymentRequestError(
        410,
        "Запрос на вход истёк или уже использован. Начните заново.",
      );
    }
    return pending;
  }
}
