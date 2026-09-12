import { expect, it } from "vitest";
import { parseFlatJson, RequestError } from "../src/http-body.js";

it("rejects a second amount even when its member name uses Unicode escaping", () => {
  expect(() => parseFlatJson(String.raw`{"amount":49900,"amou\u006et":100}`)).toThrow(RequestError);
});

it("preserves quoted apparent members inside ordinary dialogue text", () => {
  const text = 'Toyota, "amount": 100, \\ price and {"orderId":"not-an-order"}';
  expect(parseFlatJson(JSON.stringify({ text })).text).toBe(text);
});

it("rejects nested values rather than letting them supply payment fields", () => {
  expect(() => parseFlatJson('{"orderId":{"userId":42},"acceptTerms":true}')).toThrow(RequestError);
});

it("rejects non-finite amounts produced by valid JSON exponent notation", () => {
  expect(() => parseFlatJson('{"amount":1e999}')).toThrow(RequestError);
});
