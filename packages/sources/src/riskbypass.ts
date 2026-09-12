import { SourceError } from "@autodom/core";
import { type Dispatcher, fetch, type Response } from "undici";
import { z } from "zod";

const API_ORIGIN = "https://riskbypass.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOLVE_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_COOKIES = 128;
const MAX_COOKIE_BYTES = 4096;
const MAX_SESSION_COOKIE_BYTES = 64 * 1024;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const submissionSchema = z.object({
  ok: z.literal(true),
  task_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
});
const taskResultSchema = z.object({
  ok: z.literal(true).optional(),
  status: z
    .string()
    .max(64)
    .regex(/^[\x20-\x7E]*$/)
    .trim()
    .toUpperCase(),
  result: z.unknown().optional(),
});
const sessionSchema = z.object({
  cookies: z.record(z.string(), z.string()),
  user_agent: z.string().optional(),
  ua: z.string().optional(),
});

export interface CloudflareSession {
  cookies: Record<string, string>;
  userAgent: string;
}

export class RiskBypassError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = "RiskBypassError";
  }
}

function parseSession(value: unknown): CloudflareSession {
  const session = sessionSchema.parse(value);
  const userAgent = session.user_agent ?? session.ua;
  if (
    typeof userAgent !== "string" ||
    !userAgent.length ||
    userAgent.length > 2048 ||
    userAgent.trim() !== userAgent ||
    !/^[\x20-\x7E]+$/.test(userAgent)
  ) {
    throw new RiskBypassError("RiskBypass returned an invalid user agent");
  }
  const entries = Object.entries(session.cookies);
  if (entries.length === 0 || entries.length > MAX_COOKIES) {
    throw new RiskBypassError("RiskBypass returned an invalid cookie count");
  }
  const cookies: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, cookie] of entries) {
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(cookie)) {
      throw new RiskBypassError("RiskBypass returned an invalid cookie");
    }
    const cookieBytes = name.length + 1 + cookie.length;
    bytes += cookieBytes;
    if (cookieBytes > MAX_COOKIE_BYTES || bytes > MAX_SESSION_COOKIE_BYTES) {
      throw new RiskBypassError("RiskBypass session cookies exceed size limit");
    }
    cookies[name] = cookie;
  }
  if (!cookies.cf_clearance) {
    throw new RiskBypassError("RiskBypass returned no Cloudflare clearance");
  }
  return { cookies, userAgent };
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new RiskBypassError("RiskBypass returned an empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new RiskBypassError("RiskBypass response exceeds size limit");
      }
      chunks.push(chunk.value);
    }
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
    );
    return data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(new RiskBypassError("RiskBypass solve was interrupted"));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, POLL_INTERVAL_MS);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export class RiskBypass {
  readonly #apiKey: string;
  readonly #dispatcher: Dispatcher;

  constructor(options: { apiKey: string; dispatcher: Dispatcher }) {
    if (
      typeof options.apiKey !== "string" ||
      !/^[\x21-\x7E]{1,4096}$/.test(options.apiKey) ||
      !options.dispatcher
    ) {
      throw new RiskBypassError("RiskBypass requires an API key and dispatcher");
    }
    this.#apiKey = options.apiKey;
    this.#dispatcher = options.dispatcher;
  }

  async solve(targetUrl: URL, proxyUrl: URL, signal: AbortSignal): Promise<CloudflareSession> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), SOLVE_TIMEOUT_MS);
    const solveSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      solveSignal.throwIfAborted();
      // A submission can already be chargeable even if its response is lost. Never retry it.
      const submitted = submissionSchema.parse(
        await this.#request("/task/submit", solveSignal, {
          task_type: "cloudflare_waf",
          target_url: targetUrl.href,
          target_method: "GET",
          proxy: proxyUrl.href,
        }),
      );
      while (true) {
        const data = taskResultSchema.parse(
          await this.#request(`/task/result/${submitted.task_id}`, solveSignal),
        );
        switch (data.status) {
          case "QUEUED":
          case "RUNNING":
            await waitForPoll(solveSignal);
            break;
          case "SUCCESS":
            return parseSession(data.result);
          case "FAILED":
            throw new SourceError(
              "RiskBypass could not establish a session on the configured proxy",
            );
          case "NOT_FOUND":
            throw new RiskBypassError("RiskBypass task failed");
          default:
            throw new RiskBypassError("RiskBypass returned an unknown task status");
        }
      }
    } catch (error) {
      if (solveSignal.aborted) throw new RiskBypassError("RiskBypass solve was interrupted");
      if (error instanceof SourceError) throw error;
      // Transport and abort errors can contain URLs, credentials or provider bodies.
      throw new RiskBypassError("RiskBypass solve failed or was interrupted");
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(
    path: string,
    signal: AbortSignal,
    submission?: Record<string, string>,
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      requestSignal.throwIfAborted();
      const response = await fetch(`${API_ORIGIN}${path}`, {
        method: submission ? "POST" : "GET",
        headers: {
          "x-api-key": this.#apiKey,
          ...(submission
            ? { "Content-Type": "application/json" }
            : { "Cache-Control": "no-cache" }),
        },
        ...(submission ? { body: JSON.stringify(submission) } : {}),
        dispatcher: this.#dispatcher,
        redirect: "manual",
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RiskBypassError("RiskBypass API request failed");
      }
      const data = await readJson(response);
      requestSignal.throwIfAborted();
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
