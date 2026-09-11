import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("VIN CLI", () => {
  it("probes health without database, Telegram, Redis, proxy or provider configuration", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      response.end(JSON.stringify({ healthy: true, service: "autodom-vin-api" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    try {
      expect(await main(["health"], { AUTODOM_VIN_API_PORT: String(address.port) })).toBe(0);
      expect(paths).toEqual(["HEAD /health"]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("does not report an unhealthy process as ready", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    try {
      expect(await main(["health"], { AUTODOM_VIN_API_PORT: String(address.port) })).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it.each([
    { AUTODOM_VIN_API_TOKEN: "" },
    { AUTODOM_VIN_PROVIDERS: "" },
    { AUTODOM_VIN_PROVIDERS: "typo" },
    { AUTODOM_VIN_API_PORT: "NaN" },
    { AUTODOM_VIN_API_MAX_IN_FLIGHT: "0" },
    { AUTODOM_CRAWL_DELAY: "Infinity" },
  ])("fails startup for unsafe configuration without opening a listener", async (env) => {
    expect(
      await main(["serve"], {
        AUTODOM_VIN_API_TOKEN: "x".repeat(32),
        AUTODOM_VIN_PROVIDERS: "car365",
        SMARTPROXY_USERNAME: "test",
        SMARTPROXY_PASSWORD: "test",
        SMARTPROXY_RESIDENTIAL_USERNAME: "test",
        SMARTPROXY_RESIDENTIAL_PASSWORD: "test",
        ...env,
      }),
    ).toBe(1);
  });
});
