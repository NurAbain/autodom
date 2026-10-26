import { z } from "zod";

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
