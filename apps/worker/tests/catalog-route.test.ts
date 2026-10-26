import type { IncomingMessage, ServerResponse } from "node:http";
import type { CatalogLookup } from "@autodom/core/catalog-filter";
import { expect, it } from "vitest";
import { createCatalogRoute } from "../src/catalog-http.js";

const TOKEN = "c".repeat(40);

const call = async (
  route: ReturnType<typeof createCatalogRoute>,
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
) => {
  let status = 0;
  let headers: Record<string, string> = {};
  const body: string[] = [];
  const request = {
    url,
    method: options.method ?? "GET",
    headers: options.headers ?? {},
  } as unknown as IncomingMessage;
  const response = {
    writeHead(value: number, head?: Record<string, string>) {
      status = value;
      headers = head ?? {};
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    end(chunk?: string) {
      if (chunk) body.push(chunk);
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await route(request, response);
  return { handled, status, headers, body: body.join("") };
};

const catalogue = (delay: number): CatalogLookup => ({
  async getOptions() {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return [{ id: "1", value: "Toyota", label: "Toyota" }];
  },
});

it("waits for a slow catalogue instead of answering that it is still loading", async () => {
  // The mashina taxonomy needs about two seconds for a cold make or model list.
  const route = createCatalogRoute(catalogue(1600), TOKEN);
  const result = await call(route, "/v1/catalog/options?key=make", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual([{ id: "1", value: "Toyota", label: "Toyota" }]);
});

it("keeps the catalogue route private and rejects unknown requests", async () => {
  const route = createCatalogRoute(catalogue(0), TOKEN);
  expect((await call(route, "/v1/catalog/options?key=make")).status).toBe(401);
  expect(
    (
      await call(route, "/v1/catalog/options?key=make", {
        headers: { authorization: `Bearer ${"x".repeat(40)}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call(route, "/v1/catalog/options?key=make", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).status,
  ).toBe(405);
  expect(
    (
      await call(route, "/v1/catalog/options?key=unknown_key", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).status,
  ).toBe(400);
});
