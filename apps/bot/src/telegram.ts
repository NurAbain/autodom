import { randomBytes } from "node:crypto";
import { money } from "@autodom/core";
import { normalizeVin, type VinLookup, vinGoogleSearchUrl } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
import { sequentialize } from "@grammyjs/runner";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { type Buttons, Conversation, escapeHtml, packReplies, type Reply } from "./conversation.js";
import { paymentOrderStatus } from "./payment-text.js";
import type { PaymentService } from "./payments.js";
import {
  createPhotoRecognizer,
  type PhotoRecognizer,
  VIN_PHOTO_MAX_BYTES,
  VinPhotoError,
} from "./vin-photo.js";
import {
  VIN_GOOGLE_SEARCH_LABEL,
  VIN_GOOGLE_SEARCH_NOTICE,
  VIN_HELP,
  VIN_NOT_ENABLED,
  VIN_REPORT_EXAMPLE_LABEL,
  vinResultText,
} from "./vin-text.js";

function replyKeyboard(
  buttons: Buttons,
  detailUrl?: string,
  detailLabel = "Подробнее об автомобиле и VIN",
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, row] of buttons.entries()) {
    if (index) keyboard.row();
    for (const [label, action] of row) keyboard.text(label, action);
  }
  if (detailUrl) {
    if (buttons.length) keyboard.row();
    keyboard.webApp(detailLabel, detailUrl);
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
        : reply.miniAppView && options.miniAppUrl
          ? new URL(`?view=${encodeURIComponent(reply.miniAppView)}`, options.miniAppUrl).href
          : undefined;
    const keyboard = replyKeyboard(
      reply.buttons,
      detailUrl,
      reply.miniAppView ? "Открыть в приложении" : undefined,
    );
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

export type AutodomBot = Bot & { clearVinInput(userId: number): void };

export function createTelegramBot(
  store: Store,
  token: string,
  options: {
    apiRoot?: string;
    miniAppUrl?: string;
    checkVin?: VinLookup;
    conversation?: Conversation;
    photoRecognizer?: PhotoRecognizer;
    payments?: PaymentService;
  } = {},
): AutodomBot {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 40, ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}) },
  });
  const conversation = options.conversation ?? new Conversation(store);
  const recognizePhoto = options.photoRecognizer ?? createPhotoRecognizer(token);
  const pendingPhotos = new Map<
    number,
    { nonce: string; candidates: readonly string[]; expiresAt: number }
  >();
  const photoTtlMs = 10 * 60 * 1000;
  const photoHelp =
    "Можно отправить фото VIN крупным планом, без бликов: все 17 символов должны быть видны. Фото распознаётся локально на сервере Autodom и удаляется после обработки; Telegram хранит отправленное сообщение. VIN не отправляем на проверку, пока вы не подтвердите распознанный номер.";
  function rememberPhoto(userId: number, candidates: readonly string[]) {
    const now = Date.now();
    for (const [id, pending] of pendingPhotos) {
      if (pending.expiresAt <= now) pendingPhotos.delete(id);
    }
    pendingPhotos.delete(userId);
    if (pendingPhotos.size >= 1000) {
      const oldest = pendingPhotos.keys().next().value;
      if (oldest !== undefined) pendingPhotos.delete(oldest);
    }
    const pending = {
      nonce: randomBytes(12).toString("hex"),
      candidates,
      expiresAt: now + photoTtlMs,
    };
    pendingPhotos.set(userId, pending);
    return pending;
  }
  async function vinHelp(userId: number, chatId: number): Promise<void> {
    rememberPhoto(userId, []);
    await sendReplies(
      bot,
      chatId,
      [
        {
          text: escapeHtml(
            `${VIN_HELP}\n\nИли отправьте VIN отдельным сообщением.\n\n${photoHelp}`,
          ),
          buttons: [[["Отмена", "/cancel"]]],
          miniAppView: "vin",
        },
      ],
      options,
    );
  }
  async function checkVin(chatId: number, vin: string): Promise<void> {
    const searchUrl = vinGoogleSearchUrl(vin);
    if (!searchUrl) return;
    let text = VIN_NOT_ENABLED;
    if (options.checkVin) {
      try {
        text = vinResultText(await options.checkVin(vin));
      } catch {
        text =
          "Проверка VIN временно недоступна. Результат неизвестен; это не отсутствие записей. Повторите /vin позже.";
      }
    }
    const replies = packReplies(escapeHtml(`${text}\n\n${VIN_GOOGLE_SEARCH_NOTICE}`), []);
    const keyboard = new InlineKeyboard().url(VIN_GOOGLE_SEARCH_LABEL, searchUrl);
    if (options.miniAppUrl) {
      keyboard
        .row()
        .webApp(VIN_REPORT_EXAMPLE_LABEL, new URL("?view=report-example", options.miniAppUrl).href);
    }
    for (const [index, reply] of replies.entries()) {
      await bot.api.sendMessage(chatId, reply.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(index === replies.length - 1 ? { reply_markup: keyboard } : {}),
      });
    }
  }
  bot.use(sequentialize((context) => (context.from ? `autodom:user:${context.from.id}` : [])));
  bot.command("orders", async (context) => {
    if (
      context.chat.type !== "private" ||
      !context.from ||
      context.from.is_bot ||
      context.chat.id !== context.from.id
    )
      return;
    if (!options.payments) {
      await context.reply("Заказы сейчас недоступны. Поиск, уведомления и проверка VIN бесплатны.");
      return;
    }
    const orders = await options.payments.ledger.listOrders(context.from.id);
    const replies = packReplies(
      "<b>Мои заказы</b>\n\n" +
        (orders.length
          ? "Оплата и выполнение услуги — разные статусы. Состав, продавец, исполнитель и условия доступны в приложении."
          : "Заказов пока нет. Платёж появляется только для отдельно согласованной физической услуги. Поиск, уведомления и проверка VIN бесплатны."),
      orders
        .slice(0, 10)
        .map((order) =>
          escapeHtml(
            `${order.title} · ${money(order.amount, "KGS")}\n${paymentOrderStatus(order)}\nНомер: ${order.id}\nПоддержка: ${order.supportUrl}`,
          ),
        ),
    );
    if (options.miniAppUrl && replies.length) replies[replies.length - 1]!.miniAppView = "orders";
    await sendReplies(bot, context.chat.id, replies, options);
  });
  bot.on("message", async (context) => {
    if (
      context.chat.type !== "private" ||
      !context.from ||
      context.from.is_bot ||
      context.chat.id !== context.from.id
    )
      return;
    const userId = context.from.id;
    const chatId = context.chat.id;
    const text = context.message.text ?? "";
    const vinCommand = /^\/vin(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu.exec(text);
    if (vinCommand?.[1] && vinCommand[1].toLowerCase() !== bot.botInfo.username.toLowerCase())
      return;
    await store.withLock(`autodom:user:${userId}`, async () => {
      const directVin = normalizeVin(text);
      if (vinCommand || directVin) {
        pendingPhotos.delete(userId);
        await conversation.handle(userId, chatId, "/vin");
        const vin = directVin ?? normalizeVin(vinCommand?.[2] ?? "");
        if (vin) await checkVin(chatId, vin);
        else await vinHelp(userId, chatId);
        return;
      }
      if (context.message.photo) {
        pendingPhotos.delete(userId);
        await conversation.handle(userId, chatId, "/vin");
        const photo = context.message.photo.at(-1);
        if (!photo || (photo.file_size !== undefined && photo.file_size > VIN_PHOTO_MAX_BYTES)) {
          await context.reply(
            "Фото слишком большое. Отправьте обрезанный снимок VIN до 8 МБ или введите VIN вручную: /vin VIN.",
          );
          return;
        }
        await context.reply(
          "Распознаю фото локально. Проверка VIN начнётся только после вашего подтверждения.",
        );
        let candidates: readonly string[];
        try {
          const controller = new TelegramAbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const file = await bot.api
            .getFile(photo.file_id, controller.signal)
            .finally(() => clearTimeout(timeout));
          if (!file.file_path) throw new VinPhotoError("invalid");
          candidates = [
            ...new Set(
              (
                await recognizePhoto({
                  filePath: file.file_path,
                  ...(file.file_size !== undefined ? { fileSize: file.file_size } : {}),
                })
              )
                .map((candidate) => normalizeVin(candidate))
                .filter((candidate): candidate is string => candidate !== null),
            ),
          ].slice(0, 5);
        } catch (error) {
          const message =
            error instanceof VinPhotoError && error.reason === "busy"
              ? "Распознавание занято. Попробуйте фото чуть позже или введите /vin VIN."
              : error instanceof VinPhotoError && error.reason === "invalid"
                ? "Не удалось прочитать безопасное фото до 8 МБ. Отправьте VIN как обычное фото, не документ, или введите /vin VIN."
                : "Распознавание фото временно недоступно. Проверка VIN не выполнялась. Попробуйте позже или введите /vin VIN.";
          await context.reply(message);
          return;
        }
        if (!candidates.length) {
          await context.reply(
            "Не удалось уверенно прочитать 17 символов VIN. Буквы I, O и Q не заменяем на цифры. Снимите VIN ближе, ровно и без бликов либо введите /vin VIN вручную.",
          );
          await vinHelp(userId, chatId);
          return;
        }
        const pending = rememberPhoto(userId, candidates);
        await sendReplies(
          bot,
          chatId,
          [
            {
              text: escapeHtml(
                `Нашёл на фото:\n${candidates.join("\n")}\n\nСверьте каждый символ с автомобилем или документом. OCR может ошибаться. Выберите только верный VIN — после подтверждения выполним бесплатную проверку.\n\n${VIN_HELP}`,
              ),
              buttons: [
                ...candidates.map((vin, index): [string, string][] => [
                  [`Да, VIN верный: ${vin}`, `vin-photo:${pending.nonce}:yes:${index}`],
                ]),
                [
                  ["Исправить", `vin-photo:${pending.nonce}:edit`],
                  ["Отмена", `vin-photo:${pending.nonce}:cancel`],
                ],
              ],
            },
          ],
          options,
        );
        return;
      }
      if (text.startsWith("/")) pendingPhotos.delete(userId);
      const pending = pendingPhotos.get(userId);
      if (pending && pending.expiresAt > Date.now()) {
        await context.reply(
          "Подтвердите VIN кнопкой под фото или введите все 17 символов вручную. Для другого действия: /cancel.",
        );
        return;
      }
      pendingPhotos.delete(userId);
      const replies = await conversation.handle(userId, chatId, text);
      await sendReplies(bot, chatId, replies, options);
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
    const userId = callback.from.id;
    const chatId = message.chat.id;
    const data = "data" in callback ? (callback.data ?? "") : "";
    await store.withLock(`autodom:user:${userId}`, async () => {
      if (data.startsWith("vin-photo:")) {
        const action = /^vin-photo:([a-f0-9]{24}):(yes:([0-4])|edit|cancel)$/u.exec(data);
        const pending = pendingPhotos.get(userId);
        if (!action || !pending || pending.nonce !== action[1] || pending.expiresAt <= Date.now()) {
          if (pending && pending.expiresAt <= Date.now()) pendingPhotos.delete(userId);
          await context.reply(
            "Это подтверждение устарело или уже использовано. Отправьте фото заново либо /vin VIN.",
          );
          return;
        }
        pendingPhotos.delete(userId);
        if (action[2] === "edit") {
          await vinHelp(userId, chatId);
        } else if (action[2] === "cancel") {
          await sendReplies(
            bot,
            chatId,
            await conversation.handle(userId, chatId, "/cancel"),
            options,
          );
        } else {
          const vin = pending.candidates[Number(action[3])];
          if (vin) await checkVin(chatId, vin);
          else await context.reply("Этот VIN больше не доступен. Отправьте фото заново.");
        }
        return;
      }
      pendingPhotos.delete(userId);
      if (data === "/vin" || data.startsWith("/vin ")) {
        await conversation.handle(userId, chatId, "/vin");
        const vin = normalizeVin(data.slice(4));
        if (vin) await checkVin(chatId, vin);
        else await vinHelp(userId, chatId);
        return;
      }
      const replies = await conversation.handle(userId, chatId, data);
      await sendReplies(bot, chatId, replies, options);
    });
  });
  return Object.assign(bot, {
    clearVinInput(userId: number): void {
      pendingPhotos.delete(userId);
    },
  });
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
        { command: "start", description: "Выбрать цель: VIN, продажа/обмен или покупка" },
        { command: "sell", description: "Продать авто или обменять на недвижимость" },
        { command: "search", description: "Найти варианты по моему бюджету" },
        { command: "profile", description: "Мой бюджет и пожелания" },
        { command: "edit", description: "Изменить поиск" },
        { command: "resume", description: "Включить бесплатный мониторинг" },
        { command: "pause", description: "Приостановить уведомления" },
        { command: "tips", description: "Советы перед покупкой" },
        { command: "vin", description: "Проверить VIN: CarHistory и Car365, без покупки" },
        { command: "orders", description: "Мои заказы, оплата и поддержка услуг" },
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
