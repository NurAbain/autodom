import { createServer, request as httpRequest, type Server } from "node:http";
import { readVinRequest, VinRequestError } from "@autodom/core/vin-request";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function parse(body: string | Buffer, contentType = "application/json", chunked = false) {
  const server = createServer((request, response) => {
    void readVinRequest(request).then(
      (vin) => {
        response.end(JSON.stringify({ vin }));
      },
      (error: unknown) => {
        response.writeHead(error instanceof VinRequestError ? error.status : 500, {
          Connection: "close",
        });
        response.end(
          JSON.stringify({ code: error instanceof VinRequestError ? error.code : "unexpected" }),
        );
      },
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/v1/vin/check",
        headers: {
          "Content-Type": contentType,
          ...(chunked ? {} : { "Content-Length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on("error", reject);
    if (chunked) request.write(body);
    request.end(chunked ? undefined : body);
  });
}

describe("bounded VIN JSON request", () => {
  it("decodes a single escaped member and normalizes its VIN", async () => {
    expect(await parse('{"v\\u0069n":" kmfxkn7bpxu258800 "}')).toEqual({
      status: 200,
      body: { vin: "KMFXKN7BPXU258800" },
    });
  });

  it.each([
    '{"vin":"KMFXKN7BPXU258800","vin":"KMFXKN7BPXU258801"}',
    '{"vin":"KMFXKN7BPXU258800","v\\u0069n":"KMFXKN7BPXU258801"}',
    '{"vin":"KMFXKN7BPXU258800","extra":true}',
    '{"vin":17}',
    '{"vin":"KMFXKN7BPXU258800",}',
    '{"vin":"KMFXKN7BPXU2588O0"}',
    '[{"vin":"KMFXKN7BPXU258800"}]',
    '{"other":"KMFXKN7BPXU258800"}',
  ])("rejects ambiguous or invalid input: %s", async (body) => {
    expect((await parse(body)).status).toBe(400);
  });

  it("rejects invalid UTF-8 instead of accepting replacement-decoded data", async () => {
    const body = Buffer.concat([Buffer.from('{"vin":"KMFXKN7BPXU258800"}'), Buffer.from([0xff])]);
    expect((await parse(body)).status).toBe(400);
  });

  it("enforces the byte limit on declared and chunked bodies", async () => {
    const body = `${" ".repeat(1024)}{"vin":"KMFXKN7BPXU258800"}`;
    expect((await parse(body)).status).toBe(413);
    expect((await parse(body, "application/json", true)).status).toBe(413);
  });

  it("refuses non-JSON media types", async () => {
    expect((await parse('{"vin":"KMFXKN7BPXU258800"}', "text/plain")).status).toBe(415);
  });
});
