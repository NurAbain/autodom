import type { PaymentOrder } from "@autodom/core/payments";

export const PAYMENT_PRIVACY_NOTICE =
  "Заказы и платежи хранятся отдельно от бесплатного поиска; /delete их не удаляет. Finik получает номер, описание и сумму заказа, но не Telegram ID или профиль поиска. Переход на платёжную страницу не подтверждает оплату. Заявка на возврат не означает возврат денег.";

export function paymentOrderStatus(order: PaymentOrder): string {
  if (order.needsReview) return "Платёж требует проверки — не оплачивайте повторно";
  if (order.paymentStatus === "paid")
    return order.fulfillmentStatus === "fulfilled"
      ? "Оплата подтверждена · осмотр выполнен"
      : "Оплата подтверждена · выполнение осмотра ещё не подтверждено";
  if (order.invoiceStatus === "cancelled") return "Предложение отменено";
  if (Date.parse(order.expiresAt) <= Date.now()) return "Срок предложения истёк";
  if (order.invoiceStatus === "pending") return "Ожидаем серверное подтверждение Finik";
  return "Предложение ожидает вашего решения";
}
