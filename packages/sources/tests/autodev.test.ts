import { SourceError } from "@autodom/core";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VinCheckService } from "../src/vin.js";

const VIN = "WVWZZZ1JZXW000001";
const KEY = "not-a-production-autodev-test-key";
const PATH = `/vin/${VIN}`;

function payload(changes: Record<string, unknown> = {}) {
  return JSON.stringify({
    vin: VIN,
    vinValid: true,
    checksum: false,
    make: "Volkswagen",
    model: "Golf",
    year: 1999,
    origin: "Germany",
    ambiguous: false,
    vehicle: { vin: VIN, year: 1999, make: "Volkswagen", model: "Golf" },
    ...changes,
  });
}

describe("Auto.dev independent global decoding", () => {
  const originalDispatcher = getGlobalDispatcher();
  let agent: MockAgent;
  const services: VinCheckService[] = [];

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    setGlobalDispatcher(originalDispatcher);
    await agent.close();
  });

  function service(options: Partial<ConstructorParameters<typeof VinCheckService>[0]> = {}) {
    const instance = new VinCheckService({
      providers: ["autodev"],
      routes: [],
      autoDevApiKey: KEY,
      ...options,
    });
    services.push(instance);
    return instance;
  }

  function reply(status: number, body: string, headers: Record<string, string> = {}) {
    return agent
      .get("https://api.auto.dev")
      .intercept({ path: PATH, method: "GET", headers: { authorization: `Bearer ${KEY}` } })
      .reply(status, body, { headers: { "content-type": "application/json", ...headers } });
  }

  it("decodes a European VIN without a North American checksum and excludes account metadata", async () => {
    reply(
      200,
      payload({
        user: { email: "private-account@example.test", apiKey: KEY },
        links: { self: `https://attacker.invalid/?apiKey=${KEY}` },
      }),
    );
    const result = await service().check(VIN.toLowerCase());
    expect(result.autodev).toMatchObject({
      status: "available",
      source_url: "https://docs.auto.dev/v2/products/vin-decode",
      data: {
        vin: VIN,
        make: "Volkswagen",
        model: "Golf",
        model_year: 1999,
        trim: null,
        ambiguous: false,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-account|attacker|apiKey/);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.car365.status).toBe("disabled");
    agent.assertNoPendingInterceptors();
  });

  it("requires a safe credential only for an explicitly enabled provider", async () => {
    expect(() => service({ autoDevApiKey: undefined })).toThrow(SourceError);
    expect(() => service({ autoDevApiKey: "key\r\ninjected: header" })).toThrow(SourceError);
    reply(200, payload());
    expect(await service({ providers: [] }).check(VIN)).not.toHaveProperty("autodev");
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("preserves unresolved attributes and the provider's ambiguity warning", async () => {
    reply(200, payload({ model: null, vehicle: { vin: VIN, year: 1999 }, ambiguous: true }));
    expect((await service().check(VIN)).autodev).toMatchObject({
      status: "available",
      data: { model: null, model_year: 1999, trim: null, engine: null, ambiguous: true },
    });
  });

  it.each([
    [404, "not_found"],
    [401, "unavailable"],
    [429, "unavailable"],
    [503, "unavailable"],
  ] as const)(
    "classifies HTTP %s without retrying or revealing an error body",
    async (status, expected) => {
      reply(status, JSON.stringify({ error: KEY }));
      reply(200, payload());
      const result = await service().check(VIN);
      expect(result.autodev).toMatchObject({ status: expected, data: null });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(agent.pendingInterceptors()).toHaveLength(1);
    },
  );

  it.each([
    payload({ vin: "WVWZZZ1JZXW000002" }),
    payload({ vehicle: { vin: "WVWZZZ1JZXW000002" } }),
    payload({ year: 2000 }),
    payload({ ambiguous: undefined }),
    payload({ make: "A".repeat(513) }),
  ])("rejects contradictory or incomplete evidence", async (body) => {
    reply(200, body);
    expect((await service().check(VIN)).autodev).toMatchObject({
      status: "unavailable",
      data: null,
    });
  });

  it("treats a structurally rejected VIN as undecoded, not a clean vehicle", async () => {
    reply(200, payload({ vinValid: false }));
    expect((await service().check(VIN)).autodev).toMatchObject({ status: "not_found", data: null });
  });

  it("never sends a credential to a redirected endpoint", async () => {
    reply(302, "", { location: "https://attacker.invalid/capture" });
    agent.get("https://attacker.invalid").intercept({ path: "/capture" }).reply(200, payload());
    expect((await service().check(VIN)).autodev?.status).toBe("unavailable");
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("rejects non-JSON and oversized responses", async () => {
    reply(200, payload(), { "content-type": "text/html" });
    reply(200, " ".repeat(4 * 1024 * 1024 + 1));
    const lookup = service();
    expect((await lookup.check(VIN)).autodev?.status).toBe("unavailable");
    expect((await lookup.check(VIN)).autodev?.status).toBe("unavailable");
  });

  it("retains NHTSA evidence when the global decoder exhausts its quota", async () => {
    reply(429, "{}");
    agent
      .get("https://vpic.nhtsa.dot.gov")
      .intercept({ path: `/api/vehicles/DecodeVinValues/${VIN}?format=json` })
      .reply(
        200,
        JSON.stringify({
          Count: 1,
          Results: [{ VIN, ErrorCode: "0", Make: "VOLKSWAGEN", Model: "Golf", ModelYear: "1999" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    const result = await service({ providers: ["nhtsa_vpic", "autodev"] }).check(VIN);
    expect(result.autodev).toMatchObject({ status: "unavailable", data: null });
    expect(result.nhtsa_vpic).toMatchObject({ status: "available", data: { model: "Golf" } });
  });

  it("bounds stalled requests without pretending the VIN is absent", async () => {
    reply(200, payload()).delay(100);
    expect((await service({ timeoutMs: 10 }).check(VIN)).autodev?.status).toBe("unavailable");
  });

  it("propagates caller cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const caller = new AbortController();
    agent
      .get("https://api.auto.dev")
      .intercept({ path: PATH })
      .reply(() => {
        started.resolve();
        return {
          statusCode: 200,
          data: payload(),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .delay(500);
    const pending = service().check(VIN, caller.signal);
    await started.promise;
    caller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toThrow("caller stopped");
  });

  it("stops an active request on service shutdown", async () => {
    const started = Promise.withResolvers<void>();
    agent
      .get("https://api.auto.dev")
      .intercept({ path: PATH })
      .reply(() => {
        started.resolve();
        return {
          statusCode: 200,
          data: payload(),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .delay(500);
    const lookup = service();
    const pending = lookup.check(VIN);
    await started.promise;
    await lookup.close();
    expect((await pending).autodev).toMatchObject({ status: "unavailable", data: null });
  });
});
