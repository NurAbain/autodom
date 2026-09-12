import type { Store } from "@autodom/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../src/conversation.js";
import { createTelegramBot } from "../src/telegram.js";
import {
  createPhotoRecognizer,
  extractVinCandidates,
  type PhotoRecognizer,
} from "../src/vin-photo.js";

const vin = "KMHDU41DBAU123456";
const ocrEnv = {
  AUTODOM_OCR_API_URL: "http://ocr.example:8080",
  AUTODOM_OCR_API_TOKEN: "test-ocr-api-secret-not-a-production-key",
};
// A JPEG SOF header is enough for the bot's preflight; image decoding belongs to the OCR API.
const photoBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 20, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff,
  0xd9, 0,
]);
const photoFile = { filePath: "photos/file_1.jpg" };
const from = { id: 1, is_bot: false, first_name: "Owner" };
const message = {
  message_id: 1,
  date: 1,
  from,
  chat: { id: 1, type: "private" as const, first_name: "Owner" },
};

async function fixture(enabled = true) {
  const checkVin = vi.fn(async () => {
    throw new Error("Provider unavailable");
  });
  const conversation = { handle: vi.fn(async () => [{ text: "Menu", buttons: [] }]) };
  const store = { withLock: async (_key: string, run: () => Promise<unknown>) => run() };
  const bot = createTelegramBot(store as unknown as Store, "100:test-token", {
    conversation: conversation as unknown as Conversation,
    ...(enabled ? { photoRecognizer: (async () => [vin]) satisfies PhotoRecognizer } : {}),
    checkVin,
  });
  const actions: string[] = [];
  const calls: { method: string; payload: unknown }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 100, is_bot: true, first_name: "Autodom", username: "autodom_test_bot" },
      } as never;
    if (method === "getFile")
      return {
        ok: true,
        result: {
          file_id: "photo",
          file_unique_id: "photo",
          file_path: "photos/file_1.jpg",
          file_size: 1024,
        },
      } as never;
    if (
      method === "sendMessage" &&
      "reply_markup" in payload &&
      payload.reply_markup &&
      "inline_keyboard" in payload.reply_markup
    ) {
      for (const row of payload.reply_markup.inline_keyboard) {
        for (const button of row) if ("callback_data" in button) actions.push(button.callback_data);
      }
    }
    return { ok: true, result: { message_id: 1 } } as never;
  });
  await bot.init();
  await bot.handleUpdate({
    update_id: 1,
    message: {
      ...message,
      photo: [
        { file_id: "photo", file_unique_id: "photo", width: 1000, height: 200, file_size: 1024 },
      ],
    },
  });
  const confirm = actions.find((action) => action.endsWith(":yes:0"))!;
  async function callback(data: string, userId = 1) {
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "callback",
        chat_instance: "private",
        from: { ...from, id: userId },
        message,
        data,
      },
    });
  }
  return { bot, checkVin, confirm, actions, callback, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("VIN photo safety", () => {
  it("joins OCR-separated characters without guessing ambiguous letters or slicing longer identifiers", () => {
    expect(
      extractVinCandidates(
        `VIN: K M H D U 4 1 D B A U 1 2 3 4 5 6\n${vin}\nKMHDU41DBAU12345O\nX${vin}X`,
      ),
    ).toEqual([vin]);
    expect(extractVinCandidates("K-M-H-D-U-4-1-D-B-A-U-1-2-3-4-5-6")).toEqual([vin]);
  });

  it("rejects non-Telegram paths without making a network request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const recognize = createPhotoRecognizer("100:secret", ocrEnv)!;
    await expect(recognize({ filePath: "https://evil.example/photo.jpg" })).rejects.toMatchObject({
      reason: "invalid",
    });
    await expect(recognize({ filePath: "photos/../secret.jpg" })).rejects.toMatchObject({
      reason: "invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("disables photo recognition before Telegram file lookup or download when unconfigured", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(createPhotoRecognizer("100:secret", {})).toBeUndefined();
    const flow = await fixture(false);
    expect(flow.calls.some((call) => call.method === "getFile")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(flow.checkVin).not.toHaveBeenCalled();
    expect(flow.confirm).toBeUndefined();
    expect(flow.calls.filter((call) => call.method === "sendMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ text: expect.stringContaining("/vin VIN") }),
        }),
      ]),
    );
  });

  it.each([
    { AUTODOM_OCR_API_URL: ocrEnv.AUTODOM_OCR_API_URL },
    { AUTODOM_OCR_API_TOKEN: ocrEnv.AUTODOM_OCR_API_TOKEN },
    { ...ocrEnv, AUTODOM_OCR_API_TOKEN: "too-short" },
    { ...ocrEnv, AUTODOM_OCR_API_TOKEN: "x".repeat(257) },
    { ...ocrEnv, AUTODOM_OCR_API_TOKEN: `${ocrEnv.AUTODOM_OCR_API_TOKEN} ` },
    { ...ocrEnv, AUTODOM_OCR_API_TOKEN: `${ocrEnv.AUTODOM_OCR_API_TOKEN}é` },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://@ocr.example" },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://user:password@ocr.example" },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://ocr.example/v1/ocr/recognize" },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://ocr.example/../" },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://ocr.example?token=secret" },
    { ...ocrEnv, AUTODOM_OCR_API_URL: "https://ocr.example#" },
  ])("rejects partial or unsafe API configuration before network access: %j", (env) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(() => createPhotoRecognizer("100:secret", env)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("excludes low-confidence and ambiguous VINs without disclosing Telegram credentials", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(photoBytes))
      .mockResolvedValueOnce(
        Response.json({
          lines: [
            { text: "KMFXKN7BPXU258800", confidence: 0.799 },
            { text: "K M H D U 4 1 D B A U 1 2 3 4 5 6", confidence: 0.8 },
            { text: "KMHDU41DBAU12345O", confidence: 1 },
          ],
        }),
      );
    const recognize = createPhotoRecognizer("100:telegram-secret", ocrEnv)!;
    await expect(recognize(photoFile)).resolves.toEqual([vin]);
    const [url, request] = fetch.mock.calls[1]!;
    expect(JSON.stringify([url, request])).not.toContain("telegram-secret");
  });

  it.each([
    [400, "invalid"],
    [413, "invalid"],
    [415, "invalid"],
    [401, "unavailable"],
    [429, "busy"],
    [503, "unavailable"],
    [302, "unavailable"],
  ] as const)(
    "handles HTTP %i without retries or upstream error disclosure",
    async (status, reason) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(photoBytes))
        .mockResolvedValueOnce(
          new Response(`private body ${ocrEnv.AUTODOM_OCR_API_TOKEN}`, { status }),
        );
      const error = await createPhotoRecognizer("100:secret", ocrEnv)!(photoFile).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({ reason });
      expect(String(error)).not.toContain(ocrEnv.AUTODOM_OCR_API_URL);
      expect(String(error)).not.toContain(ocrEnv.AUTODOM_OCR_API_TOKEN);
      expect(String(error)).not.toContain("private body");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    '{"lines":[{"text":"KMHDU41DBAU123456","confidence":1e999}]}',
    JSON.stringify({ lines: [{ text: vin, confidence: -0.1 }] }),
    JSON.stringify({ lines: [{ text: vin, confidence: "0.9" }] }),
    JSON.stringify({ lines: [{ text: "x".repeat(513), confidence: 1 }] }),
    JSON.stringify({ lines: Array.from({ length: 257 }, () => ({ text: vin, confidence: 1 })) }),
    JSON.stringify({ lines: [{ text: vin, confidence: 1, vin }] }),
    JSON.stringify({ lines: null }),
    "not JSON",
    " ".repeat(64 * 1024 + 1),
  ])("rejects malformed or unbounded OCR results", async (body) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(photoBytes))
      .mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    await expect(createPhotoRecognizer("100:secret", ocrEnv)!(photoFile)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("cancels a pending OCR request when the bot shuts down", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(photoBytes))
      .mockImplementationOnce(
        (_url, request) =>
          new Promise<Response>((_resolve, reject) => {
            request?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error(`private transport ${ocrEnv.AUTODOM_OCR_API_TOKEN}`));
              },
              { once: true },
            );
            controller.abort();
          }),
      );
    const error = await createPhotoRecognizer("100:secret", ocrEnv, controller.signal)!(
      photoFile,
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: "unavailable" });
    expect(String(error)).not.toContain(ocrEnv.AUTODOM_OCR_API_TOKEN);
    expect(String(error)).not.toContain("private transport");
  });

  it("does not disclose an OCR VIN before confirmation and consumes confirmation once for its private owner", async () => {
    const flow = await fixture();
    expect(flow.checkVin).not.toHaveBeenCalled();
    await flow.callback(flow.confirm, 2);
    expect(flow.checkVin).not.toHaveBeenCalled();
    await flow.callback(flow.confirm);
    expect(flow.checkVin).toHaveBeenCalledExactlyOnceWith(vin);
    await flow.callback(flow.confirm);
    expect(flow.checkVin).toHaveBeenCalledTimes(1);
  });

  it("revokes the old candidate when editing or changing goals", async () => {
    const flow = await fixture();
    await flow.callback(flow.actions.find((action) => action.endsWith(":edit"))!);
    await flow.callback(flow.confirm);
    expect(flow.checkVin).not.toHaveBeenCalled();
    const other = await fixture();
    await other.bot.handleUpdate({ update_id: 3, message: { ...message, text: "/sell" } });
    await other.callback(other.confirm);
    expect(other.checkVin).not.toHaveBeenCalled();
  });

  it("expires confirmations rather than looking up an old photo", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const flow = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000);
    await flow.callback(flow.confirm);
    expect(flow.checkVin).not.toHaveBeenCalled();
  });
});
