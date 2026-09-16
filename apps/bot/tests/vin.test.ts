import type { EncarListing, VinCheckResult } from "@autodom/core/vin";
import type { VinArchiveLot } from "@autodom/core/vin-archive";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  confirmedEncarListings,
  confirmedVinReportKind,
  hasKoreanVinRecord,
  vinListingDetailsFacts,
  vinResultPresentation,
  vinSummary,
} from "../src/vin-text.js";

const result: VinCheckResult = {
  vin: "KMHDU41DBAU123456",
  checked_at: 1_789_000_000,
  carhistory: {
    status: "available",
    source_url: "https://www.carhistory.or.kr/",
    checked_at: 1_789_000_000,
  },
  car365: {
    status: "available",
    source_url: "https://www.car365.go.kr/",
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

function encarResult(listings: EncarListing[]): VinCheckResult {
  return {
    ...result,
    carhistory: { ...result.carhistory, status: "not_found" },
    car365: { ...result.car365, status: "not_found" },
    encar: {
      status: "available",
      checked_at: result.checked_at,
      source_url: "https://attacker.invalid",
      data: { vin: result.vin, discovery_url: "", partial: false, listings },
    },
  };
}

const listing: EncarListing = {
  id: "39720103",
  vin: result.vin,
  source_url: "https://attacker.invalid/ad",
  model: "BMW",
  mileage_km: null,
  advertisement_status: "SOLD",
  created_at: "2024-05-02T11:12:13",
  first_advertised_at: null,
  modified_at: null,
  re_registered: false,
  photo_urls: ["https://attacker.invalid/photo.jpg"],
};

const lot: VinArchiveLot = {
  auction: "copart",
  lot_id: "51234567",
  source_url: "https://www.copart.com/lot/51234567",
  events: [
    {
      status: "sold",
      auction_at: null,
      auction_date: "2025-01-02",
      final_bid_usd_minor: 123456789,
    },
  ],
  photos: [],
  photos_complete: false,
  details: {
    make: "BMW",
    model: "530i",
    model_year: 2019,
    odometer: { value: 100, unit: "mi", status: "Not Actual" },
    primary_damage: "FRONT END",
    title: "SALVAGE",
    engine: "2.0L",
  },
};

describe("concise VIN evidence", () => {
  it("puts recorded mileage early and never turns missing damage data into a clean history", () => {
    const summary = vinSummary(result);
    expect(summary.facts[0]![1]).toContain("Avante");
    expect(summary.facts[1]![1]).toContain("0 км");
    expect(summary.facts.some(([label]) => /гибель/u.test(label))).toBe(false);
    expect(summary.notes.join(" ")).toMatch(/неизвестны/u);
    expect(summary.notes.join(" ")).toMatch(/Дата декларации — не дата замера/u);
    expect(summary.notes.join(" ")).not.toMatch(/Расшифровка VIN/u);
    expect(vinResultPresentation(result).text).not.toMatch(/Google|tg-button|Полный отчёт/u);
  });

  it("does not display stale or mismatched records and preserves explicit zero only when observed", () => {
    const unknown = vinSummary({
      ...result,
      car365: { ...result.car365, data: { ...result.car365.data!, last_mileage_km: null } },
    });
    expect(unknown.facts.some(([label]) => /Пробег/u.test(label))).toBe(false);
    expect(unknown.notes.join(" ")).toMatch(/неизвестны/u);
    for (const status of ["not_found", "unavailable", "disabled"] as const) {
      const stale = {
        ...result,
        carhistory: { ...result.carhistory, status },
        car365: { ...result.car365, status },
      };
      expect(hasKoreanVinRecord(stale)).toBe(false);
      expect(vinSummary(stale).facts).toEqual([]);
      expect(vinSummary(stale).notes.join(" ")).toMatch(/не найдены|неполная|не подключена/u);
    }
    const mismatched = {
      ...result,
      car365: { ...result.car365, data: { ...result.car365.data!, vin: "WBAJA9C56KB389776" } },
    };
    expect(vinSummary(mismatched).facts).toEqual([]);
    expect(vinSummary(mismatched).notes.join(" ")).toMatch(/неполная/u);
  });

  it("uses decoding only for known specifications, not history or Korean report evidence", () => {
    const decoded: VinCheckResult = {
      ...carfaxResult(),
      vagvin_carfax: undefined,
      autodev: {
        status: "available",
        source_url: "https://attacker.invalid/",
        checked_at: result.checked_at,
        data: {
          vin: "WBAJA9C56KB389776",
          make: "BMW",
          model: "530i",
          model_year: 2019,
          trim: null,
          body_class: null,
          engine: null,
          drive: "Rear Wheel Drive",
          transmission: null,
          origin_country: "Germany",
          ambiguous: true,
        },
      },
    };
    const summary = vinSummary(decoded);
    expect(hasKoreanVinRecord(decoded)).toBe(false);
    expect(confirmedVinReportKind(decoded)).toBeNull();
    expect(summary.facts.flat().join(" ")).toContain("BMW 530i 2019");
    expect(summary.facts.flat().join(" ")).toContain("Germany");
    expect(summary.facts.flat().join(" ")).not.toMatch(/null|undefined|Двигатель|0 км|attacker/u);
    expect(summary.notes.join(" ")).toMatch(/неоднозначна/u);
    expect(summary.notes.join(" ")).toMatch(/не история ДТП/u);
    expect(summary.notes.join(" ")).toMatch(/не означает страну эксплуатации/u);
    decoded.autodev!.data!.make = null;
    decoded.autodev!.data!.model = null;
    expect(vinSummary(decoded).facts.flat().join(" ")).toContain("2019");
  });

  it.each([
    { model: "Corolla Cross", year: 2023 },
    { model: "Corolla", year: 2024 },
  ])("keeps conflicting known vehicle identity %j", ({ model, year }) => {
    const checked = carfaxResult();
    checked.vagvin_carfax = undefined;
    checked.archives = {
      vin: checked.vin,
      checked_at: result.checked_at,
      coverage: "indexed_lots_only",
      sources: [
        {
          provider: "copart",
          status: "no_photos",
          source_url: "https://www.copart.com/",
          checked_at: result.checked_at,
          partial: false,
          lots: [
            { ...lot, details: { make: "Toyota", model: "Corolla", model_year: 2023 } },
            {
              ...lot,
              lot_id: "61234567",
              source_url: "https://www.copart.com/lot/61234567",
              details: { make: "Toyota", model, model_year: year },
            },
          ],
        },
      ],
    };
    const summary = vinSummary(checked);
    expect(summary.facts[0]?.[1]).toContain("Toyota Corolla 2023");
    expect(summary.facts[0]?.[1]).toContain(`Toyota ${model} ${year}`);
  });

  it("deduplicates identity and facts while preserving incompatible identities and native mileage", () => {
    const checked = carfaxResult();
    checked.archives = {
      vin: checked.vin,
      checked_at: result.checked_at,
      coverage: "indexed_lots_only",
      sources: [
        {
          provider: "copart",
          status: "no_photos",
          source_url: "https://www.copart.com/",
          checked_at: result.checked_at,
          partial: false,
          lots: [lot],
        },
        {
          provider: "bidcars",
          status: "no_photos",
          source_url: "https://bid.cars/",
          checked_at: result.checked_at,
          partial: false,
          lots: [
            {
              ...lot,
              source_url: `https://bid.cars/en/lot/1-51234567/2019-BMW-530i-${checked.vin}`,
              details: { ...lot.details, odometer: { value: 120, unit: "km" } },
            },
          ],
        },
      ],
    };
    let summary = vinSummary(checked);
    expect(summary.facts[0]![1].match(/BMW 530i/gu)).toHaveLength(1);
    expect(summary.facts[1]![1]).toContain("100 миль");
    expect(summary.facts[1]![1]).toContain("160,9 км");
    expect(summary.facts[1]![1]).toContain("Not Actual");
    expect(summary.facts[1]![1]).toContain("120 км");
    expect(summary.facts[1]![1]).not.toContain("2025-01-02");
    expect(
      summary.facts
        .flat()
        .join(" ")
        .match(/FRONT END/gu),
    ).toHaveLength(1);
    expect(summary.notes.join(" ")).toMatch(/разные записи пробега/u);
    checked.vagvin_carfax!.data!.vehicle = "BMW 540i";
    summary = vinSummary(checked);
    expect(summary.facts[0]![1]).toContain("BMW 530i");
    expect(summary.facts[0]![1]).toContain("BMW 540i");
    expect(summary.notes.join(" ")).toMatch(/Идентификация.*различается/u);
    const text = vinResultPresentation(checked).text;
    expect(text).toContain("SALVAGE");
    expect(text).not.toMatch(/2025-01-02|1.234.567/u);
  });

  it("keeps only confirmed Encar identities and distinguishes conflicting legacy mileage", () => {
    const checked = encarResult([
      {
        ...listing,
        mileage_km: 120,
        details: { odometer: { value: 100, unit: "km", status: "Actual" } },
      },
      { ...listing, id: "39711062", vin: "WBAJA9C56KB389776", model: "OTHER VIN" },
      { ...listing, id: "../malicious", model: "INVALID ID" },
    ]);
    expect(confirmedEncarListings(checked)).toHaveLength(1);
    const summary = vinSummary(checked);
    expect(summary.facts.flat().join(" ")).toContain("100 км");
    expect(summary.facts.flat().join(" ")).toContain("120 км");
    expect(summary.facts.flat().join(" ")).not.toMatch(/OTHER VIN|INVALID ID|attacker/u);
    expect(hasKoreanVinRecord(checked)).toBe(true);
    expect(confirmedVinReportKind(checked)).toBeNull();
    checked.encar!.data!.vin = "WBAJA9C56KB389776";
    expect(vinSummary(checked).facts).toEqual([]);
    expect(hasKoreanVinRecord(checked)).toBe(false);
  });

  it("does not duplicate a legacy reading when the detailed record qualifies the same distance", () => {
    const summary = vinSummary(
      encarResult([
        {
          ...listing,
          mileage_km: 120,
          details: { odometer: { value: 120, unit: "km", status: "Not Actual" } },
        },
      ]),
    );
    expect(summary.facts[1]![1].match(/120 км/gu)).toHaveLength(1);
    expect(summary.facts[1]![1]).toContain("Not Actual");
  });

  it("keeps document provenance plain, escapes source markup once, and warns about incomplete evidence", () => {
    const markup = '<a href="https://attacker.invalid">source & value</a>';
    const checked = encarResult([
      {
        ...listing,
        model: markup,
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
      },
    ]);
    const summary = vinSummary(checked);
    expect(summary.facts.flat()).toEqual(expect.arrayContaining([expect.stringContaining(markup)]));
    const rendered = load(vinResultPresentation(checked).text);
    expect(rendered("a, script, tg-button")).toHaveLength(0);
    expect(rendered.root().text()).toContain(markup);
    expect(rendered.root().text()).toContain("документ от 2025-03-01");
    expect(rendered.root().text()).not.toContain("https://attacker.invalid/document");
    expect(summary.notes.join(" ")).toMatch(/неполная/u);
    expect(confirmedVinReportKind(checked)).toBeNull();
    checked.encar!.data!.listings[0]!.reports = [
      {
        kind: "inspection",
        status: "unavailable",
        source_url: "",
        partial: false,
        checked_at: result.checked_at,
        report_date: null,
        facts: [{ section: "", label: "STALE", value: "STALE" }],
      },
    ];
    expect(vinSummary(checked).facts.flat().join(" ")).not.toContain("STALE");
    expect(vinSummary(checked).notes.join(" ")).toMatch(/неполная/u);
  });

  it("preserves native units, explicit false and zero without inventing missing detail", () => {
    const facts = Object.fromEntries(
      vinListingDetailsFacts({
        odometer: { value: 100, unit: "mi", status: "Not Actual" },
        keys_present: false,
        asking_price: { amount_minor: 0, currency: "USD" },
      }),
    );
    expect(facts["Записанный пробег (не текущий)"]).toContain("100 миль");
    expect(facts["Записанный пробег (не текущий)"]).toContain("160,9 км");
    expect(facts["Ключи по записи"]).toBe("Нет");
    expect(facts["Цена предложения (не цена покупки)"]).toContain("0");
    expect(facts).not.toHaveProperty("Основное повреждение по записи");
    const unknownUnit = vinListingDetailsFacts({
      odometer: { value: 75414, unit: null, status: "ACTUAL" },
    })[0]![1];
    expect(unknownUnit).toContain("ACTUAL");
    expect(unknownUnit).not.toMatch(/км|миль|≈/u);
    expect(unknownUnit).toContain("единицы не указаны");
  });

  it("offers CARFAX only from positive matching evidence, retaining Korean report precedence", () => {
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
      { ...observation, data: { ...observation.data!, vin: result.vin } },
      { ...observation, source_url: "https://attacker.invalid/" },
      { ...observation, checked_at: null },
    ]) {
      const rejected = { ...positive, vagvin_carfax: invalid };
      expect(confirmedVinReportKind(rejected)).toBeNull();
      expect(vinSummary(rejected).facts).toEqual([]);
    }
    expect(confirmedVinReportKind({ ...positive, vin: positive.vin.toLowerCase() })).toBeNull();
  });

  it("uses CARFAX vehicle facts without duplicating sales copy or trusting its markup", () => {
    const checked = carfaxResult();
    const text = vinResultPresentation(checked).text;
    expect(text).toContain("BMW 530i");
    expect(text).not.toMatch(/Для вашего авто|Полный отчёт|Купить|VAGVIN|vagvin\.ru/u);
    checked.vagvin_carfax!.data!.vehicle =
      '<tg-button url="https://attacker.invalid/">BMW</tg-button>';
    const rendered = load(vinResultPresentation(checked).text);
    expect(rendered("a, tg-button")).toHaveLength(0);
    expect(rendered.root().text()).toContain(checked.vagvin_carfax!.data!.vehicle);
  });
});
