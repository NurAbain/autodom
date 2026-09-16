import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { VIN_SOURCE_URLS, type VinCheckResult } from "../src/vin.js";
import { createVinApiLookup } from "../src/vin-client.js";

const VIN = "KMFXKN7BPXU258800";
const TOKEN = "test-vin-api-credential-not-a-production-key";
const servers: Server[] = [];
const result: VinCheckResult = {
  vin: VIN,
  checked_at: 1_789_000_000,
  carhistory: {
    status: "available",
    source_url: VIN_SOURCE_URLS.carhistory,
    checked_at: 1_789_000_000,
  },
  car365: {
    status: "unavailable",
    source_url: VIN_SOURCE_URLS.car365,
    checked_at: 1_789_000_000,
    data: null,
  },
};

async function upstream(body: unknown, status = 200) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (
      request.method !== "POST" ||
      request.url !== "/v1/vin/check" ||
      request.headers.authorization !== `Bearer ${TOKEN}` ||
      JSON.parse(Buffer.concat(chunks).toString()).vin !== VIN
    ) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  return createVinApiLookup({
    AUTODOM_VIN_API_URL: `http://127.0.0.1:${address.port}`,
    AUTODOM_VIN_API_TOKEN: TOKEN,
  })!;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("remote VIN API consumer", () => {
  const decoder = {
    status: "available",
    source_url: VIN_SOURCE_URLS.nhtsa_vpic,
    checked_at: result.checked_at,
    data: {
      vin: VIN,
      make: "HYUNDAI",
      model: null,
      model_year: 1999,
      body_class: null,
      fuel_type: "Diesel",
      plant_country: "SOUTH KOREA",
    },
  };
  const globalDecoder = {
    status: "available",
    source_url: VIN_SOURCE_URLS.autodev,
    checked_at: result.checked_at,
    data: {
      vin: VIN,
      make: "Hyundai",
      model: null,
      model_year: 1999,
      trim: null,
      body_class: null,
      engine: null,
      drive: null,
      transmission: null,
      origin_country: "South Korea",
      ambiguous: false,
    },
  };

  it("preserves independently failed sources rather than rejecting a useful partial result", async () => {
    const check = await upstream(result);
    const actual = await check(VIN.toLowerCase());
    expect(actual.carhistory.status).toBe("available");
    expect(actual.car365).toMatchObject({ status: "unavailable", data: null });
  });

  it("accepts optional decoding without losing failed history sources during rollout", async () => {
    const check = await upstream({
      ...result,
      nhtsa_vpic: decoder,
    });
    const actual = await check(VIN);
    expect(actual.car365).toMatchObject({ status: "unavailable", data: null });
    expect(actual.nhtsa_vpic).toMatchObject({
      status: "available",
      data: { vin: VIN, model_year: 1999 },
    });
  });

  it("accepts global partial decoding alongside unavailable history sources", async () => {
    const check = await upstream({
      ...result,
      autodev: globalDecoder,
    });
    const actual = await check(VIN);
    expect(actual).toMatchObject({
      autodev: { status: "available", data: { make: "Hyundai", model: null, model_year: 1999 } },
      car365: { status: "unavailable", data: null },
    });
  });

  it("accepts a partial archive but rejects evidence belonging to another VIN or advertisement", async () => {
    const listing = {
      id: "39720103",
      vin: VIN,
      source_url: "https://fem.encar.com/cars/detail/39720103",
      model: null,
      mileage_km: null,
      advertisement_status: "SOLD",
      created_at: "2025-05-26T09:23:30",
      first_advertised_at: null,
      modified_at: null,
      re_registered: null,
      photo_urls: ["https://ci.encar.com/carpicture/carpicture02/pic3972/39720103_001.jpg"],
      details: { odometer: { value: 21986, unit: "km" }, first_registration_date: "2022-09" },
      reports: [
        {
          kind: "inspection",
          status: "available",
          source_url: "https://api.encar.com/legacy/usedcar/inspect/39720103",
          partial: true,
          checked_at: result.checked_at,
          report_date: "2025-05-27",
          facts: [{ section: "Кузов", label: "Передняя панель", value: "Замена" }],
        },
      ],
    };
    const history = {
      vin: VIN,
      discovery_url: `https://carcheck.by/auto/${VIN}`,
      listings: [listing],
      partial: true,
    };
    const observation = {
      status: "available",
      source_url: VIN_SOURCE_URLS.encar,
      checked_at: result.checked_at,
      data: history,
    };
    const valid = await upstream({ ...result, encar: observation });
    await expect(valid(VIN)).resolves.toMatchObject({
      car365: { status: "unavailable" },
      encar: {
        status: "available",
        data: {
          partial: true,
          listings: [
            {
              details: { odometer: { value: 21986, unit: "km" } },
              reports: [{ facts: [{ label: "Передняя панель", value: "Замена" }] }],
            },
          ],
        },
      },
    });

    for (const data of [
      { ...history, listings: [{ ...listing, vin: "KMFXKN7BPXU258801" }] },
      {
        ...history,
        listings: [{ ...listing, source_url: "https://fem.encar.com/cars/detail/39711062" }],
      },
      {
        ...history,
        listings: [
          {
            ...listing,
            photo_urls: ["https://ci.encar.com/carpicture/carpicture02/pic3971/39711062_001.jpg"],
          },
        ],
      },
      { ...history, discovery_url: "https://carcheck.by/auto/KMFXKN7BPXU258801" },
      { ...history, partial: false },
      ...[
        {
          ...listing.reports[0],
          source_url: "https://api.encar.com/legacy/usedcar/inspect/39711062",
        },
        { ...listing.reports[0], kind: "diagnostic" },
        { ...listing.reports[0], facts: [] },
        { ...listing.reports[0], status: "not_found" },
      ].map((report) => ({ ...history, listings: [{ ...listing, reports: [report] }] })),
    ]) {
      const invalid = await upstream({ ...result, encar: { ...observation, data } });
      await expect(invalid(VIN)).rejects.toThrow();
    }
  });

  it.each([
    { ...result, vin: "KMFXKN7BPXU258801" },
    { ...result, carhistory: { ...result.carhistory, source_url: "https://attacker.invalid/" } },
    { ...result, car365: { ...result.car365, status: "available", data: null } },
    {
      ...result,
      carhistory: { ...result.carhistory, status: "disabled", checked_at: 1_789_000_000 },
    },
    { ...result, nhtsa_vpic: { ...decoder, data: { ...decoder.data, vin: "KMFXKN7BPXU258801" } } },
    { ...result, nhtsa_vpic: { ...decoder, source_url: "https://attacker.invalid/" } },
    { ...result, nhtsa_vpic: { ...decoder, status: "not_found" } },
    { ...result, nhtsa_vpic: { ...decoder, checked_at: null } },
    {
      ...result,
      autodev: { ...globalDecoder, data: { ...globalDecoder.data, vin: "KMFXKN7BPXU258801" } },
    },
    { ...result, autodev: { ...globalDecoder, status: "not_found" } },
  ])("rejects an untrustworthy observation instead of displaying it", async (body) => {
    const check = await upstream(body);
    await expect(check(VIN)).rejects.toThrow();
  });

  it("does not reveal a service error body or credential to the caller", async () => {
    const check = await upstream({ error: `upstream internal error ${TOKEN}` }, 503);
    const request = check(VIN);
    await expect(request).rejects.toThrow(/VIN/);
    await request.catch((error: Error) => expect(error.message).not.toContain(TOKEN));
  });

  it("refuses incomplete credentials and credential-bearing URLs before network access", () => {
    expect(() => createVinApiLookup({ AUTODOM_VIN_API_URL: "https://vin.example" })).toThrow();
    expect(() =>
      createVinApiLookup({
        AUTODOM_VIN_API_URL: "https://user:password@vin.example",
        AUTODOM_VIN_API_TOKEN: TOKEN,
      }),
    ).toThrow();
  });
});
