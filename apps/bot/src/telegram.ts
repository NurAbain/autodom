import { normalizeVin, type VinLookup } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
import { sequentialize } from "@grammyjs/runner";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { type Buttons, Conversation, packReplies, type Reply } from "./conversation.js";
import { VIN_HELP, VIN_NOT_ENABLED, vinResultText } from "./vin-text.js";

function replyKeyboard(buttons: Buttons, detailUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, row] of buttons.entries()) {
    if (index) keyboard.row();
    for (const [label, action] of row) keyboard.text(label, action);
  }
  if (detailUrl) {
    if (buttons.length) keyboard.row();
    keyboard.webApp("Подробнее об автомобиле и VIN", detailUrl);
  }
  return keyboard;
}

function captionLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot);/gi,
      (_entity, hex: string | undefined, decimal: string | undefined) =>
        (hex ? Number.parseInt(hex, 16) : Number(decimal)) > 0xffff ? "xx" : "x",
    ).length;
}

export async function sendReplies(
  bot: Bot,
  chatId: number,
  replies: readonly Reply[],
  options: { miniAppUrl?: string } = {},
): Promise<void> {
  for (const reply of replies) {
    const detailUrl =
      reply.listingId && options.miniAppUrl
        ? new URL(`?car=${encodeURIComponent(reply.listingId)}`, options.miniAppUrl).href
        : undefined;
    const keyboard = replyKeyboard(reply.buttons, detailUrl);
    const hasKeyboard = reply.buttons.length > 0 || detailUrl !== undefined;
    const photos = [...new Set(reply.photos ?? [])].slice(0, 10);
    // Source-generated rich HTML is bounded conservatively by its serialized UTF-8
    // size; larger cards retain their entire content via the ordinary HTML splitter.
    const richHtml =
      reply.richHtml && Buffer.byteLength(reply.richHtml, "utf8") <= 32768
        ? reply.richHtml
        : undefined;
    let photoRejected = false;
    if (photos.length) {
      const captionFits = !richHtml && photos.length === 1 && captionLength(reply.text) <= 1024;
      try {
        if (photos.length === 1) {
          await bot.api.sendPhoto(chatId, photos[0]!, {
            ...(captionFits ? { caption: reply.text, parse_mode: "HTML" as const } : {}),
            ...(captionFits && hasKeyboard ? { reply_markup: keyboard } : {}),
          });
        } else {
          // Albums cannot carry inline keyboards. Keep the complete card and its
          // controls together in the following message instead of clipping a caption.
          await bot.api.sendMediaGroup(
            chatId,
            photos.map((media) => ({ type: "photo" as const, media })),
          );
        }
        if (captionFits) continue;
      } catch (error) {
        // Only explicit media rejection permits fallback. Authorization, rate limits,
        // malformed HTML, and uncertain network delivery must propagate to monitoring.
        const description =
          error instanceof GrammyError
            ? (/^Bad Request: failed to send message #\d+ with the error message "([^"]+)"$/.exec(
                error.description,
              )?.[1] ?? error.description)
            : "";
        if (
          !(error instanceof GrammyError) ||
          error.error_code !== 400 ||
          !/^(?:Bad Request: )?(?:failed to get HTTP URL content|wrong (?:type of the web page content|file identifier\/HTTP URL specified|remote file (?:id|identifier) specified)|PHOTO_INVALID_DIMENSIONS|PHOTO_CONTENT_TYPE_INVALID|IMAGE_PROCESS_FAILED|WEBPAGE_CURL_FAILED|WEBPAGE_MEDIA_EMPTY|photo (?:is too big|must be non-empty)|file is too big)$/i.test(
            description,
          )
        )
          throw error;
        photoRejected = true;
      }
    }
    const photoNote = photoRejected
      ? "Фото источника недоступны в Telegram. Проверьте их по ссылке объявления.\n\n"
      : "";
    if (
      richHtml &&
      (!photoRejected || Buffer.byteLength(richHtml + photoNote, "utf8") + 7 <= 32768)
    ) {
      try {
        await bot.api.sendRichMessage(
          chatId,
          {
            html: (photoRejected ? `<p>${photoNote.trim()}</p>` : "") + richHtml,
            skip_entity_detection: true,
          },
          hasKeyboard ? { reply_markup: keyboard } : {},
        );
        continue;
      } catch (error) {
        // Older self-hosted Bot API versions may lack this method. Never turn an
        // arbitrary 400, forbidden chat, throttling, or transport failure into success.
        if (
          !(error instanceof GrammyError) ||
          !(
            (error.error_code === 404 && /^(?:Not Found: )?Not Found$/i.test(error.description)) ||
            (error.error_code === 400 &&
              /^(?:Bad Request: )?(?:method (?:not found|not supported)|unknown method|unsupported method)$/i.test(
                error.description,
              ))
          )
        )
          throw error;
      }
    }
    const packedReplies = packReplies(photoNote + reply.text, [], reply.buttons);
    for (const [index, packed] of packedReplies.entries()) {
      await bot.api.sendMessage(chatId, packed.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(index === packedReplies.length - 1 && hasKeyboard ? { reply_markup: keyboard } : {}),
      });
    }
  }
}

export function createTelegramBot(
  store: Store,
  token: string,
  options: { apiRoot?: string; miniAppUrl?: string; checkVin?: VinLookup } = {},
): Bot {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 40, ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}) },
  });
  const conversation = new Conversation(store);
  bot.use(sequentialize((context) => (context.from ? `autodom:user:${context.from.id}` : [])));
  bot.on("message", async (context) => {
    if (context.chat.type !== "private" || !context.from || context.from.is_bot) return;
    const vinCommand = /^\/vin(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu.exec(
      context.message.text ?? "",
    );
    if (vinCommand) {
      if (context.chat.id !== context.from.id) return;
      if (vinCommand[1] && vinCommand[1].toLowerCase() !== bot.botInfo.username.toLowerCase())
        return;
      const vin = normalizeVin(vinCommand[2] ?? "");
      if (!vin) {
        await context.reply(VIN_HELP);
        return;
      }
      if (!options.checkVin) {
        await context.reply(VIN_NOT_ENABLED);
        return;
      }
      let text: string;
      try {
        text = vinResultText(await options.checkVin(vin));
      } catch {
        text =
          "Проверка VIN временно недоступна. Результат неизвестен; это не отсутствие записей. Повторите /vin позже.";
      }
      await context.reply(text, { link_preview_options: { is_disabled: true } });
      return;
    }
    await store.withLock(`autodom:user:${context.from.id}`, async () => {
      const replies = await conversation.handle(
        context.from!.id,
        context.chat.id,
        context.message.text ?? "",
      );
      await sendReplies(bot, context.chat.id, replies, options);
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
      await sendReplies(bot, message.chat.id, replies, options);
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
        { command: "vin", description: "Проверить VIN: CarHistory и Car365, без покупки" },
        { command: "quiet", description: "Тихие часы: /quiet 23:00-08:00 или off" },
        { command: "privacy", description: "Хранение и удаление моих данных" },
        { command: "status", description: "Состояние каталога" },
        { command: "delete", description: "Удалить мои данные" },
        { command: "help", description: "Все команды и примеры" },
      ],
      undefined,
      controller.signal,
    );
    await bot.api.setChatMenuButton({ menu_button: { type: "commands" } }, controller.signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
