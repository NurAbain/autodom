export type OwnerPurpose = "sale" | "property" | "downpayment";
export type OwnerCurrency = "USD" | "KGS";
export type PropertyType = "apartment" | "house" | "land" | "commercial" | "any";

/** One private owner card, independent of the buyer search profile. Unknown amounts are null. */
export interface OwnerVehicle {
  user_id: number;
  chat_id: number;
  purpose: OwnerPurpose;
  make_model: string;
  year: number;
  mileage_km: number | null;
  sale_price_minor: number | null;
  sale_currency: OwnerCurrency | null;
  property_city: string | null;
  property_type: PropertyType | null;
  cash_minor: number | null;
  cash_currency: OwnerCurrency | null;
  monthly_minor: number | null;
  monthly_currency: OwnerCurrency | null;
  consent_at: number;
  updated_at: number;
}

export const OWNER_PURPOSES: Record<OwnerPurpose, string> = {
  sale: "Продать автомобиль",
  property: "Обменять авто на недвижимость",
  downpayment: "Авто как первоначальный взнос",
};
export const PROPERTY_TYPES: Record<PropertyType, string> = {
  apartment: "Квартира",
  house: "Дом",
  land: "Участок",
  commercial: "Коммерческая недвижимость",
  any: "Тип пока не выбран",
};

export function validateOwnerVehicle(card: OwnerVehicle): OwnerVehicle {
  if (
    !Number.isSafeInteger(card.user_id) ||
    card.user_id <= 0 ||
    !Number.isSafeInteger(card.chat_id) ||
    card.chat_id === 0
  )
    throw new Error("Invalid owner identity");
  if (!Object.hasOwn(OWNER_PURPOSES, card.purpose)) throw new Error("Invalid owner purpose");
  if (
    typeof card.make_model !== "string" ||
    !card.make_model.trim() ||
    card.make_model.length > 120
  )
    throw new Error("Invalid owner vehicle description");
  if (!Number.isInteger(card.year) || card.year < 1900 || card.year > 2100)
    throw new Error("Invalid owner vehicle year");
  if (
    card.mileage_km !== null &&
    (!Number.isSafeInteger(card.mileage_km) || card.mileage_km < 0 || card.mileage_km > 10_000_000)
  )
    throw new Error("Invalid owner mileage");
  for (const [amount, currency, positive] of [
    [card.sale_price_minor, card.sale_currency, true],
    [card.cash_minor, card.cash_currency, false],
    [card.monthly_minor, card.monthly_currency, false],
  ] as const) {
    if (amount === null && currency === null) continue;
    if (
      amount === null ||
      !Number.isSafeInteger(amount) ||
      amount < (positive ? 1 : 0) ||
      (currency !== "USD" && currency !== "KGS")
    )
      throw new Error("Invalid owner money");
  }
  if (
    card.property_city !== null &&
    (typeof card.property_city !== "string" ||
      !card.property_city.trim() ||
      card.property_city.length > 80)
  )
    throw new Error("Invalid property city");
  if (card.property_type !== null && !Object.hasOwn(PROPERTY_TYPES, card.property_type))
    throw new Error("Invalid property type");
  if (card.purpose !== "sale" && (card.property_city === null || card.property_type === null))
    throw new Error("Property requirements are missing");
  if (
    !Number.isFinite(card.consent_at) ||
    card.consent_at <= 0 ||
    !Number.isFinite(card.updated_at) ||
    card.updated_at < card.consent_at
  )
    throw new Error("Owner storage consent is missing or invalid");
  return card;
}

export function ownerMoney(amount: number | null, currency: OwnerCurrency | null): string {
  return amount === null || currency === null
    ? "не указано"
    : `${(amount / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${currency}`;
}

/** Plain text assembled only from the owner's statements, not a valuation or verified inspection. */
export function ownerSaleDescription(card: OwnerVehicle): string {
  const facts = [`${card.make_model}, ${card.year} г.`];
  if (card.mileage_km !== null)
    facts.push(`Пробег: ${card.mileage_km.toLocaleString("ru-RU")} км.`);
  if (card.sale_price_minor !== null)
    facts.push(`Желаемая цена: ${ownerMoney(card.sale_price_minor, card.sale_currency)}.`);
  return facts.join("\n");
}

export function ownerExchangeSummary(card: OwnerVehicle): string {
  if (card.purpose === "sale") return "Цель: продать автомобиль.";
  return [
    `Цель: ${OWNER_PURPOSES[card.purpose]}.`,
    `Город: ${card.property_city ?? "не указан"}. Тип: ${card.property_type === null ? "не указан" : PROPERTY_TYPES[card.property_type]}.`,
    `Доплата сейчас: ${ownerMoney(card.cash_minor, card.cash_currency)}.`,
    `Бюджет будущего платежа в месяц: ${ownerMoney(card.monthly_minor, card.monthly_currency)}.`,
    "Это пожелания владельца, не одобрение обмена, ипотеки или рассрочки. Проверенные программы и объекты пока не подключены; заявка никому не отправлена.",
  ].join("\n");
}
