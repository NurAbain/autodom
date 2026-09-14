export const KOREAN_REPORT_EXAMPLE_PDF = {
  filename: "vin-korea-otchet-kr.pdf",
  path: "/miniapp/reports/vin-korea-otchet-kr.pdf",
  label: "Скачать пример · PDF на корейском",
  caption:
    "ПРИМЕР · Оригинальный корейский отчёт, 6 страниц.\nG70 · VIN KMTG441BBKU056893.\nЭто предоставленный образец, не новая проверка и не результат по вашему VIN. Даты внутри документа расходятся: запрос 16.09.2025, дата документа 12.09.2026. Подлинность и полнота независимо не подтверждены.",
} as const;

export const KOREAN_REPORT_PREVIEW = {
  title: "Полный корейский PDF",
  limitations: "Отчёт показывает сохранившиеся записи источника — не все ДТП и ремонты.",
  exampleNotice: "Пример ниже — другой автомобиль, не ваш VIN.",
  orderNotice: "Покупка по вашему VIN — только после проверки и согласия с условиями.",
  pdfLabel: "Посмотреть пример PDF",
} as const;
