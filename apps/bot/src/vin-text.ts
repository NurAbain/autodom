import { VIN_SOURCE_URLS, type VinCheckResult, type VinProvider } from "@autodom/core/vin";

export const VIN_DISCLOSURE =
  "По вашему запросу VIN передаётся отдельному сервису проверки Autodom и подключённым CarHistory и Car365 через настроенный прокси. Проверяем доступность платного отчёта CarHistory и государственные записи Car365; платный отчёт не покупаем и не получаем. VIN не сохраняется в вашем поиске или профиле.";
export const VIN_NOT_ENABLED = "Проверка VIN не подключена. Запрос провайдерам не отправлен.";
export const VIN_HELP = `Отправьте /vin и VIN: 17 латинских букв и цифр, без I, O, Q. Например: /vin KMHDU41DBAU123456.\n\n${VIN_DISCLOSURE}`;
export const VIN_CAUTION =
  "Отсутствие записей не означает отсутствие ДТП или ограничений. Записанный пробег — не текущий реальный пробег. Сверьте VIN с автомобилем и документами.";

export function vinSourceText(provider: VinProvider, result: VinCheckResult): string {
  const observation = result[provider];
  const name = provider === "carhistory" ? "CarHistory" : "Car365";
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
          : "Государственная запись об экспорте и пробеге для этого VIN не найдена. Это не подтверждает отсутствие повреждений.";
      break;
    case "available": {
      if (provider === "carhistory") {
        description =
          "Платный отчёт доступен для запроса у провайдера. Полный отчёт не куплен и не получен; его содержание неизвестно.";
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
  const checked =
    observation.checked_at === null
      ? "Проверка не выполнялась."
      : `Проверено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bishkek" }).format(new Date(observation.checked_at * 1000))} (Бишкек, UTC+6).`;
  return `${name}\n${description}\n${checked}`;
}

export function vinResultText(result: VinCheckResult): string {
  return [
    `VIN: ${result.vin}`,
    ...(["carhistory", "car365"] as const).map(
      (provider) => `${vinSourceText(provider, result)}\nИсточник: ${VIN_SOURCE_URLS[provider]}`,
    ),
    VIN_CAUTION,
  ].join("\n\n");
}
