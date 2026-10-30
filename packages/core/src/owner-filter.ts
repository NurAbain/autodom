import { z } from "zod";
import { BODY_TYPES, TRANSMISSIONS } from "./models.js";
import {
  OWNER_PURPOSES,
  type OwnerCurrency,
  type OwnerPurpose,
  type OwnerVehicle,
  PROPERTY_TYPES,
  type PropertyType,
  validateOwnerVehicle,
} from "./owner-vehicle.js";

/**
 * The conditions of the owner's own car. They repeat the fields of the buyer
 * filter — make, model, place, body, transmission, year, mileage and price — so
 * one catalogue and one vocabulary serve both the search and the publication.
 */
export const ownerChoiceSchema = z.object({
  id: z.string().trim().min(1).max(128),
  value: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256),
});
export type OwnerChoice = z.output<typeof ownerChoiceSchema>;

export const ownerBodyTypes = (): { value: string; label: string }[] =>
  Object.entries(BODY_TYPES).map(([value, label]) => ({ value, label }));

export const ownerTransmissions = (): { value: string; label: string }[] =>
  Object.entries(TRANSMISSIONS).map(([value, label]) => ({ value, label }));

export const ownerPurposes = (): { value: string; label: string }[] =>
  Object.entries(OWNER_PURPOSES).map(([value, label]) => ({ value, label }));

export const ownerPropertyTypes = (): { value: string; label: string }[] =>
  Object.entries(PROPERTY_TYPES).map(([value, label]) => ({ value, label }));

const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ownerDraftSchema = z
  .object({
    purpose: z.enum(["sale", "property", "downpayment"]),
    make: ownerChoiceSchema.nullable().default(null),
    model: ownerChoiceSchema.nullable().default(null),
    /** The name the owner wrote when the catalogue did not know the car. */
    make_model: z.string().trim().max(120).default(""),
    year: z.number().int().min(1900).max(2100),
    mileage_km: z.number().int().min(0).max(10_000_000).nullable().default(null),
    body_type: z
      .string()
      .refine((value) => value === "" || Object.hasOwn(BODY_TYPES, value), "Unknown body type"),
    transmission: z
      .string()
      .refine(
        (value) => value === "" || Object.hasOwn(TRANSMISSIONS, value),
        "Unknown transmission",
      ),
    city: z.string().trim().max(80).default(""),
    sale_price_minor: z.number().int().min(1).nullable().default(null),
    sale_currency: z.enum(["USD", "KGS"]).nullable().default(null),
    property_city: z.string().trim().max(80).nullable().default(null),
    property_type: z
      .enum(["apartment", "house", "land", "commercial", "any"])
      .nullable()
      .default(null),
    cash_minor: amount.nullable().default(null),
    cash_currency: z.enum(["USD", "KGS"]).nullable().default(null),
    monthly_minor: amount.nullable().default(null),
    monthly_currency: z.enum(["USD", "KGS"]).nullable().default(null),
  })
  .superRefine((draft, ctx) => {
    if (!ownerVehicleName(draft)) {
      ctx.addIssue({
        code: "custom",
        path: ["make"],
        message: "Укажите марку и модель автомобиля",
      });
    }
    if ((draft.sale_price_minor === null) !== (draft.sale_currency === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["sale_price_minor"],
        message: "Цена и валюта указываются вместе",
      });
    }
    if ((draft.cash_minor === null) !== (draft.cash_currency === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["cash_minor"],
        message: "Доплата и валюта указываются вместе",
      });
    }
    if ((draft.monthly_minor === null) !== (draft.monthly_currency === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["monthly_minor"],
        message: "Платёж и валюта указываются вместе",
      });
    }
    if (draft.purpose !== "sale") {
      if (!draft.property_city) {
        ctx.addIssue({
          code: "custom",
          path: ["property_city"],
          message: "Укажите город недвижимости",
        });
      }
      if (!draft.property_type) {
        ctx.addIssue({
          code: "custom",
          path: ["property_type"],
          message: "Выберите тип недвижимости",
        });
      }
    }
  });

export type OwnerDraft = z.output<typeof ownerDraftSchema>;
export type OwnerDraftInput = z.input<typeof ownerDraftSchema>;

/** The name of the car: the catalogue labels first, the owner's own text otherwise. */
export function ownerVehicleName(draft: {
  make?: OwnerChoice | null;
  model?: OwnerChoice | null;
  make_model?: string;
}): string {
  if (draft.make && draft.model) return `${draft.make.label} ${draft.model.label}`;
  if (draft.make) return draft.make.label;
  return (draft.make_model ?? "").trim();
}

/** Builds the card the draft describes; the consent of a saved card stays valid. */
export function ownerDraftToCard(
  userId: number,
  chatId: number,
  draft: OwnerDraft,
  previous: OwnerVehicle | null,
  now = Date.now() / 1000,
): OwnerVehicle {
  return validateOwnerVehicle({
    user_id: userId,
    chat_id: chatId,
    purpose: draft.purpose,
    make_model: ownerVehicleName(draft),
    make_id: draft.make?.id ?? null,
    make_value: draft.make?.value ?? null,
    make_label: draft.make?.label ?? null,
    model_id: draft.model?.id ?? null,
    model_value: draft.model?.value ?? null,
    model_label: draft.model?.label ?? null,
    year: draft.year,
    mileage_km: draft.mileage_km,
    body_type: draft.body_type || null,
    transmission: draft.transmission || null,
    city: draft.city || null,
    sale_price_minor: draft.sale_price_minor,
    sale_currency: draft.sale_currency,
    property_city: draft.property_city || null,
    property_type: draft.property_type,
    cash_minor: draft.cash_minor,
    cash_currency: draft.cash_currency,
    monthly_minor: draft.monthly_minor,
    monthly_currency: draft.monthly_currency,
    consent_at: previous?.consent_at ?? now,
    updated_at: now,
  });
}

/** The draft of a saved card, ready for the editor. */
export function ownerCardToDraft(card: OwnerVehicle): OwnerDraft {
  return ownerDraftSchema.parse({
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
  });
}

/** The purposes and the property types the owner can choose from. */
export function ownerChoiceLists(): {
  purposes: { value: string; label: string }[];
  propertyTypes: { value: string; label: string }[];
} {
  return { purposes: ownerPurposes(), propertyTypes: ownerPropertyTypes() };
}

export type { OwnerCurrency, OwnerPurpose, PropertyType };
