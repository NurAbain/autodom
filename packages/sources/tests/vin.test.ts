import { ProxyRoute } from "@autodom/core";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VinCheckService } from "../src/vin.js";

const VIN = "KMFXKN7BPXU258800";

describe("VIN lookup source independence", () => {
  it("keeps disabled sources unqueried without needing any proxy credentials", async () => {
    const service = new VinCheckService({ providers: [], routes: [] });
    try {
      const result = await service.check(VIN);
      expect(result.carhistory).toMatchObject({ status: "disabled", checked_at: null });
      expect(result.car365).toMatchObject({ status: "disabled", checked_at: null, data: null });
      await expect(service.check("not-a-vin")).rejects.toThrow(RangeError);
    } finally {
      await service.close();
    }
  });

  it("retains government mileage when CarHistory returns an unrecognized page", async () => {
    const carhistory = new MockAgent();
    const car365 = new MockAgent();
    carhistory.disableNetConnect();
    car365.disableNetConnect();
    carhistory
      .get("https://www.carhistory.or.kr")
      .intercept({ path: "/search/carhistory/search.car" })
      .reply(200, "<h1>Maintenance</h1>");
    car365
      .get("https://www.car365.go.kr")
      .intercept({ path: "/ccpt/carlife/scrcar/schdcarXportView.do" })
      .reply(200, '<script>const _CSRF_TOKEN = "anonymous-token";</script>', {
        headers: { "set-cookie": "JSESSIONID=government-session; Path=/ccpt; Secure" },
      });
    car365
      .get("https://www.car365.go.kr")
      .intercept({
        path: "/ccpt/carlife/scrcar/selectSchdcarXportList.do",
        method: "POST",
        headers: {
          cookie: "JSESSIONID=government-session",
          "x-csrf-token": "anonymous-token",
          "x-ajax-req": "CCPT",
        },
        body: `vin=${VIN}`,
      })
      .reply(
        200,
        JSON.stringify({
          vin: VIN,
          drvngDstnc: "    79,434",
          xportFlflYnDclrYmd: "20141117",
          tolosYn: null,
        }),
      );
    const service = new VinCheckService({
      providers: ["carhistory", "car365"],
      routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
      requestDelaySeconds: 0,
      dispatcherFactory: (_route, page) => (page === 1 ? carhistory : car365),
    });
    try {
      const result = await service.check(VIN.toLowerCase());
      expect(result.vin).toBe(VIN);
      expect(result.carhistory.status).toBe("unavailable");
      expect(result.car365.status).toBe("available");
      expect(result.car365.data).toMatchObject({
        last_mileage_km: 79434,
        export_date: "2014-11-17",
        total_loss: null,
      });
      car365.assertNoPendingInterceptors();
    } finally {
      await service.close();
    }
  });

  it("keeps confirmed history when another old Encar card hides its VIN", async () => {
    const archiveVin = "WBA51AG03NCK98884";
    const source = new MockAgent();
    source.disableNetConnect();
    source
      .get("https://carcheck.by")
      .intercept({ path: `/auto/${archiveVin}` })
      .reply(
        200,
        `<h1 class="auto-vin-title"><span>${archiveVin}</span>
        <button class="auto-save-button" data-save-vin="${archiveVin}"
          data-save-lot="39720103" data-save-auction="12"></button></h1>
        <details class="vehicle-sales-history"><table class="vehicle-sales-table"><tbody>
          <tr><td class="history-auction">Encar</td><td>—</td>
            <td><a href="https://carcheck.by/auto/${archiveVin}/39711062">39711062</a></td>
            <td>—</td><td>21,990 км</td></tr>
        </tbody></table></details>`,
      );
    for (const [id, vin] of [
      [39720103, archiveVin],
      [39711062, null],
    ] as const) {
      source
        .get("https://fem.encar.com")
        .intercept({ path: `/cars/detail/${id}` })
        .reply(
          200,
          `<div>이 차량은 판매되었거나 삭제된 차량입니다.</div>
          <script>__PRELOADED_STATE__ = ${JSON.stringify({
            cars: {
              base: {
                vehicleId: id,
                queryCarId: id,
                vin,
                manage: {
                  dummy: false,
                  dummyVehicleId: null,
                  reRegistered: false,
                  registDateTime: "2025-05-26T09:23:30",
                  firstAdvertisedDateTime: "2025-05-27T09:20:12",
                  modifyDateTime: "2025-05-31T19:21:55",
                },
                advertisement: { status: "SOLD" },
                category: { manufacturerEnglishName: "BMW", modelGroupEnglishName: "5-Series" },
                spec: { mileage: 21986 },
                photos: [{ path: `/carpicture02/pic3972/${id}_001.jpg` }],
              },
            },
          })};</script>`,
        );
    }
    const service = new VinCheckService({
      providers: ["encar"],
      routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
      requestDelaySeconds: 0,
      dispatcherFactory: () => source,
    });
    try {
      const result = await service.check(archiveVin);
      expect(result.encar?.data?.listings.map((listing) => listing.id)).toEqual(["39720103"]);
      expect(result.encar?.data?.partial).toBe(true);
    } finally {
      await service.close();
    }
  });
});

describe("Korean-first VIN lookup", () => {
  const originalDispatcher = getGlobalDispatcher();
  const services: VinCheckService[] = [];
  let direct: MockAgent;

  beforeEach(() => {
    direct = new MockAgent();
    direct.disableNetConnect();
    setGlobalDispatcher(direct);
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    setGlobalDispatcher(originalDispatcher);
    await direct.close();
  });

  type Outcome = "available" | "not_found" | "unavailable";
  function fixture(
    carhistory: Outcome,
    car365: Outcome,
    options: { koreanDelay?: number; directDelay?: number; timeoutMs?: number } = {},
  ) {
    const events: string[] = [];
    const directRequests: string[] = [];
    const korean = [new MockAgent(), new MockAgent()];
    const entry = `<form method="post" name="searchForm" action="initSearch.car">
      <select name="carnumSel"><option value="1">VIN</option></select>
      <input name="carbodynum"><input name="carnum"><input name="carnum2"><input name="realm">
    </form>`;
    const found = carhistory === "available";
    const historyBody = `<div class="sec-search-initSearch"><section class="sec1${found ? "" : " error"}">
      <h2 class="title">${found ? "조회 가능한 차량입니다" : "차량번호 오류"}</h2>
      <div class="number-box">${VIN}</div><div class="deco">
      <img src="/img/character/${found ? "initSearch" : "initSearch-noResult"}.png"></div>
    </section></div>`;
    for (const [index, mock] of korean.entries()) {
      mock.disableNetConnect();
      const history = index === 0;
      const provider = history ? "carhistory" : "car365";
      const outcome = history ? carhistory : car365;
      const pool = mock.get(history ? "https://www.carhistory.or.kr" : "https://www.car365.go.kr");
      pool
        .intercept({
          path: history
            ? "/search/carhistory/search.car"
            : "/ccpt/carlife/scrcar/schdcarXportView.do",
        })
        .reply(
          200,
          outcome === "unavailable"
            ? "Maintenance"
            : history
              ? entry
              : '<script>const _CSRF_TOKEN = "anonymous-token";</script>',
        );
      if (outcome !== "unavailable") {
        const response = pool
          .intercept({
            path: history
              ? "/search/carhistory/initSearch.car"
              : "/ccpt/carlife/scrcar/selectSchdcarXportList.do",
            method: "POST",
          })
          .reply(() => {
            events.push(provider);
            return {
              statusCode: 200,
              data: history
                ? historyBody
                : car365 === "available"
                  ? JSON.stringify({ vin: VIN, drvngDstnc: "79,434" })
                  : "",
            };
          });
        if (!history && options.koreanDelay) response.delay(options.koreanDelay);
      }
    }
    for (const provider of ["nhtsa_vpic", "autodev"] as const) {
      const nhtsa = provider === "nhtsa_vpic";
      const response = direct
        .get(nhtsa ? "https://vpic.nhtsa.dot.gov" : "https://api.auto.dev")
        .intercept({
          path: nhtsa ? `/api/vehicles/DecodeVinValues/${VIN}?format=json` : `/vin/${VIN}`,
        })
        .reply(() => {
          directRequests.push(provider);
          events.push(provider);
          return {
            statusCode: 200,
            data: JSON.stringify(
              nhtsa
                ? {
                    Count: 1,
                    Results: [
                      { VIN, ErrorCode: "0", Make: "HYUNDAI", Model: "Porter", ModelYear: "1999" },
                    ],
                  }
                : {
                    vin: VIN,
                    vinValid: true,
                    make: "Hyundai",
                    model: "Porter",
                    year: 1999,
                    ambiguous: false,
                  },
            ),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        });
      if (options.directDelay) response.delay(options.directDelay);
    }
    const lookup = new VinCheckService({
      providers: ["carhistory", "car365", "nhtsa_vpic", "autodev"],
      routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
      requestDelaySeconds: 0,
      autoDevApiKey: "not-a-production-test-key",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      dispatcherFactory: (_route, page) => {
        const mock = korean[page - 1];
        if (!mock) throw new Error("Unexpected Korean workflow");
        return mock;
      },
    });
    services.push(lookup);
    return { lookup, directRequests, events };
  }

  it.each([
    ["available", "not_found"],
    ["not_found", "available"],
    ["unavailable", "not_found"],
    ["not_found", "unavailable"],
  ] as const)(
    "does not contact either decoder for Korean outcomes %s / %s",
    async (carhistory, car365) => {
      const { lookup, directRequests } = fixture(carhistory, car365);
      const result = await lookup.check(VIN);
      expect(result.carhistory.status).toBe(carhistory);
      expect(result.car365.status).toBe(car365);
      expect(directRequests).toEqual([]);
      expect(result).not.toHaveProperty("nhtsa_vpic");
      expect(result).not.toHaveProperty("autodev");
    },
  );

  it.each(["not_found", "unavailable"] as const)(
    "decodes only after a genuine Encar archive miss, not a failed lookup: %s",
    async (outcome) => {
      const source = new MockAgent();
      source.disableNetConnect();
      source
        .get("https://carcheck.by")
        .intercept({ path: `/auto/${VIN}` })
        .reply(
          outcome === "not_found" ? 301 : 200,
          outcome === "not_found" ? "" : "<h1>Maintenance</h1>",
          { headers: { location: `https://carcheck.by/vin/${VIN}` } },
        );
      let decoderRequests = 0;
      direct
        .get("https://vpic.nhtsa.dot.gov")
        .intercept({ path: `/api/vehicles/DecodeVinValues/${VIN}?format=json` })
        .reply(() => {
          decoderRequests++;
          return {
            statusCode: 200,
            data: JSON.stringify({
              Count: 1,
              Results: [{ VIN, ErrorCode: "0", Make: "HYUNDAI", ModelYear: "1999" }],
            }),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        });
      const service = new VinCheckService({
        providers: ["encar", "nhtsa_vpic"],
        routes: [new ProxyRoute("datacenter", "http://proxy.invalid:10000", "Basic dXNlcjpwYXNz")],
        requestDelaySeconds: 0,
        dispatcherFactory: () => source,
      });
      services.push(service);
      const result = await service.check(VIN);
      expect(result.encar?.status).toBe(outcome);
      expect(decoderRequests).toBe(outcome === "not_found" ? 1 : 0);
      if (outcome === "not_found") expect(result.nhtsa_vpic?.status).toBe("available");
      else expect(result).not.toHaveProperty("nhtsa_vpic");
    },
  );

  it("waits for both Korean misses before contacting both decoders", async () => {
    const { lookup, events, directRequests } = fixture("not_found", "not_found", {
      koreanDelay: 300,
    });
    const pending = lookup.check(VIN);
    await expect.poll(() => events.includes("car365")).toBe(true);
    expect(directRequests).toEqual([]);
    const result = await pending;
    expect(result.carhistory.status).toBe("not_found");
    expect(result.car365.status).toBe("not_found");
    expect(directRequests.toSorted()).toEqual(["autodev", "nhtsa_vpic"]);
    expect(result.nhtsa_vpic).toMatchObject({ status: "available", data: { vin: VIN } });
    expect(result.autodev).toMatchObject({ status: "available", data: { vin: VIN } });
  });

  it("does not give the decoder phase a fresh whole-lookup timeout", async () => {
    const { lookup, directRequests } = fixture("not_found", "not_found", {
      koreanDelay: 150,
      directDelay: 350,
      timeoutMs: 400,
    });
    const result = await lookup.check(VIN);
    expect(result.carhistory.status).toBe("not_found");
    expect(result.car365.status).toBe("not_found");
    expect(directRequests.toSorted()).toEqual(["autodev", "nhtsa_vpic"]);
    expect(result.nhtsa_vpic).toMatchObject({ status: "unavailable", data: null });
    expect(result.autodev).toMatchObject({ status: "unavailable", data: null });
  });

  it.each(["caller", "close"] as const)(
    "does not start the decoder phase after %s cancellation in Korea",
    async (action) => {
      const { lookup, events, directRequests } = fixture("not_found", "not_found", {
        koreanDelay: 300,
      });
      const caller = new AbortController();
      const pending = lookup.check(VIN, caller.signal);
      const settled = Promise.allSettled([pending]);
      await expect.poll(() => events.includes("car365")).toBe(true);
      if (action === "caller") caller.abort(new Error("caller stopped"));
      else await lookup.close();
      const [result] = await settled;
      expect(result?.status).toBe(action === "caller" ? "rejected" : "fulfilled");
      expect(directRequests).toEqual([]);
    },
  );
});
