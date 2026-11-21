import { describe, expect, it } from "vitest";
import { ownerMoney } from "../src/owner-vehicle.js";

describe("owner money", () => {
  it("uses USD and som labels", () => {
    expect(ownerMoney(2_000_000, "USD").replace(/\u00a0/gu, " ")).toBe("20 000 USD");
    expect(ownerMoney(130_000_000, "KGS").replace(/\u00a0/gu, " ")).toBe("1 300 000 сом");
    expect(ownerMoney(null, null)).toBe("не указано");
  });
});
