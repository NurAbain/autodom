import { isWebVinReport, type PaymentOrder } from "@autodom/core/payments";

export const VIN_REPORT_STARS = 500;
export const VIN_REPORT_FINIK_MINOR = 49900;
export const CARFAX_REPORT_FINIK_MINOR = 49900;
export const VIN_REPORT_OWNER = 706854211;
export const VIN_REPORT_SLA_MS = 60 * 60 * 1000;
export const VIN_REPORT_MAX_BYTES = 20 * 1024 * 1024;
export const VIN_REPORT_TERMS = `Полный корейский PDF · ${VIN_REPORT_STARS} Telegram Stars (XTR)
Разовая покупка по указанному VIN, не подписка.

Вы получите доступ к PDF в этом боте — до ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если предоставить отчёт невозможно — полный возврат ${VIN_REPORT_STARS} Stars.

Исторические записи могут быть неполными. Отчёт не гарантирует состояние авто. Образец — не отчёт по вашему VIN.

Продавец и исполнитель: владелец Autodom, Telegram ID ${VIN_REPORT_OWNER}. По покупке отвечает Autodom, не поддержка Telegram.
Поддержка и полный возврат: /paysupport текст.

Нажимая кнопку согласия перед оплатой, вы подтверждаете VIN, цену, срок и все эти условия.`;
export const VIN_REPORT_TELEGRAM_FINIK_TERMS = `Полный корейский PDF · ${VIN_REPORT_FINIK_MINOR / 100} сом (KGS)
Разовая покупка по указанному VIN через Finik в боте, не подписка.

Вы получите доступ к PDF в этом боте — до ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если предоставить отчёт невозможно — полный возврат через Finik.

Возврат выполняет владелец в кабинете Finik. Заявка на возврат ещё не означает, что деньги возвращены.

Исторические записи могут быть неполными. Отчёт не гарантирует состояние авто. Образец — не отчёт по вашему VIN.

Продавец и исполнитель: владелец Autodom, Telegram ID ${VIN_REPORT_OWNER}. По покупке отвечает Autodom, не поддержка Telegram.
Поддержка и полный возврат: /paysupport текст.

Нажимая кнопку согласия перед оплатой, вы подтверждаете VIN, цену, срок и все эти условия.`;
export const VIN_REPORT_WEB_TERMS = `Полный корейский PDF · ${VIN_REPORT_FINIK_MINOR / 100} сом (KGS)
Разовая покупка по указанному VIN на сайте через Finik.

Вы получите доступ к PDF в заказе на этом сайте — до ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если предоставить отчёт невозможно — полный возврат через Finik.

Возврат выполняет владелец в кабинете Finik. Заявка на возврат ещё не означает, что деньги возвращены.

Исторические записи могут быть неполными. Отчёт не гарантирует состояние авто. Образец — не отчёт по вашему VIN.

Продавец и исполнитель: владелец Autodom, Telegram ID ${VIN_REPORT_OWNER}. По покупке отвечает Autodom.
Поддержка и полный возврат — через форму заказа. Ответ придёт в личный чат бота.

Нажимая кнопку согласия перед оплатой, вы подтверждаете VIN, цену, срок и все эти условия.`;

export const CARFAX_REPORT_TELEGRAM_FINIK_TERMS = `CARFAX · PDF · ${CARFAX_REPORT_FINIK_MINOR / 100} сом (KGS)
Разовая покупка отчёта CARFAX по указанному VIN через Finik в боте, не подписка.

Вы получите доступ к настоящему PDF в этом боте — до ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если получить отчёт невозможно — полный возврат через Finik.

Это заказ отчёта, а не подтверждение найденной истории. Состав и количество записей зависят от данных CARFAX. Отсутствие записей не означает отсутствие ДТП, ремонта или других проблем.

Публичный образец показывает формат документа. Это не отчёт по вашему VIN и не результат вашей покупки.

Возврат выполняет владелец в кабинете Finik. Заявка на возврат ещё не означает, что деньги возвращены.

Продавец и исполнитель: владелец Autodom, Telegram ID ${VIN_REPORT_OWNER}. По покупке отвечает Autodom, не поддержка Telegram.
Поддержка и полный возврат: /paysupport текст.

Нажимая кнопку согласия перед оплатой, вы подтверждаете VIN, цену, срок и все эти условия.`;

export function paymentAmountText(order: Pick<PaymentOrder, "amount" | "currency">): string {
  return order.currency === "XTR"
    ? `${order.amount} Stars (XTR)`
    : `${(order.amount / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} сом`;
}

export const PAYMENT_PRIVACY_NOTICE =
  "Заказы и платежи хранятся отдельно от бесплатного поиска; /delete их не удаляет. Finik получает номер, описание (включая VIN для PDF) и сумму заказа на осмотр или PDF в боте либо на сайте, но не Telegram ID или профиль поиска. Telegram обрабатывает Stars-платежи и хранит сообщения и PDF; владелец Autodom получает Telegram ID покупателя, VIN, сумму и заказ для предоставления отчёта и поддержки. PDF, купленный в боте, доступен в Telegram; купленный на сайте — только на сайте. Переход в приложение банка, на платёжную страницу и закрытие счёта не подтверждают оплату. Заявка на возврат не означает возврат денег.";

export function paymentOrderStatus(order: PaymentOrder): string {
  if (order.paymentStatus === "refunded")
    return order.needsReview
      ? "Возврат подтверждён · другие платёжные расхождения требуют проверки"
      : order.provider === "telegram_stars"
        ? "Полный возврат Stars подтверждён"
        : "Полный возврат Finik подтверждён владельцем";
  if (order.needsReview) return "Платёж требует проверки — не оплачивайте повторно";
  if (order.product === "vin_report" && order.refundPending)
    return order.provider === "telegram_stars"
      ? "Полный возврат запрошен · подтверждения Telegram пока нет · выдача PDF приостановлена"
      : "Полный возврат запрошен · владелец ещё не подтвердил возврат через Finik · выдача PDF приостановлена";
  if (order.product === "vin_report" && order.paymentStatus === "paid") {
    if (order.fulfillmentStatus === "fulfilled")
      return isWebVinReport(order)
        ? "Оплата подтверждена · PDF доступен на сайте"
        : "Оплата подтверждена · PDF отправлен в Telegram";
    if (order.fulfillmentStatus === "delivering")
      return "Оплата подтверждена · отправка PDF начата, результат ещё не подтверждён";
    if (order.fulfillmentStatus === "delivery_unknown")
      return "Исход отправки PDF неизвестен · поддержка /paysupport, повторно не платите";
    if (order.paidAt && Date.parse(order.paidAt) + VIN_REPORT_SLA_MS <= Date.now())
      return "Оплата подтверждена · срок 60 минут истёк · обратитесь в /paysupport за PDF или полным возвратом";
    return "Оплачено · доступ к PDF до 60 минут после подтверждённой оплаты";
  }
  if (order.paymentStatus === "paid")
    return order.fulfillmentStatus === "fulfilled"
      ? "Оплата подтверждена · осмотр выполнен"
      : "Оплата подтверждена · выполнение осмотра ещё не подтверждено";
  if (order.invoiceStatus === "cancelled") return "Предложение отменено";
  if (Date.parse(order.expiresAt) <= Date.now()) return "Срок предложения истёк";
  if (order.invoiceStatus === "pending")
    return order.currency === "XTR"
      ? "Ожидаем подтверждение Telegram · повторно не платите"
      : "Ожидаем серверное подтверждение Finik";
  return "Предложение ожидает вашего решения";
}
