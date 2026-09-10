import type { Store } from "@autodom/storage";
import { sequentialize } from "@grammyjs/runner";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot, InlineKeyboard } from "grammy";
import { Conversation, packReplies, type Reply } from "./conversation.js";

export async function sendReplies(
  bot: Bot,
  chatId: number,
  replies: readonly Reply[],
): Promise<void> {
  for (const reply of replies) {
    for (const packed of packReplies(reply.text, [], reply.buttons)) {
      const keyboard = new InlineKeyboard();
      for (const [index, row] of packed.buttons.entries()) {
        if (index) keyboard.row();
        for (const [label, action] of row) keyboard.text(label, action);
      }
      await bot.api.sendMessage(chatId, packed.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(packed.buttons.length ? { reply_markup: keyboard } : {}),
      });
    }
  }
}

export function createTelegramBot(
  store: Store,
  token: string,
  options: { apiRoot?: string } = {},
): Bot {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 40, ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}) },
  });
  const conversation = new Conversation(store);
  bot.use(sequentialize((context) => (context.from ? `autodom:user:${context.from.id}` : [])));
  bot.on("message", async (context) => {
    if (context.chat.type !== "private" || !context.from || context.from.is_bot) return;
    await store.withLock(`autodom:user:${context.from.id}`, async () => {
      const replies = await conversation.handle(
        context.from!.id,
        context.chat.id,
        context.message.text ?? "",
      );
      await sendReplies(bot, context.chat.id, replies);
    });
  });
  bot.on("callback_query", async (context) => {
    const callback = context.callbackQuery;
    const message = callback.message;
    if (!message || message.date === 0 || message.chat.type !== "private") {
      await context.answerCallbackQuery({ text: "Откройте бота в личном чате." });
      return;
    }
    if (message.chat.id !== callback.from.id || callback.from.is_bot) {
      await context.answerCallbackQuery({ text: "Этот поиск принадлежит другому пользователю." });
      return;
    }
    await context.answerCallbackQuery();
    await store.withLock(`autodom:user:${callback.from.id}`, async () => {
      const replies = await conversation.handle(
        callback.from.id,
        message.chat.id,
        "data" in callback ? (callback.data ?? "") : "",
      );
      await sendReplies(bot, message.chat.id, replies);
    });
  });
  return bot;
}

export async function configureTelegramBot(bot: Bot, signal: AbortSignal): Promise<void> {
  const controller = new TelegramAbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    await bot.init(controller.signal);
    const webhook = await bot.api.getWebhookInfo(controller.signal);
    if (webhook.url)
      throw new Error(
        "This bot already has a webhook; refusing to replace an existing integration",
      );
    await bot.api.setMyCommands(
      [
        { command: "start", description: "Начать подбор автомобиля" },
        { command: "search", description: "Найти варианты по моему бюджету" },
        { command: "profile", description: "Мой бюджет и пожелания" },
        { command: "edit", description: "Изменить поиск" },
        { command: "resume", description: "Включить бесплатный мониторинг" },
        { command: "pause", description: "Приостановить уведомления" },
        { command: "tips", description: "Советы перед покупкой" },
        { command: "quiet", description: "Тихие часы: /quiet 23:00-08:00 или off" },
        { command: "privacy", description: "Хранение и удаление моих данных" },
        { command: "status", description: "Состояние каталога" },
        { command: "delete", description: "Удалить мои данные" },
        { command: "help", description: "Все команды и примеры" },
      ],
      undefined,
      controller.signal,
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
