import { mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceError } from "@autodom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncarHistoryLookup } from "../src/encar-cache.js";
import { VinRequestError, type VinSession } from "../src/vin-session.js";

const VIN = "WBA51AG03NCK98884";
const OTHER_VIN = "KMHEC41MAAA015218";
const FIRST = "39720103";
const SECOND = "39711062";
const DISCOVERY = `https://carcheck.by/auto/${VIN}`;
const cardUrl = (id: string) => `https://fem.encar.com/cars/detail/${id}`;
const directories: string[] = [];

async function cachePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "encar-cache-"));
  directories.push(directory);
  return join(directory, "confirmed.json");
}

function discovery(ids = [FIRST], vin = VIN): string {
  return `<h1 class="auto-vin-title"><span>${vin}</span>
    <button class="auto-save-button" data-save-vin="${vin}"
      data-save-lot="${ids[0]}" data-save-auction="12"></button></h1>
    <details class="vehicle-sales-history"><table class="vehicle-sales-table"><tbody>
    ${ids.map((id) => `<tr><td><span class="history-auction">Encar</span></td><td><a href="/auto/${vin}/${id}">${id}</a></td></tr>`).join("")}
    </tbody></table></details>`;
}

function card(id = FIRST, overrides: Record<string, unknown> = {}): string {
  return `<script>__PRELOADED_STATE__ = ${JSON.stringify({
    cars: {
      base: {
        vehicleId: Number(id),
        queryCarId: Number(id),
        vin: VIN,
        manage: { dummy: false, dummyVehicleId: null },
        spec: { mileage: 100 },
        advertisement: { status: "ADVERTISE" },
        photos: [{ path: `/carpicture02/pic3972/${id}_001.jpg` }],
        ...overrides,
      },
    },
  })};</script>`;
}

function sessionWith(replies: Record<string, string | Error | { body: string; status: number }>): {
  session: VinSession;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    session: {
      async request(url) {
        requested.push(url);
        const response = replies[url];
        if (response === undefined) throw new SourceError("Unexpected request");
        if (response instanceof Error) throw response;
        return typeof response === "string" ? { body: response, status: 200 } : response;
      },
    },
  };
}

const freshSession = () => sessionWith({ [DISCOVERY]: discovery(), [cardUrl(FIRST)]: card() });

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("confirmed Encar ID cache", () => {
  it("survives restart but fetches current official evidence without fresh discovery completeness", async () => {
    const path = await cachePath();
    const initial = new EncarHistoryLookup({ cachePath: path });
    expect((await initial.check(VIN.toLowerCase(), freshSession().session))?.partial).toBe(false);
    await initial.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    await restarted.initialize();
    const outage = sessionWith({
      [DISCOVERY]: { body: "Gateway timeout", status: 504 },
      [cardUrl(FIRST)]: card(FIRST, { spec: { mileage: 250 }, advertisement: { status: "SOLD" } }),
    });
    const result = await restarted.check(VIN, outage.session);
    expect(result).toMatchObject({
      vin: VIN,
      partial: true,
      listings: [{ id: FIRST, mileage_km: 250, advertisement_status: "SOLD" }],
    });
    expect(outage.requested).toEqual([cardUrl(FIRST)]);
    await restarted.close();
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toEqual({
      version: 1,
      entries: [{ vin: VIN, ids: [FIRST], discoveredAt: expect.any(Number) }],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("persists only VIN-confirmed canonical IDs, never dummy aliases or hidden VIN candidates", async () => {
    const path = await cachePath();
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const alias = "42458676";
    const first = sessionWith({
      [DISCOVERY]: discovery([alias, SECOND]),
      [cardUrl(alias)]: card(FIRST, {
        queryCarId: Number(alias),
        manage: { dummy: true, dummyVehicleId: Number(alias) },
      }),
      [cardUrl(SECOND)]: card(SECOND, { vin: null }),
    });
    expect((await lookup.check(VIN, first.session))?.listings.map(({ id }) => id)).toEqual([FIRST]);
    await lookup.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    const official = sessionWith({ [cardUrl(FIRST)]: card() });
    expect((await restarted.check(VIN, official.session))?.listings.map(({ id }) => id)).toEqual([
      FIRST,
    ]);
    expect(official.requested).toEqual([cardUrl(FIRST)]);
    expect(JSON.parse(await readFile(path, "utf8")).entries[0].ids).toEqual([FIRST]);
    await restarted.close();
  });

  it("flushes concurrent VIN discoveries without losing either persisted confirmation", async () => {
    const path = await cachePath();
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const other = sessionWith({
      [`https://carcheck.by/auto/${OTHER_VIN}`]: discovery([SECOND], OTHER_VIN),
      [cardUrl(SECOND)]: card(SECOND, { vin: OTHER_VIN }),
    });
    await Promise.all([
      lookup.check(VIN, freshSession().session),
      lookup.check(OTHER_VIN, other.session),
    ]);
    await lookup.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    const official = sessionWith({
      [cardUrl(FIRST)]: card(),
      [cardUrl(SECOND)]: card(SECOND, { vin: OTHER_VIN }),
    });
    const results = await Promise.all([
      restarted.check(VIN, official.session),
      restarted.check(OTHER_VIN, official.session),
    ]);
    expect(results.map((result) => ({ vin: result?.vin, partial: result?.partial }))).toEqual([
      { vin: VIN, partial: true },
      { vin: OTHER_VIN, partial: true },
    ]);
    expect(official.requested.sort()).toEqual([cardUrl(FIRST), cardUrl(SECOND)].sort());
    await restarted.close();
  });
  it("invalidates a wrong-VIN cached card and discovers a replacement in the same session", async () => {
    const lookup = new EncarHistoryLookup();
    await lookup.check(VIN, freshSession().session);
    const changed = sessionWith({
      [cardUrl(FIRST)]: card(FIRST, { vin: OTHER_VIN }),
      [DISCOVERY]: discovery([SECOND]),
      [cardUrl(SECOND)]: card(SECOND),
    });
    const result = await lookup.check(VIN, changed.session);
    expect(result?.listings.map(({ id }) => id)).toEqual([SECOND]);
    expect(changed.requested).toEqual([cardUrl(FIRST), DISCOVERY, cardUrl(SECOND)]);
    const cached = sessionWith({ [cardUrl(SECOND)]: card(SECOND) });
    expect((await lookup.check(VIN, cached.session))?.partial).toBe(true);
    expect(cached.requested).toEqual([cardUrl(SECOND)]);
  });

  it("retains confirmed IDs through an official transport outage", async () => {
    const path = await cachePath();
    const lookup = new EncarHistoryLookup({ cachePath: path });
    await lookup.check(VIN, freshSession().session);
    const outage = sessionWith({
      [cardUrl(FIRST)]: new VinRequestError("Official route unavailable"),
    });
    await expect(lookup.check(VIN, outage.session)).rejects.toBeInstanceOf(VinRequestError);
    await lookup.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    const recovered = sessionWith({ [cardUrl(FIRST)]: card(FIRST, { spec: { mileage: 275 } }) });
    expect((await restarted.check(VIN, recovered.session))?.listings[0]?.mileage_km).toBe(275);
    expect(recovered.requested).toEqual([cardUrl(FIRST)]);
    await restarted.close();
  });

  it("does not discard cached candidates skipped by a partial recheck", async () => {
    const path = await cachePath();
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const initial = sessionWith({
      [DISCOVERY]: discovery([FIRST, SECOND]),
      [cardUrl(FIRST)]: card(),
      [cardUrl(SECOND)]: card(SECOND),
    });
    await lookup.check(VIN, initial.session);
    const limited = sessionWith({ [cardUrl(FIRST)]: card() });
    limited.session.remainingMs = () => 16_999;
    expect((await lookup.check(VIN, limited.session))?.partial).toBe(true);
    await lookup.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    const complete = sessionWith({ [cardUrl(FIRST)]: card(), [cardUrl(SECOND)]: card(SECOND) });
    expect((await restarted.check(VIN, complete.session))?.listings.map(({ id }) => id)).toEqual([
      FIRST,
      SECOND,
    ]);
    await restarted.close();
  });

  it("does not let a valid-shaped poisoned entry bypass full official VIN confirmation", async () => {
    const path = await cachePath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [{ vin: VIN, ids: [FIRST], discoveredAt: Date.now() }],
      }),
    );
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const poisoned = sessionWith({
      [cardUrl(FIRST)]: card(FIRST, { vin: OTHER_VIN }),
      [DISCOVERY]: { body: "", status: 301 },
    });
    await expect(lookup.check(VIN, poisoned.session)).resolves.toBeNull();
    expect(JSON.parse(await readFile(path, "utf8")).entries).toEqual([]);
    await lookup.close();
  });

  it.each([
    { vin: VIN, ids: ["../../private"], discoveredAt: Date.now() },
    { vin: "../private", ids: [FIRST], discoveredAt: Date.now() },
    { vin: VIN, ids: [FIRST], discoveredAt: Number.MAX_SAFE_INTEGER },
    { vin: VIN, ids: [FIRST], discoveredAt: "2026-09-14" },
    { vin: VIN, ids: [FIRST], discoveredAt: Date.now(), html: "<secret>" },
  ])("rejects malformed persisted entries before candidate requests: %j", async (entry) => {
    const path = await cachePath();
    await writeFile(path, JSON.stringify({ version: 1, entries: [entry] }));
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const outage = sessionWith({ [DISCOVERY]: { body: "", status: 504 } });
    await expect(lookup.check(VIN, outage.session)).rejects.toBeInstanceOf(SourceError);
    expect(outage.requested).toEqual([DISCOVERY]);
    await lookup.close();
  });

  it("bounds input size and ignores oversized persisted contents", async () => {
    const path = await cachePath();
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const fresh = freshSession();
    expect((await lookup.check(VIN, fresh.session))?.partial).toBe(false);
    expect(fresh.requested[0]).toBe(DISCOVERY);
    await lookup.close();
  });

  it("expires discovery IDs without extending freshness after successful official rechecks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    const lookup = new EncarHistoryLookup({ ttlMs: 1000 });
    await lookup.check(VIN, freshSession().session);
    vi.setSystemTime(new Date("2026-09-14T00:00:00.999Z"));
    expect(
      (await lookup.check(VIN, sessionWith({ [cardUrl(FIRST)]: card() }).session))?.partial,
    ).toBe(true);
    vi.setSystemTime(new Date("2026-09-14T00:00:01Z"));
    const expired = sessionWith({
      [DISCOVERY]: { body: "", status: 504 },
      [cardUrl(FIRST)]: card(),
    });
    await expect(lookup.check(VIN, expired.session)).rejects.toBeInstanceOf(SourceError);
    expect(expired.requested).toEqual([DISCOVERY]);
  });

  it("discards expired entries on restart", async () => {
    const path = await cachePath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [{ vin: VIN, ids: [FIRST], discoveredAt: Date.now() - 24 * 60 * 60 * 1000 }],
      }),
    );
    const lookup = new EncarHistoryLookup({ cachePath: path });
    const fresh = freshSession();
    expect((await lookup.check(VIN, fresh.session))?.partial).toBe(false);
    expect(fresh.requested[0]).toBe(DISCOVERY);
    await lookup.close();
  });

  it("evicts old VIN entries when the configured bound is reached", async () => {
    const lookup = new EncarHistoryLookup({ maxEntries: 1 });
    await lookup.check(VIN, freshSession().session);
    const other = sessionWith({
      [`https://carcheck.by/auto/${OTHER_VIN}`]: discovery([SECOND], OTHER_VIN),
      [cardUrl(SECOND)]: card(SECOND, { vin: OTHER_VIN }),
    });
    await lookup.check(OTHER_VIN, other.session);
    const evicted = sessionWith({ [DISCOVERY]: { body: "", status: 504 } });
    await expect(lookup.check(VIN, evicted.session)).rejects.toBeInstanceOf(SourceError);
    expect(evicted.requested).toEqual([DISCOVERY]);
  });

  it.each([
    { [DISCOVERY]: { body: "", status: 301 } },
    { [DISCOVERY]: { body: "", status: 504 } },
    { [DISCOVERY]: discovery(), [cardUrl(FIRST)]: card(FIRST, { vin: null }) },
  ])("never caches absence or failed confirmation", async (replies) => {
    const lookup = new EncarHistoryLookup();
    await lookup.check(VIN, sessionWith(replies).session).catch(() => undefined);
    const fresh = freshSession();
    expect((await lookup.check(VIN, fresh.session))?.listings.map(({ id }) => id)).toEqual([FIRST]);
    expect(fresh.requested[0]).toBe(DISCOVERY);
  });

  it.each(["AbortError", "TimeoutError"])(
    "propagates %s without discovery fallback or cache invalidation",
    async (name) => {
      const lookup = new EncarHistoryLookup();
      await lookup.check(VIN, freshSession().session);
      const cancellation = new DOMException("Cancelled", name);
      const cancelled = sessionWith({ [cardUrl(FIRST)]: cancellation });
      await expect(lookup.check(VIN, cancelled.session)).rejects.toBe(cancellation);
      expect(cancelled.requested).toEqual([cardUrl(FIRST)]);
      const resumed = sessionWith({ [cardUrl(FIRST)]: card() });
      expect((await lookup.check(VIN, resumed.session))?.partial).toBe(true);
    },
  );

  it.each(["<html><title>Temporarily unavailable</title></html>", card(FIRST, { vin: null })])(
    "does not turn unavailable official evidence into an absent archive",
    async (body) => {
      const lookup = new EncarHistoryLookup();
      await lookup.check(VIN, freshSession().session);
      const unavailable = sessionWith({
        [cardUrl(FIRST)]: body,
        [DISCOVERY]: { body: "", status: 301 },
      });
      await expect(lookup.check(VIN, unavailable.session)).rejects.toBeInstanceOf(SourceError);
      const recovered = sessionWith({ [cardUrl(FIRST)]: card() });
      expect((await lookup.check(VIN, recovered.session))?.listings[0]?.id).toBe(FIRST);
      expect(recovered.requested).toEqual([cardUrl(FIRST)]);
    },
  );

  it("resumes persistent writes after a temporary filesystem failure", async () => {
    const path = await cachePath();
    const lookup = new EncarHistoryLookup({ cachePath: path });
    await lookup.initialize();
    await rm(path);
    await mkdir(path);
    await expect(lookup.check(VIN, freshSession().session)).rejects.toBeInstanceOf(SourceError);
    await rmdir(path);
    const other = sessionWith({
      [`https://carcheck.by/auto/${OTHER_VIN}`]: discovery([SECOND], OTHER_VIN),
      [cardUrl(SECOND)]: card(SECOND, { vin: OTHER_VIN }),
    });
    expect((await lookup.check(OTHER_VIN, other.session))?.listings[0]?.id).toBe(SECOND);
    await lookup.close();
    const restarted = new EncarHistoryLookup({ cachePath: path });
    const official = sessionWith({
      [cardUrl(FIRST)]: card(),
      [cardUrl(SECOND)]: card(SECOND, { vin: OTHER_VIN }),
    });
    expect((await restarted.check(VIN, official.session))?.listings[0]?.id).toBe(FIRST);
    expect((await restarted.check(OTHER_VIN, official.session))?.listings[0]?.id).toBe(SECOND);
    await restarted.close();
  });

  it("rejects symlink storage without reading or overwriting its target", async () => {
    const path = await cachePath();
    const target = `${path}.target`;
    await writeFile(target, "private target");
    await symlink(target, path);
    const lookup = new EncarHistoryLookup({ cachePath: path });
    await expect(lookup.initialize()).rejects.toBeInstanceOf(SourceError);
    expect(await readFile(target, "utf8")).toBe("private target");
  });

  it("reports sanitized storage initialization failure instead of pretending persistence works", async () => {
    const path = await cachePath();
    await writeFile(path, "not a directory");
    const lookup = new EncarHistoryLookup({ cachePath: join(path, "private-cache.json") });
    const error = await lookup.initialize().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SourceError);
    expect(String(error)).not.toContain(path);
    const fresh = freshSession();
    await expect(lookup.check(VIN, fresh.session)).rejects.toBe(error);
    expect(fresh.requested).toEqual([]);
  });
});
