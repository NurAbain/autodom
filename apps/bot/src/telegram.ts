import type { Store } from "@autodom/storage";
import { sequentialize } from "@grammyjs/runner";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { type Buttons, Conversation, packReplies, type Reply } from "./conversation.js";

function replyKeyboard(buttons: Buttons, miniAppUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, row] of buttons.entries()) {
    if (index) keyboard.row();
    for (const [label, action] of row) keyboard.text(label, action);
  }
  if (miniAppUrl) {
    if (buttons.length) keyboard.row();
    keyboard.webApp("Открыть подбор и фото", miniAppUrl).style("primary");
  }
  return keyboard;
}

export async function sendReplies(
  bot: Bot,
  chatId: number,
  replies: readonly Reply[],
  miniAppUrl?: string,
): Promise<void> {
  for (const reply of replies) {
    let text = reply.text;
    if (reply.photoUrl) {
      // Telegram measures captions after parsing entities. UTF-16 length is
      // conservative for astral characters and matches entity offsets.
      const captionLength = text
        .replace(/<[^>]*>/g, "")
        .replace(
          /&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot);/gi,
          (_entity, hex: string | undefined, decimal: string | undefined) =>
            (hex ? Number.parseInt(hex, 16) : Number(decimal)) > 0xffff ? "xx" : "x",
        ).length;
      const captionFits = captionLength <= 1024;
      try {
        await bot.api.sendPhoto(chatId, reply.photoUrl, {
          ...(captionFits ? { caption: text, parse_mode: "HTML" as const } : {}),
          ...(captionFits && reply.buttons.length
            ? { reply_markup: replyKeyboard(reply.buttons, miniAppUrl) }
            : {}),
        });
        if (captionFits) continue;
      } catch (error) {
        // Only explicit media rejection permits fallback. Rate limits, forbidden
        // chats, malformed captions and uncertain network delivery must propagate.
        if (
          !(error instanceof GrammyError) ||
          error.error_code !== 400 ||
          !/^(?:Bad Request: )?(?:failed to get HTTP URL content|wrong (?:type of the web page content|file identifier\/HTTP URL specified|remote file (?:id|identifier) specified)|(?:PHOTO_INVALID_DIMENSIONS|PHOTO_CONTENT_TYPE_INVALID|IMAGE_PROCESS_FAILED|WEBPAGE_CURL_FAILED|WEBPAGE_MEDIA_EMPTY)|photo (?:is too big|must be non-empty)|file is too big)$/i.test(
            error.description,
          )
        )
          throw error;
        text =
          "Фото источника недоступно: Telegram не смог принять изображение. Объявление ниже; фото можно проверить по ссылке источника.\n\n" +
          text;
      }
    }
    for (const packed of packReplies(text, [], reply.buttons)) {
      await bot.api.sendMessage(chatId, packed.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(packed.buttons.length
          ? { reply_markup: replyKeyboard(packed.buttons, miniAppUrl) }
          : {}),
      });
    }
  }
}

export function createTelegramBot(
  store: Store,
  token: string,
  options: { apiRoot?: string; miniAppUrl?: string; conversation?: Conversation } = {},
): Bot {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 40, ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}) },
  });
  const conversation = options.conversation ?? new Conversation(store, token);
  bot.use(sequentialize((context) => (context.from ? `autodom:user:${context.from.id}` : [])));
  bot.command("app", async (context) => {
    if (context.chat.type !== "private" || !context.from || context.from.is_bot) return;
    await context.reply(
      options.miniAppUrl
        ? "Откройте Mini App: тот же поиск и черновик, автомобили с доступными фото. Изменения сохраняются только после вашего подтверждения."
        : "Mini App пока не подключён. Подбор доступен здесь: /search; пожелания: /profile.",
      options.miniAppUrl ? { reply_markup: replyKeyboard([], options.miniAppUrl) } : {},
    );
  });
  bot.on("message:text", async (context) => {
    if (context.chat.type !== "private" || !context.from || context.from.is_bot) return;
    await store.withLock(`autodom:user:${context.from.id}`, async () => {
      const replies = await conversation.handle(
        context.from!.id,
        context.chat.id,
        context.message.text,
      );
      await sendReplies(bot, context.chat.id, replies, options.miniAppUrl);
    });
  });
  bot.on("callback_query:data", async (context) => {
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
      const replies = await conversation.handle(callback.from.id, message.chat.id, callback.data);
      await sendReplies(bot, message.chat.id, replies, options.miniAppUrl);
    });
  });
  return bot;
}

export async function configureTelegramBot(
  bot: Bot,
  signal: AbortSignal,
  miniAppUrl?: string,
): Promise<void> {
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
        ...(miniAppUrl ? [{ command: "app", description: "Подбор и фото в Mini App" }] : []),
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
    if (miniAppUrl)
      await bot.api.setChatMenuButton(
        { menu_button: { type: "web_app", text: "Подбор и фото", web_app: { url: miniAppUrl } } },
        controller.signal,
      );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
