import { ProxyRoute } from "@autodom/core";
import { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
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
});
