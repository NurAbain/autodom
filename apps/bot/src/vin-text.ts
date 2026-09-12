import {
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinProvider,
} from "@autodom/core/vin";

export const VIN_DISCLOSURE =
  "По вашему запросу VIN передаётся отдельному сервису Autodom. Сначала проверяем подключённые CarHistory и Car365 через настроенный прокси. Подключённые NHTSA vPIC и Auto.dev запрашиваем напрямую, только если все подключённые корейские источники ответили «не найдено»; если корейские источники отключены — сразу. При найденном VIN или ошибке корейской проверки эти декодеры не запрашиваем. Платный отчёт CarHistory не покупаем и не получаем; Car365 проверяет государственную экспортную запись. NHTSA даёт характеристики для рынка США, Auto.dev — глобальную расшифровку с неполным покрытием; это не история ДТП, пробега или владельцев. Auto.dev используется на бесплатном тарифе с лимитом. VIN не сохраняется в вашем поиске или профиле.";
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
  nhtsa_vpic: "NHTSA vPIC · США, характеристики",
  autodev: "Auto.dev · глобальные характеристики",
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
          ? "Наличие полного отчёта не подтверждено. Может понадобиться прежний корейский госномер."
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
