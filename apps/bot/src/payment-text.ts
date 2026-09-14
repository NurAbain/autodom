import { isWebVinReport, type PaymentOrder } from "@autodom/core/payments";

export const VIN_REPORT_STARS = 500;
export const VIN_REPORT_FINIK_MINOR = 49900;
export const VIN_REPORT_OWNER = 706854211;
export const VIN_REPORT_SLA_MS = 60 * 60 * 1000;
export const VIN_REPORT_MAX_BYTES = 20 * 1024 * 1024;
export const VIN_REPORT_TERMS = `Полный корейский PDF по указанному VIN — ${VIN_REPORT_STARS} Telegram Stars (XTR), разовая покупка. Продавец и исполнитель: владелец Autodom (Telegram ID ${VIN_REPORT_OWNER}). Настоящий PDF вручную отправляется в этот бот в течение ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если выдать отчёт невозможно, владелец возвращает все ${VIN_REPORT_STARS} Stars. Сведения исторические и могут быть неполными; отчёт не гарантирует состояние автомобиля. Образец — не отчёт по вашему VIN. Поддержка и запрос полного возврата: /paysupport текст. По покупке отвечает Autodom, не поддержка Telegram. Подтверждая условия перед оплатой, вы подтверждаете VIN, цену, срок и эти условия.`;
export const VIN_REPORT_TELEGRAM_FINIK_TERMS = `Полный корейский PDF по указанному VIN — ${VIN_REPORT_FINIK_MINOR / 100} сом (KGS), разовая покупка в боте через Finik, не подписка. Продавец и исполнитель: владелец Autodom (Telegram ID ${VIN_REPORT_OWNER}). Настоящий PDF вручную отправляется в этот бот в течение ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если выдать отчёт невозможно, владелец возвращает всю сумму через Finik. Возврат выполняется владельцем в кабинете Finik; заявка не означает, что деньги уже возвращены. Сведения исторические и могут быть неполными; отчёт не гарантирует состояние автомобиля. Образец — не отчёт по вашему VIN. Поддержка и запрос полного возврата: /paysupport текст. По покупке отвечает Autodom, не поддержка Telegram. Подтверждая условия перед оплатой, вы подтверждаете VIN, цену, срок и эти условия.`;
export const VIN_REPORT_WEB_TERMS = `Полный корейский PDF по указанному VIN — ${VIN_REPORT_FINIK_MINOR / 100} сом (KGS), разовая покупка на сайте через Finik. Продавец и исполнитель: владелец Autodom (Telegram ID ${VIN_REPORT_OWNER}). Настоящий PDF вручную становится доступен в вашем заказе на этом сайте в течение ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если выдать отчёт невозможно, владелец возвращает всю сумму через Finik. Возврат выполняется владельцем в кабинете Finik; заявка не означает, что деньги уже возвращены. Сведения исторические и могут быть неполными; отчёт не гарантирует состояние автомобиля. Образец — не отчёт по вашему VIN. Поддержка и запрос полного возврата — через форму заказа; ответ придёт в личный чат бота. По покупке отвечает Autodom. Подтверждая условия перед оплатой, вы подтверждаете VIN, цену, срок и эти условия.`;

export function paymentAmountText(order: Pick<PaymentOrder, "amount" | "currency">): string {
  return order.currency === "XTR"
    ? `${order.amount} Stars (XTR)`
    : `${(order.amount / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} сом`;
}

export const PAYMENT_PRIVACY_NOTICE =
  "Заказы и платежи хранятся отдельно от бесплатного поиска; /delete их не удаляет. Finik получает номер, описание (включая VIN для PDF) и сумму заказа на осмотр или PDF в боте либо на сайте, но не Telegram ID или профиль поиска. Telegram обрабатывает Stars-платежи и хранит сообщения и PDF; владелец Autodom получает Telegram ID покупателя, VIN, сумму и заказ для ручной выдачи и поддержки. PDF, купленный в боте, отправляется в Telegram; купленный на сайте — выдаётся только на сайте. Переход в приложение банка, на платёжную страницу и закрытие счёта не подтверждают оплату. Заявка на возврат не означает возврат денег.";

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
    return "Оплата подтверждена · ожидаем ручную выдачу PDF в течение 60 минут после оплаты";
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
