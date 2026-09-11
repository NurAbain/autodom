import { setTimeout as delay } from "node:timers/promises";
import { configureTelegramBot } from "@autodom/bot";
import type { AbortSignal as TelegramAbortSignal } from "abort-controller";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { expect, it, vi } from "vitest";
import { startPolling } from "../src/service.js";

function aborted(signal?: TelegramAbortSignal): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>();
  const stop = () => reject(new DOMException("Fixture aborted", "AbortError"));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return promise;
}
function readyBot(): Bot {
  return new Bot("12345:lifecycle-fixture", {
    botInfo: {
      id: 12345,
      is_bot: true,
      first_name: "Autodom",
      username: "autodom_fixture_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
}

it("cancels offline Telegram initialization before retaining the process lease indefinitely", async () => {
  const bot = new Bot("12345:lifecycle-fixture");
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  vi.spyOn(bot.api, "getMe").mockImplementation((signal) => {
    entered();
    return aborted(signal);
  });
  const controller = new AbortController();
  const setup = configureTelegramBot(bot, controller.signal).catch((error) => error);
  await started;
  controller.abort();
  const outcome = await Promise.race([setup, delay(50).then(() => "still initializing")]);
  expect(outcome).toBeInstanceOf(Error);
});

it("drains accepted updates before shutdown returns to the resource owner", async () => {
  const bot = readyBot();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  let begun = 0;
  let completed = 0;
  bot.use(async () => {
    if (++begun === 2) entered();
    await gate;
    completed += 1;
  });
  let supplied = false;
  const updates: Update[] = [1, 2].map((id) => ({
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      from: { id, is_bot: false, first_name: "Fixture" },
      chat: { id, type: "private", first_name: "Fixture" },
      text: "/profile",
    },
  }));
  vi.spyOn(bot.api, "getUpdates").mockImplementation(async (_options, signal) => {
    if (!supplied) {
      supplied = true;
      return updates;
    }
    return aborted(signal);
  });
  const runner = startPolling(bot);
  await started;
  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });
  try {
    await delay(0);
    expect(stopped).toBe(false);
  } finally {
    release();
    await stopping;
  }
  expect(completed).toBe(2);
});

it("interrupts a Telegram Retry-After wait rather than holding shutdown open", async () => {
  const bot = readyBot();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  vi.spyOn(bot.api, "getUpdates").mockImplementation(async () => {
    entered();
    throw new GrammyError(
      "fixture rate limit",
      { ok: false, error_code: 429, description: "rate limited", parameters: { retry_after: 1 } },
      "getUpdates",
      {},
    );
  });
  const runner = startPolling(bot);
  await started;
  await delay(0);
  expect(runner.isRunning()).toBe(true);
  const stopping = runner.stop().then(() => "stopped");
  try {
    expect(await Promise.race([stopping, delay(50).then(() => "still waiting")])).toBe("stopped");
  } finally {
    await stopping;
  }
});
