import { configuredVinProviders, normalizeVin, vinGoogleSearchUrl } from "@autodom/core";
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

  it("searches the whole normalized VIN as one exact phrase without market restrictions", () => {
    const url = new URL(vinGoogleSearchUrl("  wvwzzz1jzxw000001  ") ?? "");
    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/search");
    expect([...url.searchParams]).toEqual([["q", '"WVWZZZ1JZXW000001"']]);
    expect(vinGoogleSearchUrl("KMFXKN7BPXU258800")).toBe(
      "https://www.google.com/search?q=%22KMFXKN7BPXU258800%22",
    );
  });

  it("does not create a search link for partial VINs or injected search operators", () => {
    expect(vinGoogleSearchUrl("KMFXKN7BPXU2588")).toBeNull();
    expect(vinGoogleSearchUrl('KMFXKN7BPXU258800" OR site:example.com')).toBeNull();
  });

  it("refuses unknown or repeated provider opt-ins instead of silently enabling a different source", () => {
    expect(() => configuredVinProviders({ AUTODOM_VIN_PROVIDERS: "carhistory,typo" })).toThrow();
    expect(() => configuredVinProviders({ AUTODOM_VIN_PROVIDERS: "car365,car365" })).toThrow();
  });
});
