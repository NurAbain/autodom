import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { VIN_SOURCE_URLS, type VinCheckResult, type VinLookup } from "@autodom/core/vin";
import { afterEach, describe, expect, it } from "vitest";
import { startVinApiServer } from "../src/server.js";

const token = "private-server-test-token-with-32-characters";
const vin = "KMFXKN7BPXU258800";
const result: VinCheckResult = {
  vin,
  checked_at: 1_700_000_000,
  carhistory: {
    status: "unavailable",
    checked_at: 1_700_000_000,
    source_url: VIN_SOURCE_URLS.carhistory,
  },
  car365: {
    status: "not_found",
    checked_at: 1_700_000_000,
    source_url: VIN_SOURCE_URLS.car365,
    data: null,
  },
};
const shutdowns: AbortController[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const controller of shutdowns.splice(0)) controller.abort();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function start(checkVin: VinLookup, maxInFlight = 4) {
  const shutdown = new AbortController();
  shutdowns.push(shutdown);
  const server = await startVinApiServer({
    host: "127.0.0.1",
    port: 0,
    apiToken: token,
    checkVin,
    maxInFlight,
    signal: shutdown.signal,
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return { url: `http://127.0.0.1:${address.port}`, shutdown, server };
}

function post(url: string, body = JSON.stringify({ vin }), authorization = `Bearer ${token}`) {
  return fetch(`${url}/v1/vin/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body,
  });
}

describe("private VIN API", () => {
  it("rejects authentication, invalid bodies and query parameters before invoking providers", async () => {
    let calls = 0;
    const { url } = await start(async () => {
      calls++;
      return result;
    });
    expect((await post(url, JSON.stringify({ vin }), "Bearer wrong")).status).toBe(401);
    expect((await post(url, JSON.stringify({ vin }), "")).status).toBe(401);
    expect((await post(url, '{"vin":"bad"}')).status).toBe(400);
    expect((await post(url, `{ "vin": "${vin}", "v\\u0069n": "${vin}" }`)).status).toBe(400);
    expect((await post(url, `{ "vin": "${vin}", }`)).status).toBe(400);
    expect((await post(url, " ".repeat(1025))).status).toBe(413);
    expect(
      (
        await fetch(`${url}/v1/vin/check?vin=${vin}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
  });

  it("returns partial provider results and checks health without querying providers", async () => {
    const checked: string[] = [];
    const { url } = await start(async (value) => {
      checked.push(value);
      return result;
    });
    const health = await fetch(`${url}/health`);
    expect(await health.json()).toEqual({ healthy: true, service: "autodom-vin-api" });
    const head = await fetch(`${url}/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(checked).toEqual([]);
    const response = await post(url, JSON.stringify({ vin: vin.toLowerCase() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(checked).toEqual([vin]);
  });

  it("refuses excess checks then recovers after the active workflow completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<VinCheckResult>();
    let calls = 0;
    const { url } = await start(async () => {
      calls++;
      entered.resolve();
      return release.promise;
    }, 1);
    const active = post(url);
    await entered.promise;
    const overload = await post(url);
    expect(overload.status).toBe(429);
    expect(Number(overload.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls).toBe(1);
    release.resolve(result);
    expect((await active).status).toBe(200);
    expect((await post(url)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("aborts an active workflow when its client disconnects and releases capacity", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let calls = 0;
    const { url } = await start(async (_value, signal) => {
      if (++calls > 1) return result;
      entered.resolve();
      try {
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              cancelled.resolve();
              reject(signal.reason);
            },
            { once: true },
          ),
        );
        return result;
      } finally {
        settled.resolve();
      }
    }, 1);
    const request = httpRequest(`${url}/v1/vin/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    const closed = new Promise<void>((resolve) => request.once("close", resolve));
    request.on("error", () => {
      /* Expected socket termination initiated below. */
    });
    request.end(JSON.stringify({ vin }));
    await entered.promise;
    request.destroy();
    await Promise.all([cancelled.promise, settled.promise, closed]);
    expect((await post(url)).status).toBe(200);
  });

  it("aborts in-flight checks and closes the listener on shutdown", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const { url, shutdown, server } = await start(async (_value, signal) => {
      entered.resolve();
      return new Promise<VinCheckResult>((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    });
    const active = post(url).catch(() => undefined);
    await entered.promise;
    const closed = once(server, "close");
    shutdown.abort();
    await Promise.all([cancelled.promise, closed, active]);
    expect(server.listening).toBe(false);
  });

  it("does not leak provider exception details", async () => {
    const { url } = await start(async () => {
      throw new Error(`upstream secret ${token} ${vin}`);
    });
    const response = await post(url);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(vin);
  });

  it("rejects an unsafe token before binding", async () => {
    await expect(
      startVinApiServer({
        host: "127.0.0.1",
        port: 0,
        apiToken: "short",
        checkVin: async () => result,
      }),
    ).rejects.toThrow();
  });
});
