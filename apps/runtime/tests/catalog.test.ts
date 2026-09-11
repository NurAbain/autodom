import {
  approvedSources,
  enabledSources,
  listingUrlAllowed,
  sourceCatalog,
  sourceStatus,
} from "@autodom/core";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const originalUmask = process.umask();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.umask(originalUmask);
});

it("exposes planning candidates offline without granting collection or listing access", async () => {
  vi.stubEnv("AUTODOM_DATABASE_URL", "not-a-database-url");
  vi.stubEnv("AUTODOM_REDIS_URL", "not-a-redis-url");
  vi.stubEnv("AUTODOM_BOT_TOKEN", "private-token-must-not-be-used");
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  expect(await main(["sources"])).toBe(0);
  expect(output).not.toContain("private-token-must-not-be-used");
  const report = JSON.parse(output);
  const candidate = report.sources.find((source: { id: string }) => source.id === "lalafo.kg");
  expect(candidate).toMatchObject({ adapter: "not_implemented", enabled: false });
  expect(
    report.coverage.find((group: { group: string }) => group.group === "neighboring"),
  ).toMatchObject({
    enabled_sources: [],
  });
  expect(() => approvedSources({ AUTODOM_APPROVED_SOURCES: candidate.id })).toThrow();
  expect(listingUrlAllowed(candidate.id, "https://lalafo.kg/kyrgyzstan/cars")).toBe(false);
  expect(enabledSources().map((source) => source.id)).toEqual(["mashina.kg"]);

  const statuses = await sourceStatus({
    async sourceStats() {
      return { "lalafo.kg": { listings: 12, last_seen: 2_000_000_000 } };
    },
    async getMeta(_key, fallback = null) {
      return fallback;
    },
    async setMeta() {},
  });
  expect(statuses.some((source) => source.source === candidate.id)).toBe(false);
});

it("distinguishes enabled vehicle-history claims from prepared but disabled sources", () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "truecar.com");
  const american = sourceCatalog().vehicle_history.find((coverage) =>
    (coverage.markets as readonly string[]).includes("US"),
  );
  expect(american).toMatchObject({
    official_report_access: "not_connected",
    enabled_listing_sources: [{ source_id: "truecar.com" }],
  });
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  expect(
    sourceCatalog().vehicle_history.find((coverage) =>
      (coverage.markets as readonly string[]).includes("US"),
    ),
  ).toMatchObject({ enabled_listing_sources: [] });
});
