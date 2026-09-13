import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import { CookieJar } from "tough-cookie";
import { type Dispatcher, fetch, MockAgent, Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserClient } from "../src/cloudflare-browser.js";
import { ProxyTransport, retryAfterSeconds } from "../src/http.js";
import { RiskBypassError } from "../src/riskbypass.js";

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
  vi.useRealTimers();
});

async function transportWith(
  agents: MockAgent[],
  browserRoutes = agents,
  refresh?: BrowserClient["refresh"],
) {
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
      ...(refresh ? { refresh } : {}),
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

async function lalafoTransport(factory: (route: ProxyRoute, page: number) => BrowserClient) {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "lalafo.kg");
  const dataDir = await mkdtemp(join(tmpdir(), "autodom-lalafo-session-"));
  directories.push(dataDir);
  const transport = new ProxyTransport({
    routes: [new ProxyRoute("lalafo", "http://isp.test:10010", "Basic ZGVtbzpkZW1v", 10001, 10)],
    dataDir,
    requestDelaySeconds: 0,
    browserClientFactory: factory,
  });
  transports.push(transport);
  return transport;
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

  it("distributes BidCars details across the proxy pool between batches", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-bidcars-pool-"));
    directories.push(dataDir);
    const agents = Array.from({ length: 3 }, () => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      browserAgents.add(agent);
      const origin = agent.get("https://bid.cars");
      origin.intercept({ path: "/en/lot/example" }).reply(200, '{"available":true}');
      origin
        .intercept({ path: "/en/lot/example" })
        .reply(429, "Proxy request allowance exhausted", { headers: { "retry-after": "120" } })
        .persist();
      return agent;
    });
    const transport = new ProxyTransport({
      routes: [
        new ProxyRoute("residential", "http://proxy.test:7000", "Basic ZGVtbzpkZW1v", 7000, 3),
      ],
      dataDir,
      requestDelaySeconds: 0,
      browserClientFactory: (route, page) => {
        const agent = agents[Number(new URL(route.urlFor(page)).port) - 7000];
        if (!agent) throw new Error("Missing test proxy");
        return { fetch: (url, init) => fetch(url, { ...init, dispatcher: agent }) };
      },
    });
    transports.push(transport);
    const request = {
      url: "https://bid.cars/en/lot/example",
      parse: JSON.parse,
      options: { source: "bid.cars" },
    };
    await expect(transport.fetchDocuments([request, request])).resolves.toEqual([
      { available: true },
      { available: true },
    ]);
    await expect(
      transport.fetchDocument(request.url, request.parse, request.options),
    ).resolves.toEqual({ available: true });
  });

  it("keeps a working BidCars route across subsequent document batches", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const first = new MockAgent();
    first.disableNetConnect();
    first.get("https://bid.cars").intercept({ path: "/en/lot/example" }).reply(403, "blocked");
    first
      .get("https://bid.cars")
      .intercept({ path: "/en/lot/example" })
      .reply(429, "Do not repeat requests on this route", { headers: { "retry-after": "120" } });
    const second = new MockAgent();
    second.disableNetConnect();
    second
      .get("https://bid.cars")
      .intercept({ path: "/en/lot/example" })
      .reply(200, '{"available":true}')
      .times(2);
    const transport = await transportWith([first, second]);
    for (let batch = 0; batch < 2; batch++)
      await expect(
        transport.fetchDocument("https://bid.cars/en/lot/example", JSON.parse, {
          source: "bid.cars",
        }),
      ).resolves.toEqual({ available: true });
    second.assertNoPendingInterceptors();
    expect(first.pendingInterceptors()).toHaveLength(1);
  });

  it("quarantines a challenged BidCars port while keeping healthy sessions usable", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    vi.useFakeTimers({ toFake: ["Date"] });
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-bidcars-health-"));
    directories.push(dataDir);
    const agents = Array.from({ length: 3 }, () => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      browserAgents.add(agent);
      return agent;
    });
    const first = agents[0];
    if (!first) throw new Error("Missing test proxy");
    first
      .get("https://bid.cars")
      .intercept({ path: "/en/lot/example" })
      .reply(403, "challenge", { headers: { "cf-mitigated": "challenge" } });
    for (const agent of agents)
      agent
        .get("https://bid.cars")
        .intercept({ path: "/en/lot/example" })
        .reply(200, '{"available":true}')
        .persist();
    const refresh = vi.fn(async () => {
      throw new SourceError("Target session unavailable");
    });
    const transport = new ProxyTransport({
      routes: [
        new ProxyRoute("residential", "http://proxy.test:7000", "Basic ZGVtbzpkZW1v", 7000, 3),
      ],
      dataDir,
      requestDelaySeconds: 0,
      browserClientFactory: (route, page) => {
        const agent = agents[Number(new URL(route.urlFor(page)).port) - 7000];
        if (!agent) throw new Error("Missing test proxy");
        return {
          async fetch(url, init) {
            const response = await fetch(url, { ...init, dispatcher: agent });
            vi.setSystemTime(Date.now() + 2000);
            return response;
          },
          refresh,
        };
      },
    });
    transports.push(transport);
    for (let document = 0; document < 6; document++)
      await expect(
        transport.fetchDocument("https://bid.cars/en/lot/example", JSON.parse, {
          source: "bid.cars",
        }),
      ).resolves.toEqual({ available: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(first.pendingInterceptors()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 300_000);
    for (let document = 0; document < 3; document++)
      await transport.fetchDocument("https://bid.cars/en/lot/example", JSON.parse, {
        source: "bid.cars",
      });
    first.assertNoPendingInterceptors();
  });

  it("preserves authenticated BidCars sessions across both ten-port tiers", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    vi.useFakeTimers({ toFake: ["Date"] });
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-bidcars-sessions-"));
    directories.push(dataDir);
    const transport = new ProxyTransport({
      routes: ["datacenter", "residential"].map(
        (tier) => new ProxyRoute(tier, "http://proxy.test:7000", "Basic ZGVtbzpkZW1v", 7000, 10),
      ),
      dataDir,
      requestDelaySeconds: 0,
      browserClientFactory: (route, page) => {
        const jar = new CookieJar();
        const session = `session=${route.tier}-${page}`;
        return {
          async fetch(url) {
            vi.setSystemTime(Date.now() + 2000);
            if (!url.pathname.includes(`/${route.tier}/`))
              return new Response("This route is unavailable for this document", { status: 503 });
            if (url.pathname.endsWith("/catalog")) await jar.setCookie(session, url.href);
            else if ((await jar.getCookieString(url.href)) !== session)
              return new Response("The established session cookie is required", { status: 403 });
            return new Response('{"available":true}');
          },
        };
      },
    });
    transports.push(transport);
    for (let round = 0; round < 10; round++)
      for (const tier of ["datacenter", "residential"])
        await transport.fetchDocument(`https://bid.cars/en/${tier}/catalog`, JSON.parse, {
          source: "bid.cars",
        });
    for (const tier of ["datacenter", "residential"])
      await expect(
        transport.fetchDocument(`https://bid.cars/en/${tier}/detail`, JSON.parse, {
          source: "bid.cars",
        }),
      ).resolves.toEqual({ available: true });
  });

  it("isolates Lalafo clearance and session caches from BidCars preferred routes", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars,lalafo.kg");
    vi.useFakeTimers({ toFake: ["Date"] });
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-isolated-clearance-"));
    directories.push(dataDir);
    let datacenterUsed = false;
    const transport = new ProxyTransport({
      routes: ["datacenter", "residential", "lalafo"].map(
        (tier) => new ProxyRoute(tier, "http://proxy.test:7000", "Basic ZGVtbzpkZW1v"),
      ),
      dataDir,
      requestDelaySeconds: 0,
      browserClientFactory: (route) => {
        const jar = new CookieJar();
        const origin = route.tier === "lalafo" ? "https://lalafo.kg" : "https://bid.cars";
        return {
          async fetch(url) {
            vi.setSystemTime(Date.now() + 2000);
            if (url.origin !== origin) return new Response("Wrong session origin", { status: 403 });
            if (route.tier === "datacenter") {
              const status = datacenterUsed ? 429 : 503;
              datacenterUsed = true;
              return new Response("Unavailable route", { status });
            }
            if (url.pathname === "/en/catalog")
              await jar.setCookie("session=auction; Secure; Path=/", url.href);
            const expected = route.tier === "lalafo" ? "session=classified" : "session=auction";
            if ((await jar.getCookieString(url.href)) !== expected)
              return new Response("Missing clearance", {
                status: 403,
                headers: { "cf-mitigated": "challenge" },
              });
            return new Response('{"available":true,"items":[]}');
          },
          async refresh(url) {
            if (route.tier !== "lalafo" || url.href !== "https://lalafo.kg/kyrgyzstan/nedvizhimost")
              throw new SourceError("Clearance requires the public Lalafo bootstrap");
            await jar.setCookie("session=classified; Secure; Path=/", url.href);
          },
        };
      },
      dispatcherFactory: () => {
        throw new Error("Protected origins must not use the plain HTTP transport");
      },
    });
    transports.push(transport);
    const documents = [
      ["bid.cars", "https://bid.cars/en/catalog"],
      ["lalafo.kg", "https://lalafo.kg/api/search/v3/feed/search"],
      ["bid.cars", "https://bid.cars/en/detail"],
      ["lalafo.kg", "https://lalafo.kg/api/search/v3/feed/search?page=2"],
    ] as const;
    for (const [source, url] of documents)
      await expect(transport.fetchDocument(url, JSON.parse, { source })).resolves.toEqual({
        available: true,
        items: [],
      });
  });

  it("renews a sticky Lalafo session before its two-hour expiry without sending stale clearance", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "lalafo.kg");
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = Date.now();
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-lalafo-rotation-"));
    directories.push(dataDir);
    let staleRequests = 0;
    const ports = new Set<string>();
    const transport = new ProxyTransport({
      routes: [new ProxyRoute("lalafo", "http://isp.test:10010", "Basic ZGVtbzpkZW1v", 10001, 10)],
      dataDir,
      requestDelaySeconds: 0,
      browserClientFactory: (route, page) => {
        const created = Date.now();
        let cleared = false;
        return {
          refresh: async () => {
            cleared = true;
          },
          fetch: async () => {
            if (Date.now() - created >= 115 * 60_000) {
              staleRequests++;
              return new Response("Expired clearance", { status: 403 });
            }
            if (!cleared)
              return new Response("Challenge", {
                status: 403,
                headers: { "cf-mitigated": "challenge" },
              });
            ports.add(route.urlFor(page));
            return new Response('{"items":[{"id":42}]}');
          },
        };
      },
    });
    transports.push(transport);
    const url = "https://lalafo.kg/api/search/v3/feed/search";
    const options = { source: "lalafo.kg" };
    await expect(transport.fetchDocument(url, JSON.parse, options)).resolves.toEqual({
      items: [{ id: 42 }],
    });
    vi.setSystemTime(started + 114 * 60_000);
    await transport.fetchDocument(url, JSON.parse, options);
    expect(ports.size).toBe(1);
    vi.setSystemTime(started + 115 * 60_000);
    await expect(transport.fetchDocument(url, JSON.parse, options)).resolves.toEqual({
      items: [{ id: 42 }],
    });
    expect(staleRequests).toBe(0);
    expect(ports.size).toBe(2);
  });

  it("replaces a revoked Lalafo session once for concurrent readers", async () => {
    let captures = 0;
    let revoked: string | undefined;
    let established: string | undefined;
    const transport = await lalafoTransport((route, page) => {
      const endpoint = route.urlFor(page);
      let cleared = false;
      return {
        refresh: async () => {
          captures++;
          cleared = true;
        },
        fetch: async () => {
          if (!cleared || endpoint === revoked)
            return new Response("Session rejected", { status: 403 });
          established = endpoint;
          return new Response('{"items":[{"id":42}]}');
        },
      };
    });
    const url = "https://lalafo.kg/api/search/v3/feed/search";
    const options = { source: "lalafo.kg" };
    await transport.fetchDocument(url, JSON.parse, options);
    revoked = established;
    await expect(
      Promise.all([
        transport.fetchDocument(`${url}?page=2`, JSON.parse, options),
        transport.fetchDocument(`${url}?page=3`, JSON.parse, options),
      ]),
    ).resolves.toEqual([{ items: [{ id: 42 }] }, { items: [{ id: 42 }] }]);
    expect(captures).toBe(2);
    expect(established).not.toBe(revoked);
  });
  it("replaces the Lalafo route when its response stream disconnects", async () => {
    let disconnected = false;
    const transport = await lalafoTransport(() => ({
      refresh: async () => {},
      fetch: async (url) => {
        if (url.searchParams.get("per-page") !== "1" && !disconnected) {
          disconnected = true;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("Connection reset while reading the response"));
              },
            }),
          );
        }
        return new Response('{"items":[{"id":42}]}');
      },
    }));
    await expect(
      transport.fetchDocument("https://lalafo.kg/api/search/v3/feed/search", JSON.parse, {
        source: "lalafo.kg",
      }),
    ).resolves.toEqual({ items: [{ id: 42 }] });
  });

  it("rejects an unusable Lalafo capture before admitting catalog requests", async () => {
    let captures = 0;
    let unverifiedDocuments = 0;
    const transport = await lalafoTransport(() => {
      const unusable = captures === 0;
      return {
        refresh: async () => {
          captures++;
        },
        fetch: async (url) => {
          if (unusable) {
            if (url.searchParams.get("per-page") !== "1") unverifiedDocuments++;
            return new Response("<html>Challenge, not API data</html>");
          }
          return new Response('{"items":[{"id":42}]}');
        },
      };
    });
    await expect(
      transport.fetchDocument("https://lalafo.kg/api/search/v3/feed/search", JSON.parse, {
        source: "lalafo.kg",
      }),
    ).resolves.toEqual({ items: [{ id: 42 }] });
    expect(unverifiedDocuments).toBe(0);
    expect(captures).toBe(2);
  });

  it("bounds failed Lalafo captures and cools down before purchasing more solves", async () => {
    let captures = 0;
    const transport = await lalafoTransport(() => ({
      refresh: async () => {
        captures++;
        throw new SourceError("The target challenge could not be solved");
      },
      fetch: async () => {
        throw new Error("Unverified sessions must not reach the API");
      },
    }));
    const url = "https://lalafo.kg/api/search/v3/feed/search";
    await expect(
      transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(captures).toBe(3);
    await expect(
      transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(captures).toBe(3);
  });

  it("retains a Lalafo session across Retry-After without rotating or buying another clearance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let captures = 0;
    let limited = false;
    let requests = 0;
    const transport = await lalafoTransport(() => ({
      refresh: async () => {
        captures++;
      },
      fetch: async () => {
        requests++;
        return limited
          ? new Response("Slow down", {
              status: 429,
              headers: { "cf-mitigated": "challenge", "retry-after": "120" },
            })
          : new Response('{"items":[{"id":42}]}');
      },
    }));
    const url = "https://lalafo.kg/api/search/v3/feed/search";
    await transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" });
    limited = true;
    await expect(
      transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" }),
    ).rejects.toMatchObject({ retry_after: 120 });
    const beforeCooldown = requests;
    await expect(
      transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" }),
    ).rejects.toBeInstanceOf(SourceRateLimited);
    expect(requests).toBe(beforeCooldown);
    expect(captures).toBe(1);
    vi.setSystemTime(Date.now() + 120_000);
    limited = false;
    await expect(
      transport.fetchDocument(url, JSON.parse, { source: "lalafo.kg" }),
    ).resolves.toEqual({ items: [{ id: 42 }] });
    expect(captures).toBe(1);
  });

  it("fails closed when Lalafo is missing or challenged without using shared routes", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,lalafo.kg");
    const dataDir = await mkdtemp(join(tmpdir(), "autodom-lalafo-fail-closed-"));
    directories.push(dataDir);
    const shared = new ProxyRoute("datacenter", "http://proxy.test:7000", "Basic ZGVtbzpkZW1v");
    const plain = vi.fn(() => {
      throw new Error("Shared route must not be used for Lalafo");
    });
    const browser = vi.fn(
      (route: ProxyRoute): BrowserClient => ({
        refresh: async () => {},
        fetch: async () => {
          if (route.tier !== "lalafo")
            throw new Error("Shared browser must not be used for Lalafo");
          return new Response("Managed challenge", {
            status: 403,
            headers: { "cf-mitigated": "challenge" },
          });
        },
      }),
    );
    for (const routes of [
      [shared],
      [shared, new ProxyRoute("lalafo", "http://isp.test:7000", "Basic ZGVtbzpkZW1v")],
    ]) {
      const transport = new ProxyTransport({
        routes,
        dataDir,
        requestDelaySeconds: 0,
        dispatcherFactory: plain,
        browserClientFactory: browser,
      });
      transports.push(transport);
      for (let request = 0; request < 2; request++)
        await expect(
          transport.fetchDocument("https://lalafo.kg/api/search/v3/feed/search", JSON.parse, {
            source: "lalafo.kg",
          }),
        ).rejects.toBeInstanceOf(SourceError);
    }
    expect(plain).not.toHaveBeenCalled();
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
      .reply(429, "limited", { headers: { server: "cloudflare", "retry-after": "180" } });
    const second = new MockAgent();
    second.disableNetConnect();
    second
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(200, "must not request");
    const refresh = vi.fn(async () => {});
    const transport = await transportWith([blocked, blocked], [first, second], refresh);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", (text) => text, {
        source: "bid.cars",
      }),
    ).rejects.toMatchObject({ retry_after: 180 });
    expect(second.pendingInterceptors()).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("solves a managed 429 challenge and replays only the real document", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const agent = new MockAgent();
    agent.disableNetConnect();
    const origin = agent.get("https://bid.cars");
    origin
      .intercept({ path: "/en/automobile/page/1" })
      .reply(429, "Enable JavaScript and cookies", { headers: { "cf-mitigated": "challenge" } });
    origin.intercept({ path: "/en/automobile/page/1" }).reply(200, '{"available":true}');
    const refresh = vi.fn(async () => {});
    const transport = await transportWith([agent], [agent], refresh);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", JSON.parse, {
        source: "bid.cars",
      }),
    ).resolves.toEqual({ available: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    agent.assertNoPendingInterceptors();
  });

  it("stops after one unusable clearance instead of repeatedly purchasing solves", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const agent = new MockAgent();
    agent.disableNetConnect();
    const origin = agent.get("https://bid.cars");
    origin
      .intercept({ path: "/en/automobile/page/1" })
      .reply(429, "challenge", { headers: { "cf-mitigated": "challenge" } });
    origin
      .intercept({ path: "/en/automobile/page/1" })
      .reply(403, "still challenged", { headers: { "cf-mitigated": "challenge" } });
    origin.intercept({ path: "/en/automobile/page/1" }).reply(200, "must not request");
    const refresh = vi.fn(async () => {});
    const transport = await transportWith([agent], [agent], refresh);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", JSON.parse, {
        source: "bid.cars",
      }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("does not repeat a failed solver control operation on another proxy", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const first = new MockAgent();
    first.disableNetConnect();
    first
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(403, "challenge", { headers: { "cf-mitigated": "challenge" } });
    const second = new MockAgent();
    second.disableNetConnect();
    second
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(200, "must not request");
    const refresh = vi.fn(async () => {
      throw new RiskBypassError("Control service unavailable");
    });
    const transport = await transportWith([first, second], [first, second], refresh);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", JSON.parse, {
        source: "bid.cars",
      }),
    ).rejects.toBeInstanceOf(RiskBypassError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(second.pendingInterceptors()).toHaveLength(1);
  });

  it("uses the configured fallback when a target-specific clearance attempt fails", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars");
    const first = new MockAgent();
    first.disableNetConnect();
    first
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(403, "challenge", { headers: { "cf-mitigated": "challenge" } });
    const second = new MockAgent();
    second.disableNetConnect();
    second
      .get("https://bid.cars")
      .intercept({ path: "/en/automobile/page/1" })
      .reply(200, '{"available":true}');
    const refresh = vi.fn(async () => {
      throw new SourceError("Target session unavailable");
    });
    const transport = await transportWith([first, second], [first, second], refresh);
    await expect(
      transport.fetchDocument("https://bid.cars/en/automobile/page/1", JSON.parse, {
        source: "bid.cars",
      }),
    ).resolves.toEqual({ available: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    first.assertNoPendingInterceptors();
    second.assertNoPendingInterceptors();
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
