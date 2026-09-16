import { createServer } from "node:http";
import { ReadableStream } from "node:stream/web";
import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import type * as Undici from "undici";
import { fetch, MockAgent, Response } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVagvinCarfaxRecord, VagvinCarfaxLookup } from "../src/vagvin-carfax.js";
import { VinCheckService } from "../src/vin.js";
import type { VinTransportOptions } from "../src/vin-session.js";

vi.mock("undici", async (original) => {
  const actual = await original<typeof Undici>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
// Match native abortable waits while allowing deterministic admission timing.
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

const VIN = "WBAJA9C56KB389776";
const COUNT = "📍 Записи в базе CARFAX";
const payload = {
  VIN,
  "✅ VIN определен как": "BMW 5 Series 530E Iperformance 2019",
  "📍 Записи в базе Autocheck": 77,
  [COUNT]: 47,
};
const routes = [
  new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dGVzdDp0ZXN0"),
  new ProxyRoute("residential", "http://proxy.invalid:7000", "Basic dGVzdDp0ZXN0", 7000, 3),
];
const lookups: VagvinCarfaxLookup[] = [];
const requests = vi.mocked(fetch);
const { fetch: realFetch } = await vi.importActual<typeof Undici>("undici");

function setup(options: Partial<VinTransportOptions> = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const lookup = new VagvinCarfaxLookup({ routes, dispatcherFactory: () => agent, ...options });
  lookups.push(lookup);
  return { lookup, agent, pool: agent.get("https://vagvin.ru") };
}

beforeEach(() => {
  vi.useFakeTimers();
  requests.mockReset().mockImplementation(realFetch);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline expired", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(async () => {
  await Promise.all(lookups.splice(0).map((lookup) => lookup.close()));
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("VAGVIN verified CARFAX schema", () => {
  it("separates CARFAX availability from decoder text and AutoCheck counts", () => {
    expect(parseVagvinCarfaxRecord(JSON.stringify(payload), VIN.toLowerCase())).toEqual({
      vin: VIN,
      record_count: 47,
      vehicle: payload["✅ VIN определен как"],
    });
    expect(parseVagvinCarfaxRecord(JSON.stringify({ ...payload, [COUNT]: 0 }), VIN)).toBeNull();
  });

  it.each([
    { ...payload, [COUNT]: undefined },
    { ...payload, [COUNT]: null },
    { ...payload, [COUNT]: "47" },
    { ...payload, [COUNT]: "0" },
    { ...payload, [COUNT]: -1 },
    { ...payload, [COUNT]: 1.5 },
    { ...payload, [COUNT]: Number.MAX_SAFE_INTEGER + 1 },
    { ...payload, VIN: "WBAJE7C55JG891379" },
    { ...payload, VIN: "WBAJE7C55JG891379", [COUNT]: 0 },
    { ...payload, Сообщение: "Upstream failed" },
    { ...payload, [COUNT]: 0, Сообщение: null },
  ])("rejects uncertain counts, messages and mismatched identities: %j", (value) => {
    expect(() => parseVagvinCarfaxRecord(JSON.stringify(value), VIN)).toThrow(SourceError);
  });

  it("does not treat a sales page as a verified negative", () => {
    expect(() => parseVagvinCarfaxRecord("<html>Buy CARFAX reports</html>", VIN)).toThrow(
      SourceError,
    );
  });
});

describe("VAGVIN fixed proxy and bounded C1 queue", () => {
  it("requires residential configuration rather than falling back to direct or datacenter", () => {
    expect(() => new VagvinCarfaxLookup({ routes: [] })).toThrow(SourceError);
    expect(() => new VagvinCarfaxLookup({ routes: routes.slice(0, 1) })).toThrow(SourceError);
  });

  it("queries the real fixed GET endpoint with normalized VIN through the same dispatcher", async () => {
    const { lookup, pool, agent } = setup();
    pool
      .intercept({ path: `/check_vin_car_aut?input=${VIN}`, method: "GET" })
      .reply(200, payload, { headers: { "content-type": "application/json" } });
    expect(await lookup.check(VIN.toLowerCase())).toMatchObject({ vin: VIN, record_count: 47 });
    vi.setSystemTime(Date.now() + 5000);
    pool
      .intercept({ path: `/check_vin_car_aut?input=${VIN}`, method: "GET" })
      .reply(200, { ...payload, [COUNT]: 0 }, { headers: { "content-type": "application/json" } });
    expect(await lookup.check(VIN)).toBeNull();
    agent.assertNoPendingInterceptors();
  });

  it("holds C1 through the full body, drops canceled entries, and spaces completed attempts", async () => {
    const { lookup } = setup({ requestDelaySeconds: 0 });
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        finish = () => controller.close();
      },
    });
    requests
      .mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(Response.json(payload));
    const first = lookup.check(VIN);
    await vi.advanceTimersByTimeAsync(0);
    const caller = new AbortController();
    const canceled = lookup.check(VIN, caller.signal).catch((error: unknown) => error);
    const third = lookup.check(VIN);
    caller.abort();
    expect(await canceled).toBe(caller.signal.reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toMatchObject({ record_count: 47 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(requests).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toMatchObject({ record_count: 47 });
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("honors a configured gap larger than five seconds", async () => {
    const { lookup } = setup({ requestDelaySeconds: 8 });
    requests.mockImplementation(async () => Response.json(payload));
    await lookup.check(VIN);
    const second = lookup.check(VIN);
    await vi.advanceTimersByTimeAsync(7999);
    expect(requests).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({ record_count: 47 });
  });

  it("admits at most ten requests and frees canceled waiting capacity immediately", async () => {
    const { lookup } = setup();
    requests.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>()));
    const active = lookup.check(VIN).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const callers = Array.from({ length: 9 }, () => new AbortController());
    const waiting = callers.map((caller) =>
      lookup.check(VIN, caller.signal).catch((error: unknown) => error),
    );
    await expect(lookup.check(VIN)).rejects.toThrow("queue is full");
    callers[0]!.abort();
    const replacement = new AbortController();
    let replacementSettled = false;
    const admitted = lookup.check(VIN, replacement.signal).catch((error: unknown) => {
      replacementSettled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replacementSettled).toBe(false);
    await lookup.close();
    await Promise.all([active, admitted, ...waiting]);
    expect(requests).toHaveBeenCalledTimes(1);
    await expect(lookup.check(VIN)).rejects.toBeDefined();
  });

  it("counts queue wait against the deadline and never sends canceled work later", async () => {
    const { lookup } = setup({ timeoutMs: 25 });
    requests.mockImplementation(async () => Response.json(payload));
    await lookup.check(VIN);
    const pending = lookup.check(VIN).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ name: "TimeoutError" });
    await lookup.close();
    expect(requests).toHaveBeenCalledTimes(1);
  });
  it("retains canceled in-flight admission until headers arrive and shutdown drains the response", async () => {
    const { lookup } = setup();
    const headers = Promise.withResolvers<Response>();
    requests.mockReturnValueOnce(headers.promise);
    const caller = new AbortController();
    const pending = lookup.check(VIN, caller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    const queued = lookup.check(VIN).catch((error: unknown) => error);
    let closed = false;
    const closing = lookup.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    const cancel = vi.fn();
    headers.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await closing;
    expect(await pending).toBe(caller.signal.reason);
    await queued;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("cancels body consumption and queued work on close", async () => {
    const { lookup } = setup();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    requests.mockResolvedValueOnce(new Response(body));
    const active = lookup.check(VIN).catch((error: unknown) => error);
    const waiting = lookup.check(VIN).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    await lookup.close();
    await Promise.all([active, waiting]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("honors 429 Retry-After without retrying or queueing requests during cooldown", async () => {
    const { lookup } = setup();
    requests
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "120" } }))
      .mockResolvedValueOnce(Response.json(payload));
    await expect(lookup.check(VIN)).rejects.toThrow(SourceError);
    await vi.advanceTimersByTimeAsync(119_999);
    await expect(lookup.check(VIN)).rejects.toBeInstanceOf(SourceRateLimited);
    expect(requests).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await lookup.check(VIN)).toMatchObject({ record_count: 47 });
  });

  it.each([401, 403, "captcha"] as const)(
    "blocks the instance permanently after %s",
    async (failure) => {
      const { lookup } = setup();
      requests.mockResolvedValueOnce(
        new Response(failure === "captcha" ? "<html>CAPTCHA required</html>" : "", {
          status: typeof failure === "number" ? failure : 200,
        }),
      );
      await expect(lookup.check(VIN)).rejects.toThrow(SourceError);
      await vi.advanceTimersByTimeAsync(3_600_000);
      await expect(lookup.check(VIN)).rejects.toThrow("blocked");
      expect(requests).toHaveBeenCalledTimes(1);
    },
  );

  it("stops CONNECT authentication failures until operator intervention", async () => {
    vi.useRealTimers();
    vi.mocked(AbortSignal.timeout).mockRestore();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let connections = 0;
    const proxy = createServer();
    proxy.on("connect", (_request, socket) => {
      connections += 1;
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not bind");
    const lookup = new VagvinCarfaxLookup({
      routes: [
        new ProxyRoute("residential", `http://127.0.0.1:${address.port}`, "Basic dGVzdDp0ZXN0"),
      ],
      timeoutMs: 5000,
    });
    lookups.push(lookup);
    try {
      await expect(lookup.check(VIN)).rejects.toBeInstanceOf(SourceError);
      clock.mockReturnValue(now + 3_600_000);
      await expect(lookup.check(VIN)).rejects.toBeInstanceOf(SourceError);
      expect(connections).toBe(1);
    } finally {
      await lookup.close();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["network", "server", "schema", "redirect"] as const)(
    "cools down on %s uncertainty without retries",
    async (failure) => {
      const { lookup } = setup();
      if (failure === "network")
        requests.mockRejectedValueOnce(new Error("private proxy credential"));
      else
        requests.mockResolvedValueOnce(
          failure === "schema"
            ? Response.json({ ...payload, [COUNT]: null })
            : new Response("", {
                status: failure === "server" ? 503 : 302,
                headers: { location: "https://example.invalid/" },
              }),
        );
      await expect(lookup.check(VIN)).rejects.toThrow("availability could not be verified");
      await vi.advanceTimersByTimeAsync(59_999);
      await expect(lookup.check(VIN)).rejects.toBeInstanceOf(SourceRateLimited);
      expect(requests).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      requests.mockResolvedValueOnce(Response.json(payload));
      expect(await lookup.check(VIN)).toMatchObject({ record_count: 47 });
    },
  );
});

describe("VAGVIN service observations", () => {
  it.each([
    [0, "not_found"],
    [null, "unavailable"],
  ] as const)(
    "distinguishes explicit zero from uncertain CARFAX counts: %s",
    async (count, status) => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      const service = new VinCheckService({
        routes,
        providers: ["vagvin_carfax"],
        dispatcherFactory: () => agent,
      });
      requests.mockResolvedValueOnce(Response.json({ ...payload, [COUNT]: count }));
      try {
        const result = await service.check(VIN);
        expect(result.vagvin_carfax).toMatchObject({ status, data: null });
      } finally {
        await service.close();
      }
    },
  );
});
