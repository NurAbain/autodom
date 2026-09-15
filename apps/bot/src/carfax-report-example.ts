export const CARFAX_REPORT_EXAMPLE_PDF = {
  path: "https://dealsoncarfax.com/sample-report.pdf",
  sourceUrl: "https://dealsoncarfax.com/sample-report",
  label: "Открыть образец CARFAX · PDF, 7 страниц",
  caption:
    "ОБРАЗЕЦ CARFAX — НЕ ОТЧЁТ ПО ВАШЕМУ VIN.\n\nПубличный PDF на английском, 7 страниц: Toyota Prius 2015, документ от 7 мая 2026 года. Издатель образца — Deals on Carfax; ссылка открывает внешний сайт.\n\nОбразец показывает формат. Его VIN, пробег, записи и цены не относятся к вашему авто или заказу Autodom. Состав вашего отчёта зависит от данных CARFAX.\nИсточник: https://dealsoncarfax.com/sample-report",
} as const;

export const CARFAX_REPORT_PREVIEW = {
  title: "CARFAX · история автомобиля в PDF",
  limitations:
    "Отчёт может содержать записи о ДТП, пробеге, регистрации, владельцах и обслуживании. Покрытие и количество записей различаются. Отсутствие записей не доказывает отсутствие проблем.",
  exampleNotice:
    "Образец — не отчёт по вашему VIN. Публичный пример Deals on Carfax: США, английский, 7 страниц, Toyota Prius 2015; дата документа — 7 мая 2026 года. Откроется внешний PDF. Это демонстрация формата, не подтверждение доступности истории вашего авто.",
  orderNotice:
    "Настоящий CARFAX по вашему VIN выдаёт владелец Autodom вручную — до 60 минут после подтверждённой оплаты. Если получить отчёт невозможно — полный возврат. Образец не подставляется в оплаченный заказ.",
  pdfLabel: CARFAX_REPORT_EXAMPLE_PDF.label,
} as const;
