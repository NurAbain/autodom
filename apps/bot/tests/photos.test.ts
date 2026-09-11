import { makeListing } from "@autodom/core";
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import type { Reply } from "../src/conversation.js";
import { listingPhotoUrl } from "../src/media.js";
import { sendReplies } from "../src/telegram.js";

const listingIdentity = { id: "one", title: "Toyota", url: "https://mashina.kg/details/one" };

const photoUrl = "https://im.mashina.kg/one.jpg";
const buttons: Reply["buttons"] = [[["Ещё варианты", "page:revision:5"]]];

function transport(rejection?: { code: number; description: string } | Error) {
  const bot = new Bot("100:test-token");
  const delivered: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendPhoto" && rejection) {
      if (rejection instanceof Error) throw rejection;
      return { ok: false, error_code: rejection.code, description: rejection.description } as never;
    }
    delivered.push({ method, payload: payload as unknown as Record<string, unknown> });
    return { ok: true, result: { message_id: delivered.length } } as never;
  });
  return { bot, delivered };
}

describe("source photo safety", () => {
  it("allows only exact source-specific public HTTPS CDN authorities", () => {
    for (const [source, host] of [
      ["mashina.kg", "im.mashina.kg"],
      ["mashina.kg", "pictures.mashina.kg"],
      ["mashina.kg", "storage.mashina.kg"],
      ["mashina.kg", "s3.mashina.kg"],
      ["encar.com", "ci.encar.com"],
      ["bid.cars", "images.bid.cars"],
      ["bid.cars", "mercury.bid.cars"],
      ["bid.cars", "pluto.bid.car"],
      ["truecar.com", "listings-prod.tcimg.net"],
    ] as const) {
      const url = `https://${host}/car.jpg`;
      expect(listingPhotoUrl(makeListing({ ...listingIdentity, source, photo_url: url }))).toBe(
        url,
      );
    }
    for (const url of [
      "http://im.mashina.kg/car.jpg",
      "https://im.mashina.kg:443/car.jpg",
      "https://im.mashina.kg:8443/car.jpg",
      "https://user:secret@im.mashina.kg/car.jpg",
      "https://im.mashina.kg@127.0.0.1/car.jpg",
      "https://im.mashina.kg.evil.test/car.jpg",
      "https://im.mashina.kg./car.jpg",
      "https://%69m.mashina.kg/car.jpg",
      "https://127.1/car.jpg",
      "https://[::1]/car.jpg",
      "https://im.mashina.kg\\@127.0.0.1/car.jpg",
      "https://im.mashina.kg\n/car.jpg",
      "https://ci.encar.com/car.jpg",
      "https://im.mashina.kg/car.jpg#fragment",
    ])
      expect(listingPhotoUrl(makeListing({ ...listingIdentity, photo_url: url }))).toBeNull();
    expect(
      listingPhotoUrl(
        makeListing({ ...listingIdentity, source: "__proto__", photo_url: photoUrl }),
      ),
    ).toBeNull();
    expect(listingPhotoUrl(makeListing(listingIdentity))).toBeNull();
  });
});

describe("Telegram photo delivery", () => {
  it("uses an HTML caption at the exact parsed boundary and retains paging plus the primary app entry", async () => {
    const { bot, delivered } = transport();
    const text = `<b>${"&amp;".repeat(1024)}</b>`;
    await sendReplies(bot, 1, [{ text, buttons, photoUrl }], "https://app.example/miniapp/");
    expect(delivered.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(delivered[0]?.payload.caption).toBe(text);
    expect(delivered[0]?.payload.parse_mode).toBe("HTML");
    expect(delivered[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [
        [{ callback_data: "page:revision:5" }],
        [{ web_app: { url: "https://app.example/miniapp/" }, style: "primary" }],
      ],
    });
  });

  it("moves a caption one character above the limit intact after its photo", async () => {
    const { bot, delivered } = transport();
    const text = `<b>${"я".repeat(1025)}</b>`;
    await sendReplies(bot, 1, [{ text, buttons, photoUrl }]);
    expect(delivered.map((call) => call.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(delivered[0]?.payload.caption).toBeUndefined();
    expect(delivered[0]?.payload.reply_markup).toBeUndefined();
    expect(delivered[1]?.payload.text).toBe(text);
    expect(delivered[1]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:revision:5" }]],
    });
  });

  it("keeps every character of oversized HTML and places actions only on its last text message", async () => {
    const { bot, delivered } = transport();
    const content = "Детали &amp; условия ".repeat(600);
    await sendReplies(bot, 1, [{ text: `<b>${content}</b>`, buttons, photoUrl }]);
    expect(delivered[0]?.method).toBe("sendPhoto");
    expect(delivered[0]?.payload.caption).toBeUndefined();
    const messages = delivered.slice(1);
    expect(messages.every((call) => call.method === "sendMessage")).toBe(true);
    expect(messages.map((call) => String(call.payload.text).replace(/<\/?b>/g, "")).join("")).toBe(
      content,
    );
    for (const { payload } of messages) {
      const text = String(payload.text);
      expect(text.length).toBeLessThanOrEqual(3800);
      expect(text).toMatch(/^<b>.*<\/b>$/s);
      expect(text.replaceAll("&amp;", "")).not.toContain("&");
    }
    expect(delivered.slice(0, -1).every((call) => call.payload.reply_markup === undefined)).toBe(
      true,
    );
    expect(delivered.at(-1)?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:revision:5" }]],
    });
  });

  it("explains explicit media rejection without losing listing details or navigation", async () => {
    const { bot, delivered } = transport({
      code: 400,
      description: "Bad Request: failed to get HTTP URL content",
    });
    const text =
      "<b>Toyota Camry</b>\nЦена объявления: 12 000 USD. Цену и наличие подтвердите у продавца.";
    await sendReplies(bot, 1, [{ text, buttons, photoUrl }]);
    expect(delivered.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(delivered[0]?.payload.text).toContain(text);
    expect(delivered[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:revision:5" }]],
    });
  });

  it.each([
    { code: 429, description: "Too Many Requests: retry after 12" },
    { code: 403, description: "Forbidden: bot was blocked by the user" },
    { code: 400, description: "Bad Request: can't parse entities" },
    new Error("Request timed out"),
    new Error("ECONNRESET"),
  ])(
    "propagates non-media delivery failure %s without sending a duplicate text fallback",
    async (error) => {
      const { bot, delivered } = transport(error);
      await expect(
        sendReplies(bot, 1, [{ text: "<b>Toyota</b>", buttons, photoUrl }]),
      ).rejects.toThrow();
      expect(delivered).toEqual([]);
    },
  );
});
