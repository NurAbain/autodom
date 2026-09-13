import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { matches, normalizeMileageKm, queryGroups } from "../src/matching.js";
import { makeListing, makeProfile } from "../src/models.js";
import { normalize } from "../src/normalization.js";

const profile = makeProfile({
  user_id: 1,
  chat_id: 1,
  currency: "USD",
  budget_min_minor: 100,
  budget_max_minor: 200,
});
const car = makeListing({
  id: "1",
  title: "Toyota Camry",
  url: "https://mashina.kg/1",
  price_usd_minor: 100,
  price_kgs_minor: 9000,
  availability: "В наличии",
});
beforeEach(() => vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg"));
afterEach(() => vi.unstubAllEnvs());

it("uses whole-word aliases and AND within OR alternatives", () => {
  const selected = { ...profile, query: "тойота камри, хёндай" };
  expect(matches(selected, car)).toBe(true);
  expect(matches(selected, { ...car, title: "Hyundai Sonata" })).toBe(true);
  expect(matches(selected, { ...car, title: "Toyota Corolla" })).toBe(false);
  expect(matches(selected, { ...car, title: "NotHyundai Sonata" })).toBe(false);
  expect(normalize("ХЁНДАЙ")).toBe(normalize("Hyundai"));
  expect(queryGroups("тойота камри, хонда")).toEqual([["toyota", "camry"], ["honda"]]);
});

it("does not interpret empty alternatives or punctuation as match-all", () => {
  for (const query of ["тойота,,", " , ", "!!!"])
    expect(matches({ ...profile, query }, { ...car, title: "Honda Fit" })).toBe(false);
  expect(matches({ ...profile, query: " \t " }, car)).toBe(true);
});

it.each<[string, number, boolean]>([
  ["", 0, false],
  ["0", 0, false],
  ["0 km", 0, true],
  ["0.000001 km", 0, false],
  ["1,000 miles", 1609, false],
  ["1,000 miles", 1610, true],
  ["15,625 miles", 25146, true],
  ["15625.000000000000001 miles", 25146, false],
  ["100 km / 62 miles", 100, false],
])("requires explicit mileage units and rounds upward: %s", (mileage, maximum, expected) => {
  expect(matches({ ...profile, mileage_max_km: maximum }, { ...car, mileage })).toBe(expected);
});

it("requires exact known hard fields but does not filter advisory preferences", () => {
  const selected = {
    ...profile,
    city: " Бишкек ",
    body_type: "sedan",
    transmission: "automatic",
    year_min: 2020,
    use_case: "work",
    purchase_by: "2000-01-01",
  };
  const listing = {
    ...car,
    city: "БИШКЕК",
    body_type: "Седан",
    transmission: "8-Speed Automatic",
    year: 2020,
  };
  expect(matches(selected, listing)).toBe(true);
  for (const changes of [
    { city: "Бишкек район" },
    { body_type: "중형차" },
    { transmission: "Automatic / Manual" },
    { year: null },
    { year: 2019 },
  ])
    expect(matches(selected, { ...listing, ...changes })).toBe(false);
  expect(normalizeMileageKm("999999999999999999999999 km")).toBeNull();
});

it("gates all-market searches by operator permissions and excludes foreign total budgets", () => {
  const foreign = {
    ...car,
    source: "truecar.com",
    market: "US",
    original_currency: "USD",
    availability: "Опубликовано",
  };
  const all = { ...profile, market: "ALL" };
  expect(matches(all, foreign)).toBe(false);
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,truecar.com");
  expect(matches(all, foreign)).toBe(true);
  expect(matches({ ...all, allow_import: false }, foreign)).toBe(false);
  expect(matches({ ...all, budget_scope: "total" }, foreign)).toBe(false);
  expect(matches({ ...all, budget_scope: "total", allow_import: false }, car)).toBe(true);
});
