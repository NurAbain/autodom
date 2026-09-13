import { describe, expect, it } from "vitest";
import { catalogFilterSchema, emptyCatalogFilter } from "../src/catalog-filter.js";

describe("catalog filter validation", () => {
  it("rejects unscoped vehicles and malformed or unbounded criteria before persistence", () => {
    const choice = { id: "lookup", value: "Camry", label: "Camry" };
    for (const changed of [
      { vehicles: [{ model: choice }] },
      { vehicles: [{ make: choice, modification: choice }] },
      { vehicles: Array.from({ length: 6 }, () => ({ make: choice })) },
      { options: { untrusted_key: [choice] } },
      { options: { gearbox: [{ ...choice, value: "x".repeat(257) }] } },
      { ranges: { engine_volume: { min: 3, max: 2 } } },
      { ranges: { mileage: { min: "100", max: null } } },
      { ranges: { year: { min: 2020.5, max: null } } },
      { ranges: { engine_volume: { min: Number.NaN, max: null } } },
      { below_market_percent: 12 },
    ])
      expect(catalogFilterSchema.safeParse({ ...emptyCatalogFilter(), ...changed }).success).toBe(
        false,
      );
  });
});
