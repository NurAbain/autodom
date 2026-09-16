import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { VinLookup } from "@autodom/core/vin";
import type { VinArchivePhotoLookup } from "@autodom/core/vin-archive";
import {
  readVinArchivePhotoRequest,
  readVinRequest,
  VinRequestError,
} from "@autodom/core/vin-request";
import { VinMetrics } from "./metrics.js";

export interface VinApiServerOptions {
  host: string;
  port: number;
  apiToken: string;
  checkVin: VinLookup;
  getVinArchivePhoto?: VinArchivePhotoLookup;
  maxInFlight?: number;
  signal?: AbortSignal;
}

export function validateVinApiOptions(
  options: Omit<VinApiServerOptions, "checkVin" | "getVinArchivePhoto">,
): void {
  if (!/^[\x21-\x7e]{32,}$/u.test(options.apiToken))
    throw new Error(
      "AUTODOM_VIN_API_TOKEN must contain at least 32 printable non-space ASCII characters.",
    );
  if (!options.host || options.host.trim() !== options.host || /[\s/?#@\\]/u.test(options.host))
    throw new Error("AUTODOM_VIN_API_HOST must be a host name or IP address.");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("AUTODOM_VIN_API_PORT must be a valid TCP port.");
  const limit = options.maxInFlight ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("AUTODOM_VIN_API_MAX_IN_FLIGHT must be a positive integer.");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(status >= 400 ? { Connection: "close" } : {}),
  });
  response.end(encoded);
}

export async function startVinApiServer(options: VinApiServerOptions): Promise<Server> {
  validateVinApiOptions(options);
  options.signal?.throwIfAborted();
  const expectedToken = createHash("sha256").update(`Bearer ${options.apiToken}`).digest();
  const active = new Set<AbortController>();
  const maxInFlight = options.maxInFlight ?? 10;
  const metrics = new VinMetrics(maxInFlight);
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000 },
    (request, response) => {
      metrics.trackHttp(request, response);
      void (async () => {
        if (request.url?.includes("?"))
          throw new VinRequestError(
            400,
            "query_not_allowed",
            "Query parameters are not supported.",
          );
        if (request.url === "/health" && (request.method === "GET" || request.method === "HEAD")) {
          json(response, 200, { healthy: true, service: "autodom-vin-api" });
          return;
        }
        if (request.url === "/metrics" && request.method === "GET") {
          const body = await metrics.registry.metrics();
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(200, {
              "Content-Type": metrics.registry.contentType,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            response.end(body);
          }
          return;
        }
        if (request.url !== "/v1/vin/check" && request.url !== "/v1/vin/archive-photo")
          throw new VinRequestError(404, "not_found", "Endpoint not found.");
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new VinRequestError(405, "method_not_allowed", "Use POST for VIN checks.");
        }
        let authorizationHeaders = 0;
        for (let index = 0; index < request.rawHeaders.length; index += 2)
          if (request.rawHeaders[index]?.toLowerCase() === "authorization") authorizationHeaders++;
        const suppliedToken = createHash("sha256")
          .update(request.headers.authorization ?? "")
          .digest();
        const authenticated = timingSafeEqual(expectedToken, suppliedToken);
        if (!authenticated || authorizationHeaders !== 1) {
          response.setHeader("WWW-Authenticate", "Bearer");
          throw new VinRequestError(
            401,
            "unauthorized",
            "Valid server authentication is required.",
          );
        }
        if (active.size >= maxInFlight) {
          response.setHeader("Retry-After", "1");
          throw new VinRequestError(429, "overloaded", "VIN service is busy; retry later.");
        }
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        active.add(controller);
        metrics.inFlight.set(active.size);
        request.once("aborted", disconnected);
        request.once("error", disconnected);
        response.once("close", disconnected);
        try {
          if (request.url === "/v1/vin/archive-photo") {
            const photoRequest = await readVinArchivePhotoRequest(request);
            controller.signal.throwIfAborted();
            if (!options.getVinArchivePhoto)
              throw new VinRequestError(
                503,
                "photo_unavailable",
                "Archive photo is unavailable; repeat the VIN check.",
              );
            const photo = await options.getVinArchivePhoto(photoRequest, controller.signal);
            controller.signal.throwIfAborted();
            if (!response.destroyed && !response.writableEnded) {
              response.writeHead(200, {
                "Content-Type": photo.content_type,
                "Content-Length": photo.bytes.byteLength,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              });
              response.end(photo.bytes);
            }
            return;
          }
          const vin = await readVinRequest(request);
          controller.signal.throwIfAborted();
          const result = await options.checkVin(vin, controller.signal);
          metrics.recordResult(result);
          controller.signal.throwIfAborted();
          json(response, 200, result);
        } finally {
          active.delete(controller);
          metrics.inFlight.set(active.size);
          request.off("aborted", disconnected);
          request.off("error", disconnected);
          response.off("close", disconnected);
        }
      })().catch((error: unknown) => {
        if (error instanceof VinRequestError)
          json(response, error.status, { code: error.code, error: error.message });
        else if (request.url === "/v1/vin/archive-photo")
          json(response, 503, {
            code: "photo_unavailable",
            error: "Archive photo is unavailable; repeat the VIN check.",
          });
        else
          json(response, 502, { code: "check_failed", error: "VIN check could not be completed." });
      });
    },
  );
  server.keepAliveTimeout = 5_000;
  const shutdown = () => {
    for (const controller of active) controller.abort();
    server.close();
    server.closeAllConnections();
  };
  server.once("close", () => {
    options.signal?.removeEventListener("abort", shutdown);
    for (const controller of active) controller.abort();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  options.signal?.addEventListener("abort", shutdown, { once: true });
  if (options.signal?.aborted) {
    shutdown();
    options.signal.throwIfAborted();
  }
  return server;
}
