import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPriceDrop,
  type ListingEvent,
  listingIsAuction,
  listingPrice,
  makeListing,
  makeProfile,
  makeSourcePage,
  purchaseEligible,
} from "../src/models.js";

const NOW = 2_000_000_000;
const lot = () =>
  makeListing({
    id: "bidcars:1-66587646",
    title: "Alfa Romeo Stelvio",
    url: "https://bid.cars/en/lot/1-66587646/",
    price_usd_minor: 3_850_000,
    market: "US",
    source: "bid.cars",
    original_currency: "USD",
    original_price_minor: 3_850_000,
    price_kind: "buy_now",
    auction_house: "Copart",
    auction_status: "active",
    auction_at: NOW + 1,
    current_bid_minor: 45_000,
    buy_now_minor: 3_850_000,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

describe("JSON models", () => {
  it("retains unknown source data and price kinds while materializing historical defaults", () => {
    const listing = makeListing({
      id: "old",
      title: "Old car",
      url: "https://example.invalid",
      extra_source_data: { useful: true },
      price_kind: "unknown",
    });
    expect(listing.extra_source_data).toEqual({ useful: true });
    expect(listing.price_kind).toBe("unknown");
    expect(listingPrice(listing, "USD")).toBeNull();
    expect(listing.auction_at).toBeNull();
    expect(makeSourcePage({ listings: [listing] }).listings[0]).toEqual(listing);
    const profile = makeProfile({
      user_id: 1,
      chat_id: 2,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 200000,
      quiet_start_minute: 1380,
      quiet_end_minute: 420,
      use_case: "family",
      allow_import: false,
      purchase_by: "2026-12-01",
      custom: "preserved",
    });
    expect(profile).toMatchObject({
      quiet_start_minute: 1380,
      quiet_end_minute: 420,
      use_case: "family",
      allow_import: false,
      purchase_by: "2026-12-01",
      custom: "preserved",
    });
  });
  it("rejects money that cannot retain integer precision", () => {
    expect(() =>
      makeListing({
        id: "x",
        title: "x",
        url: "x",
        original_price_minor: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
    expect(() => makeListing({ id: "x", title: "x", url: "x", current_bid_minor: 0.5 })).toThrow();
  });
  it("retains legacy nanosecond revision tokens without number conversion", () => {
    const profile = makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 100,
      revision: "2000000000000000001",
    });
    expect(profile.revision).toBe("2000000000000000001");
    expect(makeProfile(JSON.parse(JSON.stringify(profile))).revision).toBe("2000000000000000001");
  });
});

describe("auction purchase eligibility", () => {
  it.each([
    { auction_status: "ended" },
    { auction_status: "unknown" },
    { auction_status: "" },
    { auction_at: null },
    { auction_at: NOW },
    { price_kind: "asking" },
    { price_kind: "auction" },
  ])("excludes unavailable offers %j", (changes) => {
    const listing = { ...lot(), ...changes };
    expect(listingIsAuction(listing)).toBe(true);
    expect(purchaseEligible(listing)).toBe(false);
    expect(listingPrice(listing, "USD")).toBeNull();
  });
  it("expires cached buy-now and pending native price drops at the exact deadline", () => {
    const listing = lot();
    const event: ListingEvent = {
      id: 1,
      listing,
      kind: "price_change",
      previous_original_currency: "USD",
      previous_original_price_minor: 4_000_000,
      previous_usd_minor: null,
      previous_kgs_minor: null,
    };
    expect(listingPrice(listing, "USD")).toBe(3_850_000);
    expect(isPriceDrop(event, "USD")).toBe(true);
    vi.setSystemTime((NOW + 1) * 1000);
    expect(listingPrice(listing, "USD")).toBeNull();
    expect(isPriceDrop(event, "USD")).toBe(false);
  });
  it("recognizes zero bids as auction evidence", () => {
    const listing = makeListing({
      id: "x",
      title: "x",
      url: "x",
      current_bid_minor: 0,
      price_usd_minor: 1,
    });
    expect(listingIsAuction(listing)).toBe(true);
    expect(listingPrice(listing, "USD")).toBeNull();
  });
});

it("preserves a pending native price drop through expired FX, without exposing stale converted prices", () => {
  const listing = makeListing({
    id: "encar:1",
    title: "Hyundai",
    url: "https://fem.encar.com/cars/detail/1",
    market: "KR",
    source: "encar.com",
    original_currency: "KRW",
    original_price_minor: 900000,
    price_usd_minor: 90000,
    fx_expires_at: NOW,
  });
  const event: ListingEvent = {
    id: 1,
    listing,
    kind: "price_change",
    previous_original_currency: "KRW",
    previous_original_price_minor: 1000000,
    previous_usd_minor: 100000,
    previous_kgs_minor: null,
  };
  expect(listingPrice(listing, "USD")).toBeNull();
  expect(isPriceDrop(event, "USD")).toBe(true);
  expect(
    isPriceDrop({ ...event, listing: { ...listing, original_price_minor: 1000000 } }, "USD"),
  ).toBe(false);
  const refreshed = { ...listing, price_usd_minor: 92000, fx_expires_at: NOW + 3600 };
  expect(isPriceDrop({ ...event, listing: refreshed }, "USD")).toBe(true);
  expect(listingPrice(refreshed, "USD")).toBe(92000);
  expect(listingPrice({ ...listing, original_currency: "USD" }, "USD")).toBe(90000);
});
