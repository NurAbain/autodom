import { afterEach, expect, it, vi } from "vitest";
import { approvedSources, loadSettings, loadToken } from "../src/config.js";
import { loadProxyRoutes } from "../src/proxy.js";
import { enabledMarkets, listingUrlAllowed, sourceStatus } from "../src/registry.js";
import { requireSourceAccess, SourceError } from "../src/transport.js";

const credentials = {
  SMARTPROXY_USERNAME: "fixture-user",
  SMARTPROXY_PASSWORD: "sécret",
  SMARTPROXY_RESIDENTIAL_USERNAME: "resident",
  SMARTPROXY_RESIDENTIAL_PASSWORD: "password",
};
const settings = {
  AUTODOM_DATABASE_URL: "postgresql://user:password@localhost/autodom",
  AUTODOM_REDIS_URL: "redis://localhost:6379",
};
afterEach(() => vi.unstubAllEnvs());

it("requires a unique known approval set and refuses unapproved adapter access", () => {
  expect(approvedSources({})).toEqual(["mashina.kg"]);
  for (const selected of ["", "mashina.kg,mashina.kg", "unknown"])
    expect(() => approvedSources({ AUTODOM_APPROVED_SOURCES: selected })).toThrow();
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  expect(() => requireSourceAccess("encar.com")).toThrow(SourceError);
  expect(() => requireSourceAccess("nbkr.kg")).toThrow(SourceError);
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "bid.cars,truecar.com");
  expect(enabledMarkets()).toEqual(["US"]);
});

it("requires real database and redis locations and enforces crawl interval boundaries", () => {
  expect(() => loadSettings({})).toThrow();
  expect(loadSettings(settings)).toMatchObject({
    refresh_seconds: 300,
    refresh_pages: 3,
    crawl_delay: 2,
    monitor_seconds: 30,
    full_refresh_seconds: 86400,
  });
  for (const changes of [
    { AUTODOM_REFRESH_SECONDS: "59" },
    { AUTODOM_REFRESH_PAGES: "21" },
    { AUTODOM_CRAWL_DELAY: "NaN" },
    { AUTODOM_MONITOR_SECONDS: "9" },
    { AUTODOM_FULL_REFRESH_SECONDS: "299" },
    { AUTODOM_REFRESH_SECONDS: "60x" },
  ])
    expect(() => loadSettings({ ...settings, ...changes })).toThrow();
  expect(() =>
    loadSettings({ ...settings, AUTODOM_DATABASE_URL: "https://user:secret@host" }),
  ).toThrow(/AUTODOM_DATABASE_URL/u);
});

it("validates configured tokens without echoing credentials", async () => {
  const token = `123:${"a".repeat(30)}`;
  expect(await loadToken({ AUTODOM_BOT_TOKEN: ` ${token}\n` })).toBe(token);
  await expect(loadToken({ AUTODOM_BOT_TOKEN: "private-invalid-token" })).rejects.not.toThrow(
    "private-invalid-token",
  );
});

it("requires both proxy tiers and preserves endpoint aliases, latin1 auth and deterministic rotation", () => {
  expect(() =>
    loadProxyRoutes({ SMARTPROXY_USERNAME: "fixture-user", SMARTPROXY_PASSWORD: "password" }),
  ).toThrow();
  const routes = loadProxyRoutes({
    ...credentials,
    SMARTPROXY_ENDPOINT: "http://proxy.example:10000/",
    SMARTPROXY_DATACENTER_PORT_START: "11000",
    SMARTPROXY_DATACENTER_PORT_COUNT: "2",
  });
  expect(routes[0]!.urlFor(1)).toBe("http://proxy.example:11000");
  expect(routes[0]!.urlFor(2)).toBe("http://proxy.example:11001");
  expect(routes[0]!.urlFor(3)).toBe("http://proxy.example:11000");
  expect(Buffer.from(routes[0]!.authorization.slice(6), "base64").toString("latin1")).toBe(
    "fixture-user:sécret",
  );
  expect(routes[1]!.urlFor(20)).toBe("http://gate.decodo.com:7000");
});

it.each([
  "http://user:secret@host:1234",
  "http://host:1234/path",
  "http://host:1234?x=1",
  "http://host",
  "socks5://host:1234",
  "http://host:65536",
])("rejects malformed proxy endpoints without exposing endpoint credentials: %s", (endpoint) => {
  expect(() => loadProxyRoutes({ ...credentials, SMARTPROXY_ENDPOINT: endpoint })).toThrow(
    /Invalid datacenter SMARTPROXY/u,
  );
});

it("rejects invalid auth and port rotation bounds", () => {
  for (const changes of [
    { SMARTPROXY_USERNAME: "user:name" },
    { SMARTPROXY_PASSWORD: "пароль" },
    { SMARTPROXY_DATACENTER_PORT_START: "65535", SMARTPROXY_DATACENTER_PORT_COUNT: "2" },
    { SMARTPROXY_DATACENTER_PORT_COUNT: "-1" },
  ])
    expect(() => loadProxyRoutes({ ...credentials, ...changes })).toThrow();
});

it("accepts only source-specific HTTPS listing hosts", () => {
  expect(listingUrlAllowed("encar.com", "https://fem.encar.com/cars/detail/1")).toBe(true);
  for (const url of [
    "http://fem.encar.com/cars/detail/1",
    "https://fem.encar.com.evil.invalid/1",
    "https://user@fem.encar.com/1",
    "https://fem.encar.com:444/1",
    "https://www.truecar.com/1",
  ])
    expect(listingUrlAllowed("encar.com", url)).toBe(false);
});

it("reports every source asynchronously including disabled sources and independent error state", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const data: Record<string, string> = {
    "source:encar.com:source_error": "SourceRateLimited",
    "source:mashina.kg:last_sync_at": "2000000000",
    "source:mashina.kg:catalog_total": "37",
  };
  const result = await sourceStatus({
    async getMeta(key, fallback = null) {
      return data[key] ?? fallback;
    },
    async setMeta() {},
    async sourceStats() {
      return { "mashina.kg": { listings: 3, last_seen: 2000000000 } };
    },
  });
  expect(result.find((item) => item.source === "mashina.kg")).toMatchObject({
    listings: 3,
    last_sync: "2000000000",
    total: "37",
    enabled: true,
  });
  expect(result.find((item) => item.source === "encar.com")).toMatchObject({
    listings: 0,
    error: "SourceRateLimited",
    enabled: false,
  });
});
