import { configuredVinProviders, normalizeVin } from "@autodom/core";
import { describe, expect, it } from "vitest";

describe("VIN input and provider opt-in", () => {
  it("normalizes ASCII case without imposing a Korean WMI or North American checksum", () => {
    expect(normalizeVin("  kmfxkn7bpxu258800  ")).toBe("KMFXKN7BPXU258800");
    expect(normalizeVin("WBA3A5C50DF358002")).toBe("WBA3A5C50DF358002");
  });

  it("rejects Unicode case expansions rather than inventing a different VIN", () => {
    expect(normalizeVin("KMFXKN7BPXU2588ß")).toBeNull();
    expect(normalizeVin("KMFXKN7BPXU2588ſ0")).toBeNull();
  });

  it("refuses unknown or repeated provider opt-ins instead of silently enabling a different source", () => {
    expect(() => configuredVinProviders({ AUTODOM_VIN_PROVIDERS: "carhistory,typo" })).toThrow();
    expect(() => configuredVinProviders({ AUTODOM_VIN_PROVIDERS: "car365,car365" })).toThrow();
  });
});
