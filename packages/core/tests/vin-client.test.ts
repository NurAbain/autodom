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
  it("preserves independently failed sources rather than rejecting a useful partial result", async () => {
    const check = await upstream(result);
    const actual = await check(VIN.toLowerCase());
    expect(actual.carhistory.status).toBe("available");
    expect(actual.car365).toMatchObject({ status: "unavailable", data: null });
  });

  it.each([
    { ...result, vin: "KMFXKN7BPXU258801" },
    { ...result, carhistory: { ...result.carhistory, source_url: "https://attacker.invalid/" } },
    { ...result, car365: { ...result.car365, status: "available", data: null } },
    {
      ...result,
      carhistory: { ...result.carhistory, status: "disabled", checked_at: 1_789_000_000 },
    },
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
