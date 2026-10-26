import { describe, expect, it } from "vitest";
import { catalogChoicesSchema } from "../src/catalog-filter.js";

describe("catalogue lookup choices", () => {
  it("keeps the identifier, the canonical value and the label", () => {
    expect(catalogChoicesSchema.parse([{ id: "12", value: "Camry", label: "Camry" }])).toEqual([
      { id: "12", value: "Camry", label: "Camry" },
    ]);
  });

  it("rejects choices the catalogue cannot identify", () => {
    const bell = String.fromCharCode(7);
    for (const changed of [
      { id: "", value: "Camry", label: "Camry" },
      { id: "12", value: "   ", label: "Camry" },
      { id: "12", value: `Cam${bell}ry`, label: "Camry" },
      { id: "12", value: "Camry", label: `Camry${bell}` },
      { id: "x".repeat(129), value: "Camry", label: "Camry" },
      { id: "12", value: "x".repeat(257), label: "Camry" },
      { id: "12", value: "Camry" },
      { id: "12", value: "Camry", label: "Camry", extra: true },
    ])
      expect(catalogChoicesSchema.safeParse([changed]).success).toBe(false);
  });

  it("keeps an empty catalogue valid", () => {
    expect(catalogChoicesSchema.parse([])).toEqual([]);
  });
});
