import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { validateMiniAppData } from "../src/miniapp-auth.js";

const TOKEN = "12345:miniapp-auth-fixture";
const NOW = 2_000_000_000;
function signed(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  params.sort();
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set(
    "hash",
    createHmac("sha256", secret)
      .update([...params].map(([key, value]) => `${key}=${value}`).join("\n"))
      .digest("hex"),
  );
  return params.toString();
}
const identity = {
  user: JSON.stringify({ id: 1234567890123, first_name: "Алёна + Али", is_bot: false }),
  auth_date: String(NOW),
  query_id: "AAE+query/with=encoding",
  signature: "Telegram-third-party-signature",
};

it("authenticates decoded fields including Telegram's signature and rejects identity or token tampering", () => {
  expect(validateMiniAppData(signed(identity), TOKEN, NOW)).toEqual({
    id: 1234567890123,
    firstName: "Алёна + Али",
  });
  const tampered = new URLSearchParams(signed(identity));
  tampered.set("user", JSON.stringify({ id: 999, first_name: "Другой" }));
  expect(validateMiniAppData(tampered.toString(), TOKEN, NOW)).toBeNull();
  expect(validateMiniAppData(signed(identity), "other:bot-token", NOW)).toBeNull();
  tampered.set("signature", "replaced");
  tampered.set("user", identity.user);
  expect(validateMiniAppData(tampered.toString(), TOKEN, NOW)).toBeNull();
});

it("rejects ambiguous duplicate fields even with a valid signature", () => {
  const data = signed(identity);
  expect(validateMiniAppData(`${data}&user=%7B%22id%22%3A999%7D`, TOKEN, NOW)).toBeNull();
  expect(validateMiniAppData(`${data}&auth_date=${NOW}`, TOKEN, NOW)).toBeNull();
  const hash = new URLSearchParams(data).get("hash");
  expect(validateMiniAppData(`${data}&hash=${hash}`, TOKEN, NOW)).toBeNull();
});

it("bounds bearer replay lifetime and future clock skew inclusively", () => {
  const data = signed(identity);
  expect(validateMiniAppData(data, TOKEN, NOW + 3600)?.id).toBe(1234567890123);
  expect(validateMiniAppData(data, TOKEN, NOW + 3601)).toBeNull();
  expect(validateMiniAppData(data, TOKEN, NOW - 30)?.id).toBe(1234567890123);
  expect(validateMiniAppData(data, TOKEN, NOW - 31)).toBeNull();
});

it("rejects signed non-user identities, unsafe numeric IDs and malformed JSON", () => {
  for (const user of [
    "null",
    "{broken",
    JSON.stringify({ id: -1, first_name: "Name" }),
    JSON.stringify({ id: "123", first_name: "Name" }),
    JSON.stringify({ id: Number.MAX_SAFE_INTEGER + 1, first_name: "Name" }),
    JSON.stringify({ id: 123, first_name: "Bot", is_bot: true }),
  ]) {
    expect(validateMiniAppData(signed({ ...identity, user }), TOKEN, NOW)).toBeNull();
  }
});
