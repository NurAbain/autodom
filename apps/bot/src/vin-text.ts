import {
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinProvider,
} from "@autodom/core/vin";

export const VIN_DISCLOSURE =
  "По вашему запросу VIN передаётся отдельному сервису проверки Autodom: подключённым CarHistory и Car365 — только через настроенный прокси, а NHTSA vPIC, если включён, — напрямую через бесплатный публичный API. Проверяем доступность платного отчёта CarHistory и государственные записи Car365; платный отчёт не покупаем и не получаем. NHTSA предоставляет характеристики производителя для рынка США, не историю ДТП, пробега или владельцев. VIN не сохраняется в вашем поиске или профиле.";
export const VIN_NOT_ENABLED = "Проверка VIN не подключена. Запрос провайдерам не отправлен.";
export const VIN_HELP = `Отправьте /vin и VIN: 17 латинских букв и цифр, без I, O, Q. Например: /vin KMHDU41DBAU123456.\n\n${VIN_DISCLOSURE}`;
export const VIN_CAUTION =
  "Отсутствие записей не означает отсутствие ДТП или ограничений. Записанный пробег — не текущий реальный пробег. Сверьте VIN с автомобилем и документами.";
export const VIN_GOOGLE_SEARCH_LABEL = "Искать VIN в Google";
export const VIN_GOOGLE_SEARCH_NOTICE =
  "Поиск точного VIN в Google для любого рынка. VIN передаётся Google только при нажатии. Отсутствие результатов не означает чистую историю.";

export const VIN_SOURCE_NAMES: Record<VinProvider, string> = {
  carhistory: "CarHistory",
  car365: "Car365",
  nhtsa_vpic: "NHTSA vPIC · США, характеристики",
};

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
          ? "Доступность платного отчёта для этого VIN не подтверждена. Может потребоваться прежний корейский регистрационный номер."
          : provider === "nhtsa_vpic"
            ? "Декодер не смог установить характеристики для этого VIN. Это не подтверждает отсутствие ДТП или других событий в истории."
            : "Государственная запись об экспорте и пробеге для этого VIN не найдена. Это не подтверждает отсутствие повреждений.";
      break;
    case "available": {
      if (provider === "carhistory") {
        description =
          "Платный отчёт доступен для запроса у провайдера. Полный отчёт не куплен и не получен; его содержание неизвестно.";
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
      const record = result.car365.data;
      const lines = [
        "Найдена государственная запись.",
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
  const checked =
    observation.checked_at === null
      ? "Проверка не выполнялась."
      : `Проверено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bishkek" }).format(new Date(observation.checked_at * 1000))} (Бишкек, UTC+6).`;
  return `${name}\n${description}\n${checked}`;
}

export function vinResultText(result: VinCheckResult): string {
  return [
    `VIN: ${result.vin}`,
    ...VIN_PROVIDERS.flatMap((provider) =>
      result[provider]
        ? [`${vinSourceText(provider, result)}\nИсточник: ${VIN_SOURCE_URLS[provider]}`]
        : [],
    ),
    VIN_CAUTION,
  ].join("\n\n");
}
