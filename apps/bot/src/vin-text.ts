import type { VinReportKind } from "@autodom/core/payments";
import {
  type EncarListing,
  encarListingUrl,
  normalizeVin,
  type VagvinCarfaxRecord,
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinListingDetails,
  type VinListingReport,
  type VinProvider,
} from "@autodom/core/vin";
import { isVinArchiveLotUrl, type VinArchiveResult } from "@autodom/core/vin-archive";
import { escapeHtml } from "./html.js";

export const VIN_ARCHIVE_DISCLOSURE =
  "Если подключённые корейские источники не находят записей, VIN автоматически передаётся подключённым архивам для поиска сохранившихся сведений и фотографий. Если корейские источники не подключены, поиск начинается с доступных архивов. Архивы неполные; отсутствие результата не означает отсутствие ДТП.";
const archiveDateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function vinArchiveTime(value: number | null): string {
  return value === null ? "неизвестно" : `${archiveDateTime.format(new Date(value * 1000))} UTC`;
}

const recordedDistance = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const askingPrices = {
  USD: new Intl.NumberFormat("ru-RU", { style: "currency", currency: "USD" }),
  KRW: new Intl.NumberFormat("ru-RU", { style: "currency", currency: "KRW" }),
  AED: new Intl.NumberFormat("ru-RU", { style: "currency", currency: "AED" }),
};

/** Plain source text; Telegram escapes the complete message, the browser uses textContent. */
export function vinListingDetailsFacts(details?: VinListingDetails): [string, string][] {
  if (!details) return [];
  const facts: [string, string][] = [];
  for (const [key, label] of [
    ["make", "Марка в записи"],
    ["model", "Модель в записи"],
    ["model_year", "Модельный год"],
    ["first_registration_date", "Первая регистрация"],
    ["primary_damage", "Основное повреждение по записи"],
    ["secondary_damage", "Дополнительное повреждение по записи"],
    ["loss_type", "Тип ущерба по записи"],
    ["title", "Документ / статус права по записи"],
    ["start_status", "Запуск / движение по записи"],
    ["engine", "Двигатель"],
    ["transmission", "Трансмиссия"],
    ["fuel", "Топливо"],
    ["drive", "Привод"],
    ["body_style", "Кузов"],
    ["color", "Цвет"],
    ["location", "Место в записи"],
    ["seller_type", "Тип продавца"],
  ] as const) {
    const value = details[key];
    if (value !== undefined && value !== "") facts.push([label, String(value)]);
  }
  if (details.odometer) {
    const { value, unit, status } = details.odometer;
    facts.push([
      "Записанный пробег (не текущий)",
      `${value.toLocaleString("ru-RU", { maximumFractionDigits: 20 })} ${unit === "mi" ? `миль (≈ ${recordedDistance.format(value * 1.609344)} км)` : unit === "km" ? "км" : "(единицы не указаны)"}${status ? ` · отметка источника: ${status}` : ""}`,
    ]);
  }
  if (details.keys_present !== undefined)
    facts.push(["Ключи по записи", details.keys_present ? "Есть" : "Нет"]);
  if (details.asking_price)
    facts.push([
      "Цена предложения (не цена покупки)",
      askingPrices[details.asking_price.currency].format(
        details.asking_price.amount_minor / (details.asking_price.currency === "KRW" ? 1 : 100),
      ),
    ]);
  return facts;
}

export const VIN_LISTING_REPORT_NAMES: Record<VinListingReport["kind"], string> = {
  inspection: "Технический осмотр",
  diagnostic: "Диагностика",
  insurance: "Страховые сведения",
};

/** Keep only VIN-matched archive evidence; failed or absent sources are not cards. */
export function confirmedVinArchiveResult(result: VinArchiveResult): VinArchiveResult {
  return {
    ...result,
    sources: result.sources.flatMap((source) => {
      if (source.status !== "available" && source.status !== "no_photos") return [];
      const lots = source.lots.filter((lot) =>
        isVinArchiveLotUrl(lot.source_url, source.provider, lot.auction, lot.lot_id, result.vin),
      );
      return lots.length ? [{ ...source, lots }] : [];
    }),
  };
}

export const VIN_DISCLOSURE =
  "Для проверки VIN передаётся сервисам истории авто. В профиле поиска он не сохраняется.";
export const VIN_NOT_ENABLED = "Бесплатная проверка VIN пока не подключена. Запрос не отправлен.";
export const VIN_HELP =
  "Пришлите VIN — 17 латинских букв и цифр, без I, O, Q — или фото номера. Покажем доступные сведения об автомобиле бесплатно.";
export const VIN_CAUTION =
  "Нет записей ≠ нет ДТП или ограничений. Пробег в записи — не текущий пробег. Сверьте VIN с авто и документами.";

export function confirmedEncarListings(result: VinCheckResult): EncarListing[] {
  const history = result.encar?.data;
  if (
    result.encar?.status !== "available" ||
    !history ||
    normalizeVin(result.vin) !== result.vin ||
    history.vin !== result.vin
  )
    return [];
  return history.listings.filter(
    (listing) => listing.vin === result.vin && encarListingUrl(listing.id) !== null,
  );
}

export function hasKoreanVinRecord(result: VinCheckResult): boolean {
  return (
    result.carhistory.status === "available" ||
    result.car365.status === "available" ||
    confirmedEncarListings(result).length > 0
  );
}

function confirmedVagvinCarfaxRecord(result: VinCheckResult): VagvinCarfaxRecord | null {
  const observation = result.vagvin_carfax;
  const record = observation?.data;
  if (
    observation?.status !== "available" ||
    observation.source_url !== VIN_SOURCE_URLS.vagvin_carfax ||
    observation.checked_at === null ||
    !Number.isFinite(observation.checked_at) ||
    observation.checked_at < 0 ||
    observation.checked_at > 8_640_000_000_000 ||
    !record ||
    normalizeVin(result.vin) !== result.vin ||
    record.vin !== result.vin ||
    !Number.isSafeInteger(record.record_count) ||
    record.record_count <= 0
  )
    return null;
  return record;
}

/** Decoding and photos are not report evidence; Korean reports retain precedence. */
export function confirmedVinReportKind(result: VinCheckResult): VinReportKind | null {
  if (result.carhistory.status === "available") return "korea";
  return confirmedVagvinCarfaxRecord(result) ? "carfax" : null;
}

function vinVisibleProviders(result: VinCheckResult): VinProvider[] {
  if (normalizeVin(result.vin) !== result.vin) return [];
  return VIN_PROVIDERS.filter((provider) => {
    if (result[provider]?.status !== "available") return false;
    if (provider === "carhistory") return true;
    if (provider === "encar") return confirmedEncarListings(result).length > 0;
    if (provider === "vagvin_carfax") return confirmedVagvinCarfaxRecord(result) !== null;
    return result[provider]?.data?.vin === result.vin;
  });
}

function vinResultNotice(result: VinCheckResult, providers: readonly VinProvider[]): string | null {
  const observations = VIN_PROVIDERS.flatMap((provider) =>
    result[provider] ? [result[provider]] : [],
  );
  const archives = result.archives?.vin === result.vin ? result.archives.sources : [];
  if ([...observations, ...archives].every((observation) => observation.status === "disabled")) {
    return VIN_NOT_ENABLED;
  }
  if (
    observations.some((observation) => observation.status === "unavailable") ||
    archives.some(
      (source) =>
        source.status === "unavailable" ||
        source.partial ||
        ((source.status === "available" || source.status === "no_photos") &&
          source.lots.some(
            (lot) =>
              !isVinArchiveLotUrl(
                lot.source_url,
                source.provider,
                lot.auction,
                lot.lot_id,
                result.vin,
              ),
          )),
    ) ||
    VIN_PROVIDERS.some(
      (provider) => result[provider]?.status === "available" && !providers.includes(provider),
    ) ||
    (result.archives !== undefined && result.archives.vin !== result.vin) ||
    (result.encar?.status === "available" && result.encar.data?.partial)
  ) {
    return "Проверка неполная: часть записей не удалось получить или подтвердить. Недоступные данные неизвестны; это не отсутствие истории.";
  }
  if (
    !providers.length &&
    !(
      result.archives?.vin === result.vin &&
      confirmedVinArchiveResult(result.archives).sources.length
    )
  ) {
    return (
      "В проверенных источниках записи по VIN не найдены. Это не подтверждает отсутствие ДТП или ограничений." +
      (observations.some((observation) => observation.status === "disabled")
        ? " Часть проверок не подключена; запросы к ним не отправлены."
        : "")
    );
  }
  return null;
}

type SummaryValue = { value: string; sources: Set<string> };

function normalizedFact(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
}

/** Plain source evidence shared by Telegram and the MiniApp; escape only at the surface. */
export function vinSummary(result: VinCheckResult): { facts: [string, string][]; notes: string[] } {
  const fields = new Map<string, Map<string, SummaryValue>>();
  const identities: (SummaryValue & { name: string; year: number | null })[] = [];
  const sources = new Set<string>();
  const notes: string[] = [];
  let incomplete = false;
  let decoded = false;
  let documents = false;
  const add = (label: string, value: string | number | null | undefined, source: string) => {
    if (value === null || value === undefined || value === "") return;
    const text = String(value).trim();
    if (!text) return;
    const key = normalizedFact(text);
    let values = fields.get(label);
    if (!values) {
      values = new Map();
      fields.set(label, values);
    }
    const existing = values.get(key);
    if (existing) existing.sources.add(source);
    else values.set(key, { value: text, sources: new Set([source]) });
  };
  const identity = (
    value: string | null | undefined,
    source: string,
    modelYear: number | null | undefined = null,
  ) => {
    if (!value?.trim()) {
      add("Модельный год", modelYear, source);
      return;
    }
    const vehicle = value.trim().replace(/\s+/gu, " ");
    const name = normalizedFact(vehicle);
    const year = modelYear ?? null;
    const text = year === null ? vehicle : `${vehicle} ${year}`;
    const existing = identities.find((entry) => {
      if (entry.name === name) return entry.year === null || year === null || entry.year === year;
      // A free-form title may include a known year, but model-name prefixes are not aliases.
      return (
        (year === null &&
          entry.year !== null &&
          (name === `${entry.name} ${entry.year}` || name === `${entry.year} ${entry.name}`)) ||
        (year !== null &&
          entry.year === null &&
          (entry.name === `${name} ${year}` || entry.name === `${year} ${name}`))
      );
    });
    if (existing) {
      if (text.length > existing.value.length) existing.value = text;
      if (year !== null) {
        existing.name = name;
        existing.year = year;
      }
      existing.sources.add(source);
    } else identities.push({ value: text, name, year, sources: new Set([source]) });
  };
  const details = (record: VinListingDetails | undefined, source: string) => {
    if (!record) return;
    identity([record.make, record.model].filter(Boolean).join(" "), source, record.model_year);
    for (const [label, value] of vinListingDetailsFacts(record)) {
      if (
        [
          "Марка в записи",
          "Модель в записи",
          "Модельный год",
          "Цена предложения (не цена покупки)",
          "Тип продавца",
          "Место в записи",
        ].includes(label)
      )
        continue;
      add(label === "Записанный пробег (не текущий)" ? "📏 Пробег в записи" : label, value, source);
    }
  };
  const reports = (records: readonly VinListingReport[] | undefined, source: string) => {
    for (const report of records ?? []) {
      incomplete ||= report.partial || report.status === "unavailable";
      if (report.status !== "available") continue;
      documents = true;
      const origin = `${source}, ${VIN_LISTING_REPORT_NAMES[report.kind]}${report.report_date ? ` · документ от ${report.report_date}` : ""}`;
      for (const fact of report.facts) {
        add(fact.section ? `${fact.section}: ${fact.label}` : fact.label, fact.value, origin);
      }
    }
  };
  const providers = vinVisibleProviders(result);
  if (providers.includes("car365") && result.car365.data) {
    const record = result.car365.data;
    sources.add("Car365");
    identity(record.model, "Car365");
    add(
      "📏 Пробег в записи",
      record.last_mileage_km === null
        ? null
        : `${record.last_mileage_km.toLocaleString("ru-RU")} км`,
      "Car365",
    );
    add("Первая регистрация", record.first_registration_date, "Car365");
    add("Декларация экспорта", record.export_date, "Car365");
    if (record.total_loss !== null)
      add(
        "Полная гибель по записи",
        record.total_loss ? "Да" : "Не указана; отсутствие ДТП не подтверждено",
        "Car365",
      );
    if (record.export_date)
      notes.push(
        "Дата декларации — не дата замера пробега; декларация не подтверждает отправку авто.",
      );
  }
  for (const listing of confirmedEncarListings(result)) {
    const source = `Encar №${listing.id}`;
    sources.add("Encar");
    identity(listing.model, source);
    details(listing.details, source);
    const odometer = listing.details?.odometer;
    if (
      listing.mileage_km !== null &&
      (odometer?.unit !== "km" || odometer.value !== listing.mileage_km)
    ) {
      add("📏 Пробег в записи", `${listing.mileage_km.toLocaleString("ru-RU")} км`, source);
    }
    reports(listing.reports, source);
  }
  const archives =
    result.archives?.vin === result.vin ? confirmedVinArchiveResult(result.archives) : null;
  for (const observation of archives?.sources ?? []) {
    const name =
      observation.provider === "copart"
        ? "Copart"
        : observation.provider === "bidcars"
          ? "BidCars"
          : "Carway";
    sources.add(name);
    for (const lot of observation.lots) {
      const source = `${name} №${lot.lot_id}`;
      details(lot.details, source);
      reports(lot.reports, source);
    }
  }
  if (archives?.sources.length)
    notes.push("Архивы неполные; сведения и фото относятся к прошлому состоянию авто.");
  for (const provider of ["nhtsa_vpic", "autodev"] as const) {
    if (!providers.includes(provider)) continue;
    const record = result[provider]?.data;
    if (!record) continue;
    decoded = true;
    const source = provider === "nhtsa_vpic" ? "NHTSA" : "AutoDev";
    sources.add(source);
    identity([record.make, record.model].filter(Boolean).join(" "), source, record.model_year);
    add("Кузов", record.body_class, source);
    if (provider === "nhtsa_vpic") {
      const nhtsa = result.nhtsa_vpic!.data!;
      add("Топливо", nhtsa.fuel_type, source);
      add("Страна сборки", nhtsa.plant_country, source);
    } else {
      const autodev = result.autodev!.data!;
      add("Комплектация", autodev.trim, source);
      add("Двигатель", autodev.engine, source);
      add("Привод", autodev.drive, source);
      add("Трансмиссия", autodev.transmission, source);
      add("Страна происхождения", autodev.origin_country, source);
      if (autodev.ambiguous)
        notes.push("Расшифровка неоднозначна: год и комплектацию нужно сверить с документами.");
    }
  }
  const carfax = confirmedVagvinCarfaxRecord(result);
  if (carfax?.vehicle) {
    sources.add("CARFAX");
    identity(carfax.vehicle, "CARFAX");
  }
  const describe = (values: Iterable<SummaryValue>) =>
    Array.from(
      values,
      ({ value, sources: origins }) => `${value} · ${Array.from(origins).join(", ")}`,
    ).join("; ");
  const facts: [string, string][] = [];
  if (identities.length) facts.push(["🚘 Автомобиль", describe(identities)]);
  const mileage = fields.get("📏 Пробег в записи");
  if (mileage) {
    facts.push(["📏 Пробег в записи", describe(mileage.values())]);
    fields.delete("📏 Пробег в записи");
  }
  for (const [label, values] of fields) facts.push([label, describe(values.values())]);
  if (identities.length > 1)
    notes.push(
      "Идентификация в источниках различается; сверьте данные с автомобилем и документами.",
    );
  if (mileage && mileage.size > 1)
    notes.push("В источниках разные записи пробега; дата замера не установлена.");
  const notice = vinResultNotice(result, providers);
  if (notice) notes.unshift(notice);
  else if (incomplete) notes.unshift("Проверка неполная: часть сведений документа недоступна.");
  if (decoded)
    notes.push(
      "Расшифровка VIN — не история ДТП, пробега или владельцев. Страна сборки / происхождения не означает страну эксплуатации.",
    );
  if (documents)
    notes.push(
      "Сведения документов — не текущая диагностика и не подтверждение полного платного отчёта.",
    );
  if (facts.length) notes.push("Неуказанные сведения неизвестны.");
  if (sources.size)
    notes.push(
      `Источники: ${Array.from(sources).join(", ")}. Проверено: ${vinArchiveTime(result.checked_at)}.`,
    );
  return { facts, notes };
}

/** Free VIN facts only; confirmed report access is sent separately. */
export function vinResultPresentation(result: VinCheckResult): { text: string } {
  const { facts, notes } = vinSummary(result);
  return {
    text: [
      `<b>Бесплатная проверка VIN</b>\n<code>${escapeHtml(result.vin)}</code>`,
      facts.map(([label, value]) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`).join("\n"),
      [...notes, ...(facts.length ? [VIN_CAUTION] : [])].map(escapeHtml).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
