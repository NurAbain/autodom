import {
  BODY_TYPES,
  type Listing,
  makeProfile,
  normalize,
  type Profile,
  TRANSMISSIONS,
} from "@autodom/core";
import { z } from "zod";
import type { MiniAppFilterDraft, MiniAppFilterProfile } from "./miniapp-contract.js";

const MAX_MONEY = 1_000_000_000_00;
const MAX_YEAR = new Date().getUTCFullYear() + 1;
const MAX_QUERY = 160;
const MAX_CITY = 80;

/** The same conditions for every marketplace: text, budget, place and characteristics. */
const plainText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine((value) => !/[\p{Cc}]/u.test(value), "Control characters are not allowed");

export const filterDraftSchema = z
  .object({
    currency: z.enum(["USD", "KGS"]),
    budget_min_minor: z.number().int().min(0).max(MAX_MONEY),
    budget_max_minor: z.number().int().min(1).max(MAX_MONEY),
    query: plainText(MAX_QUERY).refine((value) => {
      if (!value) return true;
      const alternatives = value.split(",");
      return alternatives.length <= 5 && alternatives.every((part) => part.trim().length > 0);
    }, "Укажите до пяти непустых вариантов через запятую"),
    city: plainText(MAX_CITY).refine(
      (value) => value === "" || /\p{L}/u.test(value),
      "Введите название города с буквами",
    ),
    body_type: z
      .string()
      .refine((value) => value === "" || Object.hasOwn(BODY_TYPES, value), "Unknown body type"),
    transmission: z
      .string()
      .refine(
        (value) => value === "" || Object.hasOwn(TRANSMISSIONS, value),
        "Unknown transmission",
      ),
    year_min: z.number().int().min(1900).max(MAX_YEAR).nullable(),
    year_max: z.number().int().min(1900).max(MAX_YEAR).nullable(),
    mileage_max_km: z.number().int().min(0).max(10_000_000).nullable(),
    monitoring: z.boolean().default(false),
  })
  .refine(
    (draft) => draft.budget_min_minor <= draft.budget_max_minor,
    "Бюджет заканчивается раньше, чем начинается",
  )
  .refine(
    (draft) =>
      draft.year_min === null || draft.year_max === null || draft.year_max >= draft.year_min,
    "Год заканчивается раньше, чем начинается",
  );

const DRAFT_MESSAGES: Record<string, string> = {
  currency: "Выберите валюту бюджета.",
  budget_min_minor: "Проверьте нижнюю границу бюджета.",
  budget_max_minor: "Укажите верхнюю границу бюджета.",
  query: "Укажите до пяти непустых вариантов через запятую.",
  city: "Введите название города с буквами.",
  body_type: "Выберите кузов из списка.",
  transmission: "Выберите коробку передач из списка.",
  year_min: "Год от: целое число от 1900.",
  year_max: "Год до: целое число от 1900.",
  mileage_max_km: "Пробег: целое число от 0.",
  monitoring: "Выберите, включать ли уведомления.",
  default: "Проверьте условия: бюджет, текст запроса, город и характеристики.",
};

export type FilterDraftResult =
  | { ok: true; draft: MiniAppFilterDraft }
  | { ok: false; message: string };

/** Reads the flat editor body; the caller reports the message to the user. */
export function parseFilterDraft(body: Record<string, unknown>): FilterDraftResult {
  const parsed = filterDraftSchema.safeParse(body);
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
  return { ok: true, draft: { ...parsed.data, consent: body.consent === true } };
}

/** The characteristic choices the editor offers; the server owns the list. */
export function filterChoices(): {
  bodyTypes: { value: string; label: string }[];
  transmissions: { value: string; label: string }[];
} {
  return {
    bodyTypes: Object.entries(BODY_TYPES).map(([value, label]) => ({ value, label })),
    transmissions: Object.entries(TRANSMISSIONS).map(([value, label]) => ({ value, label })),
  };
}

export interface MiniAppModelChoice {
  id: string;
  value: string;
  label: string;
  /** How many collected ads match the current conditions for this model. */
  matches: number;
}

export interface ModelRequest {
  make: { id: string; value: string; label: string };
  draft: MiniAppFilterDraft;
}

const makeRequestSchema = z.object({
  make_id: z.string().trim().min(1).max(128),
  make_value: plainText(120),
  make_label: plainText(120),
});

export type ModelRequestResult =
  | { ok: true; request: ModelRequest }
  | { ok: false; message: string };

/** Reads the make the user picked together with the conditions of the search. */
export function parseModelRequest(body: Record<string, unknown>): ModelRequestResult {
  const draft = parseFilterDraft(body);
  if (!draft.ok) return { ok: false, message: draft.message };
  const make = makeRequestSchema.safeParse(body);
  if (!make.success)
    return { ok: false, message: "Сначала выберите марку: подсказки приходят из справочника." };
  return {
    ok: true,
    request: {
      make: { id: make.data.make_id, value: make.data.make_value, label: make.data.make_label },
      draft: draft.draft,
    },
  };
}

/**
 * True when the ad belongs to the model. Mashina names the model in its attributes;
 * the other marketplaces only carry it in the title, so both are checked.
 */
export function listingMatchesModel(listing: Listing, model: { value: string }): boolean {
  const attribute = listing.catalog_attributes.model;
  if (attribute && normalize(attribute) === normalize(model.value)) return true;
  const words = normalize(model.value).split(" ").filter(Boolean);
  if (!words.length) return false;
  const title = ` ${normalize(listing.title)} `;
  return words.every((word) => title.includes(` ${word} `));
}

export function filterProfileView(profile: Profile): MiniAppFilterProfile {
  return {
    currency: profile.currency === "KGS" ? "KGS" : "USD",
    budget_min_minor: profile.budget_min_minor,
    budget_max_minor: profile.budget_max_minor,
    query: profile.query,
    city: profile.city,
    body_type: profile.body_type,
    transmission: profile.transmission,
    year_min: profile.year_min,
    year_max: profile.year_max,
    mileage_max_km: profile.mileage_max_km,
    monitoring: profile.monitoring,
    revision: profile.revision,
  };
}

/**
 * Builds the profile the draft describes. Only the local market is searched, and the
 * notes and notification settings the chat owns stay untouched.
 */
export function draftToProfile(
  userId: number,
  draft: MiniAppFilterDraft,
  previous: Profile | null,
): Profile {
  return makeProfile({
    user_id: userId,
    chat_id: userId,
    currency: draft.currency,
    budget_min_minor: draft.budget_min_minor,
    budget_max_minor: draft.budget_max_minor,
    query: draft.query,
    market: "KG",
    budget_scope: previous?.budget_scope ?? "car",
    city: draft.city,
    body_type: draft.body_type,
    year_min: draft.year_min,
    year_max: draft.year_max,
    mileage_max_km: draft.mileage_max_km,
    transmission: draft.transmission,
    use_case: previous?.use_case ?? "",
    allow_import: previous?.allow_import ?? null,
    purchase_by: previous?.purchase_by ?? "",
    quiet_start_minute: previous?.quiet_start_minute ?? null,
    quiet_end_minute: previous?.quiet_end_minute ?? null,
    monitoring: draft.monitoring,
  });
}
