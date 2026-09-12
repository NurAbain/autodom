import type { Store } from "@autodom/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../src/conversation.js";
import { createTelegramBot } from "../src/telegram.js";
import { createPhotoRecognizer, extractVinCandidates } from "../src/vin-photo.js";

const vin = "KMHDU41DBAU123456";
const from = { id: 1, is_bot: false, first_name: "Owner" };
const message = {
  message_id: 1,
  date: 1,
  from,
  chat: { id: 1, type: "private" as const, first_name: "Owner" },
};

async function fixture() {
  const checkVin = vi.fn(async () => {
    throw new Error("Provider unavailable");
  });
  const conversation = { handle: vi.fn(async () => [{ text: "Menu", buttons: [] }]) };
  const store = { withLock: async (_key: string, run: () => Promise<unknown>) => run() };
  const bot = createTelegramBot(store as unknown as Store, "100:test-token", {
    conversation: conversation as unknown as Conversation,
    photoRecognizer: async () => [vin],
    checkVin,
  });
  const actions: string[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
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
  return { bot, checkVin, confirm, actions, callback };
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
    const recognize = createPhotoRecognizer("100:secret");
    await expect(recognize({ filePath: "https://evil.example/photo.jpg" })).rejects.toThrow(
      "VIN photo invalid",
    );
    await expect(recognize({ filePath: "photos/../secret.jpg" })).rejects.toThrow(
      "VIN photo invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
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
