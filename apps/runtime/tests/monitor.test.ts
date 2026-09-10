import { type ListingEvent, makeListing, makeProfile, type Profile } from "@autodom/core";
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
