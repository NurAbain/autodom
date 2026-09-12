#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadProxyRoutes } from "@autodom/core";
import { configuredVinProviders } from "@autodom/core/vin";
import { VinCheckService } from "@autodom/sources/vin";
import { startVinApiServer, validateVinApiOptions } from "./server.js";

const HELP = `Autodom private VIN API

Usage: pnpm vin [serve|health] [--help]

  serve     Start the authenticated private VIN API (default)
  health    Probe the local /health endpoint with a five-second timeout

serve requires AUTODOM_VIN_API_TOKEN (32+ non-space ASCII characters), explicit
AUTODOM_VIN_PROVIDERS (carhistory,car365,nhtsa_vpic,autodev).
Korean providers require both existing SMARTPROXY tiers. nhtsa_vpic uses the
free public NHTSA API directly. autodev requires AUTODOM_AUTODEV_API_KEY and
uses the direct Auto.dev VIN Decode API. Both decoders return technical data,
not vehicle history. Auto.dev Free is capped at 1,000 calls/month; no paid upgrades.
Configured Korean providers run first. Decoders run only after all return not_found,
or directly if no Korean provider is configured. Korean hits/errors skip both decoders.
AUTODOM_VIN_API_HOST defaults to 127.0.0.1; AUTODOM_VIN_API_PORT to 8080.
AUTODOM_VIN_API_MAX_IN_FLIGHT defaults to 10; AUTODOM_CRAWL_DELAY to 2 seconds.
health needs only host/port. No database, Redis or Telegram configuration is used.
Never expose this service or its authentication token to a browser.
`;

export async function main(
  argv = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  process.umask(0o077);
  let service: VinCheckService | undefined;
  let exitCode = 0;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    const [command = "serve", ...extra] = positionals;
    if ((command !== "serve" && command !== "health") || extra.length)
      throw new Error("Use serve or health with no extra arguments.");
    const host = env.AUTODOM_VIN_API_HOST ?? "127.0.0.1";
    const portText = env.AUTODOM_VIN_API_PORT ?? "8080";
    const port = Number(portText);
    if (!/^\d+$/u.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("AUTODOM_VIN_API_PORT must be between 1 and 65535.");
    if (!host || host.trim() !== host || /[\s/?#@\\]/u.test(host))
      throw new Error("AUTODOM_VIN_API_HOST must be a host name or IP address.");
    if (command === "health") {
      const healthHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
      const authority = healthHost.includes(":") ? `[${healthHost}]` : healthHost;
      const response = await fetch(`http://${authority}:${port}/health`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      return response.status === 200 ? 0 : 1;
    }
    const maxText = env.AUTODOM_VIN_API_MAX_IN_FLIGHT ?? "10";
    if (!/^\d+$/u.test(maxText))
      throw new Error("AUTODOM_VIN_API_MAX_IN_FLIGHT must be a positive integer.");
    const options = {
      host,
      port,
      apiToken: env.AUTODOM_VIN_API_TOKEN ?? "",
      maxInFlight: Number(maxText),
      signal: shutdown.signal,
    };
    validateVinApiOptions(options);
    const providers = configuredVinProviders(env);
    if (!providers.length)
      throw new Error("AUTODOM_VIN_PROVIDERS must explicitly enable at least one provider.");
    const delayText = env.AUTODOM_CRAWL_DELAY ?? "2";
    const requestDelaySeconds = Number(delayText);
    if (!delayText.trim() || !Number.isFinite(requestDelaySeconds) || requestDelaySeconds < 0)
      throw new Error("AUTODOM_CRAWL_DELAY must be a non-negative number of seconds.");
    const routes = providers.some((provider) => provider === "carhistory" || provider === "car365")
      ? loadProxyRoutes(env)
      : [];
    service = new VinCheckService({
      providers,
      routes,
      requestDelaySeconds,
      autoDevApiKey: env.AUTODOM_AUTODEV_API_KEY,
      signal: shutdown.signal,
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const server = await startVinApiServer({ ...options, checkVin: service.check });
    console.log("Autodom VIN API ready.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
      if (!server.listening) resolve();
    });
  } catch {
    // Provider/network errors may contain request URLs or credentials. Do not log them.
    console.error(
      "VIN API command failed. Check private service configuration and connectivity; use --help for requirements.",
    );
    exitCode = 1;
  } finally {
    shutdown.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await service?.close();
    } catch {
      console.error("VIN API shutdown failed.");
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
