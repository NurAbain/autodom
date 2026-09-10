import { inspect } from "node:util";

type Environment = Readonly<Record<string, string | undefined>>;

export class ProxyRoute {
  constructor(
    readonly tier: string,
    readonly url: string,
    readonly authorization: string,
    readonly port_start = 0,
    readonly port_count = 0,
  ) {}

  urlFor(page: number): string {
    if (!this.port_count) return this.url;
    const port =
      this.port_start + ((((page - 1) % this.port_count) + this.port_count) % this.port_count);
    return `${this.url.slice(0, this.url.lastIndexOf(":"))}:${port}`;
  }

  [inspect.custom](): string {
    return `ProxyRoute { tier: ${JSON.stringify(this.tier)}, url: ${JSON.stringify(this.url)}, port_start: ${this.port_start}, port_count: ${this.port_count} }`;
  }
}

function route(
  tier: string,
  endpoint: string,
  username: string,
  password: string,
  env: Environment,
): ProxyRoute {
  if (!username || !password)
    throw new Error(`Configure the ${tier} SMARTPROXY username and password`);
  try {
    const value = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
    const parsed = new URL(value);
    // WHATWG URL removes explicit default ports, so recover and require the written port.
    const authority = /^[a-z]+:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? "";
    const portText = /:(\d+)$/u.exec(authority)?.[1];
    const port = Number(portText);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      !portText ||
      port < 1 ||
      port > 65535 ||
      authority.includes("@") ||
      !["", "/"].includes(parsed.pathname) ||
      parsed.search ||
      parsed.hash ||
      username.includes(":") ||
      /[\u0100-\u{10ffff}]/u.test(username + password)
    )
      throw new Error();
    const startText = (env[`SMARTPROXY_${tier.toUpperCase()}_PORT_START`] ?? "0").trim();
    const countText = (env[`SMARTPROXY_${tier.toUpperCase()}_PORT_COUNT`] ?? "0").trim();
    if (!/^[+-]?\d+$/u.test(startText) || !/^[+-]?\d+$/u.test(countText)) throw new Error();
    const port_start = Number(startText);
    const port_count = Number(countText);
    if (
      !Number.isSafeInteger(port_start) ||
      !Number.isSafeInteger(port_count) ||
      port_count < 0 ||
      (port_count > 0 && (port_start < 1 || port_start + port_count - 1 > 65535))
    )
      throw new Error();
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, "latin1").toString("base64")}`;
    return new ProxyRoute(
      tier,
      `${parsed.protocol}//${parsed.hostname}:${port}`,
      authorization,
      port_start,
      port_count,
    );
  } catch {
    throw new Error(`Invalid ${tier} SMARTPROXY endpoint or authentication format`);
  }
}

export function loadProxyRoutes(env: Environment = process.env): readonly ProxyRoute[] {
  const datacenter = route(
    "datacenter",
    env.SMARTPROXY_DATACENTER_ENDPOINT || env.SMARTPROXY_ENDPOINT || "dc.decodo.com:10000",
    (env.SMARTPROXY_USERNAME ?? "").trim(),
    (env.SMARTPROXY_PASSWORD ?? "").trim(),
    env,
  );
  const residential = route(
    "residential",
    env.SMARTPROXY_RESIDENTIAL_ENDPOINT || "gate.decodo.com:7000",
    (env.SMARTPROXY_RESIDENTIAL_USERNAME ?? "").trim(),
    (env.SMARTPROXY_RESIDENTIAL_PASSWORD ?? "").trim(),
    env,
  );
  return [datacenter, residential];
}
