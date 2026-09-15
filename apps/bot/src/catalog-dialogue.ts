import { BODY_TYPES, BUDGET_SCOPES, MARKETS, money, TRANSMISSIONS, USE_CASES } from "@autodom/core";
import type { CatalogLookup } from "@autodom/core/catalog-filter";
import {
  CATALOG_OPTION_LABELS,
  CATALOG_RANGE_LABELS,
  CATALOG_VEHICLE_LABELS,
  type CatalogChoice,
  type CatalogFieldKey,
  type CatalogFilter,
  type CatalogOptionKey,
  type CatalogRangeKey,
  type CatalogVehicleKey,
  emptyCatalogFilter,
} from "@autodom/core/catalog-filter";
import { Decimal } from "decimal.js";
import type { Button, Buttons, Reply } from "./conversation.js";
import { CatalogPendingError } from "./vehicle-catalog.js";

type Draft = Record<string, unknown>;
type Action =
  | { kind: "go"; state: string }
  | { kind: "row"; index: number }
  | { kind: "field"; key: string }
  | { kind: "drop_field"; key: string; value: unknown }
  | { kind: "drop_vehicle"; index: number }
  | { kind: "drop_option"; key: CatalogOptionKey; value: string }
  | { kind: "drop_range"; key: CatalogRangeKey }
  | { kind: "add" | "remove" | "reset" | "clear" | "retry" | "search_clear" }
  | { kind: "pick"; key: CatalogFieldKey }
  | { kind: "option"; choice: CatalogChoice }
  | { kind: "page"; page: number }
  | { kind: "range"; key: CatalogRangeKey }
  | { kind: "bound"; bound: "min" | "max" }
  | { kind: "preset"; min: number | null; max: number | null }
  | { kind: "below"; value: number | null };
export interface CatalogTransition {
  state: string;
  data: Draft;
  error?: string;
}
const VEHICLE_KEYS: CatalogVehicleKey[] = ["make", "model", "generation", "modification"];
const OPTION_KEYS = Object.keys(CATALOG_OPTION_LABELS) as CatalogOptionKey[];
const RANGE_KEYS = Object.keys(CATALOG_RANGE_LABELS) as CatalogRangeKey[];
const PAGE_SIZE = 8;
const escapeText = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[char]!,
  );
const filterOf = (data: Draft): CatalogFilter =>
  (data.catalog_filter as CatalogFilter | undefined) ?? emptyCatalogFilter();
const selectedRow = (data: Draft) => filterOf(data).vehicles[Number(data.cat_row_index)];
const vehicleLabel = (row: CatalogFilter["vehicles"][number]) =>
  VEHICLE_KEYS.map((key) => row[key]?.label)
    .filter(Boolean)
    .join(" · ");
const unit = (key: CatalogRangeKey) =>
  key === "mileage" ? " км" : key === "engine_volume" ? " л" : "";
const rangeLabel = (key: CatalogRangeKey, min: number | null, max: number | null) =>
  min === null && max === null
    ? "без ограничения"
    : `${min === null ? "" : `от ${min}`}${min !== null && max !== null ? " " : ""}${max === null ? "" : `до ${max}`}${unit(key)}`;
export const CATALOG_COVERAGE_NOTE =
  "Марка, модель, поколение и модификация ищутся по названию объявления, если отдельные параметры не указаны. Остальные точные условия требуют фактов источника: если выбранный факт неизвестен (в том числе у другого источника), объявление исключается. Справочник шире собранных объявлений: совпадений может пока не быть. «Ниже рынка» — по оценке площадки, не независимой оценке Autodom; объявления без оценки исключаются. Сейчас покрытие этой оценкой ограничено, в текущей выдаче она может отсутствовать.";

export function catalogSummary(filter: CatalogFilter): string {
  const lines: string[] = [];
  if (filter.vehicles.length)
    lines.push(
      `Автомобили из справочника (ИЛИ): ${filter.vehicles.map((row) => escapeText(vehicleLabel(row))).join(" / ")}`,
    );
  for (const key of OPTION_KEYS) {
    const selected = filter.options[key];
    if (selected?.length)
      lines.push(
        `${CATALOG_OPTION_LABELS[key]}: ${selected.map((choice) => escapeText(choice.label)).join(", ")}`,
      );
  }
  for (const key of RANGE_KEYS) {
    const range = filter.ranges[key];
    if (range) lines.push(`${CATALOG_RANGE_LABELS[key]}: ${rangeLabel(key, range.min, range.max)}`);
  }
  if (filter.below_market_percent !== null)
    lines.push(`Ниже рынка Mashina: от ${filter.below_market_percent}%`);
  return lines.join("\n");
}

function clearLegacy(data: Draft, key: string): void {
  const fields: Record<string, [string, unknown]> = {
    body_type: ["body_type", ""],
    gearbox: ["transmission", ""],
    city: ["city", ""],
    year: ["year_min", null],
    mileage: ["mileage_max_km", null],
  };
  const field = fields[key];
  if (field) data[field[0]] = field[1];
}
export function renderFilterOverview(
  data: Draft,
  choice: (label: string, value: string) => Button,
): Reply {
  const filter = filterOf(data);
  const actions: Record<string, Action> = {};
  const editor: NonNullable<Reply["filterEditor"]> = {
    sections: [],
    chips: [],
    description:
      "Укажите важное; остальные параметры не ограничивают поиск. Цена — без дополнительных расходов. Неизвестные данные не проходят выбранные фильтры.",
  };
  const buttons: Button[][] = [];
  const button = (label: string, action: Action) => {
    const id = `c${Object.keys(actions).length.toString(36)}`;
    actions[id] = action;
    const result = choice(label, id);
    buttons.push([result]);
    return result[1];
  };
  const section = (title: string) => {
    const result = {
      title,
      fields: [] as NonNullable<Reply["filterEditor"]>["sections"][number]["fields"],
    };
    editor.sections.push(result);
    return result;
  };
  const field = (
    group: NonNullable<Reply["filterEditor"]>["sections"][number],
    label: string,
    value: string,
    action: Action,
  ) => group.fields.push({ label, value, command: button(`${label}: ${value}`, action) });
  const chip = (label: string, action: Action) =>
    editor.chips.push({ label, command: button(`Убрать · ${label}`, action) });
  const basic = section("Автомобиль и бюджет");
  if (!filter.vehicles.length)
    field(basic, "Выбрать автомобиль", "любая марка и модель", { kind: "add" });
  filter.vehicles.forEach((row, index) => {
    field(basic, `Автомобиль ${index + 1}`, vehicleLabel(row), { kind: "row", index });
    chip(vehicleLabel(row), { kind: "drop_vehicle", index });
  });
  if (filter.vehicles.length && filter.vehicles.length < 5)
    field(basic, "Добавить альтернативу", `${filter.vehicles.length} из 5`, { kind: "add" });
  field(
    basic,
    "Бюджет",
    `${data.minimum ? money(Number(data.minimum), String(data.currency)) + " — " : "до "}${money(Number(data.maximum), String(data.currency))}`,
    { kind: "field", key: "budget" },
  );
  field(basic, "Валюта", String(data.currency), { kind: "field", key: "currency" });
  field(
    basic,
    "Что входит в бюджет",
    BUDGET_SCOPES[data.budget_scope as keyof typeof BUDGET_SCOPES] ?? BUDGET_SCOPES.car,
    { kind: "field", key: "budget_scope" },
  );
  const location = section("Рынок и место объявления");
  field(location, "Рынок", MARKETS[data.market as keyof typeof MARKETS] ?? String(data.market), {
    kind: "field",
    key: "market",
  });
  const common = section("Основные характеристики");
  const more = section("Другие характеристики");
  const legacyValues: Partial<Record<CatalogOptionKey | CatalogRangeKey, string>> = {
    city: String(data.city ?? ""),
    body_type: BODY_TYPES[data.body_type as keyof typeof BODY_TYPES] ?? "",
    gearbox: TRANSMISSIONS[data.transmission as keyof typeof TRANSMISSIONS] ?? "",
    year: data.year_min == null ? "" : `от ${data.year_min}`,
    mileage: data.mileage_max_km == null ? "" : `до ${data.mileage_max_km} км`,
  };
  for (const key of OPTION_KEYS) {
    const selected = filter.options[key] ?? [];
    const group = ["region", "city"].includes(key)
      ? location
      : ["body_type", "fuel_type", "gearbox", "drive_type"].includes(key)
        ? common
        : more;
    field(
      group,
      CATALOG_OPTION_LABELS[key],
      selected.map((item) => item.label).join(", ") ||
        (legacyValues[key] ? `${legacyValues[key]} · прежнее; выбрать замену` : "любые"),
      { kind: "pick", key },
    );
    for (const item of selected)
      chip(`${CATALOG_OPTION_LABELS[key]}: ${item.label}`, {
        kind: "drop_option",
        key,
        value: item.value,
      });
  }
  for (const key of RANGE_KEYS) {
    const range = filter.ranges[key];
    field(
      key === "engine_volume" ? more : common,
      CATALOG_RANGE_LABELS[key],
      range
        ? rangeLabel(key, range.min, range.max)
        : legacyValues[key]
          ? `${legacyValues[key]} · прежнее; задать замену`
          : "без ограничения",
      { kind: "range", key },
    );
    if (range)
      chip(`${CATALOG_RANGE_LABELS[key]}: ${rangeLabel(key, range.min, range.max)}`, {
        kind: "drop_range",
        key,
      });
  }
  field(
    more,
    "Ниже рынка Mashina",
    filter.below_market_percent === null ? "без ограничения" : `от ${filter.below_market_percent}%`,
    { kind: "go", state: "cat_below" },
  );
  if (filter.below_market_percent !== null)
    chip(`Ниже рынка: от ${filter.below_market_percent}%`, { kind: "below", value: null });
  const extra = section("Дополнительные условия и заметки");
  const legacyFields: [string, string, string, unknown][] = [
    ["city", "Город объявления · прежнее условие", String(data.city ?? ""), ""],
    [
      "body_type",
      "Кузов · прежнее условие",
      BODY_TYPES[data.body_type as keyof typeof BODY_TYPES] ?? "",
      "",
    ],
    [
      "year_min",
      "Год от · прежнее условие",
      data.year_min == null ? "" : String(data.year_min),
      null,
    ],
    [
      "mileage_max_km",
      "Пробег до · прежнее условие",
      data.mileage_max_km == null ? "" : `${data.mileage_max_km} км`,
      null,
    ],
    [
      "transmission",
      "Коробка · прежнее условие",
      TRANSMISSIONS[data.transmission as keyof typeof TRANSMISSIONS] ?? "",
      "",
    ],
  ];
  for (const [key, label, value, empty] of legacyFields) {
    if (!value) continue;
    field(extra, label, value, { kind: "field", key });
    chip(`${label}: ${value}`, { kind: "drop_field", key, value: empty });
  }
  const optional: [string, string, string, unknown][] = [
    ["query", "Текстовый запрос", String(data.query ?? ""), ""],
    [
      "allow_import",
      "Готовность ждать импорт",
      data.allow_import === true ? "готов ждать" : data.allow_import === false ? "без импорта" : "",
      null,
    ],
    [
      "use_case",
      "Для чего автомобиль (заметка)",
      USE_CASES[data.use_case as keyof typeof USE_CASES] ?? "",
      "",
    ],
    ["purchase_by", "Планируемая дата (заметка)", String(data.purchase_by ?? ""), ""],
  ];
  for (const [key, label, value, empty] of optional) {
    field(extra, label, value || "не задано", { kind: "field", key });
    if (value) chip(`${label}: ${value}`, { kind: "drop_field", key, value: empty });
  }
  data.cat_actions = actions;
  return {
    text:
      "<b>Условия поиска</b>\nНастройте поля кнопками. Необязательные параметры можно пропустить.\n\n" +
      editor.sections
        .map(
          (group) =>
            `<b>${group.title}</b>\n${group.fields.map((item) => `${escapeText(item.label)}: ${escapeText(item.value)}`).join("\n")}`,
        )
        .join("\n\n") +
      "\n\nЦена — из объявления, не все расходы покупки. Неизвестный факт не проходит выбранный фильтр. Справочник шире собранных объявлений: совпадений может пока не быть.",
    buttons,
    filterEditor: editor,
  };
}
function parentId(data: Draft, key: CatalogFieldKey): string | undefined {
  const index = VEHICLE_KEYS.indexOf(key as CatalogVehicleKey);
  if (index > 0) return selectedRow(data)?.[VEHICLE_KEYS[index - 1]!]?.id;
  if (key === "city") {
    const regions = filterOf(data).options.region;
    return regions?.length === 1 ? regions[0]!.id : undefined;
  }
  return undefined;
}
function pickerBack(data: Draft): string {
  return VEHICLE_KEYS.includes(data.cat_key as CatalogVehicleKey) ? "cat_row" : "review";
}

export async function renderCatalog(
  state: string,
  data: Draft,
  choice: (label: string, value: string) => Button,
  catalog: CatalogLookup,
): Promise<Reply> {
  const actions: Record<string, Action> = {};
  const button = (label: string, action: Action): Button => {
    const id = `c${Object.keys(actions).length.toString(36)}`;
    actions[id] = action;
    return choice(label, id);
  };
  const go = (label: string, target: string) => button(label, { kind: "go", state: target });
  const filter = filterOf(data);
  let text = "";
  let buttons: Buttons = [];
  let input: Reply["input"];
  let picker: Reply["picker"];
  let filterEditor: Reply["filterEditor"];
  if (state === "cat_menu") return renderFilterOverview(data, choice);
  if (state === "cat_vehicles") {
    text =
      "<b>Автомобили — до пяти альтернатив</b>\nДостаточно марки; модель, поколение и модификацию можно не ограничивать. Варианты объединены ИЛИ. Текстовый запрос задаётся отдельно и, если оставлен, тоже обязателен.";
    filterEditor = {
      description: "До пяти альтернатив. Достаточно марки; поколение и модификация необязательны.",
      sections: [{ title: "Автомобили", fields: [] }],
      chips: [],
    };
    buttons = filter.vehicles.map((row, index) => {
      const edit = button(`${index + 1}. ${vehicleLabel(row) || "Выбрать марку"}`, {
        kind: "row",
        index,
      });
      filterEditor!.sections[0]!.fields.push({
        label: `Автомобиль ${index + 1}`,
        value: vehicleLabel(row),
        command: edit[1],
      });
      const remove = button(`Убрать · ${vehicleLabel(row)}`, { kind: "drop_vehicle", index });
      filterEditor!.chips.push({ label: vehicleLabel(row), command: remove[1] });
      return [edit, remove];
    });
    if (filter.vehicles.length < 5)
      buttons = [...buttons, [button("Добавить автомобиль", { kind: "add" })]];
    buttons = [
      ...buttons,
      [button("Любые автомобили / очистить список", { kind: "clear" })],
      [go("Назад ко всем фильтрам", "cat_menu")],
      [go("Готово — к сохранению", "review")],
    ];
  } else if (state === "cat_row") {
    const row = selectedRow(data);
    text = `<b>Автомобиль ${Number(data.cat_row_index) + 1}</b>\n${escapeText(row ? vehicleLabel(row) : "Новая альтернатива")}\nСмена родителя снимает дочерние условия.`;
    filterEditor = {
      description:
        "Смена марки, модели или поколения снимает дочерние условия. Необязательные ступени можно пропустить кнопкой «Готово».",
      sections: [{ title: `Автомобиль ${Number(data.cat_row_index) + 1}`, fields: [] }],
      chips: [],
    };
    buttons = VEHICLE_KEYS.filter((_, index) => index === 0 || row?.[VEHICLE_KEYS[index - 1]!]).map(
      (key) => {
        const edit = button(`${CATALOG_VEHICLE_LABELS[key]}: ${row?.[key]?.label ?? "любая"}`, {
          kind: "pick",
          key,
        });
        filterEditor!.sections[0]!.fields.push({
          label: CATALOG_VEHICLE_LABELS[key],
          value: row?.[key]?.label ?? "любая",
          command: edit[1],
        });
        return [edit];
      },
    );
    if (row) buttons = [...buttons, [button("Удалить этот автомобиль", { kind: "remove" })]];
    buttons = [
      ...buttons,
      [go("Готово — к условиям поиска", "review")],
      [go("Назад к автомобилям", "cat_vehicles")],
    ];
  } else if (state === "cat_pick") {
    const key = data.cat_key as CatalogFieldKey;
    const vehicleIndex = VEHICLE_KEYS.indexOf(key as CatalogVehicleKey);
    const row = selectedRow(data);
    const selected =
      vehicleIndex >= 0
        ? row?.[key as CatalogVehicleKey]
          ? [row[key as CatalogVehicleKey]!]
          : []
        : (filter.options[key as CatalogOptionKey] ?? []);
    const title =
      vehicleIndex >= 0
        ? CATALOG_VEHICLE_LABELS[key as CatalogVehicleKey]
        : CATALOG_OPTION_LABELS[key as CatalogOptionKey];
    const parent = parentId(data, key);
    const needsParent = vehicleIndex > 0 || key === "city";
    const subtitle =
      vehicleIndex >= 0
        ? row
          ? vehicleLabel(row)
          : "Новая альтернатива"
        : key === "city"
          ? filter.options.region?.map((region) => region.label).join(", ")
          : "Несколько вариантов объединены ИЛИ";
    picker = {
      title,
      ...(subtitle ? { subtitle } : {}),
      page: 1,
      pages: 1,
      selected: selected.length,
      searchable: false,
      options: [],
      search: String(data.cat_search ?? ""),
    };
    text = `<b>${escapeText(title)}</b>\n${escapeText(subtitle ?? "")}\nВыбрано: ${selected.map((option) => escapeText(option.label)).join(", ") || "любые"}`;
    if (needsParent && !parent) {
      text +=
        key === "city"
          ? "\nСначала выберите один регион/страну — города берутся только из него."
          : "\nСначала выберите родителя автомобиля.";
      if (key === "city")
        buttons = [[button("Выбрать регион / страну", { kind: "pick", key: "region" })]];
    } else {
      try {
        const options =
          key === "modification" && row?.model && row.generation
            ? await catalog.getOptions(key, parent, {
                modelId: row.model.id,
                generation: row.generation.value,
              })
            : await catalog.getOptions(key, parent);
        const query = String(data.cat_search ?? "")
          .trim()
          .toLocaleLowerCase("ru");
        const filtered = query
          ? options.filter((option) => option.label.toLocaleLowerCase("ru").includes(query))
          : options;
        const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        const page = Math.min(Math.max(0, Number(data.cat_page) || 0), pages - 1);
        data.cat_page = page;
        picker = {
          title,
          ...(subtitle ? { subtitle } : {}),
          page: page + 1,
          pages,
          selected: selected.length,
          searchable: true,
          options: [],
          search: String(data.cat_search ?? ""),
        };
        input = {
          label: "Поиск по справочнику",
          placeholder: "Введите часть названия",
          mode: "text",
        };
        text += `\nСтраница ${page + 1} / ${pages}${query ? ` · поиск: ${escapeText(String(data.cat_search))}` : ""}. Отправьте часть названия для поиска.`;
        if (!filtered.length)
          text += "\nВарианты не найдены. Измените поиск или снимите ограничение.";
        buttons = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((option) => {
          const isSelected = selected.some((item) => item.value === option.value);
          const item = button(`${isSelected ? "✓ " : ""}${option.label}`, {
            kind: "option",
            choice: option,
          });
          picker!.options.push({ command: item[1], selected: isSelected });
          return [item];
        });
        const pagesRow: Button[] = [];
        if (page > 0)
          pagesRow.push(button("Предыдущая страница", { kind: "page", page: page - 1 }));
        if (page + 1 < pages)
          pagesRow.push(button("Следующая страница", { kind: "page", page: page + 1 }));
        if (pagesRow.length) buttons = [...buttons, pagesRow];
        if (query) buttons = [...buttons, [button("Сбросить поиск", { kind: "search_clear" })]];
      } catch (error) {
        text +=
          error instanceof CatalogPendingError
            ? `\n${escapeText(error.message)}`
            : "\nСправочник временно недоступен. Выбранные условия сохранены в черновике. Повторите запрос или вернитесь назад.";
        buttons = [[button("Повторить загрузку", { kind: "retry" })]];
      }
    }
    const apply = go("Готово — к условиям поиска", "review");
    picker.applyCommand = apply[1];
    buttons = [
      ...buttons,
      [button("Любые / снять ограничение", { kind: "clear" })],
      [apply],
      [go("Назад", pickerBack(data))],
    ];
  } else if (state === "cat_range" || state === "cat_bound") {
    const key = data.cat_range_key as CatalogRangeKey;
    const range = filter.ranges[key] ?? { min: null, max: null };
    text = `<b>${CATALOG_RANGE_LABELS[key]}</b>\nСейчас: ${rangeLabel(key, range.min, range.max)}. Границы включаются.`;
    if (state === "cat_bound") {
      text += `\nВведите ${data.cat_bound === "min" ? "нижнюю" : "верхнюю"} границу или «-», чтобы убрать её.${key === "mileage" ? " Можно указать км или miles/миль: 100 miles = 160.9344 км, без округления." : key === "engine_volume" ? " Объём в литрах, например 1.6." : " Год — целое число от 1900 до следующего года."}`;
      input = {
        label: data.cat_bound === "min" ? "Нижняя граница" : "Верхняя граница",
        placeholder:
          key === "mileage"
            ? "100000 км или 60000 miles"
            : key === "engine_volume"
              ? "1.6"
              : "2015",
        mode: key === "year" ? "numeric" : key === "mileage" ? "text" : "decimal",
      };
      buttons = [
        [button("Без этой границы", { kind: "clear" })],
        [go("Назад без изменения", "cat_range")],
      ];
    } else {
      const presets: [number | null, number | null][] =
        key === "year"
          ? [
              [2010, null],
              [2015, null],
              [2020, null],
              [2023, null],
            ]
          : key === "mileage"
            ? [
                [null, 50000],
                [null, 100000],
                [null, 150000],
                [null, 200000],
              ]
            : [
                [null, 1.6],
                [null, 2],
                [1.5, 2.5],
                [2, 3.5],
              ];
      buttons = presets.map(([min, max]) => [
        button(rangeLabel(key, min, max), { kind: "preset", min, max }),
      ]);
      buttons = [
        ...buttons,
        [
          button("Задать минимум", { kind: "bound", bound: "min" }),
          button("Задать максимум", { kind: "bound", bound: "max" }),
        ],
        [button("Любые / снять ограничение", { kind: "clear" })],
        [go("Готово / назад", "review")],
      ];
    }
  } else if (state === "cat_below") {
    text = `<b>Ниже рынка Mashina</b>\nСейчас: ${filter.below_market_percent === null ? "без ограничения" : `от ${filter.below_market_percent}%`}. По оценке площадки, не независимой оценке Autodom; объявления без оценки исключаются. Сейчас покрытие этой оценкой ограничено, в текущей выдаче она может отсутствовать.`;
    buttons = [5, 10, 15, 20, 25, 30, 35, 40, 45].map((value) => [
      button(`От ${value}% ниже рынка`, { kind: "below", value }),
    ]);
    buttons = [
      ...buttons,
      [button("Любые / снять ограничение", { kind: "below", value: null })],
      [go("Назад к условиям поиска", "review")],
    ];
  }
  data.cat_actions = actions;
  return {
    text,
    buttons: [...buttons, [["Отмена всех изменений", "/cancel"]]],
    ...(input ? { input } : {}),
    ...(picker ? { picker } : {}),
    ...(filterEditor ? { filterEditor } : {}),
  };
}

function parseBoundary(text: string, key: CatalogRangeKey): number | null {
  if (text.length > 80) throw new Error("Граница: не более 80 символов.");
  if (text.trim() === "-") return null;
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*(км|km|mi|miles?|миль|мили|миля|л|l)?$/iu.exec(
    text.trim().replace(/(?<=\d)[ \u00a0](?=\d)/g, ""),
  );
  if (!match)
    throw new Error(
      "Введите неотрицательное число без разделителей, кроме пробелов тысяч и десятичной точки/запятой; «-» убирает границу.",
    );
  const suffix = match[2]?.toLowerCase();
  const miles = suffix && ["mi", "mile", "miles", "миль", "мили", "миля"].includes(suffix);
  if (
    (key === "year" && suffix) ||
    (key === "engine_volume" && suffix && !["л", "l"].includes(suffix)) ||
    (key === "mileage" && suffix && ["л", "l"].includes(suffix))
  )
    throw new Error("Единица измерения не относится к этому полю.");
  const raw = new Decimal(match[1]!.replace(",", "."));
  const value = (miles ? raw.times("1.609344") : raw).toNumber();
  const min = key === "year" ? 1900 : 0;
  const max =
    key === "year" ? new Date().getUTCFullYear() + 1 : key === "mileage" ? 10_000_000 : 20;
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (key === "year" && !Number.isInteger(value))
  )
    throw new Error(
      `Допустимо ${key === "year" ? "целое число" : "число"} от ${min} до ${max}${unit(key)}.`,
    );
  return value;
}

export function catalogActionAllowed(data: Draft, action: string): boolean {
  return Object.hasOwn((data.cat_actions as Record<string, Action> | undefined) ?? {}, action);
}

export function updateCatalog(
  state: string,
  original: Draft,
  actionId: string | null,
  text: string,
): CatalogTransition {
  const data = structuredClone(original);
  const filter = filterOf(data);
  data.catalog_filter = filter;
  const action =
    actionId === null
      ? undefined
      : (data.cat_actions as Record<string, Action> | undefined)?.[actionId];
  const next = (target = state, error?: string): CatalogTransition => ({
    state: target,
    data,
    ...(error ? { error } : {}),
  });
  const openPick = (key: CatalogFieldKey) => {
    data.cat_key = key;
    data.cat_page = 0;
    data.cat_search = "";
    return next("cat_pick");
  };
  const setRange = (min: number | null, max: number | null) => {
    if (min !== null && max !== null && min > max)
      return next(
        state,
        "Минимум не может превышать максимум. Сначала измените или снимите другую границу.",
      );
    const key = data.cat_range_key as CatalogRangeKey;
    if (min === null && max === null) delete filter.ranges[key];
    else filter.ranges[key] = { min, max };
    clearLegacy(data, key);
    return next("cat_range");
  };
  if (!action) {
    if (actionId !== null) return next(state, "Кнопка не относится к текущему шагу.");
    if (state === "cat_pick") {
      if ([...text].length > 80) return next(state, "Поиск: не более 80 символов.");
      data.cat_search = text;
      data.cat_page = 0;
      return next();
    }
    if (state === "cat_bound") {
      try {
        const key = data.cat_range_key as CatalogRangeKey;
        const range = filter.ranges[key] ?? { min: null, max: null };
        const value = parseBoundary(text, key);
        return setRange(
          data.cat_bound === "min" ? value : range.min,
          data.cat_bound === "max" ? value : range.max,
        );
      } catch (error) {
        return next(state, error instanceof Error ? error.message : String(error));
      }
    }
    return next(state, "Выберите действие кнопкой.");
  }
  if (action.kind === "field") {
    data.return_review = true;
    return next(action.key);
  }
  if (action.kind === "drop_field") {
    data[action.key] = action.value;
    return next(state);
  }
  if (action.kind === "drop_vehicle") {
    filter.vehicles.splice(action.index, 1);
    return next(state);
  }
  if (action.kind === "drop_option") {
    const selected = filter.options[action.key]?.filter((item) => item.value !== action.value);
    if (selected?.length) filter.options[action.key] = selected;
    else delete filter.options[action.key];
    if (action.key === "region") delete filter.options.city;
    return next(state);
  }
  if (action.kind === "drop_range") {
    delete filter.ranges[action.key];
    return next(state);
  }
  if (action.kind === "go") return next(action.state);
  if (action.kind === "retry") return next();
  if (action.kind === "search_clear") {
    data.cat_search = "";
    data.cat_page = 0;
    return next();
  }
  if (action.kind === "page") {
    data.cat_page = action.page;
    return next();
  }
  if (action.kind === "reset") {
    data.catalog_filter = emptyCatalogFilter();
    return next("cat_menu");
  }
  if (action.kind === "row") {
    data.cat_row_index = action.index;
    return state === "review" || state === "refine" || state === "cat_menu"
      ? openPick(selectedRow(data)?.make ? "model" : "make")
      : next("cat_row");
  }
  if (action.kind === "add") {
    if (filter.vehicles.length >= 5)
      return next(state, "Можно добавить не более пяти автомобилей.");
    data.cat_row_index = filter.vehicles.length;
    return openPick("make");
  }
  if (action.kind === "remove") {
    filter.vehicles.splice(Number(data.cat_row_index), 1);
    return next("cat_vehicles");
  }
  if (action.kind === "pick") return openPick(action.key);
  if (action.kind === "range") {
    data.cat_range_key = action.key;
    return next("cat_range");
  }
  if (action.kind === "bound") {
    data.cat_bound = action.bound;
    return next("cat_bound");
  }
  if (action.kind === "preset") return setRange(action.min, action.max);
  if (action.kind === "below") {
    filter.below_market_percent = action.value;
    return next(
      state === "review" || state === "refine" || state === "cat_menu" ? state : "cat_below",
    );
  }
  if (action.kind === "clear") {
    if (state === "cat_vehicles") {
      filter.vehicles = [];
      return next();
    }
    if (state === "cat_range") return setRange(null, null);
    if (state === "cat_bound") {
      const range = filter.ranges[data.cat_range_key as CatalogRangeKey] ?? {
        min: null,
        max: null,
      };
      return setRange(
        data.cat_bound === "min" ? null : range.min,
        data.cat_bound === "max" ? null : range.max,
      );
    }
    const key = data.cat_key as CatalogFieldKey;
    const index = VEHICLE_KEYS.indexOf(key as CatalogVehicleKey);
    if (index >= 0) {
      const row = selectedRow(data);
      if (index === 0) {
        if (row) filter.vehicles.splice(Number(data.cat_row_index), 1);
        return next("cat_vehicles");
      }
      if (row) for (const child of VEHICLE_KEYS.slice(index)) delete row[child];
    } else {
      delete filter.options[key as CatalogOptionKey];
      if (key === "region") {
        delete filter.options.city;
        clearLegacy(data, "city");
      }
      clearLegacy(data, key);
    }
    return next(pickerBack(data));
  }
  if (action.kind === "option") {
    const key = data.cat_key as CatalogFieldKey;
    const index = VEHICLE_KEYS.indexOf(key as CatalogVehicleKey);
    if ((index > 0 || key === "city") && !parentId(data, key))
      return next(state, "Сначала выберите родительское значение.");
    if (index >= 0) {
      const rowIndex = Number(data.cat_row_index);
      if (
        !Number.isInteger(rowIndex) ||
        rowIndex < 0 ||
        rowIndex > filter.vehicles.length ||
        rowIndex >= 5
      )
        return next("cat_vehicles", "Выберите автомобиль заново.");
      const row = filter.vehicles[rowIndex] ?? {};
      if (row[key as CatalogVehicleKey]?.id !== action.choice.id)
        for (const child of VEHICLE_KEYS.slice(index + 1)) delete row[child];
      row[key as CatalogVehicleKey] = action.choice;
      filter.vehicles[rowIndex] = row;
      return index < VEHICLE_KEYS.length - 1 ? openPick(VEHICLE_KEYS[index + 1]!) : next("cat_row");
    }
    const optionKey = key as CatalogOptionKey;
    const selected = filter.options[optionKey] ?? [];
    const found = selected.findIndex((item) => item.value === action.choice.value);
    if (key === "region") {
      filter.options.region = found >= 0 ? [] : [action.choice];
      delete filter.options.city;
      clearLegacy(data, "city");
    } else {
      if (found >= 0) selected.splice(found, 1);
      else {
        if (selected.length >= 50)
          return next(
            state,
            "В одном поле можно выбрать не более 50 значений. Снимите лишнее или выберите «Любые».",
          );
        selected.push(action.choice);
      }
      filter.options[optionKey] = selected;
    }
    if (!filter.options[optionKey]?.length) delete filter.options[optionKey];
    clearLegacy(data, key);
    return next();
  }
  return next();
}
