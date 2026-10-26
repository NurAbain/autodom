import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  BODY_TYPES,
  BUDGET_SCOPES,
  enabledSources,
  type Listing,
  listingPrice,
  MARKETS,
  money,
  type Profile,
  sourceStatus,
  TRANSMISSIONS,
  USE_CASES,
} from "@autodom/core";
import type { Store } from "@autodom/storage";
import type { AnalyticsEvent, AnalyticsRecorder, AnalyticsSurface } from "./analytics-contract.js";
import { escapeHtml } from "./html.js";
import { listingPhotoUrls } from "./media.js";
import type { SellerConversation } from "./seller-conversation.js";
import { VIN_ARCHIVE_DISCLOSURE, VIN_DISCLOSURE } from "./vin-text.js";

export type Button = readonly [string, string];
export type Buttons = readonly (readonly Button[])[];
export interface Reply {
  text: string;
  buttons: Buttons;
  photos?: readonly string[];
  listingId?: string;
  richHtml?: string;
  miniAppView?: "vin" | "buy" | "sell" | "report-example" | "orders";
  input?: { label: string; placeholder: string; mode: "text" | "numeric" | "decimal" };
  filterEditor?: {
    applyCommand?: string;
    description: string;
    sections: {
      title: string;
      fields: { label: string; value: string; command: string }[];
    }[];
    chips: { label: string; command: string }[];
  };
  picker?: {
    title: string;
    subtitle?: string;
    page: number;
    pages: number;
    selected: number;
    searchable: boolean;
    options: { command: string; selected: boolean }[];
    applyCommand?: string;
    search: string;
  };
}
export type ConversationStore = Pick<
  Store,
  | "getProfile"
  | "getDraft"
  | "setDraft"
  | "clearDraft"
  | "saveProfile"
  | "setMonitoring"
  | "setQuietHours"
  | "deleteUser"
  | "search"
  | "countMatches"
  | "getMeta"
  | "setMeta"
  | "sourceStats"
>;
type Draft = Record<string, unknown>;
/** The buyer goal opens the Mini App editor; the chat only summarises and searches. */
export const FILTERS_ACTION = "/filters";
const START_BUTTONS: Buttons = [
  [["Настроить поиск", FILTERS_ACTION]],
  [["Найти автомобили", "/search"]],
  [["Мои условия", "/profile"]],
  [["Проверить VIN", "/vin"]],
  [["Продать / обменять авто на недвижимость", "/sell"]],
  [["Данные и согласие", "/privacy"]],
  [["Удалить данные", "/delete"]],
];
const USE_CASE_TIPS: Record<string, string> = {
  city: "Для городских поездок проверьте реальные габариты парковки и расход в пробках.",
  family:
    "Для семейных поездок проверьте крепления детских кресел, ремни и место для пассажиров и багажа.",
  work: "Для работы уточните допустимую нагрузку, стоимость простоя и доступность расходников.",
  travel:
    "Для дальних поездок проверьте запасное колесо, тормоза и историю обслуживания перед выездом.",
};
const FILTER_NOTE =
  "Жёсткие фильтры поиска и уведомлений: цена объявления, слова марки/модели, город, кузов, диапазон года, пробег, коробка и рынок. Неизвестные или нераспознанные данные не проходят соответствующий выбранный фильтр. Город — место объявления, не пункт доставки.\nНабор условий одинаков для всех площадок Кыргызстана: справочные уточнения одной площадки не применяются к другой.\nЦель и дата покупки — только заметки: не определяют пригодность машины и не останавливают мониторинг.\nБюджет «под ключ» исключает иностранные объявления: полной стоимости ввоза пока нет. Даже для местных объявлений проверяется цена машины, а не все расходы покупки. Аукционы сравниваются с бюджетом только по Buy Now, пока предложение активно: текущая ставка, оценка и результат завершённых торгов не являются ценой покупки.";

function bishkekTime(timestamp: number): string {
  const date = new Date((timestamp + 6 * 3600) * 1000);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCFullYear())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function privacyText(): string {
  return (
    "<b>Autodom — VIN, своё авто и покупка</b>\n\n" +
    `Бесплатный поиск по бюджету и пожеланиям. Включённые источники: ${enabledSources()
      .map((source) => escapeHtml(source.name))
      .join(", ")}. ` +
    "Иностранные адаптеры без согласованного доступа не собирают и не показывают объявления. Цена за рубежом не включает доставку, таможню, оформление и возможный ремонт; доступность экспорта не подтверждена. Бесплатное ядро не требует платных заказов.\n\n" +
    "После вашего согласия на хранение сохраняю на сервере проекта Telegram ID, ID личного чата и условия покупки: валюту и границы бюджета, текстовый запрос с марками и моделями, город объявления, кузов, коробку передач, диапазон года, предельный пробег, а также заметки о цели и дате покупки; затем профиль и настройки уведомлений. В незавершённом вводе эти данные живут только до сохранения. Это нужно для бесплатного поиска. Профиль сохраняется только после явного согласия и кнопки сохранения. Не вводите в поля контакты.\n\n" +
    "Мониторинг бесплатный. При сохранении явно выбираете «с бесплатным мониторингом» или «без уведомлений». Позже /resume включает, /pause останавливает уведомления. После разделения ботов уведомления приходят из @autodomkgbot только после вашего обращения к нему в личном чате; ранее выбранная настройка мониторинга сохраняется. Для этого хранится отметка Telegram ID пользователя и бота, удаляемая при /delete.\n\n" +
    `По команде /vin или кнопке «Проверить VIN»: ${VIN_DISCLOSURE} Заявки партнёрам сейчас не подключены. Архив истории чата не ведётся, контакты не собираются; однако текст, который вы сами вводите в поля поиска, сохраняется в этих полях. Не вводите туда контакты. Сообщения чата хранит Telegram. Профиль и уведомления доступны пользователю только в личном чате. Интерфейса доступа операторов к профилям и контактам нет; привилегированные администраторы инфраструктуры технически могут получить доступ к базе и резервным копиям.\n\n` +
    `Архивные фото: ${VIN_ARCHIVE_DISCLOSURE}\n\n` +
    "Раздел своего авто не требует анкеты покупателя: отдельное согласие перед вводом, затем карточка марки/модели, года, пробега, цены и цели продажи или обмена. До сохранения ввод хранится временно в памяти; переключение цели его сбрасывает. Сохранённая карточка отделена от фильтров покупки. Мы не публикуем её и не отправляем партнёрам.\n\n" +
    "Данные хранятся до /delete: подтверждение удаляет профиль покупки, карточку своего авто, настройки и незавершённый ввод из рабочей базы. /cancel отменяет текущее действие, а не сохранённые данные; при подтверждении удаления отменяет удаление и возвращает прежний черновик покупки. /start, /vin и /sell не удаляют черновик покупки. Локальные снимки при управляемом хранении сохраняются не более 7 дней; удалённые данные могут оставаться в них до истечения этого срока. /delete не удаляет переписку в Telegram.\n\n" +
    "Для улучшения продукта используем собственную псевдонимную аналитику действий за последние 90 дней: шаги поиска, результаты проверки и этапы покупки. Тексты сообщений, содержимое VIN, контакты и бюджет в аналитику не попадают; внешних трекеров нет. Подтверждённый /delete удаляет эту аналитику и отключает дальнейший сбор; финансовые записи, обязательные по закону, сохраняются отдельно.\n\n" +
    "Заказы и платёжная поддержка остаются в @autokgbot, отдельно от бесплатного поиска. В заказе сохраняются Telegram ID покупателя, продавец, исполнитель, состав, цена, принятые условия, идентификаторы и серверные подтверждения оплаты, а также заявки на возврат. /delete не удаляет эти финансовые записи. Для счёта Finik получает номер, описание и сумму заказа, но не Telegram ID, контакты или профиль поиска. Создание счёта не означает оплату; заявка на возврат не означает возврат денег. Условия и поддержка конкретного заказа — /orders."
  );
}
export function profileText(profile: Profile): string {
  const budget =
    profile.budget_min_minor === 0
      ? `до ${money(profile.budget_max_minor, profile.currency)}`
      : `${money(profile.budget_min_minor, profile.currency)} — ${money(profile.budget_max_minor, profile.currency)}`;
  let quiet = "выключены";
  if (profile.quiet_start_minute !== null && profile.quiet_end_minute !== null) {
    quiet = [profile.quiet_start_minute, profile.quiet_end_minute]
      .map(
        (value) =>
          `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`,
      )
      .join("–");
  }
  const year =
    profile.year_min === null && profile.year_max === null
      ? ""
      : `Год: ${profile.year_min ?? "любой"} — ${profile.year_max ?? "любой"}\n`;
  const notes =
    profile.use_case || profile.purchase_by
      ? `Цель (заметка): ${USE_CASES[profile.use_case as keyof typeof USE_CASES] ?? "не задана"}; дата покупки (заметка): ${profile.purchase_by ? escapeHtml(profile.purchase_by) : "не задана"}\n`
      : "";
  return (
    `Рынок: <b>${MARKETS[profile.market as keyof typeof MARKETS]}</b>\nБюджет: <b>${budget}</b> · ${BUDGET_SCOPES[profile.budget_scope as keyof typeof BUDGET_SCOPES]}\nТекстовый запрос: ${profile.query ? escapeHtml(profile.query) : "не задан"}\n` +
    (profile.city ? `Город объявления: ${escapeHtml(profile.city)}\n` : "") +
    (profile.body_type
      ? `Кузов: ${BODY_TYPES[profile.body_type as keyof typeof BODY_TYPES]}\n`
      : "") +
    year +
    (profile.mileage_max_km !== null ? `Пробег до: ${profile.mileage_max_km} км\n` : "") +
    (profile.transmission
      ? `Коробка: ${TRANSMISSIONS[profile.transmission as keyof typeof TRANSMISSIONS]}\n`
      : "") +
    notes +
    `Мониторинг: ${profile.monitoring ? "включён" : "на паузе"}\nТихие часы (Бишкек, UTC+6): ${quiet}. /quiet — настройка.`
  );
}
export function menu(profile: Profile): Buttons {
  const monitor: Button = profile.monitoring
    ? ["Приостановить", `monitor:${profile.revision}:off`]
    : ["Включить мониторинг", `monitor:${profile.revision}:on`];
  return [
    [["Найти автомобили", "/search"]],
    [["Настроить поиск", FILTERS_ACTION]],
    [monitor],
    [
      ["Мои условия", "/profile"],
      ["Советы", "/tips"],
    ],
    [["Данные и согласие", "/privacy"]],
    [["Другие цели", "/start"]],
  ];
}
export function listingText(listing: Listing, currency: string): string {
  const title = escapeHtml(listing.title);
  const price = listingPrice(listing, currency);
  const original = listing.original_price_minor;
  let priceText: string;
  if (original !== null && listing.original_currency) {
    priceText =
      (listing.price_kind === "buy_now" ? "Buy Now — цена выкупа: " : "Цена объявления: ") +
      escapeHtml(money(original, listing.original_currency));
    if (listing.original_currency !== currency)
      priceText +=
        price !== null
          ? ` (≈ ${escapeHtml(money(price, currency))})`
          : " (свежий пересчёт в валюту бюджета недоступен)";
  } else priceText = price !== null ? escapeHtml(money(price, currency)) : "цена не указана";
  const parts = [
    listing.year ? String(listing.year) : "год не указан",
    ...[listing.mileage, listing.transmission, listing.body_type, listing.trim].filter(Boolean),
  ];
  if (listing.registration_month) parts.push(`регистрация: ${listing.registration_month}`);
  const observed =
    listing.observed_at !== null
      ? `${bishkekTime(listing.observed_at)} (Бишкек, UTC+6)`
      : "время наблюдения неизвестно";
  let text =
    `<b>${title}</b>\n${priceText} · ${listing.city ? escapeHtml(listing.city) : "город не указан"} · ${escapeHtml(MARKETS[listing.market as keyof typeof MARKETS] ?? listing.market)}\n${escapeHtml(parts.join(" · "))}\n` +
    `${escapeHtml(listing.availability) || "Наличие не указано"} · обновлено ${observed}.\nЦену и наличие подтвердите у продавца.`;
  if (listing.market !== "KG") {
    text += "\nДоставка, таможня, оформление и ремонт не включены. Экспорт не подтверждён.";
    if (!listing.condition) text += "\nИстория ДТП и документов неизвестна.";
    text += " Независимая проверка не выполнена.";
    if (listing.fx_date && price !== null && listing.original_currency !== currency)
      text += `\nДаты курсов НБКР: ${escapeHtml(listing.fx_date)}.`;
  }
  if (listing.condition)
    text += `\n\n<b>Заявленное состояние</b>\n${escapeHtml(listing.condition)}`;
  if (typeof listing.description === "string" && listing.description)
    text += `\n\n<b>Описание объявления</b>\n${escapeHtml(listing.description)}`;
  if (listing.vin) text += `\nVIN / номер кузова: ${escapeHtml(listing.vin)}.`;
  for (const [label, value] of [
    ["Документ продажи", listing.sale_document],
    ["Основное повреждение", listing.primary_damage],
    ["Дополнительное повреждение", listing.secondary_damage],
    ["Заявленные запуск / движение", listing.start_code],
  ] as const) {
    if (value) text += `\n${label}: ${escapeHtml(value)}.`;
  }
  if (listing.auction_house || listing.auction_status) {
    const status: Record<string, string> = {
      active: "активен на момент наблюдения",
      ended: "завершён",
      unknown: "не подтверждён",
    };
    text += `\nАукцион: ${escapeHtml(listing.auction_house) || "не указан"}, лот ${escapeHtml(listing.auction_lot) || "не указан"} — ${status[listing.auction_status] ?? "не подтверждён"}.`;
    if (listing.auction_at !== null)
      text += `\nНачало основных торгов: ${bishkekTime(listing.auction_at)} (Бишкек, UTC+6).`;
    for (const [label, amount] of [
      ["Текущая ставка — не цена покупки", listing.current_bid_minor],
      ["Финальная ставка завершённых торгов — не предложение", listing.final_bid_minor],
    ] as const) {
      if (amount !== null) text += `\n${label}: ${money(amount, "USD")}.`;
    }
    if (listing.estimated_min_minor !== null && listing.estimated_max_minor !== null)
      text += `\nОценка источника — не цена покупки: ${money(listing.estimated_min_minor, "USD")}–${money(listing.estimated_max_minor, "USD")}.`;
    if (price === null)
      text += "\nПодтверждённой цены для текущего подбора нет; Buy Now может быть недоступен.";
    text +=
      "\nАукционные и брокерские сборы также не включены. Условия выкупа подтвердите до оплаты.";
  }
  return text;
}

// Split only between complete tags, HTML entities and Unicode code points.
// Reopen formatting on the next message so even a single oversized section is safe.
function splitHtml(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const stack: { open: string; close: string }[] = [];
  let current = "";
  let reopen = "";
  let closeTags = "";
  for (const token of text.match(/<[^>]*>|&(?:#x[0-9a-f]+|#[0-9]+|[a-z]+);|[^<&]+|[<&]/giu) ?? []) {
    if (token.startsWith("<")) {
      const closing = /^<\//.test(token);
      const tag = /^<\/?([a-z0-9]+)/i.exec(token)?.[1];
      if (!tag) throw new Error("Invalid Telegram HTML tag");
      if (closing) {
        current += token;
        stack.pop();
      } else {
        const close = `</${tag}>`;
        if (token.length + close.length + reopen.length + closeTags.length >= limit)
          throw new RangeError("Telegram HTML tag exceeds the message limit");
        if (current.length + token.length + close.length + closeTags.length > limit) {
          chunks.push(current + closeTags);
          current = reopen;
        }
        current += token;
        stack.push({ open: token, close });
      }
      reopen = stack.map((item) => item.open).join("");
      closeTags = stack
        .map((item) => item.close)
        .reverse()
        .join("");
      continue;
    }
    const entities = token.startsWith("&") && token.endsWith(";") ? [token] : token;
    for (const part of entities) {
      if (current.length + part.length + closeTags.length > limit) {
        chunks.push(current + closeTags);
        current = reopen;
      }
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
export function packReplies(
  header: string,
  sections: readonly string[],
  buttons: Buttons = [],
): Reply[] {
  const chunks: Reply[] = [];
  let current = "";
  for (const section of [header, ...sections]) {
    if (!section) continue;
    for (const piece of splitHtml(section)) {
      if (current && current.length + piece.length + 2 > 3800) {
        chunks.push({ text: current, buttons: [] });
        current = piece;
      } else current += (current ? "\n\n" : "") + piece;
    }
  }
  if (current) chunks.push({ text: current, buttons });
  return chunks;
}

export function listingReplies(
  listing: Listing,
  currency: string,
  buttons: Buttons = [],
  heading = "",
): Reply[] {
  const replies = packReplies(heading, [listingText(listing, currency)], buttons);
  // Bot API rich HTML supports semantic headings and paragraphs; the ordinary
  // HTML remains complete for servers that have not enabled sendRichMessage.
  for (const reply of replies) {
    const title = /^<b>(.*?)<\/b>\n?/s.exec(reply.text);
    reply.richHtml =
      (title ? `<h2>${title[1]!.replaceAll("\n", "<br>")}</h2>` : "") +
      `<p>${reply.text.slice(title?.[0].length ?? 0).replaceAll("\n", "<br>")}</p>`;
  }
  replies[0]!.photos = listingPhotoUrls(listing);
  replies.at(-1)!.listingId = listing.id;
  return replies;
}
export function tips(profile: Profile): string {
  return (
    "<b>Перед покупкой</b>\n\n" +
    profileText(profile) +
    "\n\n• Оставьте отдельный резерв на проверку, оформление, первые расходники и возможный ремонт; фильтр бюджета самовольно не уменьшается." +
    "\n• До поездки уточните наличие, окончательную цену, документы и право продавца распоряжаться автомобилем." +
    "\n• Сверьте VIN на машине и в документах. Объявление не подтверждает отсутствие ДТП, юридических ограничений или скрученного пробега." +
    "\n• До передачи денег проведите независимую диагностику. Не переводите задаток только на основании переписки." +
    "\n• Похожие модели сравнивайте по состоянию и полной стоимости владения, а не только по году выпуска." +
    "\n\nЭто общие рекомендации, а не заключение о состоянии или пригодности конкретной машины." +
    (USE_CASE_TIPS[profile.use_case] ? `\n${USE_CASE_TIPS[profile.use_case]}` : "")
  );
}

export class Conversation {
  // Bounded ephemeral storage consent; any next input consumes it.
  private readonly consents = new Map<number, string>();
  private readonly goals = new Map<number, "home" | "buy" | "sell" | "vin">();
  private readonly deletions = new Map<number, [string, Draft]>();
  private readonly analyticsContext = new AsyncLocalStorage<{
    surface: AnalyticsSurface;
    dedupeKey?: string;
  }>();
  private async record(
    userId: number,
    event: Omit<AnalyticsEvent, "actorId" | "surface" | "dedupeKey">,
  ): Promise<void> {
    const context = this.analyticsContext.getStore();
    if (!context || !this.options.analytics) return;
    try {
      await this.options.analytics.record({
        ...event,
        actorId: userId,
        surface: context.surface,
        ...(context.dedupeKey
          ? { dedupeKey: `${context.dedupeKey}:${event.event}:${event.flow}:${event.step ?? ""}` }
          : {}),
      });
    } catch {
      /* Analytics must not affect the conversation. */
    }
  }
  constructor(
    private readonly store: ConversationStore,
    private readonly options: {
      seller?: SellerConversation;
      analytics?: AnalyticsRecorder;
    } = {},
  ) {}

  private setGoal(userId: number, goal: "home" | "buy" | "sell" | "vin"): void {
    this.goals.delete(userId);
    this.goals.set(userId, goal);
    if (this.goals.size > 2048) this.goals.delete(this.goals.keys().next().value!);
    if (goal !== "sell") this.options.seller?.clear(userId);
  }
  private consentAction(userId: number): string {
    const action = `consent:${randomBytes(12).toString("base64url")}`;
    this.consents.delete(userId);
    this.consents.set(userId, action);
    if (this.consents.size > 2048) this.consents.delete(this.consents.keys().next().value!);
    return action;
  }

  private privacy(userId: number, profile: Profile | null, detailed = false): Reply[] {
    if (profile) return packReplies(privacyText(), [], menu(profile));
    const action = this.consentAction(userId);
    return packReplies(
      detailed
        ? privacyText()
        : "<b>Поиск автомобиля</b>\nУсловия настраиваются в приложении: автомобиль, бюджет, город и характеристики. Остальные фильтры — по желанию.\n\nС вашего согласия сохраним Telegram ID, ID личного чата и условия покупки на сервере проекта; после проверки — профиль. Не вводите контакты. Уведомления включаются только по вашему выбору. /delete удаляет рабочие данные, резервные копии могут храниться до 7 дней; переписку хранит Telegram. /privacy — все условия.\n\nСогласны на хранение для бесплатного поиска?",
      [],
      [[["Согласен на хранение — настроить поиск", action]], [["Не сейчас", "/start"]]],
    );
  }
  /** The conditions live in the Mini App; the chat points to it and keeps the summary. */
  private filtersReply(profile: Profile | null): Reply[] {
    return packReplies(
      "<b>Условия поиска</b>\n" +
        "Настройте условия в приложении: автомобиль, бюджет, город и характеристики. Один набор условий работает для всех площадок Кыргызстана.\n\n" +
        (profile
          ? "Сохранённые условия откроются в приложении."
          : "Перед сохранением отметьте согласие на хранение данных в приложении."),
      [],
      profile ? menu(profile) : START_BUTTONS,
    );
  }
  private async catalogNote(profile: Profile | null = null): Promise<string> {
    const lines: string[] = [];
    for (const source of await sourceStatus(this.store)) {
      if (!source.enabled) {
        if (!profile)
          lines.push(
            `${escapeHtml(source.name)}: выключен до согласования доступа; сбор и показ запрещены.`,
          );
        continue;
      }
      if (profile && !["ALL", source.market].includes(profile.market)) continue;
      lines.push(
        `${escapeHtml(source.name)} · ${MARKETS[source.market as keyof typeof MARKETS]}: ${String(source.listings).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} сохранённых объявлений.`,
      );
      if (source.last_sync)
        lines.push(`Последняя успешная страница: ${escapeHtml(source.last_sync)}.`);
      if (source.total !== null)
        lines.push(`Последний запрос источника: ${escapeHtml(String(source.total))} объявлений.`);
      if (source.scope) lines.push("Охват запроса: " + escapeHtml(source.scope.slice(0, 400)));
      if (source.error)
        lines.push("Ошибка этого источника; его данные могут быть неполными или устаревшими.");
    }
    if (!lines.length)
      lines.push("Рынок поиска сейчас выключен. Выберите доступный рынок через /filters.");
    lines.push(
      "Это не весь рынок. В выдаче — наблюдения за последние 48 часов; зарубежные объявления означают публикацию на сайте, а не подтверждённое наличие.",
    );
    if (profile && ["KR", "AE", "ALL"].includes(profile.market))
      lines.push(
        "Для цен KRW и AED нужен свежий курс НБКР; без него сравнение по бюджету не выполняется.",
      );
    return lines.join("\n");
  }
  async search(profile: Profile, offset = 0): Promise<Reply[]> {
    const count = await this.store.countMatches(profile);
    if (offset >= count && offset)
      return packReplies("Выдача изменилась. Откройте её заново: /search.", [], menu(profile));
    const [listing] = await this.store.search(profile, 1, offset);
    await this.record(profile.user_id, {
      event: "search_completed",
      flow: "buyer",
      outcome: listing ? "results" : "empty",
    });
    if (!listing)
      return packReplies(
        "<b>Пока нет совпадений</b>\nПопробуйте увеличить бюджет или убрать один из необязательных фильтров. Условия меняются только по вашему выбору.\n\n" +
          "Можно включить бесплатный мониторинг — сообщим о новых подходящих объявлениях. Проверена свежая часть нашего каталога, не весь рынок.",
        [],
        menu(profile),
      );
    const heading =
      `<b>Автомобиль ${offset + 1} из ${count}</b>\n` +
      "Подходит вашим условиям · недавно найденные сначала.";
    const navigation: Button[] = [];
    if (offset > 0) navigation.push(["Предыдущий", `page:${profile.revision}:${offset - 1}`]);
    if (offset + 1 < count)
      navigation.push(["Следующий", `page:${profile.revision}:${offset + 1}`]);
    return listingReplies(
      listing,
      profile.currency,
      [...(navigation.length ? [navigation] : []), ...menu(profile)],
      heading,
    );
  }

  async handle(
    userId: number,
    chatId: number,
    input: string,
    surface: AnalyticsSurface = "telegram",
    dedupeKey?: string,
  ): Promise<Reply[]> {
    return this.analyticsContext.run({ surface, ...(dedupeKey ? { dedupeKey } : {}) }, () =>
      this.handleInput(userId, chatId, input),
    );
  }

  private async handleInput(userId: number, chatId: number, input: string): Promise<Reply[]> {
    if (chatId !== userId)
      return [
        {
          text: "Бюджет, профиль и уведомления доступны только в личном чате с ботом.",
          buttons: [],
        },
      ];
    const text = input.trim();
    let profile = await this.store.getProfile(userId);
    let command = text.split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase() ?? "";
    const draft = (await this.store.getDraft(userId)) ?? this.deletions.get(userId) ?? null;
    const consent = this.consents.get(userId);
    this.consents.delete(userId);
    if (text.startsWith("consent:")) {
      if (profile || draft?.[0] === "delete_confirm" || !consent || text !== consent)
        return packReplies(
          "Согласие не принято: откройте актуальное описание /privacy.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      this.setGoal(userId, "buy");
      await this.record(userId, {
        event: "profile_step",
        flow: "buyer",
        step: "consent",
        outcome: "success",
      });
      return this.filtersReply(null);
    }
    if (text.startsWith("monitor:")) {
      const parts = text.split(":");
      if (
        !profile ||
        parts.length !== 3 ||
        parts[1] !== String(profile.revision) ||
        !["on", "off"].includes(parts[2]!)
      )
        return packReplies(
          "Настройки изменились. Откройте актуальный поиск: /profile.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      command = parts[2] === "on" ? "/resume" : "/pause";
    }
    if (command === "/privacy")
      return draft && (draft[1].consent === true || draft[0] === "delete_confirm")
        ? packReplies(privacyText(), [], profile ? menu(profile) : START_BUTTONS)
        : this.privacy(userId, profile, true);
    if (command === "/start") {
      this.setGoal(userId, "home");
      await this.record(userId, { event: "bot_started", flow: "navigation", step: "start" });
      return packReplies(
        "<b>Autodom</b>\nВаш следующий автомобиль — с понятными фактами.\n\nНастройте условия поиска, проверьте VIN или расскажите о своём для продажи и обмена.\n\nПоиск и мониторинг бесплатны. Сохранённые данные остаются на месте.",
        [],
        START_BUTTONS,
      );
    }
    if (command === "/vin") {
      this.setGoal(userId, "vin");
      await this.record(userId, { event: "goal_selected", flow: "report", step: "vin" });
      return [
        {
          text: "Введите VIN из 17 символов или отправьте фото VIN в боте. Бесплатно проверим доступные корейские данные; это не полный платный отчёт.",
          buttons: START_BUTTONS,
          miniAppView: "vin",
        },
      ];
    }
    if ([FILTERS_ACTION, "/buy", "/begin", "/edit"].includes(command)) {
      this.setGoal(userId, "buy");
      if (draft?.[0] === "delete_confirm")
        return packReplies("Сначала подтвердите удаление или /cancel.", [], []);
      await this.record(userId, { event: "goal_selected", flow: "buyer", step: "buy" });
      if (!profile) {
        await this.record(userId, {
          event: "profile_step",
          flow: "buyer",
          step: "consent",
          outcome: "available",
        });
        return this.privacy(userId, null);
      }
      return this.filtersReply(profile);
    }
    if (command === "/cancel") {
      if (this.goals.get(userId) === "sell" && draft?.[0] !== "delete_confirm") {
        this.setGoal(userId, "home");
        return packReplies(
          "Ввод по вашему авто отменён. Сохранённая карточка авто и условия покупки не изменены.",
          [],
          START_BUTTONS,
        );
      }
      if (draft?.[0] !== "delete_confirm") {
        this.setGoal(userId, "home");
        return packReplies(
          "Текущее действие отменено. Сохранённые данные не изменены.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      }
      this.setGoal(userId, "home");
      this.deletions.delete(userId);
      const previous =
        draft?.[0] === "delete_confirm" ? (draft[1].previous as [string, Draft] | null) : null;
      if (previous) {
        await this.store.setDraft(userId, previous[0], previous[1]);
        this.setGoal(userId, "buy");
      } else await this.store.clearDraft(userId);
      let note = previous
        ? "Удаление отменено. Незавершённый ввод сохранён."
        : draft?.[0] === "delete_confirm"
          ? "Удаление отменено."
          : "Ввод отменён.";
      if (profile)
        note +=
          " Сохранённый поиск не изменён." +
          (profile.monitoring
            ? " Мониторинг остаётся включён."
            : " Мониторинг остаётся на паузе; /resume — включить.");
      return packReplies(note, [], profile ? menu(profile) : START_BUTTONS);
    }
    if (command === "/help")
      return packReplies(
        "/start — цели: покупка, VIN, продажа и обмен\n/vin — бесплатные корейские данные; можно отправить фото VIN\n/sell — продать или обменять своё авто на недвижимость / первоначальный взнос\n/mycar — сохранённое авто\n/orders — мои заказы, оплата и поддержка услуг\n/filters — настроить условия поиска в приложении\n/search — подходящие автомобили с фото\n/profile — сохранённые условия и их ограничения\n/resume — включить бесплатный мониторинг\n/pause — остановить уведомления\n/quiet HH:MM-HH:MM — тихие часы (Бишкек); /quiet off — отключить\n/privacy — данные и согласие\n/tips — советы\n/status — каталог\n/cancel — отменить текущее действие; сохранённые данные остаются\n/delete — удалить данные с подтверждением\n\nПокупка: условия настраиваются в приложении — автомобиль, бюджет, город и характеристики. Уведомления — только по вашему выбору.",
        [],
        profile ? menu(profile) : START_BUTTONS,
      );
    if (command === "/status")
      return packReplies(await this.catalogNote(), [], profile ? menu(profile) : START_BUTTONS);
    if (command === "/delete") {
      this.options.seller?.clear(userId);
      const previous = draft?.[0] === "delete_confirm" ? draft[1].previous : draft;
      const nonce = randomBytes(12).toString("base64url");
      if (profile || (draft && !this.deletions.has(userId)))
        await this.store.setDraft(userId, "delete_confirm", { nonce, previous });
      else {
        this.deletions.delete(userId);
        this.deletions.set(userId, ["delete_confirm", { nonce, previous: null }]);
        if (this.deletions.size > 2048) this.deletions.delete(this.deletions.keys().next().value!);
      }
      return packReplies(
        "Удалить карточку своего авто, условия покупки, незавершённый ввод, Telegram ID из профиля и настройки уведомлений из рабочей базы? После подтверждения мониторинг остановится. Резервные снимки могут содержать удалённые данные до 7 дней. Переписка в Telegram не удаляется. Отдельные записи заказов, платежей и заявок на возврат сохраняются; это удаление не отменяет заказ и не возвращает деньги.",
        [],
        [
          [
            ["Удалить мои данные", `delete:${nonce}`],
            ["Отмена", "/cancel"],
          ],
        ],
      );
    }
    if (text.startsWith("delete:")) {
      if (!draft || draft[0] !== "delete_confirm" || text !== `delete:${draft[1].nonce}`)
        return packReplies(
          "Подтверждение устарело. Для удаления используйте /delete.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      await this.store.deleteUser(userId);
      let analyticsDeleted = !this.options.analytics;
      try {
        analyticsDeleted = (await this.options.analytics?.forget(userId)) ?? true;
      } catch {
        /* Report incomplete erasure without undoing core deletion. */
      }
      this.deletions.delete(userId);
      this.setGoal(userId, "home");
      return packReplies(
        "Профиль покупки, карточка своего авто и незавершённый ввод удалены из рабочей базы. Уведомления остановлены. Переписка в Telegram не удалена; резервные снимки могут содержать удалённые данные до 7 дней. Записи заказов и платежей, если они есть, сохранены; заказы этим не отменяются." +
          (this.options.analytics
            ? analyticsDeleted
              ? "\n\nАналитика удалена, дальнейший сбор отключён."
              : "\n\nУдаление аналитики временно недоступно. Рабочие данные уже удалены; повторите /delete для завершения удаления аналитики."
            : ""),
        [],
        START_BUTTONS,
      );
    }
    if (
      ["/profile", "/search", "/pause", "/resume", "/tips", "/quiet"].includes(command) ||
      text.startsWith("page:")
    ) {
      if (!profile)
        return packReplies(
          "Сначала настройте условия поиска в приложении: «Настроить поиск».",
          [],
          START_BUTTONS,
        );
      if (command === "/profile" || command === "/search") this.setGoal(userId, "buy");
      if (command === "/profile")
        return packReplies(profileText(profile) + "\n\n" + FILTER_NOTE, [], menu(profile));
      if (command === "/quiet") {
        const value = text
          .slice(text.indexOf(" ") < 0 ? text.length : text.indexOf(" ") + 1)
          .trim();
        let start: number | null = null;
        let end: number | null = null;
        const match = /^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(
          value,
        );
        if (value.toLowerCase() !== "off") {
          if (!match)
            return packReplies(
              "Задайте /quiet 22:00-07:00 или /quiet off. Часовой пояс: Бишкек (UTC+6). Начало включительно, конец не включается; переход через полночь допустим. Тихие часы задерживают уведомления, но не включают мониторинг.",
              [],
              menu(profile),
            );
          start = Number(match[1]) * 60 + Number(match[2]);
          end = Number(match[3]) * 60 + Number(match[4]);
          if (start === end)
            return packReplies(
              "Начало и конец должны различаться. Для отключения: /quiet off.",
              [],
              menu(profile),
            );
        }
        profile = await this.store.setQuietHours(userId, start, end);
        if (!profile)
          return packReplies("Сначала настройте условия поиска в приложении.", [], START_BUTTONS);
        return packReplies("Тихие часы сохранены.\n\n" + profileText(profile), [], menu(profile));
      }
      if (command === "/pause") {
        profile = await this.store.setMonitoring(userId, false);
        if (profile)
          await this.record(userId, {
            event: "monitoring_paused",
            flow: "buyer",
            outcome: "success",
          });
        return packReplies(
          "Мониторинг приостановлен. Поиск остаётся доступным бесплатно.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      }
      if (command === "/resume") {
        if (draft?.[0] === "delete_confirm")
          return packReplies(
            "Сначала подтвердите удаление или отмените его: /cancel. Настройки мониторинга не изменены.",
            [],
          );
        if (draft)
          return packReplies(
            "Сначала завершите удаление или /cancel. Настройки мониторинга не изменены.",
            [],
          );
        if (!profile.monitoring) profile = await this.store.setMonitoring(userId, true);
        if (profile)
          await this.record(userId, {
            event: "monitoring_enabled",
            flow: "buyer",
            outcome: "success",
          });
        return packReplies(
          "Бесплатный мониторинг включён. Буду присылать новые совпадения в нашем каталоге и снижение цены. Уже собранные варианты смотрите через /search: повторно отправлять весь каталог не буду. Новая запись в каталоге не обязательно только что опубликована на сайте. /pause — остановить.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      }
      if (command === "/tips") return packReplies(tips(profile), [], menu(profile));
      let offset = 0;
      if (text.startsWith("page:")) {
        const parts = text.split(":");
        if (
          parts.length !== 3 ||
          parts[1] !== String(profile.revision) ||
          !/^[+-]?\d+$/.test(parts[2]!)
        )
          return packReplies("Откройте актуальную выдачу: /search.", [], menu(profile));
        offset = Number(parts[2]);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
          return packReplies("Откройте актуальную выдачу: /search.", [], menu(profile));
      }
      return this.search(profile, offset);
    }
    if (draft?.[0] === "delete_confirm")
      return packReplies(
        "Ожидаю подтверждение удаления. /delete — новая кнопка; /cancel — сохранить данные.",
        [],
        [],
      );
    if (
      command === "/sell" ||
      command === "/mycar" ||
      text.startsWith("seller:") ||
      this.goals.get(userId) === "sell"
    ) {
      if (command === "/sell" || command === "/mycar") this.setGoal(userId, "sell");
      const replies = await this.options.seller?.handle(userId, chatId, text, (event) =>
        this.record(userId, event),
      );
      if (replies) return replies;
      if (command === "/sell" || command === "/mycar")
        return packReplies("Раздел своего авто сейчас недоступен.", [], START_BUTTONS);
    }
    return packReplies(
      "Выберите цель. Условия поиска настраиваются в приложении.",
      [],
      profile ? menu(profile) : START_BUTTONS,
    );
  }
}
