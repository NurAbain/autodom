import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isWebVinReport, type PaymentOrder, type VinReportKind } from "@autodom/core/payments";
import {
  ENCAR_HISTORY_MAX_LISTINGS,
  ENCAR_HISTORY_MAX_PHOTOS,
  isEncarPhotoUrl,
  normalizeVin,
  type VinCheckResult,
  type VinLookup,
} from "@autodom/core/vin";
import {
  disabledVinArchiveResult,
  groupVinArchiveLots,
  isVinArchivePhotoUrl,
  VIN_ARCHIVE_AUCTION_NAMES,
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  type VinArchiveLookup,
  type VinArchivePhotoLookup,
  type VinArchiveResult,
} from "@autodom/core/vin-archive";
import type { Store } from "@autodom/storage";
import { sequentialize } from "@grammyjs/runner";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot, type Context, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BotMode } from "./bot-mode.js";
import { CARFAX_REPORT_EXAMPLE_PDF } from "./carfax-report-example.js";
import { type Buttons, Conversation, packReplies, type Reply } from "./conversation.js";
import { escapeHtml } from "./html.js";
import { KOREAN_REPORT_EXAMPLE_PDF } from "./korean-report-example.js";
import {
  PAYMENT_PRIVACY_NOTICE,
  paymentAmountText,
  paymentOrderStatus,
  VIN_REPORT_FINIK_MINOR,
  VIN_REPORT_MAX_BYTES,
  VIN_REPORT_OWNER,
  VIN_REPORT_TELEGRAM_FINIK_TERMS,
  VIN_REPORT_TERMS,
} from "./payment-text.js";
import { PaymentRequestError, type PaymentService } from "./payments.js";
import { type PhotoRecognizer, VIN_PHOTO_MAX_BYTES, VinPhotoError } from "./vin-photo.js";
import {
  confirmedEncarListings,
  confirmedVinReportKind,
  VIN_ARCHIVE_CARWAY_NOTICE,
  VIN_ARCHIVE_LABEL,
  VIN_ARCHIVE_STATUS_TEXT,
  VIN_DISCLOSURE,
  VIN_HELP,
  VIN_NOT_ENABLED,
  VIN_PHOTOS_LABEL,
  vinArchiveLotText,
  vinArchiveTime,
  vinResultActions,
  vinResultPresentation,
} from "./vin-text.js";
import type { WebReportAuth } from "./web-report-auth.js";

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

function isRejectedPhoto(error: unknown): boolean {
  if (!(error instanceof GrammyError) || error.error_code !== 400) return false;
  const description =
    /^Bad Request: failed to send message #\d+ with the error message "([^"]+)"$/.exec(
      error.description,
    )?.[1] ?? error.description;
  return /^(?:Bad Request: )?(?:failed to get HTTP URL content|wrong (?:type of the web page content|file identifier\/HTTP URL specified|remote file (?:id|identifier) specified)|PHOTO_INVALID_DIMENSIONS|PHOTO_CONTENT_TYPE_INVALID|IMAGE_PROCESS_FAILED|WEBPAGE_CURL_FAILED|WEBPAGE_MEDIA_EMPTY|photo (?:is too big|must be non-empty)|file is too big)$/i.test(
    description,
  );
}

export async function sendReplies(
  bot: Bot,
  chatId: number,
  replies: readonly Reply[],
  options: {
    miniAppUrl?: string;
    fallbackReplyMarkup?: InlineKeyboardMarkup;
    onSent?: (messageId: number) => void;
  } = {},
): Promise<void> {
  for (const reply of replies) {
    const detailUrl =
      reply.listingId && options.miniAppUrl
        ? new URL(`?car=${encodeURIComponent(reply.listingId)}`, options.miniAppUrl).href
        : reply.miniAppView && options.miniAppUrl
          ? new URL(`?view=${encodeURIComponent(reply.miniAppView)}`, options.miniAppUrl).href
          : undefined;
    const keyboard =
      options.fallbackReplyMarkup ??
      replyKeyboard(
        reply.buttons,
        detailUrl,
        reply.miniAppView ? "Открыть в приложении" : undefined,
      );
    const hasKeyboard =
      options.fallbackReplyMarkup !== undefined ||
      reply.buttons.length > 0 ||
      detailUrl !== undefined;
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
        if (!isRejectedPhoto(error)) throw error;
        photoRejected = true;
      }
    }
    const photoNote = photoRejected ? "Часть фотографий недоступна в Telegram.\n\n" : "";
    if (
      richHtml &&
      (!photoRejected || Buffer.byteLength(richHtml + photoNote, "utf8") + 7 <= 32768)
    ) {
      try {
        const sent = await bot.api.sendRichMessage(
          chatId,
          {
            html: (photoRejected ? `<p>${photoNote.trim()}</p>` : "") + richHtml,
            skip_entity_detection: true,
          },
          hasKeyboard && !options.fallbackReplyMarkup ? { reply_markup: keyboard } : {},
        );
        options.onSent?.(sent.message_id);
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
      const sent = await bot.api.sendMessage(chatId, packed.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(index === packedReplies.length - 1 && hasKeyboard ? { reply_markup: keyboard } : {}),
      });
      if (index === packedReplies.length - 1) options.onSent?.(sent.message_id);
    }
  }
}

export type AutodomBot = Bot & {
  clearVinInput(userId: number): void;
  webReportAuth?: WebReportAuth;
};

export interface TelegramBotOptions {
  mode?: BotMode;
  reportBotUrl?: string;
  onPrivateInteraction?: (userId: number) => Promise<void>;
  apiRoot?: string;
  miniAppUrl?: string;
  checkVin?: VinLookup;
  checkVinArchive?: VinArchiveLookup;
  getVinArchivePhoto?: VinArchivePhotoLookup;
  conversation?: Conversation;
  photoRecognizer?: PhotoRecognizer;
  payments?: PaymentService;
  starsEnabled?: boolean;
}

export function createTelegramBot(
  store: Store,
  token: string,
  options: TelegramBotOptions = {},
): AutodomBot {
  const bot = new Bot(token, {
    client: { timeoutSeconds: 40, ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}) },
  });
  const vinOnly = options.mode === "vin";
  const reportBotUrl = !vinOnly ? options.reportBotUrl : undefined;
  // Register before payment handlers too: only a user's own private chat is reachable.
  bot.use(async (context, next) => {
    if (context.message && privateBuyer(context))
      await options.onPrivateInteraction?.(context.from!.id);
    await next();
  });
  options.payments?.configureStars(bot.api, options.starsEnabled === true, token);
  // Financial callbacks bypass per-user serialization and all slow VIN/media work.
  bot.on("pre_checkout_query", async (context) => {
    if (options.payments) await options.payments.approveStarsCheckout(context.preCheckoutQuery);
    else
      await context.answerPreCheckoutQuery(false, { error_message: "Покупка сейчас недоступна." });
  });
  bot.on(["message:successful_payment", "message:refunded_payment"], async (context) => {
    // Polling already committed this receipt before acknowledging its offset; replay is safe.
    await options.payments?.ingestTelegramPayment(context.update);
  });
  const conversation = options.conversation ?? new Conversation(store);
  const recognizePhoto = options.photoRecognizer;
  const pendingPhotos = new Map<
    number,
    { nonce: string; candidates: readonly string[]; expiresAt: number }
  >();
  const photoTtlMs = 10 * 60 * 1000;
  interface VehiclePhotoOffer {
    result: VinCheckResult | VinArchiveResult;
    expiresAt: number;
    messageIds: Set<number>;
  }
  const vehiclePhotos = new Map<string, VehiclePhotoOffer>();
  function clearVehiclePhotos(userId: number): void {
    vehiclePhotos.delete(`${userId}:encar`);
    vehiclePhotos.delete(`${userId}:archive`);
  }
  function rememberVehiclePhotos(
    userId: number,
    kind: "encar" | "archive",
    result: VinCheckResult | VinArchiveResult,
  ) {
    const now = Date.now();
    for (const [key, offer] of vehiclePhotos) {
      if (offer.expiresAt <= now) vehiclePhotos.delete(key);
    }
    const key = `${userId}:${kind}`;
    vehiclePhotos.delete(key);
    if (vehiclePhotos.size >= 1000) {
      const oldest = vehiclePhotos.keys().next().value;
      if (oldest !== undefined) vehiclePhotos.delete(oldest);
    }
    const offer = { result, expiresAt: now + photoTtlMs, messageIds: new Set<number>() };
    vehiclePhotos.set(key, offer);
    return offer;
  }
  const photoHelp = recognizePhoto
    ? "Отправьте фото VIN крупным планом, без бликов: все 17 символов должны быть видны. Перед проверкой вы сможете подтвердить или исправить распознанный номер."
    : "Распознавание фото не подключено. Введите VIN текстом: /vin VIN.";
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
  function vinMenu(): InlineKeyboard {
    return new InlineKeyboard()
      .text("Проверить VIN / фото", "/vin")
      .row()
      .text("Мои заказы", "/orders")
      .row()
      .text("Поддержка", "/paysupport");
  }
  async function vinWelcome(chatId: number): Promise<void> {
    await bot.api.sendMessage(
      chatId,
      [
        "<b>Бесплатная проверка VIN</b>",
        "Пришлите <b>VIN из 17 символов</b> или фото номера. Покажем доступные бесплатные данные об автомобиле.",
        "Нет записей ≠ нет ДТП. Фото VIN проверяем только после вашего подтверждения.",
        "/privacy — ваши данные · /orders — существующие заказы · /paysupport — помощь",
      ].join("\n\n"),
      { parse_mode: "HTML", reply_markup: vinMenu() },
    );
  }
  async function delegateReport(context: Context, payload = "orders"): Promise<void> {
    if (!privateBuyer(context) || !reportBotUrl) return;
    await context.reply(
      "Доступ к полному отчёту, ваши заказы и поддержка — в @autokgbot. Продолжите там: оплата и доступ к отчёту остаются в одном боте.",
      {
        reply_markup: new InlineKeyboard().url(
          "Открыть отчёты и заказы",
          `${reportBotUrl}?start=${payload}`,
        ),
      },
    );
  }
  async function vinPrivacy(chatId: number, deleting = false): Promise<void> {
    await bot.api.sendMessage(
      chatId,
      [
        "<b>Ваши данные</b>",
        escapeHtml(VIN_DISCLOSURE),
        escapeHtml(photoHelp),
        "Фото VIN обрабатывает сервер распознавания Autodom; Telegram хранит отправленное сообщение.",
        "Подтверждение фото действует 10 минут. Новый VIN, /start или /cancel сбрасывает его.",
        escapeHtml(PAYMENT_PRIVACY_NOTICE),
        ...(deleting
          ? [
              "VIN не записывается в профиль поиска. Для удаления ранее сохранённых авто, фильтров и настроек отправьте /paysupport Удалить мои сохранённые данные. Владелец уточнит запрос в этом чате. Ничего не удаляем без вашего подтверждения; заказы и платежи хранятся отдельно.",
            ]
          : [
              "Для запроса удаления ранее сохранённых авто, фильтров и настроек используйте /delete. Данные не удаляются автоматически.",
            ]),
      ].join("\n\n"),
      { parse_mode: "HTML", reply_markup: vinMenu() },
    );
  }
  async function vinHelp(userId: number, chatId: number): Promise<void> {
    clearVehiclePhotos(userId);
    rememberPhoto(userId, []);
    await sendReplies(
      bot,
      chatId,
      [
        {
          text: escapeHtml(
            `${VIN_HELP}\n\nИли отправьте VIN отдельным сообщением.\n\n${photoHelp}`,
          ),
          buttons: [
            [
              ["Новая проверка", "/vin"],
              ["Меню", "/start"],
            ],
          ],
          miniAppView: "vin",
        },
      ],
      options,
    );
  }
  async function sendReportExample(
    chatId: number,
    reportKind: VinReportKind = "korea",
  ): Promise<void> {
    if (reportKind === "carfax") {
      await bot.api.sendMessage(chatId, CARFAX_REPORT_EXAMPLE_PDF.caption, {
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .url(CARFAX_REPORT_EXAMPLE_PDF.label, CARFAX_REPORT_EXAMPLE_PDF.path)
          .row()
          .url("Страница источника образца", CARFAX_REPORT_EXAMPLE_PDF.sourceUrl),
      });
      return;
    }
    const example = KOREAN_REPORT_EXAMPLE_PDF;
    await bot.api.sendDocument(
      chatId,
      new InputFile(
        fileURLToPath(new URL(`./public/reports/${example.filename}`, import.meta.url)),
        example.filename,
      ),
      { caption: example.caption },
    );
  }
  async function checkVin(chatId: number, vin: string): Promise<void> {
    if (normalizeVin(vin) !== vin) return;
    clearVehiclePhotos(chatId);
    const revision = options.payments?.forgetVinResult(chatId, vin);
    let keyboard: InlineKeyboardMarkup | undefined;
    let purchase: InlineKeyboardMarkup["inline_keyboard"][number][number] | undefined;
    let reportKind: VinReportKind | null = null;
    let photoOffer: VehiclePhotoOffer | undefined;
    let presentation = { text: escapeHtml(VIN_NOT_ENABLED), richHtml: "" };
    if (options.checkVin) {
      try {
        const checked = await options.checkVin(vin);
        if (checked.vin !== vin) throw new Error("VIN result does not match the request");
        const actions = vinResultActions(checked);
        if (actions.photos.length) photoOffer = rememberVehiclePhotos(chatId, "encar", checked);
        if (revision !== undefined) options.payments?.rememberVinResult(chatId, checked, revision);
        reportKind = confirmedVinReportKind(checked);
        if (reportKind) {
          const price = options.payments?.reportPrice ?? {
            amount: VIN_REPORT_FINIK_MINOR,
            currency: "KGS" as const,
          };
          purchase = reportBotUrl
            ? {
                text: `Получить доступ · ${paymentAmountText(price)}`,
                url: `${reportBotUrl}?start=vin_${vin}`,
                style: "primary" as const,
              }
            : options.payments?.reportSalesEnabled
              ? {
                  text: `Получить доступ · ${paymentAmountText(price)}`,
                  callback_data: `vin-report-buy:${vin}`,
                  style: "primary" as const,
                }
              : undefined;
        }
        presentation = vinResultPresentation(checked, actions);
        keyboard = actions.keyboard;
      } catch {
        clearVehiclePhotos(chatId);
        photoOffer = undefined;
        purchase = undefined;
        presentation.text =
          "Проверка VIN временно недоступна. Результат неизвестен; это не отсутствие записей. Повторите /vin позже.";
      }
    }
    await sendReplies(
      bot,
      chatId,
      [
        {
          text: presentation.text,
          ...(presentation.richHtml ? { richHtml: presentation.richHtml } : {}),
          buttons: [],
        },
      ],
      {
        ...(keyboard ? { fallbackReplyMarkup: keyboard } : {}),
        ...(photoOffer ? { onSent: (id: number) => photoOffer?.messageIds.add(id) } : {}),
      },
    );
    if (purchase && reportKind)
      await bot.api.sendMessage(
        chatId,
        "Полный отчёт найден. Бесплатные данные — выше. Перед покупкой посмотрите пример PDF: это образец, не отчёт по вашему VIN.\n\nДоступ к полному отчёту — до 60 минут после подтверждённой оплаты. Если предоставить доступ невозможно — полный возврат.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    reportKind === "carfax"
                      ? CARFAX_REPORT_EXAMPLE_PDF.label
                      : KOREAN_REPORT_EXAMPLE_PDF.label,
                  callback_data:
                    reportKind === "carfax" ? "carfax-report-example" : "vin-report-example",
                },
              ],
              [purchase],
            ],
          },
        },
      );
  }
  async function sendEncarPhotos(chatId: number, result: VinCheckResult): Promise<void> {
    const vin = result.vin;
    const sentListings = new Set<string>();
    for (const listing of confirmedEncarListings(result).slice(0, ENCAR_HISTORY_MAX_LISTINGS)) {
      if (sentListings.has(listing.id)) continue;
      sentListings.add(listing.id);
      const photos: string[] = [];
      for (const url of listing.photo_urls) {
        if (isEncarPhotoUrl(url, listing.id) && !photos.includes(url)) photos.push(url);
        if (photos.length === ENCAR_HISTORY_MAX_PHOTOS) break;
      }
      for (let offset = 0; offset < photos.length; offset += 10) {
        await sendReplies(bot, chatId, [
          {
            text: escapeHtml(
              `Архив объявления №${listing.id} · VIN ${vin}\n` +
                `Фото ${offset + 1}–${Math.min(offset + 10, photos.length)} из ${photos.length}.\n` +
                "Фотографии не подтверждают текущее состояние автомобиля.",
            ),
            photos: photos.slice(offset, offset + 10),
            buttons: [],
          },
        ]);
      }
    }
  }
  async function checkVinArchive(chatId: number, vin: string): Promise<void> {
    vehiclePhotos.delete(`${chatId}:archive`);
    let result: VinArchiveResult;
    try {
      result = options.checkVinArchive
        ? await options.checkVinArchive(vin)
        : disabledVinArchiveResult(vin);
      if (result.vin !== vin) throw new Error("Archive VIN mismatch");
    } catch {
      await sendReplies(
        bot,
        chatId,
        packReplies(
          escapeHtml(
            `VIN ${vin}\n\n${VIN_ARCHIVE_STATUS_TEXT.unavailable}\n\nАрхивы неполные; отсутствие записей не означает отсутствие ДТП.`,
          ),
          [],
        ),
        options,
      );
      return;
    }
    await sendReplies(
      bot,
      chatId,
      packReplies(
        escapeHtml(
          `VIN ${vin}\n${VIN_ARCHIVE_LABEL}\nПроверено: ${vinArchiveTime(result.checked_at)}\n\nАрхивы неполные. Фото относятся к прошлому состоянию автомобиля; отсутствие записей не означает отсутствие ДТП.`,
        ),
        [],
      ),
      options,
    );
    for (const source of result.sources) {
      await sendReplies(
        bot,
        chatId,
        packReplies(
          escapeHtml(
            [
              `${source.provider === "carway" ? "Архив ОАЭ" : "Архив США"}: ${VIN_ARCHIVE_STATUS_TEXT[source.status]}`,
              `Данные получены: ${vinArchiveTime(source.checked_at)}.`,
              ...(source.provider === "carway" ? [VIN_ARCHIVE_CARWAY_NOTICE] : []),
              ...(source.partial ? ["Поиск или получение фотографий выполнены не полностью."] : []),
            ].join("\n"),
          ),
          [],
        ),
        options,
      );
    }
    for (const group of groupVinArchiveLots(result)) {
      const title = `${VIN_ARCHIVE_AUCTION_NAMES[group.auction]} · лот ${group.lot_id}`;
      const { provider, lot } = group.photo_source;
      const photos = [
        ...new Set(
          lot.photos.filter((photo) =>
            isVinArchivePhotoUrl(photo, provider, lot.auction, lot.lot_id, vin),
          ),
        ),
      ];
      await sendReplies(
        bot,
        chatId,
        packReplies(
          escapeHtml(
            [
              title,
              ...group.sources.map((source) => vinArchiveLotText(source.lot, source.provider)),
              `Фотографий в записи: ${photos.length}.`,
              ...(photos.length < lot.photos.length ? ["Часть ссылок на фото недоступна."] : []),
            ].join("\n\n"),
          ),
          [],
        ),
        options,
      );
    }
    if (
      groupVinArchiveLots(result).some(({ photo_source: { provider, lot } }) =>
        lot.photos.some((photo) =>
          isVinArchivePhotoUrl(photo, provider, lot.auction, lot.lot_id, vin),
        ),
      )
    ) {
      const offer = rememberVehiclePhotos(chatId, "archive", result);
      const sent = await bot.api.sendMessage(
        chatId,
        "Найдены архивные фото автомобиля. Отправим их, только если вы нажмёте кнопку.",
        {
          reply_markup: new InlineKeyboard().text(VIN_PHOTOS_LABEL, `vinarchivephotos:${vin}`),
        },
      );
      offer.messageIds.add(sent.message_id);
    }
  }
  async function sendArchivePhotos(chatId: number, result: VinArchiveResult): Promise<void> {
    const vin = result.vin;
    let photoSignal: AbortSignal | undefined;
    for (const group of groupVinArchiveLots(result)) {
      const title = `${VIN_ARCHIVE_AUCTION_NAMES[group.auction]} · лот ${group.lot_id}`;
      const { provider, lot } = group.photo_source;
      const photos = [
        ...new Set(
          lot.photos.filter((photo) =>
            isVinArchivePhotoUrl(photo, provider, lot.auction, lot.lot_id, vin),
          ),
        ),
      ];
      for (let offset = 0; offset < photos.length; offset += 10) {
        const batch = photos.slice(offset, offset + 10);
        const media: InputFile[] = [];
        let unavailable = false;
        // Keep at most one album in memory and one provider request in flight.
        for (const photo_url of batch) {
          if (!options.getVinArchivePhoto || photoSignal?.aborted) {
            unavailable = true;
            break;
          }
          try {
            photoSignal ??= AbortSignal.timeout(40_000);
            const photo = await options.getVinArchivePhoto(
              {
                vin,
                provider,
                auction: lot.auction,
                lot_id: lot.lot_id,
                photo_url,
              },
              photoSignal,
            );
            if (!photo.bytes.byteLength || photo.bytes.byteLength > VIN_ARCHIVE_PHOTO_MAX_BYTES)
              throw new Error("Invalid archive photo size");
            const extension =
              photo.content_type === "image/jpeg"
                ? "jpg"
                : photo.content_type === "image/png"
                  ? "png"
                  : photo.content_type === "image/webp"
                    ? "webp"
                    : undefined;
            if (!extension) throw new Error("Invalid archive photo type");
            media.push(new InputFile(photo.bytes, `${lot.auction}-${lot.lot_id}.${extension}`));
          } catch {
            unavailable = true;
          }
        }
        if (media.length > 1) {
          try {
            await bot.api.sendMediaGroup(
              chatId,
              media.map((photo) => ({ type: "photo" as const, media: photo })),
            );
            media.length = 0;
          } catch (error) {
            // A rejected album was not delivered. Send its valid photos separately;
            // never retry uncertain delivery, authorization failures, or rate limits.
            if (!isRejectedPhoto(error)) throw error;
          }
        }
        for (const photo of media) {
          try {
            await bot.api.sendPhoto(chatId, photo);
          } catch (error) {
            if (!isRejectedPhoto(error)) throw error;
            unavailable = true;
          }
        }
        await sendReplies(
          bot,
          chatId,
          [
            {
              text: escapeHtml(
                [
                  `${title} · фото ${offset + 1}–${offset + batch.length}`,
                  ...(unavailable ? ["Часть фото недоступна. Повторите поиск архива позже."] : []),
                ].join("\n"),
              ),
              buttons: [],
            },
          ],
          options,
        );
      }
    }
  }
  const serialize = sequentialize<Context>((context) =>
    context.from ? `autodom:user:${context.from.id}` : [],
  );
  // Reserve user order immediately, while acknowledging ahead of earlier slow media.
  bot.use(async (context, next) => {
    const callback = context.callbackQuery;
    if (!callback) return serialize(context, next);
    const message = callback.message;
    if (!message || message.date === 0 || message.chat.type !== "private") {
      await context.answerCallbackQuery({ text: "Откройте бота в личном чате." });
      return;
    }
    if (message.chat.id !== callback.from.id || callback.from.is_bot) {
      await context.answerCallbackQuery({ text: "Этот поиск принадлежит другому пользователю." });
      return;
    }
    const acknowledged = context.answerCallbackQuery();
    await Promise.all([
      acknowledged,
      serialize(context, async () => {
        await acknowledged;
        await options.onPrivateInteraction?.(callback.from.id);
        await next();
      }),
    ]);
  });
  function privateBuyer(context: Context): boolean {
    return (
      context.chat?.type === "private" &&
      !!context.from &&
      !context.from.is_bot &&
      context.chat.id === context.from.id
    );
  }
  // The full bot never opens local commercial orders, including old inline buttons.
  bot.use(async (context, next) => {
    if (!reportBotUrl || !privateBuyer(context)) return next();
    const callback = context.callbackQuery;
    const data = callback && "data" in callback ? callback.data : undefined;
    const message = context.message;
    const text = message?.text ?? message?.caption ?? data ?? "";
    const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/iu.exec(text)?.[1]?.toLowerCase();
    if (text.startsWith("vin-report-buy:")) {
      const vin = normalizeVin(text.slice("vin-report-buy:".length));
      await delegateReport(context, vin ? `vin_${vin}` : "orders");
      return;
    }
    if (
      text.startsWith("vin-report-pay:") ||
      text.startsWith("vin-report-status:") ||
      [
        "orders",
        "terms",
        "paysupport",
        "payreply",
        "refund",
        "refundconfirm",
        "report",
        "deliver",
      ].includes(command ?? "")
    ) {
      await delegateReport(
        context,
        command === "paysupport" || command === "payreply" ? "paysupport" : "orders",
      );
      return;
    }
    await next();
  });
  async function paymentAction(
    context: Context,
    action: (payments: PaymentService) => Promise<void>,
  ): Promise<void> {
    if (!privateBuyer(context)) return;
    if (!options.payments) {
      await context.reply("Платежи недоступны.");
      return;
    }
    try {
      await action(options.payments);
    } catch (error) {
      await context.reply(
        error instanceof PaymentRequestError
          ? error.message
          : "Действие не подтверждено. Проверьте /orders или /report; повторно не платите. Поддержка: /paysupport.",
      );
    }
  }
  function paymentKeyboard(order: PaymentOrder): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const active =
      order.paymentStatus === "unpaid" &&
      !order.needsReview &&
      !order.refundPending &&
      order.invoiceStatus !== "cancelled" &&
      Date.parse(order.expiresAt) > Date.now();
    if (active && order.invoiceUrl) {
      if (order.provider === "finik" && options.miniAppUrl) {
        const url = new URL("?view=orders", options.miniAppUrl);
        url.searchParams.set("order_id", order.id);
        keyboard.webApp("Выбрать банк или карту", url.href).row();
      }
      keyboard
        .url(order.provider === "finik" ? "Открыть Finik" : "Оплатить Stars", order.invoiceUrl)
        .row();
    }
    return keyboard.text("Проверить оплату", `vin-report-status:${order.id}`);
  }

  async function offerReport(context: Context, vin: string): Promise<void> {
    await paymentAction(context, async (payments) => {
      const order = await payments.reportOffer(context.from!.id, vin);
      const keyboard = new InlineKeyboard();
      if (order.paymentStatus === "unpaid")
        keyboard
          .text(
            `Принимаю условия · оплатить ${paymentAmountText(order)}`,
            `vin-report-pay:${order.id}`,
          )
          .row();
      keyboard.text(
        order.reportKind === "carfax"
          ? CARFAX_REPORT_EXAMPLE_PDF.label
          : KOREAN_REPORT_EXAMPLE_PDF.label,
        order.reportKind === "carfax" ? "carfax-report-example" : "vin-report-example",
      );
      await context.reply(
        `<b>${escapeHtml(order.title)} · ${escapeHtml(paymentAmountText(order))}</b>\nVIN <code>${escapeHtml(order.vin ?? "")}</code>\nЗаказ ${escapeHtml(order.id)}\n<b>${escapeHtml(paymentOrderStatus(order))}</b>\n\n<b>Доступ к полному отчёту · до 60 минут после подтверждённой оплаты. Если предоставить доступ невозможно — полный возврат.</b>\n\n${escapeHtml(order.terms)}`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    });
  }

  bot.command("terms", async (context) => {
    if (!privateBuyer(context)) return;
    await context.reply(
      options.payments?.reportPrice.currency === "KGS" || (vinOnly && !options.payments)
        ? VIN_REPORT_TELEGRAM_FINIK_TERMS
        : VIN_REPORT_TERMS,
    );
  });
  bot.command("start", async (context, next) => {
    if (!privateBuyer(context)) return;
    clearVehiclePhotos(context.from!.id);
    if (context.match.startsWith("vin_")) {
      await store.withLock(`autodom:user:${context.from!.id}`, async () => {
        const vin = normalizeVin(context.match.slice(4));
        pendingPhotos.delete(context.from!.id);
        if (!vinOnly) await conversation.handle(context.from!.id, context.chat.id, "/vin");
        if (vin) await checkVin(context.chat.id, vin);
        else await vinHelp(context.from!.id, context.chat.id);
      });
      return;
    }
    if (context.match === "orders") {
      if (reportBotUrl) await delegateReport(context);
      else await showOrders(context);
      return;
    }
    if (context.match === "paysupport" && reportBotUrl) {
      await delegateReport(context, "paysupport");
      return;
    }
    if (context.match.startsWith("web_report_")) {
      if (!privateBuyer(context)) return;
      try {
        const auth = (bot as AutodomBot).webReportAuth;
        if (!auth) throw new PaymentRequestError(503, "Вход на сайт сейчас недоступен.");
        const login = auth.issueCode(context.match.slice("web_report_".length), context.from!.id);
        await context.reply(
          `Код входа на сайт Autodom: ${login.code}\n\nВведите его только в том браузере, где вы начали вход. Не сообщайте код другим людям. Срок действия — 10 минут с начала входа. Если вы не открывали сайт, не передавайте код. Это только вход, не покупка и не согласие на оплату.`,
        );
      } catch (error) {
        await context.reply(
          error instanceof PaymentRequestError
            ? error.message
            : "Вход не подтверждён. Начните вход на сайте заново.",
        );
      }
      return;
    }
    if (context.match !== "paysupport") {
      if (!vinOnly) return next();
      pendingPhotos.delete(context.from!.id);
      await vinWelcome(context.chat.id);
      return;
    }
    if (privateBuyer(context))
      await context.reply(
        "Для связи с владельцем отправьте /paysupport и ваш вопрос или запрос полного возврата. Укажите номер заказа.",
      );
  });
  bot.command("paysupport", (context) =>
    paymentAction(context, async (payments) => {
      await payments.paymentSupport(context.from!.id, context.match);
      await context.reply("Вопрос отправлен владельцу Autodom. Ответ придёт в этот чат.");
    }),
  );
  bot.command("payreply", (context) =>
    paymentAction(context, async (payments) => {
      const match = /^(\d+)\s+([\s\S]+)$/u.exec(context.match);
      if (!match) throw new PaymentRequestError(400, "Используйте /payreply BUYER_ID текст.");
      await payments.paymentSupportReply(context.from!.id, Number(match[1]), match[2]!);
      await context.reply("Ответ отправлен покупателю.");
    }),
  );
  bot.command("refund", (context) =>
    paymentAction(context, async (payments) => {
      const order = await payments.refundReport(context.from!.id, context.match.trim());
      await context.reply(
        `${order.id}\n${paymentOrderStatus(order)}${order.provider === "finik" && order.paymentStatus !== "refunded" ? `\n\nДеньги ещё не возвращены. Выполните полный возврат ${paymentAmountText(order)} в кабинете Finik по платежу ${order.chargeId}, затем подтвердите фактический результат:\n/refundconfirm ${order.id} РЕФЕРЕНС_ВОЗВРАТА` : ""}`,
      );
    }),
  );
  bot.command("refundconfirm", (context) =>
    paymentAction(context, async (payments) => {
      const match = /^([0-9a-f-]+)\s+([^\r\n]+)$/u.exec(context.match.trim());
      if (!match)
        throw new PaymentRequestError(
          400,
          "Только после полного возврата в кабинете Finik: /refundconfirm ORDER_ID РЕФЕРЕНС_ВОЗВРАТА.",
        );
      const order = await payments.confirmFinikRefund(context.from!.id, match[1]!, match[2]!);
      await context.reply(
        `${order.id}\n${paymentOrderStatus(order)}\nЗаписано подтверждение владельца, не выполнен новый банковский перевод.`,
      );
    }),
  );
  bot.command("report", (context) =>
    paymentAction(context, async (payments) => {
      if (context.from!.id !== VIN_REPORT_OWNER)
        throw new PaymentRequestError(403, "Только владелец.");
      const order = await payments.ledger.getOrder(context.match.trim());
      if (!order || order.product !== "vin_report")
        throw new PaymentRequestError(404, "PDF-заказ не найден.");
      const refunds = await payments.ledger.listRefunds(order.id);
      await context.reply(
        `${order.title}\nВид отчёта: ${order.reportKind === "carfax" ? "CARFAX" : "Корея"}\n${order.id}\nVIN ${order.vin}\nПокупатель ${order.userId}\n${paymentAmountText(order)}\n${paymentOrderStatus(order)}\nВыдан: ${order.deliveredAt ?? "нет"}\n${isWebVinReport(order) ? "Выдача: только сайт" : `Сообщение: ${order.reportMessageId ?? "не подтверждено"}`}\n${refunds.map((refund) => `Возврат: ${refund.status}${refund.confirmationReference ? ` · ${refund.confirmationReference} · подтвердил ${refund.confirmedBy}` : ""}`).join("\n")}`,
      );
    }),
  );
  bot.on("message:document", async (context, next) => {
    if (!/^\/deliver(?:@\w+)?(?:\s|$)/u.test(context.message.caption ?? "")) return next();
    await paymentAction(context, async (payments) => {
      if (context.from!.id !== VIN_REPORT_OWNER)
        throw new PaymentRequestError(403, "Только владелец.");
      const match = /^\/deliver(?:@\w+)?\s+([0-9a-f-]+)\s+(\S+)\s*$/u.exec(
        context.message.caption ?? "",
      );
      const document = context.message.document;
      if (
        !match ||
        document.mime_type !== "application/pdf" ||
        !document.file_name?.toLowerCase().endsWith(".pdf") ||
        !document.file_size ||
        document.file_size > VIN_REPORT_MAX_BYTES
      )
        throw new PaymentRequestError(
          400,
          "Пришлите PDF до 20 МБ с подписью /deliver ORDER_UUID VIN.",
        );
      const order = await payments.ledger.getOrder(match[1]!);
      if (!order || order.vin !== normalizeVin(match[2]!))
        throw new PaymentRequestError(400, "VIN документа в подписи должен совпадать с заказом.");
      const delivered = await payments.deliverReport(context.from!.id, order.id, document.file_id);
      await context.reply(`${delivered.id}\n${paymentOrderStatus(delivered)}`);
    });
  });
  async function showOrders(context: Context): Promise<void> {
    if (!privateBuyer(context)) return;
    if (!options.payments) {
      await context.reply("Заказы сейчас недоступны. Бесплатная проверка: /vin.");
      return;
    }
    const orders = (await options.payments.ledger.listOrders(context.from!.id)).filter(
      (order) => !isWebVinReport(order),
    );
    const replies = packReplies(
      "<b>Мои заказы</b>\n\n" +
        (orders.length
          ? "Оплата и выполнение услуги — разные статусы. Состав, продавец, исполнитель и условия доступны в приложении."
          : "Заказов пока нет. Для бесплатной проверки пришлите VIN из 17 символов или фото номера."),
      orders
        .slice(0, 10)
        .map(
          (order) =>
            `<b>${escapeHtml(order.title)} · ${escapeHtml(paymentAmountText(order))}</b>\n` +
            (order.vin ? `VIN: <code>${escapeHtml(order.vin)}</code>\n` : "") +
            `<b>${escapeHtml(paymentOrderStatus(order))}</b>\nНомер: ${escapeHtml(order.id)}\n` +
            escapeHtml(
              `Поддержка: ${order.product === "vin_report" ? "/paysupport текст" : order.supportUrl}`,
            ),
        ),
    );
    if (options.miniAppUrl && replies.length) replies[replies.length - 1]!.miniAppView = "orders";
    await sendReplies(bot, context.chat!.id, replies, options);
  }
  bot.command("orders", showOrders);
  bot.command("sample", async (context) => {
    if (privateBuyer(context))
      await context.reply("Публичные образцы PDF — не отчёт по вашему VIN. Выберите образец:", {
        reply_markup: new InlineKeyboard()
          .text(KOREAN_REPORT_EXAMPLE_PDF.label, "vin-report-example")
          .row()
          .text(CARFAX_REPORT_EXAMPLE_PDF.label, "carfax-report-example"),
      });
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
        if (!vinOnly) await conversation.handle(userId, chatId, "/vin");
        const vin = directVin ?? normalizeVin(vinCommand?.[2] ?? "");
        if (vin) await checkVin(chatId, vin);
        else await vinHelp(userId, chatId);
        return;
      }
      if (context.message.photo) {
        pendingPhotos.delete(userId);
        clearVehiclePhotos(userId);
        if (!vinOnly) await conversation.handle(userId, chatId, "/vin");
        if (!recognizePhoto) {
          await context.reply(photoHelp);
          return;
        }
        const photo = context.message.photo.at(-1);
        if (!photo || (photo.file_size !== undefined && photo.file_size > VIN_PHOTO_MAX_BYTES)) {
          await context.reply(
            "Фото слишком большое. Отправьте обрезанный снимок VIN до 8 МБ или введите VIN текстом: /vin VIN.",
          );
          return;
        }
        await context.reply(
          "Распознаю VIN на фото. Проверка начнётся только после вашего подтверждения.",
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
            "Не удалось уверенно прочитать 17 символов VIN. Буквы I, O и Q не заменяем на цифры. Снимите VIN ближе, ровно и без бликов либо введите VIN текстом: /vin VIN.",
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
      if (/^\/(?:start|cancel)(?:@\w+)?(?:\s|$)/iu.test(text)) clearVehiclePhotos(userId);
      const pending = pendingPhotos.get(userId);
      if (pending && pending.expiresAt > Date.now()) {
        await context.reply(
          "Подтвердите VIN кнопкой под фото или введите все 17 символов текстом. Для другого действия: /cancel.",
        );
        return;
      }
      pendingPhotos.delete(userId);
      if (vinOnly) {
        const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/iu.exec(text)?.[1]?.toLowerCase();
        if (command === "privacy" || command === "delete")
          await vinPrivacy(chatId, command === "delete");
        else await vinWelcome(chatId);
        return;
      }
      const replies = await conversation.handle(userId, chatId, text);
      await sendReplies(bot, chatId, replies, options);
    });
  });
  bot.on("callback_query", async (context) => {
    const callback = context.callbackQuery;
    const userId = callback.from.id;
    const chatId = userId;
    const data = "data" in callback ? (callback.data ?? "") : "";
    await store.withLock(`autodom:user:${userId}`, async () => {
      if (data === "/orders") {
        if (reportBotUrl) await delegateReport(context);
        else await showOrders(context);
        return;
      }
      if (data === "/paysupport") {
        if (reportBotUrl) await delegateReport(context, "paysupport");
        else
          await context.reply(
            "Отправьте /paysupport и вопрос или запрос полного возврата. Укажите номер заказа. Ответ придёт в этот чат.",
          );
        return;
      }
      if (data.startsWith("vin-report-buy:")) {
        const value = data.slice("vin-report-buy:".length);
        const vin = normalizeVin(value);
        if (!vin || vin !== value) {
          await context.reply("Некорректный VIN. Начните заново: /vin VIN.");
          return;
        }
        await offerReport(context, vin);
        return;
      }
      if (data.startsWith("vin-report-pay:")) {
        await paymentAction(context, async (payments) => {
          const order = await payments.checkout(userId, data.slice("vin-report-pay:".length), true);
          if (!order.invoiceUrl) throw new PaymentRequestError(503, "Счёт ещё не подтверждён.");
          await context.reply(
            `<b>${escapeHtml(order.title)} · ${escapeHtml(paymentAmountText(order))}</b> · VIN <code>${escapeHtml(order.vin ?? "")}</code>\n${order.provider === "finik" ? "Выберите банк или карту. Оплата — только по серверной квитанции Finik." : "Оплата — только по подтверждению сервера Telegram."}\n\n<b>Доступ к полному отчёту до 60 минут после подтверждённой оплаты.</b> Если предоставить доступ невозможно — полный возврат.\nВернитесь сюда и нажмите «Проверить оплату». <b>Повторно не платите.</b>`,
            { parse_mode: "HTML", reply_markup: paymentKeyboard(order) },
          );
        });
        return;
      }
      if (data.startsWith("vin-report-status:")) {
        await paymentAction(context, async (payments) => {
          const order = await payments.ownedOrder(userId, data.slice("vin-report-status:".length));
          await context.reply(
            `<b>${escapeHtml(order.title)} · ${escapeHtml(paymentAmountText(order))}</b>\nVIN <code>${escapeHtml(order.vin ?? "")}</code>\nЗаказ ${escapeHtml(order.id)}\n<b>${escapeHtml(paymentOrderStatus(order))}</b>\n\nДоступ к полному отчёту до 60 минут после подтверждённой оплаты; если предоставить доступ невозможно — полный возврат.\nПоддержка и возврат: /paysupport текст`,
            { parse_mode: "HTML", reply_markup: paymentKeyboard(order) },
          );
        });
        return;
      }
      if (data === "carfax-report-example") {
        await sendReportExample(chatId, "carfax");
        return;
      }
      if (data === "vin-report-example") {
        await sendReportExample(chatId);
        return;
      }
      if (data.startsWith("vinphotos:") || data.startsWith("vinarchivephotos:")) {
        const archive = data.startsWith("vinarchivephotos:");
        const value = data.slice(archive ? "vinarchivephotos:".length : "vinphotos:".length);
        const vin = normalizeVin(value);
        const key = `${userId}:${archive ? "archive" : "encar"}`;
        const offer = vehiclePhotos.get(key);
        const messageId = callback.message?.message_id;
        if (
          !vin ||
          vin !== value ||
          !offer ||
          offer.result.vin !== vin ||
          offer.expiresAt <= Date.now() ||
          messageId === undefined ||
          !offer.messageIds.has(messageId)
        ) {
          if (offer && offer.expiresAt <= Date.now()) vehiclePhotos.delete(key);
          await context.reply(
            "Эта кнопка фото устарела или относится к другой проверке. Проверьте VIN заново; для архивных фото повторите поиск архива.",
          );
          return;
        }
        if (archive && "coverage" in offer.result) await sendArchivePhotos(chatId, offer.result);
        else if (!archive && !("coverage" in offer.result))
          await sendEncarPhotos(chatId, offer.result);
        return;
      }
      if (data.startsWith("vinarchive:")) {
        const value = data.slice("vinarchive:".length);
        const vin = normalizeVin(value);
        if (!vin || vin !== value) {
          await context.reply("Некорректный VIN. Отправьте /vin и все 17 символов.");
          return;
        }
        await checkVinArchive(chatId, vin);
        return;
      }
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
          if (vinOnly) await vinWelcome(chatId);
          else
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
      if (data === "/start" || data === "/cancel") clearVehiclePhotos(userId);
      if (data === "/vin" || data.startsWith("/vin ")) {
        if (!vinOnly) await conversation.handle(userId, chatId, "/vin");
        const vin = normalizeVin(data.slice(4));
        if (vin) await checkVin(chatId, vin);
        else await vinHelp(userId, chatId);
        return;
      }
      if (vinOnly) {
        if (data === "/privacy" || data === "/delete") await vinPrivacy(chatId, data === "/delete");
        else {
          clearVehiclePhotos(userId);
          await vinWelcome(chatId);
        }
        return;
      }
      const replies = await conversation.handle(userId, chatId, data);
      await sendReplies(bot, chatId, replies, options);
    });
  });
  return Object.assign(bot, {
    clearVinInput(userId: number): void {
      pendingPhotos.delete(userId);
      clearVehiclePhotos(userId);
    },
  });
}

export async function configureTelegramBot(
  bot: Bot,
  signal: AbortSignal,
  options: { mode?: BotMode; reportBotUrl?: string } = {},
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
      options.mode === "vin"
        ? [
            { command: "start", description: "Бесплатная проверка VIN" },
            { command: "vin", description: "Новая проверка VIN или фото номера" },
            { command: "orders", description: "Мои PDF, оплата и статус выдачи" },
            { command: "sample", description: "Образцы корейского PDF и CARFAX — не ваш отчёт" },
            { command: "paysupport", description: "Поддержка по заказу и полный возврат" },
            { command: "terms", description: "Цена, срок выдачи и условия покупки" },
            { command: "privacy", description: "Как обрабатываются ваши данные" },
            { command: "delete", description: "Как удалить сохранённые данные" },
            { command: "help", description: "VIN, фото и помощь" },
          ]
        : [
            { command: "start", description: "Выбрать цель: VIN, продажа/обмен или покупка" },
            { command: "sell", description: "Продать авто или обменять на недвижимость" },
            { command: "search", description: "Найти варианты по моему бюджету" },
            { command: "profile", description: "Мой бюджет и пожелания" },
            { command: "edit", description: "Изменить поиск" },
            { command: "resume", description: "Включить бесплатный мониторинг" },
            { command: "pause", description: "Приостановить уведомления" },
            { command: "tips", description: "Советы перед покупкой" },
            { command: "vin", description: "Бесплатная проверка VIN и фото номера" },
            { command: "sample", description: "Образцы корейского PDF и CARFAX" },
            {
              command: "orders",
              description: options.reportBotUrl
                ? "PDF и заказы — перейти в @autokgbot"
                : "Мои заказы, оплата и поддержка услуг",
            },
            { command: "terms", description: "Условия доступа к полному отчёту" },
            { command: "paysupport", description: "Написать владельцу по оплате или возврату" },
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
