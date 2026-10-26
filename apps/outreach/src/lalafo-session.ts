import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdtemp, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyRoute } from "@autodom/core";
import { CloudflareBrowser, nativeClient } from "@autodom/sources/cloudflare-browser";
import { type CloudflareSession, RiskBypass } from "@autodom/sources/riskbypass";
import type { Impit, ImpitResponse } from "impit";
import puppeteer, { type Browser } from "puppeteer-core";
import { Cookie, CookieJar } from "tough-cookie";
import { ProxyAgent } from "undici";
import { z } from "zod";

const ORIGIN = "https://lalafo.kg";
const CLEARANCE_URL = `${ORIGIN}/kyrgyzstan/nedvizhimost`;
const MAX_SESSION_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = 40_000;
const LOGIN_TIMEOUT = 400_000;
const nativeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const jwt = z
  .string()
  .max(16384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const accessToken = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7E]+$/);
const cookiesSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
    z
      .string()
      .max(4096)
      .regex(/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/),
  )
  .refine((cookies) => {
    const entries = Object.entries(cookies);
    return (
      Boolean(cookies.cf_clearance) &&
      entries.length <= 128 &&
      entries.every(([name, value]) => name.length + value.length + 1 <= 4096) &&
      entries.reduce((sum, [name, value]) => sum + name.length + value.length + 1, 0) <= 65536
    );
  });
const sessionSchema = z
  .object({
    token: jwt,
    accessToken,
    userId: nativeId,
    userHash: z.string().uuid(),
    deviceFingerprint: z.string().regex(/^[a-f0-9]{32}$/),
    proxyUrl: z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            Boolean(url.hostname && url.username && url.password) &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    userAgent: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x20-\x7E]+$/)
      .refine((value) => value.trim() === value),
    cookies: cookiesSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
const loginSchema = z.object({ id: nativeId, token: jwt, access_token: accessToken });
const profileSchema = z.object({ id: nativeId });

export interface LalafoSession {
  token: string;
  accessToken: string;
  userId: number;
  userHash: string;
  deviceFingerprint: string;
  proxyUrl: string;
  userAgent: string;
  cookies: Record<string, string>;
  createdAt: string;
}

function assertPrivateFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size > MAX_SESSION_BYTES ||
    (process.platform !== "win32" &&
      ((info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())))
  )
    throw new Error("Unsafe session file");
}

async function privatePath(path: string): Promise<string> {
  const absolute = resolve(path);
  const target = resolve(await realpath(dirname(absolute)), basename(absolute));
  const repository = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  const inside = relative(repository, target);
  if (inside === "" || (!inside.startsWith("../") && !isAbsolute(inside))) {
    throw new Error("Session files must be outside the repository");
  }
  return target;
}

export async function readLalafoSession(path: string): Promise<LalafoSession> {
  try {
    const file = await open(
      await privatePath(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      assertPrivateFile(info);
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length === 0 || length !== info.size) throw new Error("Invalid or changing session size");
      assertPrivateFile(await file.stat());
      return sessionSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(
      "Сессия Lalafo отсутствует, повреждена или небезопасна. Нужен собственный файл 0600 вне репозитория.",
    );
  }
}

async function sessionJar(cookies: Record<string, string>): Promise<CookieJar> {
  const jar = new CookieJar();
  for (const [key, value] of Object.entries(cookies)) {
    await jar.setCookie(new Cookie({ key, value, path: "/", secure: true }), ORIGIN);
  }
  return jar;
}

export async function createLalafoClient(session: LalafoSession): Promise<Impit> {
  try {
    const parsed = sessionSchema.parse(session);
    return nativeClient(
      new URL(parsed.proxyUrl),
      await sessionJar(parsed.cookies),
      parsed.userAgent,
    );
  } catch {
    throw new Error("Не удалось подготовить защищённый клиент Lalafo. Обновите сессию.");
  }
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error("Lalafo request deadline exceeded"));
  signal.addEventListener("abort", abort, { once: true });
  operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  return promise;
}

async function readJson(response: ImpitResponse, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Lalafo response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Lalafo response too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
    ) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || !value.trim() || value.length > 4096)
    throw new Error("Missing login configuration");
  return value;
}

function dedicatedRoute(env: NodeJS.ProcessEnv): ProxyRoute {
  const endpoint = required(env, "SMARTPROXY_LALAFO_ENDPOINT").trim();
  const username = required(env, "SMARTPROXY_LALAFO_USERNAME").trim();
  const password = required(env, "SMARTPROXY_LALAFO_PASSWORD");
  const value = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
  const url = new URL(value);
  const authority = /^[a-z]+:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? "";
  const port = Number(/:(\d+)$/u.exec(authority)?.[1]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    authority.includes("@") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    username.includes(":") ||
    /[\p{Cc}\s\u0100-\u{10FFFF}]/u.test(username + password)
  )
    throw new Error("Invalid dedicated ISP proxy configuration");
  return new ProxyRoute(
    "lalafo",
    url.href,
    `Basic ${Buffer.from(`${username}:${password}`, "latin1").toString("base64")}`,
  );
}

async function checkDestination(path: string): Promise<void> {
  try {
    assertPrivateFile(await lstat(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeSession(path: string, session: LalafoSession): Promise<void> {
  const data = `${JSON.stringify(sessionSchema.parse(session))}\n`;
  if (Buffer.byteLength(data) > MAX_SESSION_BYTES) throw new Error("Session too large");
  const temporary = resolve(dirname(path), `.lalafo-session-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(data, "utf8");
    await file.sync();
    await file.close();
    await checkDestination(path);
    await rename(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Explicit authentication only: no messages, retries, or parser transport changes. */
export async function loginLalafoSession(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  let dispatcher: ProxyAgent | undefined;
  let browser: Browser | undefined;
  let profileDirectory: string | undefined;
  const deadline = AbortSignal.timeout(LOGIN_TIMEOUT);
  const abortBrowser = () => {
    void browser?.close().catch(() => undefined);
  };
  deadline.addEventListener("abort", abortBrowser, { once: true });
  let stage =
    "Проверьте Chrome, переменные входа Lalafo, выделенный ISP-прокси, RiskBypass и приватный путь сессии.";
  try {
    const destination = await privatePath(path);
    await checkDestination(destination);
    const executablePath = required(env, "AUTODOM_OUTREACH_CHROME_PATH");
    await access(executablePath, constants.X_OK);
    const mobile = required(env, "AUTODOM_OUTREACH_LALAFO_PHONE").trim();
    const password = required(env, "AUTODOM_OUTREACH_LALAFO_PASSWORD");
    if (!/^\+?[0-9]{8,15}$/.test(mobile)) throw new Error("Invalid phone");
    const route = dedicatedRoute(env);
    dispatcher = new ProxyAgent({ uri: route.urlFor(1), token: route.authorization });
    const solver = new RiskBypass({ apiKey: required(env, "RISKBYPASS_API_KEY"), dispatcher });
    let captured: { clearance: CloudflareSession; proxyUrl: string } | undefined;
    const clearanceBrowser = new CloudflareBrowser(
      route,
      1,
      {
        async solve(url, proxy, signal) {
          const clearance = await solver.solve(url, proxy, signal);
          captured = { clearance, proxyUrl: proxy.href };
          return clearance;
        },
      },
      randomUUID(),
    );
    stage =
      "Не удалось получить сессию защиты Lalafo через выделенный ISP-прокси. Автоматический повтор не выполнялся.";
    await bounded(
      clearanceBrowser.refresh(new URL(CLEARANCE_URL), clearanceBrowser.generation, deadline),
      deadline,
    );
    if (!captured) throw new Error("Missing clearance session");
    const { clearance, proxyUrl } = captured;
    const proxy = new URL(proxyUrl);
    stage =
      "Не удалось открыть изолированный Chrome для входа Lalafo. Проверьте executable и зависимости браузера.";
    profileDirectory = await mkdtemp(join(tmpdir(), "autodom-outreach-login-"));
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profileDirectory,
      timeout: 30_000,
      args: [
        `--proxy-server=${proxy.protocol}//${proxy.host}`,
        ...(env.AUTODOM_OUTREACH_CHROME_NO_SANDBOX === "true" ? ["--no-sandbox"] : []),
      ],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(REQUEST_TIMEOUT);
    page.setDefaultNavigationTimeout(REQUEST_TIMEOUT);
    await page.authenticate({
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    });
    await page.setUserAgent(clearance.userAgent);
    await browser.defaultBrowserContext().setCookie(
      ...Object.entries(clearance.cookies).map(([name, value]) => ({
        name,
        value,
        domain: ".lalafo.kg",
        path: "/",
        secure: true,
      })),
    );
    // Direct password HTTP was rejected while the real form accepted the same credentials.
    // Use that observed form once; never bypass an OTP/challenge or retry a rejected login.
    stage =
      "Lalafo не подтвердила вход через браузер. Возможны изменение формы, OTP или ограничение аккаунта; повтор не выполнялся.";
    await page.goto(ORIGIN, { waitUntil: "networkidle2" });
    await page.click("text/Вход");
    await page.waitForSelector("input[type=password]");
    await page.type('input[placeholder="Email или телефон"]', mobile);
    await page.type("input[type=password]", password);
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url() === `${ORIGIN}/api/auth/login`,
      { timeout: REQUEST_TIMEOUT, signal: deadline },
    );
    await page.click("text/Войти");
    const response = await submitted;
    if (!response.ok()) throw new Error("Browser login rejected");
    const login = loginSchema.parse(await response.json());
    const requestHeaders = response.request().headers();
    const cookies: Record<string, string> = { ...clearance.cookies };
    for (const cookie of await browser.defaultBrowserContext().cookies()) {
      if (
        cookie.domain.replace(/^\./, "") === "lalafo.kg" &&
        !cookie.partitionKey &&
        [
          "cf_clearance",
          "jwt_token_spa",
          "event_user_hash",
          "device_fingerprint",
          "event_session_id",
        ].includes(cookie.name)
      )
        cookies[cookie.name] = cookie.value;
    }
    const session = sessionSchema.parse({
      token: login.token,
      accessToken: login.access_token,
      userId: login.id,
      userHash: cookies.event_user_hash ?? requestHeaders["user-hash"],
      deviceFingerprint: requestHeaders["device-fingerprint"],
      proxyUrl,
      userAgent: clearance.userAgent,
      cookies,
      createdAt: new Date().toISOString(),
    });
    stage = "Lalafo не подтвердила перенос сессии в сервис. Приватный файл не изменён.";
    const client = await createLalafoClient(session);
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]);
    const profileResponse = await bounded(
      client.fetch(`${ORIGIN}/api/user/v3/profiles?user_id=${session.userId}`, {
        headers: {
          Authorization: `Bearer ${session.token}`,
          Origin: ORIGIN,
          device: "pc",
          language: "ru_RU",
          "country-id": "12",
          "user-hash": session.userHash,
        },
        redirect: "manual",
        signal,
      }),
      signal,
    );
    if (!profileResponse.ok) {
      void profileResponse.body?.cancel().catch(() => undefined);
      throw new Error("Session transfer rejected");
    }
    const profile = profileSchema.parse(await readJson(profileResponse, signal));
    if (profile.id !== session.userId) throw new Error("Profile mismatch");
    deadline.throwIfAborted();
    stage =
      "Не удалось безопасно сохранить сессию Lalafo. Нужен собственный файл 0600 вне репозитория.";
    await writeSession(destination, session);
  } catch {
    throw new Error(stage);
  } finally {
    deadline.removeEventListener("abort", abortBrowser);
    await browser?.close().catch(() => undefined);
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
    await dispatcher?.destroy().catch(() => undefined);
  }
}
