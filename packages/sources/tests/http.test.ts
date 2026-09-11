import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import { type Dispatcher, fetch, MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyTransport, retryAfterSeconds } from "../src/http.js";

const directories: string[] = [];
const transports: ProxyTransport[] = [];
const browserAgents = new Set<MockAgent>();
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all([...browserAgents].map((agent) => agent.close()));
  browserAgents.clear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function transportWith(agents: MockAgent[], browserRoutes = agents) {
  const dataDir = await mkdtemp(join(tmpdir(), "autodom-http-test-"));
  directories.push(dataDir);
  for (const agent of browserRoutes) browserAgents.add(agent);
  const transport = new ProxyTransport({
    routes: agents.map(
      (_, index) =>
        new ProxyRoute(
          index ? "residential" : "datacenter",
          "http://proxy.test:7000",
          "Basic ZGVtbzpkZW1v",
          7000,
          1,
        ),
    ),
    dataDir,
    requestDelaySeconds: 0,
    dispatcherFactory: (_route, _page, index): Dispatcher => {
      const agent = agents[index];
      if (!agent) throw new Error("Missing test proxy");
      browserAgents.delete(agent);
      return agent;
    },
    browserClientFactory: (_route, _page, index) => ({
      fetch: (url, init) => fetch(url, { ...init, dispatcher: browserRoutes[index]! }),
    }),
  });
  transports.push(transport);
  return transport;
}

function agentReply(status: number, body: string, headers: Record<string, string> = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://mashina.kg")
    .intercept({ path: "/catalog/passenger", method: "GET" })
    .reply(status, body, { headers });
  return agent;
}

describe("mandatory proxy document transport", () => {
  it("fails over only through configured routes and decodes a valid document", async () => {
    const first = agentReply(403, "blocked");
    const second = agentReply(200, '{"ok":true}');
    const transport = await transportWith([first, second]);
    const result = await transport.fetchDocument(
      "https://mashina.kg/catalog/passenger",
      JSON.parse,
      { source: "mashina.kg" },
    );
    expect(result).toEqual({ ok: true });
    first.assertNoPendingInterceptors();
    second.assertNoPendingInterceptors();
  });

  it("shares its concurrency bound across simultaneous document batches", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    let active = 0;
    let peak = 0;
    agent
      .get("https://mashina.kg")
      .intercept({ path: "/catalog/passenger", method: "GET" })
      .reply(() => {
        active += 1;
        peak = Math.max(peak, active);
        return { statusCode: 200, data: "ok" };
      })
      .delay(80)
      .times(5);
    const transport = await transportWith([agent]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        transport.fetchDocument(
          "https://mashina.kg/catalog/passenger",
          (text) => {
            active -= 1;
            return text;
          },
          { source: "mashina.kg" },
        ),
      ),
    );
    expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("preserves the BidCars two-second request floor independently of general crawl delay", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const agent = new MockAgent();
    agent.disableNetConnect();
    const starts: number[] = [];
    agent
      .get("https://bid.cars")
      .intercept({ path: "/en/", method: "GET" })
      .reply(() => {
        starts.push(performance.now());
        return { statusCode: 200, data: "ok" };
      })
      .times(2);
    const transport = await transportWith([agent]);
    await transport.fetchDocuments(
      Array.from({ length: 2 }, () => ({
        url: "https://bid.cars/en/",
        parse: (text: string) => text,
        options: { source: "bid.cars" },
      })),
    );
    const [first, second] = starts;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(Number(second) - Number(first)).toBeGreaterThanOrEqual(1900);
  });

  it("does not rotate around a source rate limit", async () => {
    const first = agentReply(429, "limited", { "retry-after": "120" });
    const second = agentReply(200, "must not request");
    const transport = await transportWith([first, second]);
    await expect(
      transport.fetchDocument("https://mashina.kg/catalog/passenger", (text) => text, {
        source: "mashina.kg",
      }),
    ).rejects.toMatchObject({ retry_after: 120 });
    expect(second.pendingInterceptors()).toHaveLength(1);
  });

  it("preserves origin rate limits on the browser transport without rotating proxies", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const blocked = new MockAgent();
    blocked.disableNetConnect();
    const first = new MockAgent();
    first.disableNetConnect();
    first
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(429, "limited", { headers: { "retry-after": "180" } });
    const second = new MockAgent();
    second.disableNetConnect();
    second
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(200, "must not request");
    const transport = await transportWith([blocked, blocked], [first, second]);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", (text) => text, {
        source: "bid.cars",
      }),
    ).rejects.toMatchObject({ retry_after: 180 });
    expect(second.pendingInterceptors()).toHaveLength(1);
  });

  it("rejects browser redirects and oversized documents before parsing", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const blocked = new MockAgent();
    blocked.disableNetConnect();
    const redirect = new MockAgent();
    redirect.disableNetConnect();
    redirect
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(302, "", { headers: { location: "http://127.0.0.1/private" } });
    redirect.get("http://127.0.0.1").intercept({ path: "/private" }).reply(200, "private content");
    const transport = await transportWith([blocked], [redirect]);
    const parse = vi.fn((text: string) => text);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", parse, {
        source: "bid.cars",
      }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(redirect.pendingInterceptors()).toHaveLength(1);
    const oversized = new MockAgent();
    oversized.disableNetConnect();
    oversized
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(200, "x".repeat(4 * 1024 * 1024 + 1));
    const bounded = await transportWith([blocked], [oversized]);
    await expect(
      bounded.fetchDocument("https://bid.cars/en/automobile/page/1", parse, {
        source: "bid.cars",
      }),
    ).rejects.toBeInstanceOf(SourceError);
    oversized.assertNoPendingInterceptors();
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects disabled sources and off-origin requests before transport", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
    const agent = agentReply(200, "unused");
    const transport = await transportWith([agent]);
    await expect(
      transport.fetchDocument("https://bid.cars/en/", (text) => text, { source: "bid.cars" }),
    ).rejects.toBeInstanceOf(SourceError);
    await expect(
      transport.fetchDocument("http://127.0.0.1/private", (text) => text, { source: "mashina.kg" }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("does not follow redirects or accept oversized documents", async () => {
    const redirect = agentReply(302, "", { location: "http://127.0.0.1/private" });
    redirect.get("http://127.0.0.1").intercept({ path: "/private" }).reply(200, "private content");
    const transport = await transportWith([redirect]);
    const parse = vi.fn((text: string) => text);
    await expect(
      transport.fetchDocument("https://mashina.kg/catalog/passenger", parse, {
        source: "mashina.kg",
      }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(redirect.pendingInterceptors()).toHaveLength(1);
    const excessive = agentReply(200, "x".repeat(4 * 1024 * 1024 + 1));
    const oversized = await transportWith([excessive]);
    await expect(
      oversized.fetchDocument("https://mashina.kg/catalog/passenger", parse, {
        source: "mashina.kg",
      }),
    ).rejects.toBeInstanceOf(SourceError);
    excessive.assertNoPendingInterceptors();
    expect(parse).not.toHaveBeenCalled();
  });

  it("allows only bounded official NBKR currency archives", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://www.nbkr.kg")
      .intercept({ path: /.*/, method: "GET" })
      .reply(200, "87.4500")
      .persist();
    const transport = await transportWith([agent]);
    const url =
      "https://www.nbkr.kg/index1.jsp?item=1562&lang=RUS&valuta_id=15&beg_day=08&beg_month=09&beg_year=2026&end_day=11&end_month=09&end_year=2026";
    expect(await transport.fetchDocument(url, Number, { source: "nbkr.kg" })).toBe(87.45);
    await expect(
      transport.fetchDocument(url, Number, { source: "nbkr.kg", params: { item: "1" } }),
    ).rejects.toBeInstanceOf(SourceError);
    await expect(
      transport.fetchDocument(`${url}&redirect=elsewhere`, Number, { source: "nbkr.kg" }),
    ).rejects.toBeInstanceOf(SourceError);
    await expect(
      transport.fetchDocument(url, Number, { source: "nbkr.kg", params: { beg_year: "2025" } }),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it("collects repeated batches within a bounded worker heap", async () => {
    const program = `
      import assert from 'node:assert/strict';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { MockAgent } from 'undici';
      import { ProxyRoute } from ${JSON.stringify(new URL("../../core/src/index.ts", import.meta.url).href)};
      import { ProxyTransport } from ${JSON.stringify(new URL("../src/http.ts", import.meta.url).href)};
      const dir = await mkdtemp(join(tmpdir(), 'autodom-bounded-worker-'));
      const proxy = new MockAgent();
      proxy.disableNetConnect();
      proxy.get('https://mashina.kg').intercept({ path: '/catalog/passenger' }).reply(200, 'ok').times(24);
      const transport = new ProxyTransport({
        routes: [new ProxyRoute('datacenter', 'http://proxy.test:7000', 'Basic ZGVtbzpkZW1v', 7000, 1)],
        dataDir: dir, requestDelaySeconds: 0, dispatcherFactory: () => proxy,
      });
      try {
        for (let page = 1; page <= 24; page++) {
          assert.equal(await transport.fetchDocument('https://mashina.kg/catalog/passenger', text => text, { source: 'mashina.kg', page }), 'ok');
          global.gc();
        }
        proxy.assertNoPendingInterceptors();
      } finally {
        await transport.close();
        await rm(dir, { recursive: true, force: true });
      }
    `;
    await promisify(execFile)(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        program,
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        env: { ...process.env, AUTODOM_APPROVED_SOURCES: "mashina.kg" },
        timeout: 25_000,
      },
    );
  }, 30_000);

  it("requires proxies even for the explicitly allowed NBKR feed", () => {
    expect(() => new ProxyTransport({ routes: [], dataDir: tmpdir() })).toThrow("proxies");
  });
});

it("honors Retry-After without unbounded numeric or malformed delays", () => {
  expect(retryAfterSeconds("5", 100)).toBe(60);
  expect(retryAfterSeconds("120", 100)).toBe(120);
  expect(retryAfterSeconds("Thu, 01 Jan 1970 00:05:00 GMT", 100)).toBe(200);
  expect(retryAfterSeconds("garbage", 100)).toBe(300);
  expect(new SourceRateLimited(120)).toBeInstanceOf(SourceError);
});
