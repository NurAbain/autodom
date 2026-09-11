import { ProxyRoute, SourceError } from "@autodom/core";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNhtsaVpicRecord } from "../src/nhtsa-vpic.js";
import { VinCheckService } from "../src/vin.js";

const VIN = "1HGCM82633A004352";
const PATH = `/api/vehicles/DecodeVinValues/${VIN}?format=json`;

function payload(changes: Record<string, unknown> = {}) {
  return JSON.stringify({
    Count: 1,
    Message: "Results returned successfully",
    Results: [
      { VIN, ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003", ...changes },
    ],
  });
}

describe("NHTSA technical decode evidence", () => {
  it("retains only decoded technical facts and leaves blank values unknown", () => {
    expect(
      parseNhtsaVpicRecord(
        payload({
          BodyClass: " Sedan ",
          FuelTypePrimary: " ",
          PlantCountry: "UNITED STATES (USA)",
          Accident: "No",
        }),
        VIN,
      ),
    ).toEqual({
      vin: VIN,
      make: "HONDA",
      model: "Accord",
      model_year: 2003,
      body_class: "Sedan",
      fuel_type: null,
      plant_country: "UNITED STATES (USA)",
    });
    expect(parseNhtsaVpicRecord(payload({ ModelYear: "" }), VIN)?.model_year).toBeNull();
  });

  it.each([
    payload({ VIN: "1HGCM82633A004353" }),
    payload({ ErrorCode: "Service unavailable" }),
    payload({ ErrorCode: 0 }),
    payload({ ErrorCode: "7", Make: {} }),
    payload({ Make: "", Model: "", ModelYear: "" }),
    payload({ Make: {} }),
    payload({ Make: "x".repeat(513) }),
    payload({ ModelYear: "2003.5" }),
    payload({ ModelYear: "1885" }),
    payload({ error: "backend failed" }),
    JSON.stringify({ Count: 1, Results: [], error: "backend failed" }),
    "{}",
    "null",
    "",
    "<html>Maintenance</html>",
  ])("rejects malformed or mismatched evidence rather than establishing a decode: %s", (body) => {
    expect(() => parseNhtsaVpicRecord(body, VIN)).toThrow(SourceError);
  });

  it.each(["7", "1,7,11", "0, 7"])(
    "does not establish a decode from partial/unsupported error code %s",
    (ErrorCode) => {
      expect(parseNhtsaVpicRecord(payload({ ErrorCode }), VIN)).toBeNull();
    },
  );
});

describe("NHTSA independent direct lookup", () => {
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
    const instance = new VinCheckService({ providers: ["nhtsa_vpic"], routes: [], ...options });
    services.push(instance);
    return instance;
  }

  function reply(status: number, body: string, headers: Record<string, string> = {}) {
    return agent
      .get("https://vpic.nhtsa.dot.gov")
      .intercept({ path: PATH, method: "GET" })
      .reply(status, body, { headers: { "content-type": "application/json", ...headers } });
  }

  it("decodes without Korean proxy routes or enabling Korean observations", async () => {
    reply(200, payload());
    const result = await service().check(VIN.toLowerCase());
    expect(result.nhtsa_vpic).toMatchObject({
      status: "available",
      checked_at: expect.any(Number),
      source_url: "https://vpic.nhtsa.dot.gov/api/",
      data: { vin: VIN, make: "HONDA", model: "Accord", model_year: 2003 },
    });
    expect(result.carhistory.status).toBe("disabled");
    expect(result.car365.status).toBe("disabled");
    agent.assertNoPendingInterceptors();
  });

  it("omits the decoder entirely unless explicitly enabled", async () => {
    expect(await service({ providers: [] }).check(VIN)).not.toHaveProperty("nhtsa_vpic");
  });

  it.each([
    [200, payload({ ErrorCode: "7" }), "not_found"],
    [200, payload({ VIN: "1HGCM82633A004353" }), "unavailable"],
    [200, "{}", "unavailable"],
    [429, "limited", "unavailable"],
    [503, "unavailable", "unavailable"],
    [404, "not found", "unavailable"],
  ] as const)(
    "classifies HTTP %s without confusing decode absence and source failure",
    async (status, body, expected) => {
      reply(status, body);
      expect((await service().check(VIN)).nhtsa_vpic).toMatchObject({
        status: expected,
        checked_at: expect.any(Number),
        data: null,
      });
    },
  );

  it("never follows an upstream redirect", async () => {
    reply(302, "", { location: "https://vpic.nhtsa.dot.gov/unapproved" });
    agent
      .get("https://vpic.nhtsa.dot.gov")
      .intercept({ path: "/unapproved" })
      .reply(200, payload());
    expect((await service().check(VIN)).nhtsa_vpic?.status).toBe("unavailable");
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("rejects non-JSON and oversized successful responses", async () => {
    reply(200, payload(), { "content-type": "text/html" });
    reply(200, " ".repeat(4 * 1024 * 1024 + 1));
    const lookup = service();
    expect((await lookup.check(VIN)).nhtsa_vpic?.status).toBe("unavailable");
    expect((await lookup.check(VIN)).nhtsa_vpic?.status).toBe("unavailable");
  });

  it("retains the decode when a Korean workflow fails", async () => {
    reply(200, payload());
    const korean = new MockAgent();
    korean.disableNetConnect();
    korean
      .get("https://www.carhistory.or.kr")
      .intercept({ path: "/search/carhistory/search.car" })
      .reply(200, "<h1>Maintenance</h1>");
    const result = await service({
      providers: ["carhistory", "nhtsa_vpic"],
      routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
      requestDelaySeconds: 0,
      dispatcherFactory: () => korean,
    }).check(VIN);
    expect(result.carhistory.status).toBe("unavailable");
    expect(result.nhtsa_vpic?.status).toBe("available");
  });

  it("bounds a stalled direct request without reporting decode absence", async () => {
    reply(200, payload()).delay(200);
    expect((await service({ timeoutMs: 10 }).check(VIN)).nhtsa_vpic).toMatchObject({
      status: "unavailable",
      data: null,
    });
  });

  it("retains Korean mileage when the decoder returns malformed evidence", async () => {
    reply(200, payload({ VIN: "1HGCM82633A004353" }));
    const korean = new MockAgent();
    korean.disableNetConnect();
    korean
      .get("https://www.car365.go.kr")
      .intercept({ path: "/ccpt/carlife/scrcar/schdcarXportView.do" })
      .reply(200, '<script>const _CSRF_TOKEN = "anonymous-token";</script>');
    korean
      .get("https://www.car365.go.kr")
      .intercept({ path: "/ccpt/carlife/scrcar/selectSchdcarXportList.do", method: "POST" })
      .reply(200, JSON.stringify({ vin: VIN, drvngDstnc: "79,434" }));
    const result = await service({
      providers: ["car365", "nhtsa_vpic"],
      routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
      requestDelaySeconds: 0,
      dispatcherFactory: () => korean,
    }).check(VIN);
    expect(result.car365).toMatchObject({ status: "available", data: { last_mileage_km: 79434 } });
    expect(result.nhtsa_vpic).toMatchObject({ status: "unavailable", data: null });
  });

  it("classifies network failure as unavailable instead of a missing decode", async () => {
    agent
      .get("https://vpic.nhtsa.dot.gov")
      .intercept({ path: PATH })
      .replyWithError(new Error("connection reset"));
    expect((await service().check(VIN)).nhtsa_vpic).toMatchObject({
      status: "unavailable",
      data: null,
    });
  });

  it("propagates caller cancellation during the direct request", async () => {
    const caller = new AbortController();
    const started = Promise.withResolvers<void>();
    agent
      .get("https://vpic.nhtsa.dot.gov")
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

  it.each(["close", "shutdown"] as const)(
    "stops a pending direct request on %s",
    async (action) => {
      const shutdown = new AbortController();
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      agent
        .get("https://vpic.nhtsa.dot.gov")
        .intercept({ path: PATH })
        .reply(() => {
          started();
          return {
            statusCode: 200,
            data: payload(),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        })
        .delay(500);
      const lookup = service({ signal: shutdown.signal });
      const pending = lookup.check(VIN);
      await requestStarted;
      if (action === "close") await lookup.close();
      else shutdown.abort();
      expect((await pending).nhtsa_vpic).toMatchObject({ status: "unavailable", data: null });
    },
  );
});
