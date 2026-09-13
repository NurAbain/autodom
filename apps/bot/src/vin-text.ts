import {
  type EncarListing,
  encarHistoryDiscoveryUrl,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinProvider,
} from "@autodom/core/vin";
import {
  isVinArchiveLotUrl,
  VIN_ARCHIVE_AUCTION_NAMES,
  VIN_ARCHIVE_PROVIDER_NAMES,
  VIN_ARCHIVE_SOURCE_URLS,
  type VinArchiveLot,
  type VinArchiveProvider,
  type VinArchiveStatus,
} from "@autodom/core/vin-archive";

export const VIN_ARCHIVE_LABEL = "Архивные фото США / ОАЭ";
export const VIN_ARCHIVE_CARWAY_NOTICE =
  "Carway — сторонний архив, не официальная история EmiratesAuction. В данных встречаются противоречия. Поиск ограничен первым найденным результатом; полнота записей и галереи не подтверждена.";
export const VIN_ARCHIVE_DISCLOSURE = `Отдельный поиск: VIN передаётся архивным источникам только по нажатию кнопки «${VIN_ARCHIVE_LABEL}», не при обычной проверке VIN. Через сервис Autodom запрашиваем подключённые Copart и Bid.Cars (через настроенный прокси), а также Carway для ОАЭ, если он отдельно подключён (напрямую). Ищем сохранившиеся записи и фотографии. Лоты Copart и IAAI доступны также через посредника Bid.Cars; прямого запроса в IAAI нет. ${VIN_ARCHIVE_CARWAY_NOTICE}`;
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
    `Данные: ${VIN_ARCHIVE_PROVIDER_NAMES[provider]}${
      provider === "carway"
        ? ` (сторонний архив; аукцион по данным Carway: ${VIN_ARCHIVE_AUCTION_NAMES[lot.auction]})`
        : provider === "bidcars"
          ? ` (посредник, аукцион ${VIN_ARCHIVE_AUCTION_NAMES[lot.auction]})`
          : " (аукцион напрямую)"
    }.`,
    ...(provider === "carway"
      ? [
          "Исход торгов, дата аукциона и финальная ставка не подтверждены.",
          "Пробег не подтверждён; данные архива не заменяют проверку автомобиля.",
        ]
      : [
          ...lot.events.map((event) =>
            [
              event.status === "sold"
                ? "SOLD (продан по данным источника)."
                : "ENDED (торги завершены; продажа не подтверждена).",
              `Дата аукциона: ${event.auction_date ?? vinArchiveTime(event.auction_at)}.`,
              ...(event.auction_date !== null && event.auction_at !== null
                ? [`Время: ${vinArchiveTime(event.auction_at)}.`]
                : []),
              `Финальная ставка: ${event.final_bid_usd_minor === null ? "неизвестна / скрыта" : archiveBid.format(event.final_bid_usd_minor / 100)}.`,
            ].join(" "),
          ),
          "Ставка не равна цене сделки. Статус не подтверждает переход права собственности.",
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
  "По вашему запросу VIN передаётся отдельному сервису Autodom. Сначала проверяем подключённые корейские источники через настроенный прокси: CarHistory, Car365 и историю объявлений Encar. Для Encar VIN передаётся Carcheck для поиска кандидатов, затем найденные объявления сверяются с полным VIN на официальном Encar. Подключённые NHTSA vPIC и Auto.dev запрашиваем напрямую, только если все подключённые корейские источники ответили «не найдено»; если корейские источники отключены — сразу. При найденном VIN или ошибке корейской проверки эти декодеры не запрашиваем. Платные отчёты не покупаем и не получаем; Car365 проверяет государственную экспортную запись. Google — только внешний поиск по нажатию, без автоматических запросов. NHTSA даёт характеристики для рынка США, Auto.dev — глобальную расшифровку с неполным покрытием; это не история ДТП, пробега или владельцев. Auto.dev используется на бесплатном тарифе с лимитом. VIN не сохраняется в вашем поиске или профиле.";
export const VIN_NOT_ENABLED = "Проверка VIN не подключена. Запрос провайдерам не отправлен.";
export const VIN_HELP = `Отправьте /vin и VIN: 17 латинских букв и цифр, без I, O, Q. Например: /vin KMHDU41DBAU123456.\n\n${VIN_DISCLOSURE}`;
export const VIN_CAUTION =
  "Отсутствие записей не означает отсутствие ДТП или ограничений. Записанный пробег — не текущий реальный пробег. Сверьте VIN с автомобилем и документами.";
export const VIN_GOOGLE_SEARCH_LABEL = "Искать VIN в Google";
export const VIN_GOOGLE_SEARCH_NOTICE =
  "Поиск точного VIN в Google для любого рынка. VIN передаётся Google только при нажатии. Отсутствие результатов не означает чистую историю.";
export const VIN_REPORT_EXAMPLE_LABEL = "Посмотреть пример полного отчёта";
export const VIN_PREMIUM_DESCRIPTION =
  "Полный корейский отчёт: страховые повреждения и ремонт, смены собственника, записи пробега — в пределах данных источника. Можно посмотреть переведённый пример другого автомобиля: это не результат по вашему VIN. Покупка и выдача нового отчёта не подключены; цифровые VIN-отчёты через Finik в Telegram не продаём.";

export const VIN_SOURCE_NAMES: Record<VinProvider, string> = {
  carhistory: "Корея · CarHistory · наличие отчёта",
  car365: "Корея · Car365 · экспортная запись",
  encar: "Корея · Encar · история объявлений",
  nhtsa_vpic: "NHTSA vPIC · США, характеристики",
  autodev: "Auto.dev · глобальные характеристики",
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
  if (!listings.length)
    return "Объявления с подтверждённым полным VIN недоступны. Результат неизвестен; это не отсутствие истории.";
  return [
    `Найдено объявлений с подтверждённым полным VIN: ${listings.length}. Это не полный архив Encar.`,
    ...(result.encar?.data?.partial
      ? [
          "Частичный результат: часть найденных кандидатов не подтверждена или достигнут лимит проверки. Подтверждённые объявления показаны ниже.",
        ]
      : []),
    "Данные и фотографии относятся к этим объявлениям, а не подтверждают текущее состояние автомобиля. Даты — местные дата и время источника, без определения часового пояса; это не даты продажи.",
  ].join("\n");
}

export function encarListingFacts(listing: EncarListing): [string, string][] {
  const facts: [string, string][] = [];
  if (listing.model) facts.push(["Модель в объявлении", listing.model]);
  facts.push([
    "Записанный пробег (не текущий реальный)",
    listing.mileage_km === null ? "Неизвестен" : `${listing.mileage_km.toLocaleString("ru-RU")} км`,
  ]);
  facts.push([
    "Статус объявления",
    listing.advertisement_status === "SOLD"
      ? "Снято / продано по данным Encar (SOLD); совершённая сделка не подтверждена"
      : listing.advertisement_status === "ADVERTISE"
        ? "Опубликовано по данным Encar (ADVERTISE); актуальность предложения уточняйте у источника"
        : "Неизвестен",
  ]);
  if (listing.created_at) facts.push(["Создано у источника", listing.created_at]);
  if (listing.first_advertised_at)
    facts.push(["Впервые опубликовано у источника", listing.first_advertised_at]);
  if (listing.modified_at) facts.push(["Изменено у источника", listing.modified_at]);
  if (listing.re_registered !== null)
    facts.push(["Повторное размещение по данным Encar", listing.re_registered ? "Да" : "Нет"]);
  facts.push([
    "Фотографии объявления",
    `${listing.photo_urls.filter((url) => isEncarPhotoUrl(url, listing.id)).length} · просмотр в MiniApp или у источника`,
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
      description = "Источник отключён; запрос не отправлен.";
      break;
    case "unavailable":
      description =
        "Источник временно недоступен. Результат проверки неизвестен; это не отсутствие записей.";
      break;
    case "not_found":
      description =
        provider === "carhistory"
          ? "Наличие полного отчёта не подтверждено. Может понадобиться прежний корейский госномер."
          : provider === "encar"
            ? "В публичном поиске Carcheck кандидаты Encar не найдены. Это не означает, что автомобиль никогда не размещался на Encar, и не подтверждает отсутствие событий в истории."
            : provider === "nhtsa_vpic" || provider === "autodev"
              ? "Декодер не смог установить характеристики для этого VIN. Это не подтверждает отсутствие ДТП или других событий в истории."
              : "Экспортная запись с пробегом не найдена. Это не означает отсутствие повреждений.";
      break;
    case "available": {
      if (provider === "carhistory") {
        description =
          "Провайдер подтвердил наличие платного отчёта. Сам отчёт не получен и не куплен; ДТП, ремонт и владельцы пока неизвестны.";
        break;
      }
      if (provider === "encar") {
        description = [
          encarHistorySummary(result),
          `Поиск кандидатов (Carcheck): ${encarHistoryDiscoveryUrl(result.vin)}`,
          ...confirmedEncarListings(result).map((listing) =>
            [
              `Объявление Encar №${listing.id} · VIN ${listing.vin}`,
              ...encarListingFacts(listing).map(([label, value]) => `${label}: ${value}`),
              `Официальное объявление и фотографии: ${encarListingUrl(listing.id)}`,
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
        const lines = ["Характеристики по данным Auto.dev; полнота зависит от марки и рынка."];
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
        "Найдена государственная экспортная запись.",
        record?.last_mileage_km == null
          ? "Пробег в записи неизвестен."
          : `Последний записанный пробег: ${record.last_mileage_km.toLocaleString("ru-RU")} км (не текущий реальный пробег).`,
      ];
      if (record?.model) lines.push(`Модель в записи: ${record.model}`);
      if (record?.export_date)
        lines.push(`Дата декларации об экспорте: ${record.export_date} (не дата замера пробега)`);
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
      : `Проверено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bishkek" }).format(new Date(observation.checked_at * 1000))} (Бишкек, UTC+6).`;
  return `${name}\n${description}\n${checked}`;
}

export function vinResultText(result: VinCheckResult): string {
  return [
    `Бесплатная проверка VIN: ${result.vin}`,
    ...VIN_PROVIDERS.flatMap((provider) =>
      result[provider]
        ? [`${vinSourceText(provider, result)}\nИсточник: ${VIN_SOURCE_URLS[provider]}`]
        : [],
    ),
    VIN_CAUTION,
    VIN_PREMIUM_DESCRIPTION,
  ].join("\n\n");
}
