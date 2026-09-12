import { describe, expect, it } from "vitest";
import {
  finikPaymentId,
  parseFinikPaymentId,
  validatePaymentAmount,
  validatePaymentTimestamp,
} from "../src/payments.js";

describe("Finik merchant identity and exact monetary boundaries", () => {
  it("round trips only canonical lowercase merchant UUIDs", () => {
    const id = "fd5ab9a9-1bf0-4f23-9b3d-8f22353a40c5";
    expect(finikPaymentId(id)).toBe("ad_fd5ab9a91bf04f239b3d8f22353a40c5");
    expect(parseFinikPaymentId(finikPaymentId(id))).toBe(id);
    expect(parseFinikPaymentId("other_fd5ab9a91bf04f239b3d8f22353a40c5")).toBeNull();
    expect(parseFinikPaymentId(finikPaymentId(id).toUpperCase())).toBeNull();
    expect(() => finikPaymentId(id.toUpperCase())).toThrow();
  });
  it("rejects rounded and unsafe monetary input", () => {
    for (const amount of [
      0,
      -100,
      1.1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() => validatePaymentAmount(amount)).toThrow();
    expect(() => validatePaymentAmount(101, true)).toThrow();
  });
  it("rejects timezone ambiguity and calendar rollover", () => {
    expect(() => validatePaymentTimestamp("2026-02-30T12:00:00Z")).toThrow();
    expect(() => validatePaymentTimestamp("2026-09-12T12:00:00")).toThrow();
    expect(() => validatePaymentTimestamp("2026-09-12T24:00:00Z")).toThrow();
  });
});
