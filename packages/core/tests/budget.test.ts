import { describe, expect, it } from "vitest";
import { money, parseBudget } from "../src/budget.js";

describe("budget input", () => {
  it.each([
    ["15\u00a0000", [0, 1500000]],
    ["10к–15,25к", [1000000, 1525000]],
    ["0 — 0.01", [0, 1]],
    ["1.25-1.25", [125, 125]],
    ["1 000 000", [0, 100000000]],
  ])("preserves inclusive minor-unit range %s", (text, expected) => {
    expect(parseBudget(text as string)).toEqual(expected);
  });
  it.each([
    "",
    "0",
    "-100",
    "200-100",
    "100-200-300",
    "NaN",
    "1e6",
    "15000 USD",
    "1.001",
    "1,000,000",
    "100000000001",
    "9".repeat(81),
  ])("rejects ambiguous or invalid input %s", (text) => {
    expect(() => parseBudget(text)).toThrow();
  });
  it("keeps fractional money and whole won", () => {
    expect(money(123456, "USD")).toBe("1 234,56 $");
    expect(money(123456, "KGS")).toBe("1 234,56 сом");
    expect(money(123456, "KRW")).toBe("123 456 KRW");
    expect(money(123456, "AED")).toBe("1 234,56 AED");
    expect(money(1, "AED")).toBe("0,01 AED");
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow();
  });
});
