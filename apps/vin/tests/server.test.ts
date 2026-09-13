import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { VIN_SOURCE_URLS, type VinCheckResult, type VinLookup } from "@autodom/core/vin";
import {
  disabledVinArchiveResult,
  type VinArchiveLookup,
  type VinArchivePhotoLookup,
} from "@autodom/core/vin-archive";
import { afterEach, describe, expect, it } from "vitest";
import { startVinApiServer } from "../src/server.js";

const token = "private-server-test-token-with-32-characters";
const vin = "KMFXKN7BPXU258800";
const photoRequest = {
  vin: "1FTFW1ED9NFB06106",
  provider: "bidcars",
  auction: "iaai",
  lot_id: "45397077",
  photo_url: "https://mercury.bid.cars/0-45397077/2022-Ford-F-150-1FTFW1ED9NFB06106-1.jpg",
};
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

async function start(
  checkVin: VinLookup,
  maxInFlight?: number,
  checkVinArchive?: VinArchiveLookup,
  getVinArchivePhoto?: VinArchivePhotoLookup,
) {
  const shutdown = new AbortController();
  shutdowns.push(shutdown);
  const server = await startVinApiServer({
    host: "127.0.0.1",
    port: 0,
    apiToken: token,
    checkVin,
    ...(checkVinArchive ? { checkVinArchive } : {}),
    ...(getVinArchivePhoto ? { getVinArchivePhoto } : {}),
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
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

  it("requires authentication on archive photo requests without calling decoders", async () => {
    let calls = 0;
    const { url } = await start(async () => {
      calls++;
      return result;
    });
    const response = await fetch(`${url}/v1/vin/archive-photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vin }),
    });
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("shares admission capacity between archive photos and regular VIN checks", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { url } = await start(
      async () => result,
      1,
      async () => {
        entered.resolve();
        await release.promise;
        return disabledVinArchiveResult(vin);
      },
    );
    const pending = fetch(`${url}/v1/vin/archive-photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vin }),
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Archive request ended before entering its lookup");
        }),
      ]);
      expect((await post(url)).status).toBe(429);
      release.resolve();
      expect((await pending).status).toBe(200);
      expect((await post(url)).status).toBe(200);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("returns exact binary archive bytes and rejects unauthenticated or forged bodies before loading", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
      "base64",
    );
    let photoCalls = 0;
    let decoderCalls = 0;
    const { url } = await start(
      async () => {
        decoderCalls++;
        return result;
      },
      undefined,
      undefined,
      async () => {
        photoCalls++;
        return { bytes, content_type: "image/png" };
      },
    );
    const send = (body: string, authorization = `Bearer ${token}`) =>
      fetch(`${url}/v1/vin/archive-photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body,
      });
    const body = JSON.stringify(photoRequest);
    expect((await send(body, "")).status).toBe(401);
    expect((await send(JSON.stringify({ ...photoRequest, lot_id: "45397078" }))).status).toBe(400);
    expect((await send(body.replace('"provider":', '"extra":"no","provider":'))).status).toBe(400);
    expect(
      (await send(body.replace('"provider":', '"pr\\u006fvider":"copart","provider":'))).status,
    ).toBe(400);
    expect(photoCalls).toBe(0);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(decoderCalls).toBe(0);
    expect(photoCalls).toBe(1);
  });

  it("shares photo admission, propagates disconnect cancellation and keeps source errors private", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let calls = 0;
    const { url } = await start(
      async () => result,
      1,
      undefined,
      async (_request, signal) => {
        if (++calls > 1) throw new Error(`secret ${token} ${photoRequest.photo_url}`);
        entered.resolve();
        const pending = Promise.withResolvers<never>();
        signal?.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            pending.reject(signal.reason);
          },
          { once: true },
        );
        return pending.promise;
      },
    );
    const request = httpRequest(`${url}/v1/vin/archive-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    const closed = Promise.withResolvers<void>();
    request.once("close", () => closed.resolve());
    request.on("error", () => {
      /* Expected disconnect. */
    });
    request.end(JSON.stringify(photoRequest));
    await entered.promise;
    expect((await post(url)).status).toBe(429);
    const archive = await fetch(`${url}/v1/vin/archive-photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vin }),
    });
    expect(archive.status).toBe(429);
    request.destroy();
    await Promise.all([cancelled.promise, closed.promise]);
    expect((await post(url)).status).toBe(200);
    const response = await fetch(`${url}/v1/vin/archive-photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(photoRequest),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(photoRequest.photo_url);
    expect(text).not.toContain(photoRequest.vin);
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

  it.each([
    { maxInFlight: undefined, capacity: 10 },
    { maxInFlight: 1, capacity: 1 },
  ])(
    "admits $capacity concurrent checks, rejects excess and recovers capacity",
    async ({ maxInFlight, capacity }) => {
      const release = Promise.withResolvers<VinCheckResult>();
      let calls = 0;
      const { url } = await start(async () => {
        calls++;
        return release.promise;
      }, maxInFlight);
      const active: Promise<Response>[] = [];
      let responses: Response[] = [];
      try {
        for (let index = 0; index < capacity; index++) {
          active.push(post(url));
          await expect.poll(() => calls).toBe(index + 1);
        }
        const overload = await post(url);
        expect(overload.status).toBe(429);
        expect(Number(overload.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(calls).toBe(capacity);
      } finally {
        release.resolve(result);
        responses = await Promise.all(active);
      }
      expect(responses.map((response) => response.status)).toEqual(Array(capacity).fill(200));
      expect((await post(url)).status).toBe(200);
      expect(calls).toBe(capacity + 1);
    },
  );

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
