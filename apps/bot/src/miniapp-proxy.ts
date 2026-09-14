import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/** Fixed private companion, never a client-supplied target or a payment callback proxy. */
export function forwardFullMiniApp(
  incoming: IncomingMessage,
  response: ServerResponse,
  target: string,
  path: string,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "content-type", "origin", "accept"]) {
    const value = incoming.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const upstream = httpRequest(new URL(path.slice("/full".length), target), {
    method: incoming.method,
    headers,
    timeout: 60_000,
  });
  const fail = () => {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Автодом временно недоступен. Повторите позже." }));
    } else response.destroy();
    resolve();
  };
  upstream.on("error", fail);
  upstream.on("timeout", () => upstream.destroy(new Error("Companion timed out")));
  upstream.on("response", (result) => {
    for (const name of ["content-type", "content-security-policy", "cache-control"]) {
      const value = result.headers[name];
      if (value) response.setHeader(name, value);
    }
    if (result.headers.location?.startsWith("/miniapp"))
      response.setHeader("Location", `/full${result.headers.location}`);
    response.writeHead(result.statusCode ?? 502);
    result.on("error", fail);
    result.pipe(response);
    result.on("end", resolve);
  });
  incoming.on("aborted", () => upstream.destroy());
  response.on("close", () => {
    upstream.destroy();
    resolve();
  });
  incoming.pipe(upstream);
  return promise;
}
