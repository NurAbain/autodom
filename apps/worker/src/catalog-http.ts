import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CATALOG_OPTION_LABELS,
  CATALOG_VEHICLE_LABELS,
  type CatalogFieldKey,
  type CatalogLookup,
} from "@autodom/core/catalog-filter";

/** How long a cold catalogue request may take before the caller is told to retry. */
const READY_BUDGET_MS = 9_000;

/** Extends the parser's private listener; credentials never go to a source or browser. */
export function createCatalogRoute(catalog: CatalogLookup, token: string) {
  if (token.length < 32 || token.length > 256 || /\s/u.test(token))
    throw new Error("AUTODOM_CATALOG_API_TOKEN must be 32–256 non-whitespace characters");
  const credential = Buffer.from(`Bearer ${token}`);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.url?.split("?", 1)[0] !== "/v1/catalog/options") return false;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(value));
    };
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
      send(401, { error: "Unauthorized" });
      return true;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      send(405, { error: "Method not allowed" });
      return true;
    }
    if ((request.url?.length ?? 0) > 2048) {
      send(400, { error: "Invalid catalogue request" });
      return true;
    }
    const params = new URL(request.url!, "http://parser.invalid").searchParams;
    const key = params.get("key") ?? "";
    const parent = params.get("parent") ?? undefined;
    const modelId = params.get("model") ?? undefined;
    const generation = params.get("generation") ?? undefined;
    const numeric = (value: string | undefined) =>
      value !== undefined && /^[1-9]\d{0,17}$/u.test(value);
    if (
      [...params.keys()].some(
        (name) =>
          !["key", "parent", "model", "generation"].includes(name) ||
          params.getAll(name).length !== 1,
      ) ||
      (!Object.hasOwn(CATALOG_VEHICLE_LABELS, key) && !Object.hasOwn(CATALOG_OPTION_LABELS, key)) ||
      (["model", "generation", "modification", "city"].includes(key)
        ? !numeric(parent)
        : parent !== undefined) ||
      (key === "modification"
        ? !numeric(modelId) ||
          !generation ||
          generation.length > 256 ||
          /[\p{Cc}]/u.test(generation)
        : modelId !== undefined || generation !== undefined)
    ) {
      send(400, { error: "Invalid catalogue request" });
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = catalog
        .getOptions(
          key as CatalogFieldKey,
          parent,
          modelId && generation ? { modelId, generation } : undefined,
        )
        .then(
          (items) => ({ state: "ready" as const, items }),
          () => ({ state: "failed" as const }),
        );
      const result = await Promise.race([
        pending,
        new Promise<{ state: "loading" }>((resolve) => {
          // The mashina taxonomy needs about two seconds for a cold make or model
          // list. A shorter budget turned every first suggestion into "loading".
          timer = setTimeout(() => resolve({ state: "loading" }), READY_BUDGET_MS);
        }),
      ]);
      if (result.state === "ready") send(200, result.items);
      else if (result.state === "loading") {
        response.setHeader("Retry-After", "3");
        send(202, { state: "loading" });
      } else send(503, { error: "Catalogue unavailable" });
    } finally {
      clearTimeout(timer);
    }
    return true;
  };
}
