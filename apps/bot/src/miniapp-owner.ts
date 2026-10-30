import { type OwnerDraft, ownerDraftSchema } from "@autodom/core/owner-filter";
import type { OwnerVehicle } from "@autodom/core/owner-vehicle";
import type { MiniAppOwnerCard, MiniAppOwnerChoice } from "./miniapp-contract.js";

/**
 * The message names the field the owner has to fix. The catalogue choice and
 * the free text share one field: either the owner picks the car from the
 * catalogue or writes its name.
 */
const DRAFT_MESSAGES: Record<string, string> = {
  purpose: "Выберите цель: продать, обменять или взнос.",
  make: "Выберите марку и модель автомобиля.",
  model: "Выберите марку и модель автомобиля.",
  make_model: "Укажите марку и модель автомобиля.",
  year: "Укажите год выпуска.",
  mileage_km: "Пробег: целое число километров.",
  body_type: "Выберите кузов из списка.",
  transmission: "Выберите коробку передач из списка.",
  city: "Укажите город автомобиля.",
  sale_price_minor: "Укажите цену и валюту вместе.",
  sale_currency: "Укажите цену и валюту вместе.",
  property_city: "Укажите город недвижимости.",
  property_type: "Выберите тип недвижимости.",
  cash_minor: "Укажите доплату и валюту вместе.",
  cash_currency: "Укажите доплату и валюту вместе.",
  monthly_minor: "Укажите платёж и валюту вместе.",
  monthly_currency: "Укажите платёж и валюту вместе.",
  default: "Проверьте условия: марка и модель, год, город и суммы.",
};

export type OwnerDraftResult = { ok: true; draft: OwnerDraft } | { ok: false; message: string };

/**
 * The catalogue choice travels flat, the way the buyer filter sends it: the
 * three fields of the make stand next to each other in the body.
 */
function readChoice(
  body: Record<string, unknown>,
  prefix: "make" | "model",
): MiniAppOwnerChoice | null {
  const id = body[`${prefix}_id`];
  const value = body[`${prefix}_value`];
  const label = body[`${prefix}_label`];
  const choice: MiniAppOwnerChoice = {
    id: typeof id === "string" ? id : "",
    value: typeof value === "string" ? value : "",
    label: typeof label === "string" ? label : "",
  };
  if (!choice.id && !choice.value && !choice.label) return null;
  return choice;
}

/** Reads the flat editor body; the caller reports the message to the owner. */
export function parseOwnerDraft(body: Record<string, unknown>): OwnerDraftResult {
  const parsed = ownerDraftSchema.safeParse({
    ...body,
    make: readChoice(body, "make"),
    model: readChoice(body, "model"),
    body_type: body.body_type ?? "",
    transmission: body.transmission ?? "",
    city: body.city ?? "",
    make_model: body.make_model ?? "",
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      message:
        typeof field === "string"
          ? (DRAFT_MESSAGES[field] ?? DRAFT_MESSAGES.default!)
          : DRAFT_MESSAGES.default!,
    };
  }
  return { ok: true, draft: parsed.data };
}

/** The card as the browser sees it: unknown texts are empty, unknown sums stay unknown. */
export function ownerCardView(card: OwnerVehicle): MiniAppOwnerCard {
  return {
    purpose: card.purpose,
    make: card.make_id
      ? { id: card.make_id, value: card.make_value ?? "", label: card.make_label ?? "" }
      : null,
    model: card.model_id
      ? { id: card.model_id, value: card.model_value ?? "", label: card.model_label ?? "" }
      : null,
    make_model: card.make_model,
    year: card.year,
    mileage_km: card.mileage_km,
    body_type: card.body_type ?? "",
    transmission: card.transmission ?? "",
    city: card.city ?? "",
    sale_price_minor: card.sale_price_minor,
    sale_currency: card.sale_currency,
    property_city: card.property_city,
    property_type: card.property_type,
    cash_minor: card.cash_minor,
    cash_currency: card.cash_currency,
    monthly_minor: card.monthly_minor,
    monthly_currency: card.monthly_currency,
    updated_at: card.updated_at,
  };
}
