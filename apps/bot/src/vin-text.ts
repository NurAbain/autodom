import {
  type EncarListing,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  VIN_PROVIDERS,
  type VinCheckResult,
  type VinProvider,
} from "@autodom/core/vin";
import {
  isVinArchiveLotUrl,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveLot,
  type VinArchiveProvider,
  type VinArchiveStatus,
} from "@autodom/core/vin-archive";

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
export const VIN_REPORT_EXAMPLE_LABEL = "Пример полного отчёта";
export const VIN_PREMIUM_DESCRIPTION =
  "В примере полного корейского отчёта — страховые ремонты, смены собственника и записи пробега. Это документ другого автомобиля, не проверка вашего VIN. Заказ нового отчёта пока недоступен.";

export const VIN_SOURCE_NAMES: Record<VinProvider, string> = {
  carhistory: "Полный отчёт · Корея",
  car365: "Экспорт и пробег · Корея",
  encar: "Архив объявлений · Корея",
  nhtsa_vpic: "Характеристики · рынок США",
  autodev: "Характеристики · другие рынки",
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

export function vinSourceText(provider: VinProvider, result: VinCheckResult): string {
  const observation = result[provider];
  if (!observation) return "";
  const name = VIN_SOURCE_NAMES[provider];
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
      const record = result.car365.data;
      const lines = [
        "Найдена экспортная декларация. Она не подтверждает фактическую отправку автомобиля.",
        record?.last_mileage_km == null
          ? "Пробег в записи неизвестен."
          : `Последний записанный пробег: ${record.last_mileage_km.toLocaleString("ru-RU")} км (не текущий реальный пробег).`,
      ];
      if (record?.model) lines.push(`Модель в записи: ${record.model}`);
      if (record?.export_date)
        lines.push(`Дата декларации: ${record.export_date} (не дата замера пробега)`);
      if (record?.first_registration_date)
        lines.push(`Первая регистрация: ${record.first_registration_date}`);
      lines.push(
        record?.total_loss == null
          ? "Данные о полной гибели неизвестны; отсутствие повреждений не подтверждено."
          : record.total_loss
            ? "В записи указана полная гибель автомобиля."
            : "Полная гибель в записи не указана; это не означает отсутствие ДТП или повреждений.",
      );
      description = lines.join("\n");
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
  const checked =
    observation.checked_at === null
      ? "Проверка не выполнялась."
      : `Проверено: ${vinArchiveTime(observation.checked_at)}.`;
  return `${name}\n${description}\n${checked}`;
}

export function vinResultText(result: VinCheckResult): string {
  return [
    `Бесплатная проверка VIN: ${result.vin}`,
    `Результат получен: ${vinArchiveTime(result.checked_at)}`,
    ...VIN_PROVIDERS.flatMap((provider) => {
      const observation = result[provider];
      return observation ? [vinSourceText(provider, result)] : [];
    }),
    VIN_CAUTION,
    VIN_PREMIUM_DESCRIPTION,
  ].join("\n\n");
}
