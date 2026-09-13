import { makeListing } from "@autodom/core";
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import type { Reply } from "../src/conversation.js";
import { listingPhotoUrls } from "../src/media.js";
import { sendReplies } from "../src/telegram.js";

const photo = "https://im.mashina.kg/one.jpg";
const secondPhoto = "https://im.mashina.kg/two.jpg";
const identity = { id: "car:one", title: "Toyota", url: "https://mashina.kg/details/one" };
const buttons: Reply["buttons"] = [[["Следующий автомобиль", "page:123:1"]]];
type Failure = { code: number; description: string } | Error;

function transport(failures: Record<string, Failure> = {}) {
  const bot = new Bot("100:test-token");
  const delivered: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    const failure = failures[method];
    if (failure instanceof Error) throw failure;
    if (failure) return { ok: false, error_code: failure.code, description: failure.description };
    delivered.push({ method, payload: payload as unknown as Record<string, unknown> });
    return { ok: true, result: { message_id: delivered.length } } as never;
  });
  return { bot, delivered };
}

function rendered(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<");
}

describe("source gallery safety", () => {
  it("keeps source-bound HTTPS photos in cover-first order, deduplicated and capped for Telegram", () => {
    const listing = makeListing({
      ...identity,
      photo_url: photo,
      photo_urls: [
        photo,
        "https://im.mashina.kg/unused/../two.jpg",
        secondPhoto,
        ...Array.from({ length: 15 }, (_, index) => `https://im.mashina.kg/${index}.jpg`),
      ],
    });
    expect(listingPhotoUrls(listing)).toEqual([
      photo,
      secondPhoto,
      ...Array.from({ length: 8 }, (_, index) => `https://im.mashina.kg/${index}.jpg`),
    ]);
  });

  it("rejects authority disguises and cross-source URLs, including an unsafe cover", () => {
    const unsafe = [
      "http://im.mashina.kg/one.jpg",
      "https://im.mashina.kg:443/one.jpg",
      "https://im.mashina.kg@evil.example/one.jpg",
      "https://user@im.mashina.kg/one.jpg",
      "https://im.mashina.kg.evil.example/one.jpg",
      "https://%69m.mashina.kg/one.jpg",
      "https://127.0.0.1/one.jpg",
      "https://im.mashina.kg/one.jpg#fragment",
      "https://im.mashina.kg/one\\.jpg",
      "https://im.mashina.kg/one\n.jpg",
      "https://ci.encar.com/one.jpg",
    ];
    expect(
      listingPhotoUrls(makeListing({ ...identity, photo_url: unsafe[0], photo_urls: unsafe })),
    ).toEqual([]);
    const recovered = makeListing({
      ...identity,
      photo_url: unsafe[0],
      photo_urls: [...unsafe, photo],
    });
    expect(listingPhotoUrls(recovered)).toEqual([photo]);
    expect(
      listingPhotoUrls(makeListing({ ...identity, source: "__proto__", photo_urls: [photo] })),
    ).toEqual([]);
  });

  it("accepts only the verified Lalafo CDN, never sibling hosts or cross-source photos", () => {
    const verified = "https://img5.lalafo.com/i/posters/original/one.jpg";
    const listing = makeListing({
      ...identity,
      source: "lalafo.kg",
      photo_url: verified,
      photo_urls: [
        "https://img4.lalafo.com/i/posters/one.jpg",
        "https://cdn.img5.lalafo.com/i/posters/one.jpg",
        "https://img5.lalafo.com.evil.example/i/posters/one.jpg",
        "http://img5.lalafo.com/i/posters/one.jpg",
        photo,
      ],
    });
    expect(listingPhotoUrls(listing)).toEqual([verified]);
    expect(listingPhotoUrls({ ...listing, source: "mashina.kg", photo_urls: [] })).toEqual([]);
  });
});

describe("Telegram listing delivery", () => {
  it("keeps exact-limit parsed captions and card controls on a single photo", async () => {
    const { bot, delivered } = transport();
    const text = `<b>${"&amp;".repeat(1024)}</b>`;
    await sendReplies(bot, 1, [{ text, buttons, photos: [photo], listingId: "car:one & two" }], {
      miniAppUrl: "https://cars.example/miniapp/",
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.method).toBe("sendPhoto");
    expect(delivered[0]?.payload.caption).toBe(text);
    expect(delivered[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [
        [{ callback_data: "page:123:1" }],
        [{ web_app: { url: "https://cars.example/miniapp/?car=car%3Aone%20%26%20two" } }],
      ],
    });
  });

  it("moves an over-limit caption after the photo without losing text or controls", async () => {
    const { bot, delivered } = transport();
    const text = `<b>${"x".repeat(1025)}</b>`;
    await sendReplies(bot, 1, [{ text, buttons, photos: [photo] }]);
    expect(delivered.map((item) => item.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(delivered[0]?.payload.caption).toBeUndefined();
    expect(delivered[1]?.payload.text).toBe(text);
    expect(delivered[1]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:123:1" }]],
    });
  });

  it("delivers an album before every character of a long HTML card, with controls on the final chunk", async () => {
    const { bot, delivered } = transport();
    const text = `<b>${"Описание &amp; подробности ".repeat(650)}</b>\n<a href="https://mashina.kg/details/one">Источник</a>`;
    await sendReplies(
      bot,
      1,
      [{ text, buttons, photos: [photo, secondPhoto], listingId: identity.id }],
      {
        miniAppUrl: "https://cars.example/miniapp/",
      },
    );
    expect(delivered[0]?.method).toBe("sendMediaGroup");
    expect(delivered[0]?.payload.media).toEqual([
      { type: "photo", media: photo },
      { type: "photo", media: secondPhoto },
    ]);
    const messages = delivered.slice(1);
    expect(messages.map((item) => rendered(item.payload.text as string)).join("")).toBe(
      rendered(text),
    );
    for (const message of messages) {
      expect(message.method).toBe("sendMessage");
      const html = message.payload.text as string;
      expect(rendered(html).length).toBeLessThanOrEqual(4096);
      expect(html.match(/<b>/g)?.length ?? 0).toBe(html.match(/<\/b>/g)?.length ?? 0);
    }
    expect(delivered.slice(0, -1).every((item) => item.payload.reply_markup === undefined)).toBe(
      true,
    );
    expect(messages.at(-1)?.payload.reply_markup).toMatchObject({
      inline_keyboard: [
        [{ callback_data: "page:123:1" }],
        [{ web_app: { url: "https://cars.example/miniapp/?car=car%3Aone" } }],
      ],
    });
  });

  it("keeps ordinary no-photo replies in chat without adding a Mini App entry", async () => {
    const { bot, delivered } = transport();
    await sendReplies(bot, 1, [{ text: "Выберите бюджет", buttons }], {
      miniAppUrl: "https://cars.example/miniapp/",
    });
    expect(delivered.map((item) => item.method)).toEqual(["sendMessage"]);
    expect(delivered[0]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:123:1" }]],
    });
    expect(JSON.stringify(delivered)).not.toContain("web_app");
  });

  it("sends structured HTML through the native rich method after visible gallery media", async () => {
    const { bot, delivered } = transport();
    await sendReplies(bot, 1, [
      {
        text: "Toyota\nПолное описание",
        richHtml: "<h2>Toyota</h2><p>Полное описание</p>",
        buttons,
        photos: [photo, secondPhoto],
      },
    ]);
    expect(delivered.map((item) => item.method)).toEqual(["sendMediaGroup", "sendRichMessage"]);
    expect(delivered[1]?.payload.rich_message).toMatchObject({
      html: "<h2>Toyota</h2><p>Полное описание</p>",
    });
    expect(delivered[1]?.payload.reply_markup).toMatchObject({
      inline_keyboard: [[{ callback_data: "page:123:1" }]],
    });
    expect(delivered[1]?.payload.parse_mode).toBeUndefined();
  });

  it("falls back from a missing rich method without duplicating already-delivered photos", async () => {
    const { bot, delivered } = transport({
      sendRichMessage: { code: 404, description: "Not Found" },
    });
    await sendReplies(bot, 1, [
      { text: "<b>Toyota</b>", richHtml: "<h2>Toyota</h2>", buttons, photos: [photo] },
    ]);
    expect(delivered.map((item) => item.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(delivered[1]?.payload.text).toBe("<b>Toyota</b>");
    expect(delivered[1]?.payload.reply_markup).toBeDefined();
  });

  it("preserves descriptions beyond the rich limit through ordinary HTML chunks", async () => {
    const { bot, delivered } = transport();
    const plain = "Описание ".repeat(5000);
    await sendReplies(bot, 1, [{ text: `<b>${plain}</b>`, richHtml: `<p>${plain}</p>`, buttons }]);
    expect(delivered.every((item) => item.method === "sendMessage")).toBe(true);
    expect(delivered.map((item) => rendered(item.payload.text as string)).join("")).toBe(plain);
    expect(delivered.at(-1)?.payload.reply_markup).toBeDefined();
  });

  it.each([
    ["sendPhoto", [photo], "Bad Request: failed to get HTTP URL content"],
    [
      "sendMediaGroup",
      [photo, secondPhoto],
      'Bad Request: failed to send message #1 with the error message "WEBPAGE_MEDIA_EMPTY"',
    ],
  ])(
    "keeps the complete card when %s explicitly rejects media",
    async (method, photos, description) => {
      const { bot, delivered } = transport({
        [method as string]: { code: 400, description: description as string },
      });
      await sendReplies(bot, 1, [
        { text: "<b>Toyota</b>\nПолное описание", buttons, photos: photos as string[] },
      ]);
      expect(delivered.map((item) => item.method)).toEqual(["sendMessage"]);
      expect(delivered[0]?.payload.text).toContain("<b>Toyota</b>\nПолное описание");
      expect(delivered[0]?.payload.reply_markup).toBeDefined();
    },
  );

  it.each([
    { code: 403, description: "Forbidden: bot was blocked by the user" },
    { code: 429, description: "Too Many Requests: retry after 10" },
    { code: 400, description: "Bad Request: can't parse entities" },
    new Error("connection reset after upload"),
  ])(
    "propagates uncertain/non-media failures rather than marking notification delivery successful: %s",
    async (failure) => {
      for (const method of ["sendPhoto", "sendMediaGroup", "sendRichMessage"]) {
        const { bot, delivered } = transport({ [method]: failure });
        const reply: Reply = { text: "Toyota", buttons };
        if (method === "sendPhoto") reply.photos = [photo];
        if (method === "sendMediaGroup") reply.photos = [photo, secondPhoto];
        if (method === "sendRichMessage") reply.richHtml = "<h2>Toyota</h2>";
        await expect(sendReplies(bot, 1, [reply])).rejects.toThrow();
        expect(delivered).toEqual([]);
      }
    },
  );
});
