export const ANALYTICS_EVENTS = [
  "bot_started",
  "goal_selected",
  "profile_step",
  "profile_saved",
  "search_completed",
  "listing_opened",
  "favorite_added",
  "monitoring_enabled",
  "monitoring_paused",
  "vin_submitted",
  "vin_completed",
  "report_offered",
  "report_sample_opened",
  "report_checkout_started",
  "order_created",
  "terms_accepted",
  "invoice_created",
  "payment_succeeded",
  "report_delivered",
  "payment_refunded",
  "feedback_submitted",
  "interaction_error",
  "miniapp_opened",
] as const;
export const ANALYTICS_OUTCOMES = [
  "success",
  "results",
  "empty",
  "available",
  "not_found",
  "partial",
  "unavailable",
  "invalid",
  "error",
  "declined",
  "positive",
  "negative",
] as const;
export const ANALYTICS_STEPS = [
  "start",
  "consent",
  "currency",
  "budget",
  "model",
  "filters",
  "review",
  "saved",
  "buy",
  "sell",
  "exchange",
  "vin",
  "report",
  "checkout",
  "payment",
  "delivery",
] as const;
export const ANALYTICS_REASONS = [
  "too_expensive",
  "unclear_value",
  "not_now",
  "payment_problem",
  "need_other_data",
  "trust",
  "check_history",
  "mileage",
  "accidents",
  "convenience",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];
export type AnalyticsSurface = "telegram" | "miniapp" | "web" | "system";
export type AnalyticsBot = "vin" | "full";
export type AnalyticsFlow = "report" | "buyer" | "seller" | "navigation";
export type AnalyticsReason = (typeof ANALYTICS_REASONS)[number];
export interface AnalyticsEvent {
  actorId: number;
  event: AnalyticsEventName;
  surface: AnalyticsSurface;
  flow: AnalyticsFlow;
  /** Server-only correlation; HMAC before persistence. Never a metric label. */
  contextKey?: string;
  /** Server-only idempotency key, HMAC before persistence. */
  dedupeKey?: string;
  outcome?: (typeof ANALYTICS_OUTCOMES)[number];
  step?: (typeof ANALYTICS_STEPS)[number];
  reason?: AnalyticsReason;
  reportKind?: "korea" | "carfax";
  /** Only trusted ledger reconciliation supplies historical timestamps. */
  occurredAt?: Date;
}
export interface AnalyticsRecorder {
  /** Best effort, bounded; never reject or affect business behavior. */
  record(event: AnalyticsEvent): Promise<void>;
  /** Purge both bots' pseudonymous history, not the legally retained ledger. */
  forget(actorId: number): Promise<boolean>;
}
export const NON_PURCHASE_REASONS = [
  "too_expensive",
  "unclear_value",
  "not_now",
  "payment_problem",
  "need_other_data",
  "trust",
] as const;
export const PURCHASE_REASONS = ["check_history", "mileage", "accidents", "convenience"] as const;
export const ANALYTICS_REASON_LABELS: Record<AnalyticsReason, string> = {
  too_expensive: "Дорого",
  unclear_value: "Непонятна польза",
  not_now: "Пока не нужен",
  payment_problem: "Не получается оплатить",
  need_other_data: "Нужны другие данные",
  trust: "Не уверен в отчёте",
  check_history: "Проверить историю",
  mileage: "Проверить пробег",
  accidents: "Узнать о повреждениях",
  convenience: "Удобно получить здесь",
};
