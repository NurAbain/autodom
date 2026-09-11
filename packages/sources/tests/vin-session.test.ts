import { ProxyRoute, SourceError, SourceRateLimited } from "@autodom/core";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all([...agents].map((agent) => agent.close()));
  agents.clear();
});

describe("proxy-only VIN sessions", () => {
  it("refuses to create a direct-only transport", () => {
    expect(() => new VinTransport({ routes: [] })).toThrow(SourceError);
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
