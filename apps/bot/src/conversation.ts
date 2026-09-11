import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BODY_TYPES,
  BUDGET_SCOPES,
  enabledMarkets,
  enabledSources,
  type Listing,
  listingPrice,
  listingUrlAllowed,
  MARKETS,
  makeProfile,
  money,
  normalize,
  normalizeCity,
  type Profile,
  parseBudget,
  sourceStatus,
  TRANSMISSIONS,
  USE_CASES,
} from "@autodom/core";
import type { Store } from "@autodom/storage";
import { listingPhotoUrl } from "./media.js";

export type Button = readonly [string, string];
export type Buttons = readonly (readonly Button[])[];
export interface Reply {
  text: string;
  buttons: Buttons;
  photoUrl?: string;
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
const START_BUTTONS: Buttons = [
  [
    ["Начать подбор", "/start"],
    ["Данные и согласие", "/privacy"],
  ],
];
const OPTIONAL_DEFAULTS = {
  city: "",
  body_type: "",
  year_min: null,
  mileage_max_km: null,
  transmission: "",
  use_case: "",
  allow_import: null,
  purchase_by: "",
};
const FIELD_LABELS: Record<string, string> = {
  market: "Рынок",
  currency: "Валюта",
  budget: "Бюджет",
  query: "Марки и модели",
  budget_scope: "Что входит в бюджет",
  city: "Город объявления",
  body_type: "Кузов",
  year_min: "Год от",
  mileage_max_km: "Пробег до, км",
  transmission: "Коробка передач",
  use_case: "Для чего автомобиль",
  allow_import: "Готовность ждать импорт",
  purchase_by: "Планируемая дата покупки",
};
const CHOICES: Record<string, Readonly<Record<string, string>>> = {
  budget_scope: BUDGET_SCOPES,
  body_type: BODY_TYPES,
  transmission: TRANSMISSIONS,
  use_case: USE_CASES,
  allow_import: { yes: "Готов ждать импорт", no: "Без импорта" },
};
const FILTER_NOTE =
  "Жёсткие фильтры поиска и уведомлений: рынок, цена объявления, слова марки/модели, город, кузов, год, пробег, коробка и запрет импорта, если выбраны. Неизвестные или нераспознанные данные не проходят соответствующий выбранный фильтр. Город — место объявления, не пункт доставки.\nЦель и дата покупки — только заметки: не определяют пригодность машины и не останавливают мониторинг.\nБюджет «под ключ» исключает иностранные объявления: полной стоимости ввоза пока нет. Даже для местных объявлений проверяется цена машины, а не все расходы покупки. Аукционы сравниваются с бюджетом только по Buy Now, пока предложение активно: текущая ставка, оценка и результат завершённых торгов не являются ценой покупки. Готовность к импорту не включает выключенные источники и не гарантирует срок доставки.";
const USE_CASE_TIPS: Record<string, string> = {
  city: "Для городских поездок проверьте реальные габариты парковки и расход в пробках.",
  family:
    "Для семейных поездок проверьте крепления детских кресел, ремни и место для пассажиров и багажа.",
  work: "Для работы уточните допустимую нагрузку, стоимость простоя и доступность расходников.",
  travel:
    "Для дальних поездок проверьте запасное колесо, тормоза и историю обслуживания перед выездом.",
};
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[char]!,
  );
}
function bishkekTime(timestamp: number): string {
  const date = new Date((timestamp + 6 * 3600) * 1000);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function privacyText(): string {
  return (
    "<b>Autodom — помощник при покупке автомобиля</b>\n\n" +
    `Бесплатный поиск по бюджету и пожеланиям. Включённые источники: ${enabledSources()
      .map((source) => escapeHtml(source.name))
      .join(", ")}. ` +
    "Иностранные адаптеры без согласованного доступа не собирают и не показывают объявления. Цена за рубежом не включает доставку, таможню, оформление и возможный ремонт; доступность экспорта не подтверждена. Платные услуги не подключены.\n\n" +
    "После вашего согласия сохраняю на сервере проекта Telegram ID, ID личного чата, черновик рынка, бюджета, моделей и дополнительных предпочтений (город, кузов, год, пробег, коробка, цель, готовность к импорту, планируемая дата покупки), затем профиль и настройки уведомлений. Это нужно для поиска и бесплатного мониторинга. Бюджет и контакты партнёрам не передаются; профиль доступен только вам — в личном чате и Mini App с проверенной сессией Telegram. Уведомления отправляю в личный чат. Данные хранятся до удаления: /delete удаляет профиль и незавершённый ввод из рабочей базы. Локальные резервные копии хранятся до 7 дней; удалённые данные могут оставаться в них до истечения этого срока.\n\n" +
    "В Mini App избранное (до 100 ID объявлений) хранится на устройстве отдельно для вашего Telegram-аккаунта, а сравнение — только в текущем сеансе. Хранилище избранного не содержит бюджета или данных авторизации. Удаление данных внутри Mini App очищает избранное на текущем устройстве; /delete в чате не очищает хранилища устройств. Фотографии загружаются с серверов площадок: им виден IP вашего устройства, но бюджет и профиль не передаются. Через кнопку «Поделиться объявлением» отправляется только публичное объявление.\n\n" +
    "Профиль сохраняется только после проверки и кнопки «Сохранить». Дополнительные поля необязательны. Цель и дата покупки — заметки, не оценка пригодности автомобиля и не срок остановки мониторинга. Мониторинг включается отдельно. /privacy — это описание; /cancel — отмена ввода. До нажатия «Согласен на хранение» новый черновик не сохраняется."
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
  return (
    `Рынок: <b>${MARKETS[profile.market as keyof typeof MARKETS]}</b>\nБюджет: <b>${budget}</b> · ${BUDGET_SCOPES[profile.budget_scope as keyof typeof BUDGET_SCOPES]}\nАвтомобили: ${profile.query ? escapeHtml(profile.query) : "любые модели"}\n` +
    `Город объявления: ${profile.city ? escapeHtml(profile.city) : "любой"}\nКузов: ${BODY_TYPES[profile.body_type as keyof typeof BODY_TYPES] ?? "любой"}; год от: ${profile.year_min ?? "не задан"}\n` +
    `Пробег до: ${profile.mileage_max_km === null ? "не задан" : `${profile.mileage_max_km} км`}; коробка: ${TRANSMISSIONS[profile.transmission as keyof typeof TRANSMISSIONS] ?? "любая"}\n` +
    `Импорт: ${profile.allow_import === true ? "готов ждать" : profile.allow_import === false ? "исключён" : "не уточнён, разрешён из включённых источников"}\n` +
    `Цель (заметка): ${USE_CASES[profile.use_case as keyof typeof USE_CASES] ?? "не задана"}; дата покупки (заметка): ${profile.purchase_by ? escapeHtml(profile.purchase_by) : "не задана"}\n` +
    `Мониторинг: ${profile.monitoring ? "включён" : "на паузе"}\nТихие часы (Бишкек, UTC+6): ${quiet}. /quiet — настройка.`
  );
}
export function menu(profile: Profile): Buttons {
  const monitor: Button = profile.monitoring
    ? ["Приостановить", `monitor:${profile.revision}:off`]
    : ["Включить мониторинг", `monitor:${profile.revision}:on`];
  return [
    [["Найти автомобили", "/search"]],
    [monitor, ["Изменить поиск", "/edit"]],
    [
      ["Мой поиск", "/profile"],
      ["Советы", "/tips"],
    ],
    [["Данные и согласие", "/privacy"]],
  ];
}
export function listingText(listing: Listing, currency: string): string {
  let title = escapeHtml(listing.title.slice(0, 140));
  if (listingUrlAllowed(listing.source, listing.url))
    title = `<a href="${escapeHtml(listing.url)}">${title}</a>`;
  const price = listingPrice(listing, currency);
  const original = listing.original_price_minor;
  let priceText: string;
  if (original !== null && listing.original_currency) {
    priceText =
      (listing.price_kind === "buy_now" ? "Buy Now — цена выкупа: " : "Цена объявления: ") +
      money(original, listing.original_currency);
    if (listing.original_currency !== currency)
      priceText +=
        price !== null
          ? ` (≈ ${money(price, currency)} по НБКР)`
          : " (свежий пересчёт в валюту бюджета недоступен)";
  } else priceText = price !== null ? money(price, currency) : "цена не указана";
  const parts = [
    listing.year ? String(listing.year) : "год не указан",
    ...[listing.mileage, listing.transmission, listing.body_type, listing.trim]
      .filter(Boolean)
      .map((value) => value.slice(0, 80)),
  ];
  if (listing.registration_month)
    parts.push(`регистрация: ${listing.registration_month.slice(0, 10)}`);
  const observed =
    listing.observed_at !== null
      ? `${bishkekTime(listing.observed_at)} (Бишкек, UTC+6)`
      : "время наблюдения неизвестно";
  let text =
    `<b>${title}</b>\n${priceText} · ${listing.city ? escapeHtml(listing.city.slice(0, 80)) : "город не указан"} · ${MARKETS[listing.market as keyof typeof MARKETS]}\n${escapeHtml(parts.join(" · "))}\n` +
    `Статус на сайте: ${escapeHtml(listing.availability.slice(0, 50)) || "не указан"}. Источник: ${escapeHtml(listing.source)}.\nПоследнее наблюдение: ${observed}. Цену и наличие подтвердите у продавца.`;
  if (listing.market !== "KG") {
    text += "\nДоставка, таможня, оформление и ремонт не включены. Экспорт не подтверждён.";
    text += listing.condition
      ? `\n${escapeHtml(listing.condition.slice(0, 600))}`
      : "\nИстория ДТП и документов неизвестна.";
    text += " Независимая проверка не выполнена.";
    if (listing.fx_date && price !== null && listing.original_currency !== currency)
      text += `\nДаты курсов НБКР: ${escapeHtml(listing.fx_date)}.`;
  }
  if (listing.auction_house || listing.auction_status) {
    const status: Record<string, string> = {
      active: "активен на момент наблюдения",
      ended: "завершён",
      unknown: "не подтверждён",
    };
    text += `\nАукцион: ${escapeHtml(listing.auction_house.slice(0, 30)) || "не указан"}, лот ${escapeHtml(listing.auction_lot.slice(0, 40)) || "не указан"} — ${status[listing.auction_status] ?? "не подтверждён"}.`;
    if (listing.vin) text += `\nVIN / номер кузова: ${escapeHtml(listing.vin.slice(0, 40))}.`;
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
  constructor(
    private readonly store: ConversationStore,
    private readonly consentSecret: string,
  ) {
    if (typeof consentSecret !== "string" || !consentSecret.trim())
      throw new Error("A stable consent signing secret is required");
  }

  private consentSignature(userId: number, issuedAt: string): Buffer {
    return createHmac("sha256", this.consentSecret)
      .update(`autodom:storage-consent:v1:${userId}:${issuedAt}`)
      .digest();
  }

  private validConsent(userId: number, callback: string): boolean {
    const parts = /^consent:([0-9a-z]{1,11}):([A-Za-z0-9_-]{43})$/.exec(callback);
    if (!parts) return false;
    const issuedAt = Number.parseInt(parts[1]!, 36);
    const age = Math.floor(Date.now() / 1000) - issuedAt;
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt.toString(36) !== parts[1] ||
      age < 0 ||
      age >= 300
    )
      return false;
    const signature = Buffer.from(parts[2]!, "base64url");
    return (
      signature.toString("base64url") === parts[2] &&
      timingSafeEqual(signature, this.consentSignature(userId, parts[1]!))
    );
  }

  private privacy(userId: number, profile: Profile | null): Reply[] {
    if (profile) return packReplies(privacyText(), [], menu(profile));
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw new RangeError("Telegram user ID must be a positive safe integer");
    // Only Telegram holds this credential; replicas need no pre-consent user state.
    const issuedAt = Math.floor(Date.now() / 1000).toString(36);
    const signature = this.consentSignature(userId, issuedAt).toString("base64url");
    return packReplies(
      privacyText(),
      [],
      [[["Согласен на хранение — начать подбор", `consent:${issuedAt}:${signature}`]]],
    );
  }
  private async begin(userId: number, profile: Profile | null): Promise<Reply[]> {
    const data: Draft = { consent: true, budget_scope: "car", ...OPTIONAL_DEFAULTS };
    if (profile) {
      await this.store.setMonitoring(userId, false);
      for (const field of Object.keys(OPTIONAL_DEFAULTS) as (keyof typeof OPTIONAL_DEFAULTS)[])
        data[field] = profile[field];
      Object.assign(data, {
        market: profile.market,
        currency: profile.currency,
        minimum: profile.budget_min_minor,
        maximum: profile.budget_max_minor,
        query: profile.query,
        budget_scope: profile.budget_scope,
      });
    }
    const markets = enabledMarkets();
    if (markets.length === 1) data.market = markets[0];
    return this.prompt(userId, markets.length === 1 ? "currency" : "market", data);
  }
  private draftProfile(userId: number, data: Draft, profile: Profile | null): Profile {
    return makeProfile({
      user_id: userId,
      chat_id: userId,
      currency: data.currency as Profile["currency"],
      budget_min_minor: data.minimum as number,
      budget_max_minor: data.maximum as number,
      query: data.query as string,
      market: (data.market ?? "KG") as Profile["market"],
      budget_scope: (data.budget_scope ?? "car") as Profile["budget_scope"],
      quiet_start_minute: profile?.quiet_start_minute ?? null,
      quiet_end_minute: profile?.quiet_end_minute ?? null,
      city: (data.city ?? "") as string,
      body_type: (data.body_type ?? "") as Profile["body_type"],
      year_min: (data.year_min ?? null) as number | null,
      mileage_max_km: (data.mileage_max_km ?? null) as number | null,
      transmission: (data.transmission ?? "") as Profile["transmission"],
      use_case: (data.use_case ?? "") as Profile["use_case"],
      allow_import: (data.allow_import ?? null) as boolean | null,
      purchase_by: (data.purchase_by ?? "") as string,
    });
  }
  private async prompt(
    userId: number,
    state: string,
    original: Draft,
    error = "",
  ): Promise<Reply[]> {
    const data: Draft = { ...original, nonce: randomBytes(12).toString("base64url") };
    await this.store.setDraft(userId, state, data);
    const choice = (label: string, value: string): Button => [
      label,
      `draft:${data.nonce}:${state}:${value}`,
    ];
    let text: string;
    let buttons: Buttons;
    if (state === "review") {
      const candidate = this.draftProfile(userId, data, await this.store.getProfile(userId));
      text =
        "<b>Проверьте поиск перед сохранением</b>\nЧто входит в ваш бюджет? При первом вводе по умолчанию — цена автомобиля. Можно сохранить сразу или уточнить любое поле; незаполненные поля не добавляют ограничений.\n\n" +
        profileText(candidate) +
        "\n\n" +
        FILTER_NOTE +
        "\n\nПока это черновик. /cancel — оставить прежний поиск; мониторинг останется на паузе.";
      buttons = [
        [choice("Сохранить поиск", "save")],
        ...Object.entries(FIELD_LABELS).map(([field, label]) => [choice(label, `edit.${field}`)]),
      ];
    } else {
      const prompts: Record<string, string> = {
        market:
          "На каком рынке искать? Иностранная цена не включает доставку, таможню, оформление и ремонт.",
        currency: "В какой валюте задать бюджет? Значение бюджета уточняется перед сохранением.",
        budget: `Какой бюджет в ${data.pending_currency ?? data.currency ?? "USD"}? Например: 15000, 15к или 10000–15000. Без обозначения валюты.`,
        query:
          "Какие автомобили рассматриваете? Например: Toyota Camry, Honda Accord. Запятая разделяет альтернативы; внутри варианта все слова обязательны. Если не определились — «Пока не знаю».",
        budget_scope:
          "Что входит в бюджет? Цена автомобиля — сравнение с ценой объявления. Под ключ — иностранные объявления исключены, пока нет полной стоимости ввоза; для местных проверяется только цена машины, дополнительные расходы не рассчитаны.",
        city: "Город объявления (до 80 символов), например Бишкек. Это место автомобиля в источнике, не адрес доставки. При выборе города объявления без известного города исключаются.",
        body_type: "Какой кузов? Неизвестный или нераспознанный кузов не пройдёт выбранный фильтр.",
        year_min: `Самый ранний год выпуска: целое число от 1900 до ${new Date().getUTCFullYear() + 1}. Неизвестный год не пройдёт фильтр.`,
        mileage_max_km:
          "Максимальный пробег в километрах: целое число от 0 до 10 000 000. Можно разделять тысячи пробелами. Неизвестный пробег не пройдёт фильтр.",
        transmission:
          "Какая коробка передач? Неизвестная или нераспознанная коробка не пройдёт фильтр.",
        use_case:
          "Для чего автомобиль? Это заметка для общих советов, не оценка пригодности конкретной модели и не фильтр.",
        allow_import:
          "Готовы ждать импорт? «Без импорта» исключает зарубежные объявления. Готовность не гарантирует срок и не включает выключенные источники; бюджет под ключ всё равно исключает иностранные объявления.",
        purchase_by:
          "Планируемая дата покупки: ГГГГ-ММ-ДД (например 2026-12-31) или ДД.ММ.ГГГГ. Это заметка, не фильтр и не дата автоматической остановки мониторинга. Прошлая дата допустима.",
      };
      text =
        prompts[state] ??
        "Черновик использует прежний шаг. /edit — начать ввод заново; /cancel — отменить.";
      let choices = CHOICES[state] ?? {};
      if (state === "market") {
        const markets = enabledMarkets();
        choices = Object.fromEntries(
          (markets.length > 1 ? [...markets, "ALL"] : markets).map((market) => [
            market,
            MARKETS[market as keyof typeof MARKETS],
          ]),
        );
      } else if (state === "currency") choices = { USD: "Доллары США · USD", KGS: "Сомы · KGS" };
      buttons = Object.entries(choices).map(([value, label]) => [choice(label, value)]);
      if (state === "query" || Object.hasOwn(OPTIONAL_DEFAULTS, state))
        buttons = [
          ...buttons,
          [
            choice(
              state === "query"
                ? "Пока не знаю / без ограничения"
                : "Не знаю / пропустить (снять значение)",
              "skip",
            ),
          ],
        ];
      if (
        (data.return_review || ["currency", "budget", "query"].includes(state)) &&
        (state !== "currency" || data.return_review || enabledMarkets().length > 1)
      )
        buttons = [...buttons, [choice("Назад — сохранить прежнее значение", "back")]];
      text += "\n/cancel — отменить весь ввод. Мониторинг на время изменений приостановлен.";
    }
    return packReplies((error ? escapeHtml(error) + "\n\n" : "") + text, [], buttons);
  }
  private async advance(userId: number, state: string, data: Draft): Promise<Reply[]> {
    const returnReview = data.return_review;
    delete data.return_review;
    const next: Record<string, string> = {
      market: "currency",
      currency: "budget",
      budget: "query",
    };
    return this.prompt(userId, returnReview ? "review" : (next[state] ?? "review"), data);
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
      lines.push("Рынок поиска сейчас выключен. Выберите доступный рынок через /edit.");
    lines.push(
      "Это не весь рынок. В выдаче — наблюдения за последние 48 часов; зарубежные объявления означают публикацию на сайте, а не подтверждённое наличие.",
    );
    if (profile && ["KR", "ALL"].includes(profile.market))
      lines.push(
        "Для цен KRW нужен свежий курс НБКР; без него сравнение по бюджету не выполняется.",
      );
    return lines.join("\n");
  }
  async search(profile: Profile, offset = 0): Promise<Reply[]> {
    const count = await this.store.countMatches(profile);
    if (offset >= count && offset)
      return packReplies("Выдача изменилась. Откройте её заново: /search.", [], menu(profile));
    const listings = await this.store.search(profile, 5, offset);
    if (!listings.length)
      return packReplies(
        "Совпадений в свежей собранной части каталога нет. Это не означает, что таких машин нет на всём рынке.\n\n" +
          profileText(profile) +
          "\n\n" +
          FILTER_NOTE +
          "\n\n" +
          (await this.catalogNote(profile)) +
          "\n\nМожно изменить пожелания или включить бесплатный мониторинг.",
        [],
        menu(profile),
      );
    const heading =
      `<b>Совпадения по фильтрам · ${offset + 1}–${offset + listings.length} из ${count}</b>\n` +
      profileText(profile) +
      "\n\n" +
      FILTER_NOTE +
      "\nСначала — недавно найденные варианты.\n" +
      (await this.catalogNote(profile));
    let buttons = menu(profile);
    if (offset + listings.length < count)
      buttons = [
        [["Ещё варианты", `page:${profile.revision}:${offset + listings.length}`]],
        ...buttons,
      ];
    return [
      ...packReplies(heading, []),
      ...listings.map((listing, index): Reply => {
        const photoUrl = listingPhotoUrl(listing);
        return {
          text: listingText(listing, profile.currency),
          buttons: index === listings.length - 1 ? buttons : [],
          ...(photoUrl ? { photoUrl } : {}),
        };
      }),
    ];
  }

  async current(userId: number): Promise<Reply[]> {
    const draft = await this.store.getDraft(userId);
    if (draft?.[0] === "delete_confirm") return this.handle(userId, userId, "/delete");
    if (draft) return this.prompt(userId, draft[0], draft[1]);
    const profile = await this.store.getProfile(userId);
    return profile ? this.handle(userId, userId, "/profile") : this.privacy(userId, null);
  }

  async handle(userId: number, chatId: number, input: string): Promise<Reply[]> {
    if (!Number.isSafeInteger(userId) || userId <= 0 || chatId !== userId)
      return [
        {
          text: "Бюджет, профиль и уведомления доступны только в личном чате с ботом.",
          buttons: [],
        },
      ];
    const text = input.trim();
    let profile = await this.store.getProfile(userId);
    let command = text.split(/\s+/, 1)[0]?.split("@", 1)[0]?.toLowerCase() ?? "";
    const draft = await this.store.getDraft(userId);
    if (text.startsWith("consent:")) {
      if (profile || draft || !this.validConsent(userId, text))
        return packReplies(
          "Согласие не принято: откройте актуальное описание /privacy.",
          [],
          profile ? menu(profile) : START_BUTTONS,
        );
      return this.begin(userId, null);
    }
    let action: string | null = null;
    if (text.startsWith("draft:")) {
      const parts = text.split(":");
      if (
        !draft ||
        parts.length !== 4 ||
        parts[1] !== draft[1].nonce ||
        parts[2] !== draft[0] ||
        draft[0] === "delete_confirm"
      )
        return packReplies(
          "Эта кнопка устарела или не относится к вашему текущему шагу. Продолжите текущий ввод или /edit.",
          [],
        );
      const state = draft[0];
      action = parts[3]!;
      let allowed = Object.keys(CHOICES[state] ?? {});
      if (state === "review")
        allowed = ["save", ...Object.keys(FIELD_LABELS).map((field) => `edit.${field}`)];
      else if (state === "currency") allowed.push("USD", "KGS");
      else if (state === "market") {
        const markets = enabledMarkets();
        allowed.push(...markets, ...(markets.length > 1 ? ["ALL"] : []));
      }
      if (state === "query" || Object.hasOwn(OPTIONAL_DEFAULTS, state)) allowed.push("skip");
      if (
        draft[1].return_review ||
        ["budget", "query"].includes(state) ||
        (state === "currency" && enabledMarkets().length > 1)
      )
        allowed.push("back");
      if (!allowed.includes(action))
        return packReplies(
          "Эта кнопка не относится к текущему шагу. Продолжите ввод или /cancel.",
          [],
        );
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
    if (command === "/privacy") return this.privacy(userId, profile);
    if (command === "/start")
      return profile
        ? packReplies("Ваш сохранённый поиск:\n\n" + profileText(profile), [], menu(profile))
        : this.privacy(userId, null);
    if (command === "/begin" || command === "/edit") {
      if (!profile && draft?.[1].consent !== true) return this.privacy(userId, null);
      return this.begin(userId, profile);
    }
    if (command === "/cancel") {
      const previous =
        draft?.[0] === "delete_confirm" ? (draft[1].previous as [string, Draft] | null) : null;
      if (previous) await this.store.setDraft(userId, previous[0], previous[1]);
      else await this.store.clearDraft(userId);
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
        "/start — начать или открыть поиск\n/app — открыть Mini App, если он подключён: пожелания, автомобили и фотографии\n/search — подходящие автомобили с фото источника, если оно доступно\n/profile — бюджет и пожелания\n/edit — изменить поиск\n/resume — включить бесплатный мониторинг\n/pause — приостановить\n/quiet HH:MM-HH:MM — тихие часы (Бишкек, UTC+6); /quiet off — отключить\n/privacy — хранение данных и согласие\n/tips — советы перед покупкой\n/status — состояние каталога\n/cancel — отменить ввод\n/delete — удалить мои данные\n\nБюджет можно ввести как 15000, 15к или 10000–15000. Модели — через запятую: Toyota Camry, Honda Accord. Внутри одного варианта все слова обязательны. Можно выбрать «Пока не знаю».",
        [],
        profile ? menu(profile) : START_BUTTONS,
      );
    if (command === "/status")
      return packReplies(await this.catalogNote(), [], profile ? menu(profile) : START_BUTTONS);
    if (command === "/delete") {
      if (!profile && !draft) return packReplies("Сохранённых данных нет.", [], START_BUTTONS);
      const previous = draft?.[0] === "delete_confirm" ? draft[1].previous : draft;
      const nonce = randomBytes(12).toString("base64url");
      await this.store.setDraft(userId, "delete_confirm", { nonce, previous });
      return packReplies(
        "Удалить Telegram ID, бюджет, пожелания, незавершённый ввод и настройки уведомлений из рабочей базы? Мониторинг остановится сразу. Локальные резервные копии хранятся до 7 дней. Восстановить поиск здесь можно только новым вводом.",
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
      return packReplies(
        "Профиль и незавершённый ввод удалены. Уведомления остановлены.",
        [],
        START_BUTTONS,
      );
    }
    if (
      ["/profile", "/search", "/pause", "/resume", "/tips", "/quiet"].includes(command) ||
      text.startsWith("page:")
    ) {
      if (!profile)
        return packReplies("Сначала задайте бюджет и пожелания через /start.", [], START_BUTTONS);
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
          return packReplies("Сначала задайте бюджет и пожелания через /start.", [], START_BUTTONS);
        return packReplies("Тихие часы сохранены.\n\n" + profileText(profile), [], menu(profile));
      }
      if (command === "/pause") {
        profile = await this.store.setMonitoring(userId, false);
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
            "Сначала завершите изменение поиска или /cancel. Мониторинг остаётся на паузе.",
            [],
          );
        if (!profile.monitoring) profile = await this.store.setMonitoring(userId, true);
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
    if (!draft)
      return packReplies(
        "Используйте /edit для изменения пожеланий или /search для подбора.",
        [],
        profile ? menu(profile) : START_BUTTONS,
      );
    const [state, data] = draft;
    if (state === "delete_confirm")
      return packReplies(
        "Ожидаю подтверждение удаления. /delete — новая кнопка; /cancel — сохранить данные.",
        [],
      );
    if (!profile && data.consent !== true) return this.privacy(userId, null);
    if (
      action === null &&
      (text.includes(":") || text.startsWith("/") || /[\p{Cc}&&\p{ASCII}]/v.test(text))
    )
      return packReplies(
        "Команда или кнопка не может быть значением поля. Продолжите ввод или /cancel.",
        [],
      );
    if (state === "review") {
      if (action === "save") {
        profile = await this.store.saveProfile(this.draftProfile(userId, data, profile));
        await this.store.clearDraft(userId);
        return [
          {
            text: "Поиск сохранён. Подбор и мониторинг бесплатны. Уведомления включите отдельной кнопкой.",
            buttons: [],
          },
          ...(await this.search(profile)),
        ];
      }
      if (action?.startsWith("edit."))
        return this.prompt(userId, action.slice(5), { ...data, return_review: true });
      return this.prompt(
        userId,
        "review",
        data,
        "Для сохранения нажмите «Сохранить», для исправления — нужное поле.",
      );
    }
    if (action === "back") {
      delete data.pending_currency;
      if (data.return_review) {
        delete data.return_review;
        return this.prompt(userId, "review", data);
      }
      const previous: Record<string, string> = {
        currency: "market",
        budget: "currency",
        query: "budget",
      };
      return this.prompt(userId, previous[state]!, data);
    }
    const unknown = [
      "любые",
      "любой",
      "любая",
      "не знаю",
      "пока не знаю",
      "все",
      "пропустить",
    ].includes(text.toLowerCase());
    if (
      action === "skip" ||
      (action === null && unknown && (state === "query" || Object.hasOwn(OPTIONAL_DEFAULTS, state)))
    ) {
      data[state] = Object.hasOwn(OPTIONAL_DEFAULTS, state)
        ? OPTIONAL_DEFAULTS[state as keyof typeof OPTIONAL_DEFAULTS]
        : "";
      return this.advance(userId, state, data);
    }
    const value = action ?? text;
    if ([...value].length > 160)
      return this.prompt(
        userId,
        state,
        data,
        "Слишком длинный ввод: максимум 160 символов, для города — 80.",
      );
    if (state === "market") {
      const market = value.toUpperCase();
      const markets = enabledMarkets();
      if (!(markets.length > 1 ? [...markets, "ALL"] : markets).includes(market))
        return this.prompt(userId, state, data, "Выберите включённый рынок кнопкой.");
      data.market = market;
    } else if (state === "currency") {
      const aliases: Record<string, string> = { СОМ: "KGS", СОМЫ: "KGS", $: "USD" };
      const currency = aliases[value.toUpperCase()] ?? value.toUpperCase();
      if (!["USD", "KGS"].includes(currency))
        return this.prompt(userId, state, data, "Выберите USD или KGS.");
      if (data.return_review && currency !== data.currency)
        return this.prompt(userId, "budget", { ...data, pending_currency: currency });
      data.currency = currency;
    } else if (state === "budget") {
      try {
        [data.minimum, data.maximum] = parseBudget(value);
      } catch (error) {
        return this.prompt(
          userId,
          state,
          data,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (Object.hasOwn(data, "pending_currency")) {
        data.currency = data.pending_currency;
        delete data.pending_currency;
      }
    } else if (state === "query") {
      if (value.split(",").length > 5 || value.split(",").some((part) => !normalize(part)))
        return this.prompt(
          userId,
          state,
          data,
          "Укажите до пяти непустых вариантов с буквами или цифрами через запятую, не более 160 символов, либо выберите «Пока не знаю».",
        );
      data.query = value;
    } else if (Object.hasOwn(CHOICES, state)) {
      const choices = CHOICES[state]!;
      let selected = value.toLowerCase();
      if (!Object.hasOwn(choices, selected))
        selected =
          Object.entries(choices).find(([, label]) => label.toLowerCase() === selected)?.[0] ?? "";
      if (!Object.hasOwn(choices, selected))
        return this.prompt(userId, state, data, "Выберите один из вариантов кнопкой.");
      data[state] = state === "allow_import" ? selected === "yes" : selected;
    } else if (state === "city") {
      if ([...value].length > 80 || !/\p{L}/u.test(normalizeCity(value)))
        return this.prompt(
          userId,
          state,
          data,
          "Введите название города с буквами, не более 80 символов, или пропустите.",
        );
      data.city = value;
    } else if (state === "year_min" || state === "mileage_max_km") {
      const digits = state === "mileage_max_km" ? value.replace(/[ \u00a0]/g, "") : value;
      const minimum = state === "year_min" ? 1900 : 0;
      const maximum = state === "year_min" ? new Date().getUTCFullYear() + 1 : 10_000_000;
      if (!/^[0-9]+$/.test(digits) || Number(digits) < minimum || Number(digits) > maximum)
        return this.prompt(
          userId,
          state,
          data,
          `Введите целое число от ${minimum} до ${maximum} или пропустите.`,
        );
      data[state] = Number(digits);
    } else if (state === "purchase_by") {
      const dotted = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/.exec(value);
      const iso = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : value;
      const date = new Date(iso + "T00:00:00Z");
      if (
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso) ||
        iso.startsWith("0000") ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== iso
      )
        return this.prompt(
          userId,
          state,
          data,
          "Введите существующую календарную дату ГГГГ-ММ-ДД или ДД.ММ.ГГГГ, либо пропустите.",
        );
      data[state] = iso;
    } else
      return packReplies(
        "Черновик использует прежний шаг. /edit — начать ввод заново; /cancel — отменить.",
        [],
      );
    return this.advance(userId, state, data);
  }
}
