import { ReadableStream } from "node:stream/web";
import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import { Response } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarcheckSession, type CarcheckSessionOptions } from "../src/carcheck-session.js";
import type { BrowserClient } from "../src/cloudflare-browser.js";

// Native timers/promises is not replaced by Vitest's clock. Preserve cancellation
// while scheduling every admission on the deterministic test clock.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const signal = options?.signal;
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return promise;
  },
}));

const url = new URL("https://carcheck.by/auto/KMHXX00XXPU123456");
const otherUrl = new URL("https://carcheck.by/auto/KMHXX00XXPU654321");
const routes = [
  new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic ZGM6c2VjcmV0"),
  new ProxyRoute("residential", "http://proxy.invalid:7000", "Basic cmVzOnNlY3JldA==", 7000, 3),
];
const sessions: CarcheckSession[] = [];
const site = () =>
  new Response("<!doctype html><html><title>Carcheck</title><body>carcheck.by</body></html>");

function setup(refresh: NonNullable<BrowserClient["refresh"]> = async () => {}) {
  let challenge = true;
  const requests = vi.fn<BrowserClient["fetch"]>(async (target) => {
    if (target.pathname !== "/" && challenge) {
      challenge = false;
      return new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
    }
    return site();
  });
  const capture = vi.fn(refresh);
  const factory = vi.fn<NonNullable<CarcheckSessionOptions["browserClientFactory"]>>(() => ({
    fetch: requests,
    refresh: capture,
  }));
  const session = new CarcheckSession({ routes, apiKey: "", browserClientFactory: factory });
  sessions.push(session);
  return { session, requests, capture };
}

async function accepted() {
  const context = setup();
  const first = context.session.fetch(url, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(6_000);
  expect((await first).status).toBe(200);
  context.requests.mockClear();
  return context;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.useRealTimers();
});

describe("Carcheck shared clearance", () => {
  it("prepares the public homepage without buying an unnecessary capture", async () => {
    const { session, capture, requests } = setup();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).not.toHaveBeenCalled();
    expect(requests.mock.calls.map(([target]) => target.pathname)).toEqual(["/"]);
  });

  it("never turns a challenged warmup homepage into a paid bootstrap target", async () => {
    const { session, requests, capture } = setup();
    requests.mockResolvedValueOnce(new Response("challenge", { status: 403 }));
    await expect(session.fetch(url, new AbortController().signal)).rejects.toBeInstanceOf(
      SourceError,
    );
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    const recovered = session.fetch(url, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await recovered).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0].href).toBe(url.href);
  });

  it("solves the actually challenged VIN once and reuses clearance for another VIN", async () => {
    const { session, capture } = await accepted();
    const next = session.fetch(otherUrl, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await next).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0].href).toBe(url.href);
  });

  it("keeps accepted clearance through a 504 and honors its pause without recapture", async () => {
    const { session, requests, capture } = await accepted();
    requests.mockResolvedValueOnce(
      new Response("upstream timeout", { status: 504, headers: { "retry-after": "60" } }),
    );
    const failed = session
      .fetch(url, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await failed).toBeInstanceOf(SourceRateLimited);
    await expect(session.fetch(url, new AbortController().signal)).rejects.toBeInstanceOf(
      SourceRateLimited,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await session.fetch(url, new AbortController().signal)).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("enforces one capture cooldown across replacement browsers", async () => {
    const { session, requests, capture } = await accepted();
    requests.mockResolvedValueOnce(new Response("challenge", { status: 403 }));
    const blocked = session
      .fetch(otherUrl, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await blocked).toBeInstanceOf(SourceError);
    await expect(session.fetch(url, new AbortController().signal)).rejects.toBeInstanceOf(
      SourceError,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(294_000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1]?.[0].href).toBe(otherUrl.href);
  });

  it("does not let a canceled VIN waiter cancel another caller's shared capture", async () => {
    const ready = Promise.withResolvers<void>();
    let captureSignal: AbortSignal | undefined;
    const { session, capture } = setup(async (_url, _generation, signal) => {
      captureSignal = signal;
      await ready.promise;
    });
    const caller = new AbortController();
    const canceled = session.fetch(url, caller.signal).catch((error: unknown) => error);
    const remaining = session.fetch(otherUrl, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    caller.abort(new Error("private-caller-reason"));
    expect(String(await canceled)).not.toContain("private-caller-reason");
    expect(captureSignal?.aborted).toBe(false);
    ready.resolve();
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await remaining).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("waits five minutes after capture failure, not merely after submission", async () => {
    const failed = Promise.withResolvers<void>();
    const { session, capture } = setup(async () => failed.promise);
    const initial = session
      .fetch(url, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(22_000);
    failed.reject(new Error("proxy-user:private-password"));
    expect(String(await initial)).not.toContain("private-password");
    await vi.advanceTimersByTimeAsync(280_000);
    await expect(session.fetch(url, new AbortController().signal)).rejects.toBeInstanceOf(
      SourceError,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    const retried = session.fetch(url, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await retried).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("holds admission and shutdown until an aborted pre-header request is drained", async () => {
    const { session, requests } = await accepted();
    const headers = Promise.withResolvers<Response>();
    requests.mockImplementationOnce(() => headers.promise);
    const caller = new AbortController();
    const first = session.fetch(url, caller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    caller.abort();
    expect(await first).toBeInstanceOf(SourceError);
    const second = session
      .fetch(otherUrl, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requests).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    const cancel = vi.fn();
    headers.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await closing;
    expect(await second).toBeInstanceOf(SourceError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps discovery serial through body consumption and removes canceled queue entries", async () => {
    const { session, requests } = await accepted();
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("archive"));
        finish = () => controller.close();
      },
    });
    requests.mockResolvedValueOnce(new Response(body));
    const first = session.fetch(url, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    const caller = new AbortController();
    const canceled = session.fetch(otherUrl, caller.signal).catch((error: unknown) => error);
    const third = session.fetch(otherUrl, new AbortController().signal);
    caller.abort();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(await canceled).toBeInstanceOf(SourceError);
    finish?.();
    expect(await (await first).text()).toBe("archive");
    expect((await third).status).toBe(200);
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("cancels and unlocks unfinished response bytes during shutdown", async () => {
    const { session, requests } = await accepted();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    requests.mockResolvedValueOnce(new Response(body));
    const pending = session
      .fetch(url, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(body.locked).toBe(true);
    await session.close();
    expect(await pending).toBeInstanceOf(SourceError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("aborts and drains an active paid capture on close", async () => {
    let signal: AbortSignal | undefined;
    const stopped = Promise.withResolvers<void>();
    const { session } = setup(async (_url, _generation, captureSignal) => {
      signal = captureSignal;
      captureSignal.addEventListener("abort", () => stopped.resolve(), { once: true });
      await stopped.promise;
    });
    const pending = session
      .fetch(url, new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    await session.close();
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(SourceError);
  });

  it("does not accept challenge HTML disguised as HTTP 200", async () => {
    const { session, requests } = await accepted();
    requests.mockResolvedValueOnce(
      new Response(
        "<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/a'></script></html>",
      ),
    );
    const pending = session.fetch(url, new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(SourceError);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
  });

  it.each([
    "https://carcheck.by.evil.invalid/auto/KMHXX00XXPU123456",
    "https://user:secret@carcheck.by/auto/KMHXX00XXPU123456",
    "https://carcheck.by/auto/KMHXX00XXPU123456?report=1",
    "https://carcheck.by/vin/KMHXX00XXPU123456",
  ])("rejects unsafe URLs before any request or capture: %s", async (target) => {
    const { session, requests, capture } = setup();
    await expect(
      session.fetch(new URL(target), new AbortController().signal),
    ).rejects.toBeInstanceOf(SourceError);
    expect(requests).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
