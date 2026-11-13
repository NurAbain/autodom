import { type ListingEvent, makeListing, makeProfile, type Profile } from "@autodom/core";
import type { FavoriteState } from "@autodom/storage";
import { HttpError } from "grammy";
import { afterEach, expect, it, vi } from "vitest";
import { type MonitorStore, notifyOnce, quietNow } from "../src/monitor.js";

const NOW = 1_800_000_000;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function state() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  let profile: Profile | null = makeProfile({
    user_id: 1,
    chat_id: 1,
    currency: "USD",
    budget_min_minor: 0,
    budget_max_minor: 2_000_000,
    monitoring: true,
    revision: "9007199254740993",
  });
  let listing = makeListing({
    id: "mashina:1",
    title: "Toyota Camry",
    url: "https://mashina.kg/details/toyota",
    price_usd_minor: 1_500_000,
    availability: "В наличии",
  });
  const events: ListingEvent[] = [
    {
      id: 1,
      listing,
      kind: "new",
      previous_usd_minor: null,
      previous_kgs_minor: null,
      previous_original_price_minor: null,
      previous_original_currency: "",
    },
  ];
  const metadata: Record<string, string> = {};
  let favorite: FavoriteState = { cursor: 0, items: [] };
  const store: MonitorStore = {
    async withLock(_key, operation) {
      return operation();
    },
    async monitoringProfiles() {
      return profile?.monitoring ? [profile] : [];
    },
    async getProfile() {
      return profile;
    },
    async eventsAfter(cursor) {
      return events.filter((event) => event.id > cursor);
    },
    async getListing() {
      return listing;
    },
    async getMeta(key, fallback = null) {
      return metadata[key] ?? fallback;
    },
    async estimatePrice() {
      return {
        currency: "USD",
        medianMinor: 2_000_000,
        lowMinor: 1_800_000,
        highMinor: 2_200_000,
        sampleSize: 6,
        observedAt: NOW,
      };
    },
    async favoriteProfiles() {
      return profile && favorite.items.length ? [profile] : [];
    },
    async favoriteState() {
      return structuredClone(favorite);
    },
    async saveFavoriteState(_userId, value) {
      favorite = structuredClone(value);
    },
    async favoriteListings() {
      return favorite.items.map((item) => ({
        id: item.id,
        listing: item.id === listing.id ? listing : null,
      }));
    },
    async advanceCursor(_userId, eventId, revision) {
      if (!profile || profile.revision !== revision) return false;
      profile = { ...profile, cursor: eventId };
      return true;
    },
    async setMonitoring(_id, enabled) {
      if (profile) profile = { ...profile, monitoring: enabled };
      return profile;
    },
    async setMeta(key, value) {
      metadata[key] = value;
    },
  };
  return {
    store,
    events,
    metadata,
    profile: () => profile,
    current: () => listing,
    replaceListing(value: typeof listing) {
      listing = value;
    },
  };
}

it("delivers the latest new match once and preserves its exact revision cursor", async () => {
  const fixture = state();
  const changed = makeListing({ ...fixture.current(), price_usd_minor: 1_600_000 });
  fixture.replaceListing(changed);
  fixture.events.push({
    id: 2,
    listing: changed,
    kind: "price_changed",
    previous_usd_minor: 1_500_000,
    previous_kgs_minor: null,
    previous_original_price_minor: null,
    previous_original_currency: "",
  });
  const send = vi.fn(async () => undefined);
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(send.mock.calls.length).toBe(1);
  expect(fixture.profile()?.cursor).toBe(2);
  expect(await notifyOnce(fixture.store, send)).toBe(0);
});

it("sends buyout matches only when the observed price is at least 15% below the reference", async () => {
  const fixture = state();
  fixture.metadata["autodom:buyout:1"] = "1";
  const send = vi.fn(async () => undefined);
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(JSON.stringify(send.mock.calls)).toContain("ниже рынка");
  expect(JSON.stringify(send.mock.calls)).toContain("6 аналогов");
  const expensive = state();
  expensive.metadata["autodom:buyout:1"] = "1";
  const listing = makeListing({ ...expensive.current(), price_usd_minor: 1_800_000 });
  expensive.replaceListing(listing);
  expensive.events[0]!.listing = listing;
  expect(
    await notifyOnce(expensive.store, async () => {
      throw new Error("Not below threshold");
    }),
  ).toBe(0);
});

it("watches saved cars independently of the search and retries undelivered changes", async () => {
  const fixture = state();
  await fixture.store.setMonitoring(1, false);
  const fresh = makeListing({ ...fixture.current(), observed_at: NOW });
  fixture.replaceListing(fresh);
  fixture.events[0] = {
    ...fixture.events[0]!,
    listing: fresh,
    kind: "price_change",
    previous_usd_minor: 2_000_000,
  };
  await fixture.store.saveFavoriteState(1, {
    cursor: 0,
    items: [{ id: fresh.id, addedEvent: 0, staleNotified: false }],
  });
  expect(
    await notifyOnce(fixture.store, async () => {
      throw new HttpError("offline", new Error("unreachable"));
    }),
  ).toBe(0);
  expect((await fixture.store.favoriteState(1)).cursor).toBe(0);
  const send = vi.fn(async () => undefined);
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(JSON.stringify(send.mock.calls)).toContain("снизилась");
  expect((await fixture.store.favoriteState(1)).cursor).toBe(1);
  fixture.replaceListing(makeListing({ ...fresh, observed_at: NOW - 49 * 3600 }));
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(JSON.stringify(send.mock.calls)).toContain("давно не наблюдались");
  expect(await notifyOnce(fixture.store, send)).toBe(0);
});

it("does not describe an older saved-car price change as a current decrease", async () => {
  const fixture = state();
  await fixture.store.setMonitoring(1, false);
  const earlier = makeListing({ ...fixture.current(), observed_at: NOW });
  fixture.events[0] = {
    ...fixture.events[0]!,
    listing: earlier,
    kind: "price_change",
    previous_usd_minor: 2_000_000,
  };
  fixture.replaceListing(makeListing({ ...earlier, price_usd_minor: 1_800_000 }));
  await fixture.store.saveFavoriteState(1, {
    cursor: 0,
    items: [{ id: earlier.id, addedEvent: 0, staleNotified: false }],
  });
  const send = vi.fn(async () => undefined);
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(JSON.stringify(send.mock.calls)).toContain("изменилась");
  expect(JSON.stringify(send.mock.calls)).not.toContain("снизилась");
});

it("notifies when a saved car first receives a price", async () => {
  const fixture = state();
  await fixture.store.setMonitoring(1, false);
  const priced = makeListing({ ...fixture.current(), observed_at: NOW });
  fixture.replaceListing(priced);
  fixture.events[0] = { ...fixture.events[0]!, id: 2, listing: priced, kind: "new" };
  await fixture.store.saveFavoriteState(1, {
    cursor: 1,
    items: [{ id: priced.id, addedEvent: 1, staleNotified: false }],
  });
  const send = vi.fn(async () => undefined);
  expect(await notifyOnce(fixture.store, send)).toBe(1);
  expect(JSON.stringify(send.mock.calls)).toContain("Цена избранного автомобиля изменилась");
});

it("retains events after a Telegram network failure and honors pause", async () => {
  const fixture = state();
  expect(
    await notifyOnce(fixture.store, async () => {
      throw new HttpError("offline", new Error("unreachable"));
    }),
  ).toBe(0);
  expect(fixture.profile()?.cursor).toBe(0);
  expect(fixture.metadata.telegram_error).toBe("network_error");
  await fixture.store.setMonitoring(1, false);
  expect(
    await notifyOnce(fixture.store, async () => {
      throw new Error("Paused search was delivered");
    }),
  ).toBe(0);
});

it("does not deliver an event after the current listing changes price kind", async () => {
  const fixture = state();
  fixture.replaceListing(makeListing({ ...fixture.current(), price_kind: "estimate" }));
  expect(
    await notifyOnce(fixture.store, async () => {
      throw new Error("Estimate was delivered");
    }),
  ).toBe(0);
  expect(fixture.profile()?.cursor).toBe(1);
});

it("preserves an existing search until its owner starts the new bot", async () => {
  const fixture = state();
  const send = vi.fn(async () => undefined);
  let startedNewBot = false;
  const canNotify = async () => startedNewBot;
  expect(await notifyOnce(fixture.store, send, undefined, undefined, canNotify)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(fixture.profile()?.monitoring).toBe(true);
  expect(fixture.profile()?.cursor).toBe(0);
  startedNewBot = true;
  expect(await notifyOnce(fixture.store, send, undefined, undefined, canNotify)).toBe(1);
  expect(fixture.profile()?.cursor).toBe(1);
});

it.each([
  [16, 59, false],
  [17, 0, true],
  [1, 59, true],
  [2, 0, false],
] as const)("honors Bishkek quiet-hour boundary %i:%i", (hour, minute, expected) => {
  const profile = makeProfile({
    user_id: 1,
    chat_id: 1,
    currency: "USD",
    budget_min_minor: 0,
    budget_max_minor: 100,
    quiet_start_minute: 23 * 60,
    quiet_end_minute: 8 * 60,
  });
  expect(quietNow(profile, new Date(Date.UTC(2026, 8, 9, hour, minute)))).toBe(expected);
});
