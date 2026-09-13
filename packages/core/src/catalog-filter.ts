import { z } from "zod";
import type { Listing } from "./models.js";
import { normalize } from "./normalization.js";

export const CATALOG_VEHICLE_LABELS = {
  make: "Марка",
  model: "Модель",
  generation: "Поколение",
  modification: "Модификация",
} as const;
export const CATALOG_OPTION_LABELS = {
  body_type: "Кузов",
  fuel_type: "Топливо",
  drive_type: "Привод",
  gearbox: "Коробка передач",
  steering_wheel: "Руль",
  color: "Цвет",
  condition: "Состояние",
  exchange_option: "Обмен",
  region: "Регион / страна",
  city: "Город",
  availibility: "Наличие",
} as const;
export const CATALOG_RANGE_LABELS = {
  year: "Год выпуска",
  mileage: "Пробег, км",
  engine_volume: "Объём двигателя, л",
} as const;
export type CatalogVehicleKey = keyof typeof CATALOG_VEHICLE_LABELS;
export type CatalogOptionKey = keyof typeof CATALOG_OPTION_LABELS;
export type CatalogRangeKey = keyof typeof CATALOG_RANGE_LABELS;
export type CatalogFieldKey = CatalogVehicleKey | CatalogOptionKey;

const choiceText = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u);
const choiceSchema = z
  .object({
    id: choiceText.max(128),
    value: choiceText,
    label: choiceText,
  })
  .strict();
export type CatalogChoice = z.output<typeof choiceSchema>;
export interface ModificationScope {
  modelId: string;
  generation: string;
}

export interface CatalogLookup {
  getOptions(
    key: CatalogFieldKey,
    parentId?: string,
    scope?: ModificationScope,
  ): Promise<readonly CatalogChoice[]>;
}
export const catalogChoicesSchema = z.array(choiceSchema).max(10_000);
const vehicleKeys = Object.keys(CATALOG_VEHICLE_LABELS) as CatalogVehicleKey[];
const optionKeys = Object.keys(CATALOG_OPTION_LABELS) as CatalogOptionKey[];
const rangeKeys = Object.keys(CATALOG_RANGE_LABELS) as CatalogRangeKey[];
const vehicleSchema = z
  .object({
    make: choiceSchema.optional(),
    model: choiceSchema.optional(),
    generation: choiceSchema.optional(),
    modification: choiceSchema.optional(),
  })
  .strict()
  .superRefine((vehicle, context) => {
    if (!vehicle.make) context.addIssue({ code: "custom", message: "Vehicle requires a make" });
    for (let index = 1; index < vehicleKeys.length; index++) {
      const key = vehicleKeys[index]!;
      if (vehicle[key] && !vehicle[vehicleKeys[index - 1]!])
        context.addIssue({ code: "custom", path: [key], message: "Vehicle ancestor is missing" });
    }
  });
export type CatalogVehicle = z.output<typeof vehicleSchema>;
const choices = z.array(choiceSchema).max(50).optional();
function rangeSchema(minimum: number, maximum: number, integer = false) {
  const value = integer
    ? z.number().finite().int().min(minimum).max(maximum)
    : z.number().finite().min(minimum).max(maximum);
  return z
    .object({ min: value.nullable(), max: value.nullable() })
    .strict()
    .refine(
      (range) => range.min === null || range.max === null || range.min <= range.max,
      "Range minimum exceeds maximum",
    );
}
export const catalogFilterSchema = z
  .object({
    vehicles: z.array(vehicleSchema).max(5),
    options: z
      .object({
        body_type: choices,
        fuel_type: choices,
        drive_type: choices,
        gearbox: choices,
        steering_wheel: choices,
        color: choices,
        condition: choices,
        exchange_option: choices,
        region: choices,
        city: choices,
        availibility: choices,
      })
      .strict(),
    ranges: z
      .object({
        year: rangeSchema(1800, 2200, true).optional(),
        mileage: rangeSchema(0, 100_000_000).optional(),
        engine_volume: rangeSchema(0, 100).optional(),
      })
      .strict(),
    below_market_percent: z
      .number()
      .finite()
      .refine(
        (value) => value >= 5 && value <= 45 && value % 5 === 0,
        "Unsupported source below-market threshold",
      )
      .nullable(),
  })
  .strict();
export type CatalogFilter = z.output<typeof catalogFilterSchema>;
export function emptyCatalogFilter(): CatalogFilter {
  return { vehicles: [], options: {}, ranges: {}, below_market_percent: null };
}

/** Source values are exact canonical text; lookup IDs never identify an ad's value. */
export function matchesCatalogFilter(filter: CatalogFilter, listing: Listing): boolean {
  const attributes = listing.catalog_attributes;
  let title: string | undefined;
  if (
    filter.vehicles.length &&
    !filter.vehicles.some((vehicle) =>
      vehicleKeys.every((key) => {
        const choice = vehicle[key];
        if (!choice) return true;
        const value = attributes[key];
        if (value) return value === choice.value;
        title ??= ` ${normalize(listing.title)} `;
        const words = normalize(choice.value).split(" ").filter(Boolean);
        return words.length > 0 && words.every((word) => title!.includes(` ${word} `));
      }),
    )
  )
    return false;
  for (const key of optionKeys) {
    const values = filter.options[key];
    if (values?.length && !values.some((choice) => attributes[key] === choice.value)) return false;
  }
  for (const key of rangeKeys) {
    const range = filter.ranges[key];
    if (!range || (range.min === null && range.max === null)) continue;
    const value = listing.catalog_numbers[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (range.min !== null && value < range.min) ||
      (range.max !== null && value > range.max)
    )
      return false;
  }
  if (filter.below_market_percent !== null) {
    const value = listing.catalog_numbers.price_range;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value > -filter.below_market_percent
    )
      return false;
  }
  return true;
}
