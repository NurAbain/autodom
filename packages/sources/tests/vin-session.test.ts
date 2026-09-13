import { setTimeout as delay } from "node:timers/promises";
import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { checkEncarHistory } from "../src/encar-history.js";
import { VinTransport } from "../src/vin-session.js";

const ORIGIN = "https://www.carhistory.or.kr";
const ENTRY = "/search/carhistory/search.car";
const LOOKUP = "/search/carhistory/initSearch.car";
const routes = [
  new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic ZGM6c2VjcmV0"),
  new ProxyRoute("residential", "http://proxy.invalid:7000", "Basic cmVzOnNlY3JldA=="),
];
const transports: VinTransport[] = [];
const agents = new Set<MockAgent>();

function setup() {
  const mocks = routes.map(() => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    agents.add(mock);
    return mock;
  });
  const transport = new VinTransport({
    routes,
    requestDelaySeconds: 0,
    dispatcherFactory: (_route, _page, index) => {
      const mock = mocks[index] as MockAgent;
      agents.delete(mock); // VinTransport now owns closing this dispatcher.
      return mock;
    },
  });
  transports.push(transport);
  return { transport, mocks };
}

function setupPacing(requestDelaySeconds = 0.1, timeoutMs = 350) {
  const requests: { provider: string; page: number; at: number }[] = [];
  const closes: MockInstance<MockAgent["close"]>[] = [];
  const transport = new VinTransport({
    routes: routes.slice(0, 1),
    requestDelaySeconds,
    timeoutMs,
    dispatcherFactory: (_route, page) => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      closes.push(vi.spyOn(mock, "close"));
      for (const [provider, origin, path] of [
        ["carhistory", ORIGIN, ENTRY],
        ["car365", "https://www.car365.go.kr", "/ccpt/carlife/scrcar/schdcarXportView.do"],
      ] as const) {
        mock
          .get(origin)
          .intercept({ path })
          .reply(() => {
            requests.push({ provider, page, at: Date.now() });
            return { statusCode: 200, data: String(page) };
          });
      }
      return mock;
    },
  });
  transports.push(transport);
  return { transport, requests, closes };
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all([...agents].map((agent) => agent.close()));
  agents.clear();
});

describe("proxy-only VIN sessions", () => {
  it("refuses to create a direct-only transport", () => {
    expect(() => new VinTransport({ routes: [] })).toThrow(SourceError);
  });

  it("never uses the dedicated Lalafo ISP, including when every shared VIN route fails", async () => {
    const lalafo = new ProxyRoute("lalafo", "http://isp.invalid:7000", "Basic aXNwOnNlY3JldA==");
    expect(() => new VinTransport({ routes: [lalafo] })).toThrow(SourceError);
    const dedicated = new MockAgent();
    dedicated.disableNetConnect();
    agents.add(dedicated);
    dedicated.get(ORIGIN).intercept({ path: ENTRY }).reply(200, "Wrong dedicated ISP");
    const shared = routes.map(() => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      agents.add(mock);
      mock.get(ORIGIN).intercept({ path: ENTRY }).reply(503, "Unavailable");
      return mock;
    });
    const transport = new VinTransport({
      routes: [lalafo, ...routes, lalafo],
      requestDelaySeconds: 0,
      dispatcherFactory: (route) => {
        const mock = route.tier === "lalafo" ? dedicated : shared[routes.indexOf(route)]!;
        agents.delete(mock);
        return mock;
      },
    });
    transports.push(transport);
    await expect(
      transport.run("carhistory", (session) => session.request(ENTRY)),
    ).rejects.toBeInstanceOf(SourceError);
    for (const mock of shared) mock.assertNoPendingInterceptors();
    expect(dedicated.pendingInterceptors()).toHaveLength(1);
  });

  it.each([
    `${ORIGIN}/payment/pay.car`,
    "https://another-provider.invalid/search/carhistory/search.car",
    `${ORIGIN}${ENTRY}?vin=KMFXKN7BPXU258800`,
  ])("refuses an unapproved request even when that endpoint would respond: %s", async (target) => {
    const { transport, mocks } = setup();
    const url = new URL(target);
    for (const mock of mocks)
      mock
        .get(url.origin)
        .intercept({ path: `${url.pathname}${url.search}` })
        .reply(200, "paid or unrelated data");
    await expect(transport.run("carhistory", (session) => session.request(target))).rejects.toThrow(
      SourceError,
    );
  });

  it.each([
    "https://carcheck.by/vin/WBA51AG03NCK98884",
    "https://fem.encar.com/cars/detail/39720103?vin=WBA51AG03NCK98884",
    "https://attacker.invalid/auto/WBA51AG03NCK98884",
  ])("blocks non-discovery Encar requests before network access: %s", async (target) => {
    const { transport, mocks } = setup();
    const url = new URL(target);
    let requests = 0;
    for (const mock of mocks)
      mock
        .get(url.origin)
        .intercept({ path: `${url.pathname}${url.search}` })
        .reply(() => {
          requests++;
          return { statusCode: 200, data: "not an approved lookup" };
        });
    await expect(transport.run("encar", (session) => session.request(target))).rejects.toThrow(
      SourceError,
    );
    expect(requests).toBe(0);
  });

  it("recovers an Encar candidate blocked on datacenter through the residential route", async () => {
    const { transport, mocks } = setup();
    const vin = "WBA51AG03NCK98884";
    const id = "39720103";
    const discovery = `<h1 class="auto-vin-title"><span>${vin}</span>
      <button class="auto-save-button" data-save-vin="${vin}" data-save-lot="${id}"
        data-save-auction="12"></button></h1>`;
    for (const mock of mocks)
      mock
        .get("https://carcheck.by")
        .intercept({ path: `/auto/${vin}` })
        .reply(200, discovery);
    mocks[0]
      ?.get("https://fem.encar.com")
      .intercept({ path: `/cars/detail/${id}` })
      .reply(403, "");
    mocks[1]
      ?.get("https://fem.encar.com")
      .intercept({ path: `/cars/detail/${id}` })
      .reply(
        200,
        `<script>__PRELOADED_STATE__ = ${JSON.stringify({
          cars: { base: { vehicleId: Number(id), vin } },
        })};</script>`,
      );
    const result = await transport.run("encar", (session) => checkEncarHistory(vin, session));
    expect(result?.listings).toMatchObject([
      { id, vin, source_url: `https://fem.encar.com/cars/detail/${id}` },
    ]);
  });

  it("keeps discovery cookies on Carcheck without leaking them to official Encar", async () => {
    const { transport, mocks } = setup();
    const mock = mocks[0] as MockAgent;
    const discovery = "https://carcheck.by";
    const path = "/auto/WBA51AG03NCK98884";
    mock
      .get(discovery)
      .intercept({ path })
      .reply(200, "discovery", {
        headers: { "set-cookie": "session=mirror-only; Path=/; Secure" },
      });
    mock
      .get("https://fem.encar.com")
      .intercept({
        path: "/cars/detail/39720103",
        headers: (headers) => !JSON.stringify(headers).toLowerCase().includes("cookie"),
      })
      .reply(200, "official", {
        headers: { "set-cookie": "session=official-only; Path=/; Secure" },
      });
    mock
      .get(discovery)
      .intercept({
        path,
        headers: { cookie: "session=mirror-only" },
      })
      .reply(200, "discovery retained");
    await transport.run("encar", async (session) => {
      await session.request(`${discovery}${path}`);
      await session.request("https://fem.encar.com/cars/detail/39720103");
      await session.request(`${discovery}${path}`);
    });
    mock.assertNoPendingInterceptors();
  });

  it.each([
    ["https://carcheck.by/vin/WBA51AG03NCK98884", true],
    ["https://carcheck.by/vin/KMHEC41MAAA015218", false],
    ["https://carcheck.by/payment", false],
  ] as const)(
    "recognizes only the same-VIN missing-archive redirect: %s",
    async (location, absent) => {
      const { transport, mocks } = setup();
      const mock = mocks[0] as MockAgent;
      mock
        .get("https://carcheck.by")
        .intercept({ path: "/auto/WBA51AG03NCK98884" })
        .reply(301, "", { headers: { location } });
      let followed = false;
      mock
        .get("https://carcheck.by")
        .intercept({ path: new URL(location).pathname })
        .reply(() => {
          followed = true;
          return { statusCode: 200, data: "report route must not be visited" };
        });
      const lookup = transport.run("encar", (session) =>
        session.request("https://carcheck.by/auto/WBA51AG03NCK98884"),
      );
      if (absent) await expect(lookup).resolves.toMatchObject({ status: 301 });
      else await expect(lookup).rejects.toThrow(SourceError);
      expect(followed).toBe(false);
    },
  );

  it("restarts the entire anonymous session on proxy fallback, without forwarding old cookies", async () => {
    const { transport, mocks } = setup();
    const first = mocks[0] as MockAgent;
    const second = mocks[1] as MockAgent;
    first
      .get(ORIGIN)
      .intercept({ path: ENTRY })
      .reply(200, "entry", {
        headers: { "set-cookie": "session=datacenter; Path=/search/carhistory; Secure" },
      });
    first
      .get(ORIGIN)
      .intercept({
        path: LOOKUP,
        method: "POST",
        headers: { cookie: "session=datacenter" },
        body: "vin=KMFXKN7BPXU258800",
      })
      .reply(503);
    second
      .get(ORIGIN)
      .intercept({
        path: ENTRY,
        headers: (headers) => !JSON.stringify(headers).toLowerCase().includes("cookie"),
      })
      .reply(200, "entry", {
        headers: { "set-cookie": "session=residential; Path=/search/carhistory; Secure" },
      });
    second
      .get(ORIGIN)
      .intercept({
        path: LOOKUP,
        method: "POST",
        headers: { cookie: "session=residential" },
        body: "vin=KMFXKN7BPXU258800",
      })
      .reply(200, "lookup completed");
    const response = await transport.run("carhistory", async (session) => {
      await session.request(ENTRY);
      return session.request(LOOKUP, { method: "POST", form: { vin: "KMFXKN7BPXU258800" } });
    });
    expect(response.body).toBe("lookup completed");
    for (const mock of mocks) mock.assertNoPendingInterceptors();
  });

  it("runs ten isolated workflows across all Korean providers and queues the eleventh", async () => {
    const fixtures = Array.from({ length: 11 }, (_, index) => {
      const provider = index % 3 === 0 ? "carhistory" : index % 3 === 1 ? "car365" : "encar";
      return {
        provider,
        vin: String(index + 1).padStart(17, "0"),
        origin:
          provider === "encar"
            ? "https://fem.encar.com"
            : provider === "carhistory"
              ? ORIGIN
              : "https://www.car365.go.kr",
        entry:
          provider === "encar"
            ? "/cars/detail/39720103"
            : provider === "carhistory"
              ? ENTRY
              : "/ccpt/carlife/scrcar/schdcarXportView.do",
        lookup:
          provider === "encar"
            ? "/cars/detail/39711062"
            : provider === "carhistory"
              ? LOOKUP
              : "/ccpt/carlife/scrcar/selectSchdcarXportList.do",
      } as const;
    });
    const release = Promise.withResolvers<void>();
    let entered = 0;
    let active = 0;
    let peakActive = 0;
    const transport = new VinTransport({
      routes: routes.slice(0, 1),
      requestDelaySeconds: 0,
      dispatcherFactory: (_route, page) => {
        const fixture = fixtures[page - 1];
        if (!fixture) throw new Error("Unexpected workflow");
        const mock = new MockAgent();
        mock.disableNetConnect();
        const pool = mock.get(fixture.origin);
        pool.intercept({ path: fixture.entry }).reply(200, "entry", {
          headers: { "set-cookie": `session=${page}; Path=/; Secure` },
        });
        pool
          .intercept({
            path: fixture.lookup,
            method: fixture.provider === "encar" ? "GET" : "POST",
            headers: { cookie: `session=${page}` },
            ...(fixture.provider === "encar" ? {} : { body: `vin=${fixture.vin}` }),
          })
          .reply(200, fixture.vin);
        return mock;
      },
    });
    transports.push(transport);
    const checks = fixtures.map((fixture) =>
      transport.run(fixture.provider, async (session) => {
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          await session.request(fixture.entry);
          entered++;
          await release.promise;
          return (
            await session.request(
              fixture.lookup,
              fixture.provider === "encar"
                ? undefined
                : {
                    method: "POST",
                    form: { vin: fixture.vin },
                  },
            )
          ).body;
        } finally {
          active--;
        }
      }),
    );
    try {
      await expect.poll(() => entered).toBe(10);
    } finally {
      release.resolve();
      await Promise.allSettled(checks);
    }
    expect(await Promise.all(checks)).toEqual(fixtures.map((fixture) => fixture.vin));
    expect(peakActive).toBe(10);
  });

  it("does not charge cancelled unsent requests against the next workflow's deadline", async () => {
    const { transport, requests, closes } = setupPacing();
    await transport.run("carhistory", (session) => session.request(ENTRY));
    for (let index = 0; index < 7; index++) {
      const controller = new AbortController();
      const reason = new Error("Cancelled waiting lookup");
      await expect(
        transport.run(
          "carhistory",
          (session) => {
            const pending = session.request(ENTRY);
            controller.abort(reason);
            return pending;
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
    }
    await delay(120);
    await transport.run("carhistory", (session) => session.request(ENTRY));
    expect(requests.map(({ page }) => page)).toEqual([1, 9]);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("spaces concurrent admissions in FIFO order without blocking the other provider", async () => {
    const { transport, requests } = setupPacing(0.1, 1_000);
    await transport.run("carhistory", (session) => session.request(ENTRY));
    const waiting = [
      transport.run("carhistory", (session) => session.request(ENTRY)),
      transport.run("carhistory", (session) => session.request(ENTRY)),
      transport.run("car365", (session) =>
        session.request("/ccpt/carlife/scrcar/schdcarXportView.do"),
      ),
    ];
    await Promise.all(waiting);
    expect(requests.map(({ page }) => page)).toEqual([1, 4, 2, 3]);
    const history = requests.filter(({ provider }) => provider === "carhistory");
    for (let index = 1; index < history.length; index++)
      expect(history[index]!.at - history[index - 1]!.at).toBeGreaterThanOrEqual(95);
  });

  it("closes dispatchers and drains pacing and workflow queues when closed", async () => {
    const { transport, requests, closes } = setupPacing(1, 2_000);
    await transport.run("carhistory", (session) => session.request(ENTRY));
    const entered = Promise.withResolvers<void>();
    let active = 0;
    const pending = Array.from({ length: 12 }, () =>
      transport.run("carhistory", (session) => {
        if (++active === 10) entered.resolve();
        return session.request(ENTRY);
      }),
    );
    const settled = Promise.allSettled(pending);
    await entered.promise;
    await transport.close();
    expect((await settled).map(({ status }) => status)).toEqual(Array(12).fill("rejected"));
    expect(requests.map(({ page }) => page)).toEqual([1]);
    expect(closes).toHaveLength(11);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not bypass a provider's rate limit by changing proxies or starting another lookup", async () => {
    const { transport, mocks } = setup();
    (mocks[0] as MockAgent)
      .get(ORIGIN)
      .intercept({ path: ENTRY })
      .reply(429, "limited", {
        headers: { "retry-after": "120" },
      });
    (mocks[1] as MockAgent).get(ORIGIN).intercept({ path: ENTRY }).reply(200, "would bypass limit");
    await expect(transport.run("carhistory", (session) => session.request(ENTRY))).rejects.toThrow(
      SourceRateLimited,
    );
    await expect(transport.run("carhistory", (session) => session.request(ENTRY))).rejects.toThrow(
      SourceRateLimited,
    );
  });

  it("does not follow redirects into authentication or payment", async () => {
    const { transport, mocks } = setup();
    (mocks[0] as MockAgent)
      .get(ORIGIN)
      .intercept({ path: ENTRY })
      .reply(302, "", {
        headers: { location: `${ORIGIN}/payment/pay.car` },
      });
    (mocks[0] as MockAgent)
      .get(ORIGIN)
      .intercept({ path: "/payment/pay.car" })
      .reply(200, "payment");
    await expect(transport.run("carhistory", (session) => session.request(ENTRY))).rejects.toThrow(
      SourceError,
    );
  });
});
