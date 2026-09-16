import type { EncarListing, VinCheckResult } from "@autodom/core/vin";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  confirmedVinReportKind,
  hasKoreanVinRecord,
  vinListingDetailsFacts,
  vinResultActions,
  vinResultNotice,
  vinResultPresentation,
  vinSourceText,
  vinVisibleProviders,
} from "../src/vin-text.js";

const result: VinCheckResult = {
  vin: "KMHDU41DBAU123456",
  checked_at: 1_789_000_000,
  carhistory: {
    status: "available",
    source_url: "https://attacker.invalid/",
    checked_at: 1_789_000_000,
  },
  car365: {
    status: "available",
    source_url: "https://attacker.invalid/",
    checked_at: 1_789_000_000,
    data: {
      vin: "KMHDU41DBAU123456",
      model: "Avante",
      last_mileage_km: 0,
      export_date: "2024-05-02",
      first_registration_date: "2010-01-15",
      total_loss: null,
    },
  },
};

describe("VIN observations presented without buying or certifying a report", () => {
  it("distinguishes recorded mileage, missing damage data and report availability", () => {
    const { text } = vinResultPresentation(result);
    expect(text).toContain(result.vin);
    expect(text).toContain("0 км");
    expect(text).toContain("2024-05-02");
    expect(text).toContain("2010-01-15");
    expect(text).toMatch(/полной гибели.*неизвестны/);
    expect(text).toMatch(/не текущий/);
    expect(text).not.toContain("attacker.invalid");
    expect(text).not.toContain("NHTSA");
    expect(text).not.toContain("vpic.nhtsa.dot.gov");
    expect(vinVisibleProviders(result)).toEqual(["car365", "carhistory"]);
    expect(text).not.toMatch(/vinarchive:|Google|США \/ ОАЭ|Фото и поиск в интернете|web_app/);
  });

  it("presents decoder specifications separately from vehicle history", () => {
    const decoded: VinCheckResult = {
      ...result,
      nhtsa_vpic: {
        status: "available",
        source_url: "https://attacker.invalid/",
        checked_at: result.checked_at,
        data: {
          vin: result.vin,
          make: "HYUNDAI",
          model: "AVANTE",
          model_year: 2011,
          body_class: "Sedan/Saloon",
          fuel_type: "Gasoline",
          plant_country: "SOUTH KOREA",
        },
      },
    };
    const section = vinSourceText("nhtsa_vpic", decoded);
    expect(section).toContain("HYUNDAI");
    expect(section).toContain("AVANTE");
    expect(section).toContain("2011");
    expect(section).toContain("Sedan/Saloon");
    expect(section).toContain("Gasoline");
    expect(section).toMatch(/Страна сборки: SOUTH KOREA/);
    expect(section).toMatch(/не история ДТП, пробега или владельцев/);
    expect(section).toMatch(/не означает страну регистрации/);
    expect(section).not.toContain("0 км");
    expect(section).not.toContain("2024-05-02");
    const { text } = vinResultPresentation(decoded);
    expect(text).not.toContain("attacker.invalid");
  });

  it("shows found decoder facts without inferring Korean records from the VIN or assembly country", () => {
    const decoded: VinCheckResult = {
      ...result,
      carhistory: { ...result.carhistory, status: "not_found" },
      car365: { ...result.car365, status: "not_found" },
      nhtsa_vpic: {
        status: "available",
        source_url: "",
        checked_at: result.checked_at,
        data: {
          vin: result.vin,
          make: "HYUNDAI",
          model: "AVANTE",
          model_year: 2011,
          body_class: null,
          fuel_type: null,
          plant_country: "SOUTH KOREA",
        },
      },
    };
    expect(hasKoreanVinRecord(decoded)).toBe(false);
    expect(confirmedVinReportKind(decoded)).toBeNull();
    expect(vinVisibleProviders(decoded)).toEqual(["nhtsa_vpic"]);
    expect(vinResultNotice(decoded)).toBeNull();
    const actions = vinResultActions(decoded);
    expect(actions.keyboard.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining("google.com/search") }),
      ]),
    );
    const { text } = vinResultPresentation(decoded);
    expect(text).toContain("HYUNDAI");
    expect(text).toContain("SOUTH KOREA");
    expect(text).not.toMatch(/Экспорт и пробег|Полный отчёт|vin-report-example|Avante|0 км|Заказ/);
  });

  it("keeps found facts while disclosing failed checks without empty source sections", () => {
    const partial: VinCheckResult = {
      ...result,
      carhistory: { ...result.carhistory, status: "unavailable" },
    };
    expect(vinVisibleProviders(partial)).toEqual(["car365"]);
    expect(vinResultNotice(partial)).toMatch(/неполная.*не удалось/);
    const presentation = vinResultPresentation(partial);
    expect(presentation.text).toContain("Avante");
    expect(presentation.text).toMatch(/неполная/);
    expect(presentation.text).not.toContain("Наличие отчёта подтверждено");
  });

  it("treats unknown decoder fields as unknown rather than absent vehicle features", () => {
    const text = vinSourceText("nhtsa_vpic", {
      ...result,
      nhtsa_vpic: {
        status: "available",
        source_url: "https://vpic.nhtsa.dot.gov/api/",
        checked_at: result.checked_at,
        data: {
          vin: result.vin,
          make: "HYUNDAI",
          model: null,
          model_year: null,
          body_class: null,
          fuel_type: null,
          plant_country: null,
        },
      },
    });
    expect(text).toContain("HYUNDAI");
    expect(text).toMatch(/характеристики неизвестны/);
    expect(text).not.toMatch(/Модель:|Модельный год:|Тип кузова:|Топливо:|Страна сборки:/);
    expect(text).not.toMatch(/null|undefined/);
  });

  it("marks ambiguous global specifications and never substitutes history or an untrusted link", () => {
    const decoded: VinCheckResult = {
      ...result,
      autodev: {
        status: "available",
        source_url: "https://attacker.invalid/",
        checked_at: result.checked_at,
        data: {
          vin: result.vin,
          make: "Hyundai",
          model: null,
          model_year: 2010,
          trim: null,
          body_class: null,
          engine: null,
          drive: "Front Wheel Drive",
          transmission: null,
          origin_country: "South Korea",
          ambiguous: true,
        },
      },
    };
    const section = vinSourceText("autodev", decoded);
    expect(section).toContain("Hyundai");
    expect(section).toContain("2010");
    expect(section).toMatch(/неоднозначн/);
    expect(section).toMatch(/не история ДТП/);
    expect(section).toMatch(/происхождени.*South Korea/);
    expect(section).not.toMatch(/0 км|2024-05-02|null|undefined|Двигатель:/);
    const { text } = vinResultPresentation(decoded);
    expect(text).not.toContain("attacker.invalid");
  });

  it("keeps only full-VIN Encar matches without trusting supplied URLs", () => {
    const listing: EncarListing = {
      id: "39720103",
      vin: result.vin,
      source_url: "https://attacker.invalid/ad",
      model: "BMW",
      mileage_km: 0,
      advertisement_status: "SOLD",
      created_at: "2024-05-02T11:12:13",
      first_advertised_at: null,
      modified_at: null,
      re_registered: false,
      photo_urls: ["https://attacker.invalid/photo.jpg"],
    };
    const history = {
      ...result,
      carhistory: { ...result.carhistory, status: "not_found" },
      car365: { ...result.car365, status: "not_found" },
      encar: {
        status: "available",
        source_url: "https://attacker.invalid",
        checked_at: result.checked_at,
        data: {
          vin: result.vin,
          discovery_url: "https://attacker.invalid/search",
          partial: true,
          listings: [
            listing,
            { ...listing, id: "39711062", vin: "WBA51AG03NCK98884", model: "OTHER VIN" },
            { ...listing, id: "40122438", vin: "", model: "UNKNOWN VIN" },
            { ...listing, id: "../malicious", model: "INVALID ID" },
          ],
        },
      },
    } satisfies VinCheckResult;
    expect(hasKoreanVinRecord(history)).toBe(true);
    expect(vinVisibleProviders(history)).toEqual(["encar"]);
    expect(vinResultNotice(history)).toMatch(/неполная/);
    const { text } = vinResultPresentation(history);
    expect(text).toContain("39720103");
    expect(text).toContain("2024-05-02T11:12:13");
    expect(text).not.toMatch(
      /39711062|40122438|OTHER VIN|UNKNOWN VIN|INVALID ID|attacker\.invalid/,
    );
    for (const status of ["disabled", "unavailable", "not_found"] as const) {
      const stale = { ...history, encar: { ...history.encar, status } };
      expect(hasKoreanVinRecord(stale)).toBe(false);
      expect(
        vinSourceText("encar", { ...history, encar: { ...history.encar, status } }),
      ).not.toContain("39720103");
    }
    history.encar.data.vin = "WBA51AG03NCK98884";
    expect(vinSourceText("encar", history)).not.toContain("39720103");
    expect(hasKoreanVinRecord(history)).toBe(false);
    expect(vinVisibleProviders(history)).toEqual([]);
    expect(vinResultNotice(history)).toMatch(/неполная/);
  });

  it("escapes retrieved document facts and keeps incomplete free evidence separate from full-report availability", () => {
    const markup = '<a href="https://attacker.invalid">source & value</a>';
    const listing: EncarListing = {
      id: "39720103",
      vin: result.vin,
      source_url: "https://attacker.invalid/ad",
      model: null,
      mileage_km: null,
      advertisement_status: null,
      created_at: null,
      first_advertised_at: null,
      modified_at: null,
      re_registered: null,
      photo_urls: [],
      details: { primary_damage: markup },
      reports: [
        {
          kind: "inspection",
          status: "available",
          source_url: "https://attacker.invalid/document",
          partial: true,
          checked_at: result.checked_at,
          report_date: "2025-03-01",
          facts: [{ section: markup, label: markup, value: markup }],
        },
      ],
    };
    const history: VinCheckResult = {
      ...result,
      carhistory: { ...result.carhistory, status: "not_found" },
      car365: { ...result.car365, status: "not_found" },
      encar: {
        status: "available",
        checked_at: result.checked_at,
        source_url: listing.source_url,
        data: { vin: result.vin, discovery_url: "", partial: false, listings: [listing] },
      },
    };
    const rendered = load(vinResultPresentation(history).text);
    expect(rendered("a, script")).toHaveLength(0);
    expect(rendered.root().text()).toContain(markup);
    expect(rendered.root().text()).toContain("2025-03-01");
    expect(rendered.root().text()).not.toContain("https://attacker.invalid/document");
    expect(vinResultNotice(history)).not.toBeNull();
    expect(confirmedVinReportKind(history)).toBeNull();
    listing.reports = [
      {
        ...listing.reports![0]!,
        status: "unavailable",
        report_date: null,
        facts: [],
      },
    ];
    const unavailable = vinResultPresentation(history).text;
    expect(unavailable).not.toContain("2025-03-01");
    expect(unavailable).toContain("Документ недоступен");
    expect(unavailable).toContain("Основное повреждение");
    expect(confirmedVinReportKind(history)).toBeNull();
  });

  it("preserves recorded units, explicit false and zero without inventing omitted facts", () => {
    expect(vinListingDetailsFacts()).toEqual([]);
    expect(vinListingDetailsFacts({})).toEqual([]);
    const recorded = Object.fromEntries(
      vinListingDetailsFacts({
        odometer: { value: 100, unit: "mi", status: "Not Actual" },
        keys_present: false,
        asking_price: { amount_minor: 0, currency: "USD" },
      }),
    );
    expect(recorded["Записанный пробег (не текущий)"]).toContain("100 миль");
    expect(recorded["Записанный пробег (не текущий)"]).toContain("160,9 км");
    expect(recorded["Записанный пробег (не текущий)"]).toContain("Not Actual");
    expect(recorded["Ключи по записи"]).toBe("Нет");
    expect(recorded["Цена предложения (не цена покупки)"]).toContain("0");
    expect(recorded).not.toHaveProperty("Основное повреждение по записи");
    const unknownUnit = vinListingDetailsFacts({
      odometer: { value: 75414, unit: null, status: "ACTUAL" },
    })[0]![1];
    expect(unknownUnit).toContain("ACTUAL");
    expect(unknownUnit).not.toMatch(/км|миль|≈/);
    expect(unknownUnit).toContain("единицы не указаны");
    const won = vinListingDetailsFacts({
      asking_price: { amount_minor: 100, currency: "KRW" },
    })[0]![1];
    expect(won).toBe(
      new Intl.NumberFormat("ru-RU", { style: "currency", currency: "KRW" }).format(100),
    );
  });

  it("keeps provider markup as visible text rather than links or purchase buttons", () => {
    const model =
      '<tg-button type="url" url="https://attacker.invalid">Купить</tg-button> & <b>GT</b>';
    const presentation = vinResultPresentation({
      ...result,
      car365: { ...result.car365, data: { ...result.car365.data!, model } },
    });
    const rendered = load(presentation.text);
    expect(rendered('a, script, [url*="attacker.invalid"]')).toHaveLength(0);
    expect(rendered.root().text()).toContain(model);
  });

  it("never presents unknown or stale export mileage as zero or as a successful check", () => {
    const unknown = vinResultPresentation({
      ...result,
      car365: {
        ...result.car365,
        data: { ...result.car365.data!, last_mileage_km: null },
      },
    });
    expect(unknown.text).toContain("неизвестен");
    expect(unknown.text).not.toContain("0 км");
    for (const status of ["not_found", "unavailable", "disabled"] as const) {
      const stale: VinCheckResult = {
        ...result,
        carhistory: { ...result.carhistory, status },
        car365: { ...result.car365, status },
      };
      const presentation = vinResultPresentation(stale);
      expect(hasKoreanVinRecord(stale)).toBe(false);
      expect(vinVisibleProviders(stale)).toEqual([]);
      expect(vinResultNotice(stale)).toMatch(
        status === "not_found"
          ? /не найдены.*не подтверждает/
          : status === "unavailable"
            ? /неполная.*не удалось/
            : /не подключена.*не отправлен/,
      );
      expect(presentation.text).not.toMatch(/Avante|0 км|2024-05-02|Найдена экспортная декларация/);
      expect(presentation.text).not.toContain("Наличие отчёта подтверждено");
      expect(presentation.text).not.toMatch(/vin-report-example|Полный отчёт|Заказ/);
    }
  });

  it("offers CARFAX only from positive matching VAGVIN evidence, with Korean report precedence", () => {
    const positive = carfaxResult();
    expect(confirmedVinReportKind(positive)).toBe("carfax");
    expect(confirmedVinReportKind({ ...positive, carhistory: result.carhistory })).toBe("korea");
    expect(confirmedVinReportKind({ ...positive, vagvin_carfax: undefined })).toBeNull();
    for (const status of ["not_found", "unavailable", "disabled"] as const) {
      expect(
        confirmedVinReportKind({
          ...positive,
          vagvin_carfax: { ...positive.vagvin_carfax!, status },
        }),
      ).toBeNull();
    }
  });

  it("rejects malformed counts and mismatched or missing source evidence for CARFAX", () => {
    const positive = carfaxResult();
    const observation = positive.vagvin_carfax!;
    for (const record_count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(
        confirmedVinReportKind({
          ...positive,
          vagvin_carfax: { ...observation, data: { ...observation.data!, record_count } },
        }),
      ).toBeNull();
    }
    for (const invalid of [
      { ...observation, data: null },
      { ...observation, data: { ...observation.data!, vin: "WBAJE7C55JG891379" } },
      { ...observation, source_url: "https://attacker.invalid/" },
      { ...observation, checked_at: null },
    ]) {
      const rejected = { ...positive, vagvin_carfax: invalid };
      expect(confirmedVinReportKind(rejected)).toBeNull();
      expect(vinVisibleProviders(rejected)).not.toContain("vagvin_carfax");
    }
    expect(confirmedVinReportKind({ ...positive, vin: positive.vin.toLowerCase() })).toBeNull();
  });

  it("attributes the actual CARFAX count to VAGVIN without presenting a fetched report", () => {
    const positive = carfaxResult();
    const source = vinSourceText("vagvin_carfax", positive);
    expect(source).toContain("VAGVIN");
    expect(source).toContain("CARFAX");
    expect(source).toContain("47");
    expect(source).toContain("BMW 530i");
    const rendered = load(vinResultPresentation(positive).text);
    expect(rendered('a[href="https://vagvin.ru/home"]').text()).toContain("VAGVIN");
    expect(rendered.root().text()).toContain("47");
    const unsafe = carfaxResult();
    unsafe.vagvin_carfax!.data!.vehicle = '<a href="https://attacker.invalid/">BMW</a>';
    expect(load(vinResultPresentation(unsafe).text)('a[href*="attacker"]').length).toBe(0);
  });
});

function carfaxResult(): VinCheckResult {
  return {
    vin: "WBAJA9C56KB389776",
    checked_at: result.checked_at,
    carhistory: { ...result.carhistory, status: "not_found" },
    car365: { ...result.car365, status: "not_found", data: null },
    vagvin_carfax: {
      status: "available",
      source_url: "https://vagvin.ru/home",
      checked_at: result.checked_at + 0.125,
      data: { vin: "WBAJA9C56KB389776", record_count: 47, vehicle: "BMW 530i" },
    },
  };
}
