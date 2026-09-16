import {
  type Car365Record,
  type EncarListing,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  VIN_PROVIDERS,
  type VinCheckResult,
  type VinProvider,
  vinGoogleSearchUrl,
} from "@autodom/core/vin";
import {
  isVinArchiveLotUrl,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveLot,
  type VinArchiveProvider,
  type VinArchiveStatus,
} from "@autodom/core/vin-archive";
import { escapeHtml } from "./html.js";
import { KOREAN_REPORT_PREVIEW } from "./korean-report-example.js";

export const VIN_ARCHIVE_LABEL = "Архивные фото США / ОАЭ";
export const VIN_ARCHIVE_CARWAY_NOTICE =
  "Архив ОАЭ — сторонний, не официальная история аукциона. В записях возможны противоречия; полнота поиска и фотографий не подтверждена.";
export const VIN_ARCHIVE_DISCLOSURE = `«${VIN_ARCHIVE_LABEL}» — отдельный поиск сохранившихся записей и фотографий. VIN передаётся подключённым архивам только по нажатию этой кнопки. Архивы неполные; отсутствие результата не означает отсутствие ДТП.`;
export const VIN_ARCHIVE_STATUS_TEXT: Record<VinArchiveStatus, string> = {
  available: "Найдены сохранившиеся фотографии.",
  no_photos: "Архивные записи найдены, но фотографии недоступны.",
  not_found: "По этому VIN архивные записи не найдены. Это не подтверждает отсутствие истории.",
  unavailable: "Поиск временно недоступен. Результат неизвестен — это не отсутствие истории.",
  disabled: "Поиск архивных фото не подключён. Запрос не отправлен.",
};

const archiveDateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function vinArchiveTime(value: number | null): string {
  return value === null ? "неизвестно" : `${archiveDateTime.format(new Date(value * 1000))} UTC`;
}

const archiveBid = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "USD",
});

export function vinArchiveLotText(lot: VinArchiveLot, provider: VinArchiveProvider): string {
  return [
    provider === "carway" ? "Архивная запись ОАЭ." : "Архивная запись США.",
    ...(provider === "carway"
      ? [
          "Исход торгов, дата аукциона и финальная ставка не подтверждены.",
          "Пробег не подтверждён; данные архива не заменяют проверку автомобиля.",
        ]
      : [
          ...lot.events.map((event) =>
            [
              event.status === "sold"
                ? "Продан по данным архива."
                : "Торги завершены; продажа не подтверждена.",
              `Дата аукциона: ${event.auction_date ?? vinArchiveTime(event.auction_at)}.`,
              ...(event.auction_date !== null && event.auction_at !== null
                ? [`Время: ${vinArchiveTime(event.auction_at)}.`]
                : []),
              `Финальная ставка: ${event.final_bid_usd_minor === null ? "неизвестна / скрыта" : archiveBid.format(event.final_bid_usd_minor / 100)}.`,
            ].join(" "),
          ),
          "Ставка не равна цене сделки и не гарантирует покупку. Статус не подтверждает переход права собственности.",
        ]),
    ...(!lot.photos_complete
      ? ["Полнота галереи не подтверждена; часть фотографий может быть недоступна."]
      : []),
    ...(!lot.photos.length ? ["Фотографии этого лота недоступны."] : []),
  ].join("\n");
}

export function vinArchiveSourceUrl(
  value: string,
  provider: VinArchiveProvider,
  lot?: VinArchiveLot,
  vin?: string,
): string | null {
  return lot
    ? vin && isVinArchiveLotUrl(value, provider, lot.auction, lot.lot_id, vin)
      ? value
      : null
    : value === VIN_ARCHIVE_SOURCE_URLS[provider]
      ? value
      : null;
}

export const VIN_DISCLOSURE =
  "VIN передаётся подключённым сервисам для бесплатной проверки корейских записей и, при отсутствии данных, расшифровки характеристик. Платные отчёты не покупаем. Поиск в Google и аукционных архивах — только по отдельному нажатию. VIN не сохраняется в вашем поиске или профиле.";
export const VIN_NOT_ENABLED = "Бесплатная проверка VIN пока не подключена. Запрос не отправлен.";
export const VIN_HELP = `Отправьте /vin и VIN: 17 латинских букв и цифр, без I, O, Q. Например: /vin KMHDU41DBAU123456.\n\n${VIN_DISCLOSURE}`;
export const VIN_CAUTION =
  "Отсутствие записей не означает отсутствие ДТП или ограничений. Записанный пробег — не текущий реальный пробег. Сверьте VIN с автомобилем и документами.";
export const VIN_GOOGLE_SEARCH_LABEL = "Искать VIN в Google";
export const VIN_GOOGLE_SEARCH_NOTICE =
  "Поиск точного VIN в Google для любого рынка. VIN передаётся Google только при нажатии. Отсутствие результатов не означает чистую историю.";

export const VIN_SOURCE_NAMES: Record<VinProvider, string> = {
  carhistory: "Полный отчёт · Корея",
  car365: "Экспорт и пробег · Корея",
  encar: "Архив объявлений · Корея",
  nhtsa_vpic: "Характеристики · рынок США",
  autodev: "Характеристики · другие рынки",
  vagvin_carfax: "Доступность CARFAX · VAGVIN",
};

export function confirmedEncarListings(result: VinCheckResult): EncarListing[] {
  const history = result.encar?.data;
  if (
    result.encar?.status !== "available" ||
    !history ||
    normalizeVin(result.vin) !== result.vin ||
    history.vin !== result.vin
  )
    return [];
  return history.listings.filter(
    (listing) => listing.vin === result.vin && encarListingUrl(listing.id) !== null,
  );
}

export function encarHistorySummary(result: VinCheckResult): string {
  const listings = confirmedEncarListings(result);
  if (!listings.length) return "Объявления с подтверждённым VIN недоступны. История неизвестна.";
  return [
    `Объявлений с подтверждённым VIN: ${listings.length}. Архив неполный.`,
    ...(result.encar?.data?.partial ? ["Часть найденных записей не удалось проверить."] : []),
    "Фото и пробег относятся к объявлениям, не к текущему состоянию. Даты публикаций указаны в местном времени архива; это не даты продажи.",
  ].join("\n");
}

export function encarListingFacts(listing: EncarListing): [string, string][] {
  const facts: [string, string][] = [];
  if (listing.model) facts.push(["Модель в объявлении", listing.model]);
  facts.push([
    "Записанный пробег (не текущий)",
    listing.mileage_km === null ? "Неизвестен" : `${listing.mileage_km.toLocaleString("ru-RU")} км`,
  ]);
  facts.push([
    "Статус объявления",
    listing.advertisement_status === "SOLD"
      ? "Снято / продано; сделка не подтверждена"
      : listing.advertisement_status === "ADVERTISE"
        ? "Опубликовано; актуальность не подтверждена"
        : "Неизвестен",
  ]);
  if (listing.created_at) facts.push(["Создано", listing.created_at]);
  if (listing.first_advertised_at) facts.push(["Первая публикация", listing.first_advertised_at]);
  if (listing.modified_at) facts.push(["Обновлено", listing.modified_at]);
  if (listing.re_registered !== null)
    facts.push(["Повторное размещение", listing.re_registered ? "Да" : "Нет"]);
  facts.push([
    "Фотографии объявления",
    String(listing.photo_urls.filter((url) => isEncarPhotoUrl(url, listing.id)).length),
  ]);
  return facts;
}

function car365Facts(record: Car365Record | null): [string, string][] {
  return [
    ["Модель в записи", record?.model ?? "неизвестна"],
    [
      "Записанный пробег",
      record?.last_mileage_km == null
        ? "неизвестен"
        : `${record.last_mileage_km.toLocaleString("ru-RU")} км`,
    ],
    ["Дата декларации", record?.export_date ?? "неизвестна"],
    ["Первая регистрация", record?.first_registration_date ?? "неизвестна"],
  ];
}

function car365Notes(record: Car365Record | null): string[] {
  return [
    "Найдена экспортная декларация. Она не подтверждает фактическую отправку автомобиля.",
    "Записанный пробег — не текущий реальный пробег. Дата декларации — не дата замера пробега.",
    record?.total_loss == null
      ? "Данные о полной гибели неизвестны; отсутствие повреждений не подтверждено."
      : record.total_loss
        ? "В записи указана полная гибель автомобиля."
        : "Полная гибель в записи не указана; это не означает отсутствие ДТП или повреждений.",
  ];
}

function vinSourceDescription(provider: VinProvider, result: VinCheckResult): string {
  const observation = result[provider];
  if (!observation) return "";
  let description: string;
  switch (observation.status) {
    case "disabled":
      description = "Проверка отключена; запрос не отправлен.";
      break;
    case "unavailable":
      description =
        "Проверка временно недоступна. Результат неизвестен — это не отсутствие записей.";
      break;
    case "not_found":
      description =
        provider === "carhistory"
          ? "Наличие полного отчёта не подтверждено. Может понадобиться прежний корейский госномер."
          : provider === "encar"
            ? "Объявления не найдены. Это не означает отсутствие истории автомобиля."
            : provider === "nhtsa_vpic" || provider === "autodev"
              ? "Характеристики по VIN не установлены."
              : provider === "vagvin_carfax"
                ? "VAGVIN не подтвердил наличие записей CARFAX. Это не означает отсутствие истории автомобиля."
                : "Экспортная запись с пробегом не найдена. Это не означает отсутствие повреждений.";
      break;
    case "available": {
      if (provider === "carhistory") {
        description =
          "Наличие отчёта подтверждено. Сам отчёт не получен и не куплен; ДТП, ремонт и владельцы неизвестны.";
        break;
      }
      if (provider === "encar") {
        description = [
          encarHistorySummary(result),
          ...confirmedEncarListings(result).map((listing) =>
            [
              `Объявление №${listing.id}`,
              ...encarListingFacts(listing).map(([label, value]) => `${label}: ${value}`),
            ].join("\n"),
          ),
        ].join("\n\n");
        break;
      }
      if (provider === "nhtsa_vpic") {
        const record = result.nhtsa_vpic?.data;
        const lines = ["Характеристики по данным производителя для рынка США."];
        if (record?.make) lines.push(`Марка: ${record.make}`);
        if (record?.model) lines.push(`Модель: ${record.model}`);
        if (record?.model_year != null) lines.push(`Модельный год: ${record.model_year}`);
        if (record?.body_class) lines.push(`Тип кузова: ${record.body_class}`);
        if (record?.fuel_type) lines.push(`Топливо: ${record.fuel_type}`);
        if (record?.plant_country) lines.push(`Страна сборки: ${record.plant_country}`);
        lines.push("Неуказанные характеристики неизвестны.");
        description = lines.join("\n");
        break;
      }
      if (provider === "autodev") {
        const record = result.autodev?.data;
        const lines = ["Расшифровка VIN; покрытие зависит от марки и рынка."];
        if (record?.ambiguous) {
          lines.push("Расшифровка неоднозначна: уточните год и комплектацию по документам.");
        }
        if (record?.make) lines.push(`Марка: ${record.make}`);
        if (record?.model) lines.push(`Модель: ${record.model}`);
        if (record?.model_year != null) lines.push(`Модельный год: ${record.model_year}`);
        if (record?.trim) lines.push(`Комплектация: ${record.trim}`);
        if (record?.body_class) lines.push(`Тип кузова: ${record.body_class}`);
        if (record?.engine) lines.push(`Двигатель: ${record.engine}`);
        if (record?.drive) lines.push(`Привод: ${record.drive}`);
        if (record?.transmission) lines.push(`Трансмиссия: ${record.transmission}`);
        if (record?.origin_country) lines.push(`Страна происхождения: ${record.origin_country}`);
        lines.push("Неуказанные характеристики неизвестны.");
        description = lines.join("\n");
        break;
      }
      if (provider === "vagvin_carfax") {
        const record = result.vagvin_carfax?.data;
        description =
          record?.vin === result.vin &&
          Number.isSafeInteger(record.record_count) &&
          record.record_count > 0
            ? `VAGVIN сообщает о ${record.record_count} записях CARFAX.${record.vehicle ? `\nАвтомобиль по данным VAGVIN: ${record.vehicle}.` : ""}\nПроверена только доступность: это не сам отчёт и не сведения о ДТП.\nИсточник: https://vagvin.ru/home`
            : "Доступность CARFAX не удалось подтвердить.";
        break;
      }
      const record = result.car365.data;
      description = [
        ...car365Facts(record).map(([label, value]) => `${label}: ${value}`),
        ...car365Notes(record),
      ].join("\n");
      break;
    }
  }
  if (provider === "nhtsa_vpic") {
    description +=
      "\nЭто не история ДТП, пробега или владельцев. Страна сборки не означает страну регистрации или эксплуатации.";
  }
  if (provider === "autodev") {
    description +=
      "\nЭто не история ДТП, пробега или владельцев. Страна происхождения не означает страну регистрации или эксплуатации.";
  }
  return description;
}

function vinCheckedText(checkedAt: number | null): string {
  return checkedAt === null
    ? "Проверка не выполнялась."
    : `Проверено: ${vinArchiveTime(checkedAt)}.`;
}

export function vinSourceText(provider: VinProvider, result: VinCheckResult): string {
  const observation = result[provider];
  if (!observation) return "";
  return `${VIN_SOURCE_NAMES[provider]}\n${vinSourceDescription(provider, result)}\n${vinCheckedText(observation.checked_at)}`;
}

type VinButton = { text: string; style?: "primary" } & (
  | { callback_data: string }
  | { url: string }
  | { web_app: { url: string } }
);

export function vinResultActions(vin: string, miniAppUrl?: string) {
  const report: VinButton[] = [];
  const pdf: VinButton = {
    text: KOREAN_REPORT_PREVIEW.pdfLabel,
    callback_data: "vin-report-example",
  };
  if (miniAppUrl) {
    report.push({
      text: KOREAN_REPORT_PREVIEW.explanationLabel,
      web_app: { url: new URL("?view=report-example", miniAppUrl).href },
      style: "primary",
    });
  } else {
    pdf.style = "primary";
  }
  report.push(pdf);
  const additional: { button: VinButton; notice: string }[] = [
    {
      button: { text: VIN_ARCHIVE_LABEL, callback_data: `vinarchive:${vin}` },
      notice: VIN_ARCHIVE_DISCLOSURE,
    },
  ];
  const searchUrl = vinGoogleSearchUrl(vin);
  if (searchUrl) {
    additional.push({
      button: { text: VIN_GOOGLE_SEARCH_LABEL, url: searchUrl },
      notice: VIN_GOOGLE_SEARCH_NOTICE,
    });
  }
  return {
    report,
    additional,
    keyboard: {
      inline_keyboard: [...report, ...additional.map(({ button }) => button)].map((button) => [
        button,
      ]),
    },
  };
}

function richVinButtons(buttons: readonly VinButton[]): string {
  return buttons
    .map((button) => {
      const action =
        "callback_data" in button
          ? `type="callback_data" data="${escapeHtml(button.callback_data)}"`
          : "web_app" in button
            ? `type="web_app" url="${escapeHtml(button.web_app.url)}"`
            : `type="url" url="${escapeHtml(button.url)}"`;
      return `<tg-button-row><tg-button ${action}${button.style ? ` style="${button.style}"` : ""}>${escapeHtml(button.text)}</tg-button></tg-button-row>`;
    })
    .join("");
}

/** Both Telegram formats share the same facts and order; neither offers an unavailable purchase. */
export function vinResultPresentation(
  result: VinCheckResult,
  actions = vinResultActions(result.vin),
): { text: string; richHtml: string } {
  const sections: {
    title: string;
    body: string;
    checked: string;
    richBody?: string;
    buttons?: readonly VinButton[];
  }[] = [];
  const record = result.car365.data;
  const exportAvailable = result.car365.status === "available";
  const facts = exportAvailable ? car365Facts(record) : [];
  const notes = exportAvailable ? car365Notes(record) : [];
  const exportBody = exportAvailable
    ? [
        ...facts.map(([label, value]) => `${label}: <b>${escapeHtml(value)}</b>`),
        "",
        ...notes.map((note) => escapeHtml(note)),
      ].join("\n")
    : escapeHtml(vinSourceDescription("car365", result));
  sections.push({
    title: "Экспорт и пробег · бесплатно",
    body: exportBody,
    checked: vinCheckedText(result.car365.checked_at),
    ...(exportAvailable
      ? {
          richBody:
            "<table compact striped>" +
            facts
              .map(
                ([label, value]) =>
                  `<tr><td>${label}</td><td><b>${escapeHtml(value)}</b></td></tr>`,
              )
              .join("") +
            "</table>" +
            `<p>${notes.map((note) => escapeHtml(note)).join("<br>")}</p>`,
        }
      : {}),
  });
  for (const provider of VIN_PROVIDERS) {
    if (provider === "car365" || provider === "carhistory") continue;
    const observation = result[provider];
    if (!observation) continue;
    sections.push({
      title: VIN_SOURCE_NAMES[provider],
      body: escapeHtml(vinSourceDescription(provider, result)),
      checked: vinCheckedText(observation.checked_at),
    });
  }
  const preview = KOREAN_REPORT_PREVIEW;
  const benefits = preview.benefits.map(
    ([title, detail]) => `<b>${escapeHtml(title)}</b> — ${escapeHtml(detail)}`,
  );
  const exampleNotice = escapeHtml(preview.exampleNotice);
  const reportStatus = escapeHtml(vinSourceDescription("carhistory", result));
  const orderStatus = escapeHtml(preview.orderNotice);
  sections.push({
    title: preview.title,
    body: [
      reportStatus,
      "",
      `<b>${escapeHtml(preview.heading)}</b>`,
      ...benefits.map((benefit) => `• ${benefit}`),
      escapeHtml(preview.limitations),
      "",
      exampleNotice,
      orderStatus,
    ].join("\n"),
    checked: vinCheckedText(result.carhistory.checked_at),
    richBody:
      `<p>${reportStatus}</p><p><b>${escapeHtml(preview.heading)}</b></p>` +
      `<ul>${benefits.map((benefit) => `<li>${benefit}</li>`).join("")}</ul>` +
      `<p>${escapeHtml(preview.limitations)}</p><p>${exampleNotice}</p><p>${orderStatus}</p>`,
    buttons: actions.report,
  });
  const vin = escapeHtml(result.vin);
  const received = escapeHtml(`Результат получен: ${vinArchiveTime(result.checked_at)}`);
  const caution = escapeHtml(VIN_CAUTION);
  return {
    text: [
      `<b>Бесплатная проверка VIN</b>\n<code>${vin}</code>`,
      ...sections.map(({ title, body, checked }) => `<b>${title}</b>\n${body}\n<i>${checked}</i>`),
      `<b>Важно</b>\n${caution}`,
      ...actions.additional.map(({ notice }) => escapeHtml(notice)),
      received,
    ].join("\n\n"),
    richHtml:
      `<h2>Бесплатная проверка VIN</h2><p><code>${vin}</code></p>` +
      sections
        .map(
          ({ title, body, richBody, checked, buttons }, index) =>
            `${index ? "<hr>" : ""}<h3>${title}</h3>` +
            (richBody ?? `<p>${body.replaceAll("\n", "<br>")}</p>`) +
            (buttons ? richVinButtons(buttons) : "") +
            `<footer>${checked}</footer>`,
        )
        .join("") +
      "<details><summary>Фото и поиск в интернете</summary>" +
      actions.additional
        .map(({ button, notice }) => `<p>${escapeHtml(notice)}</p>${richVinButtons([button])}`)
        .join("") +
      "</details>" +
      `<details><summary>Как понимать результат</summary><p>${caution}</p></details><footer>${received}</footer>`,
  };
}
