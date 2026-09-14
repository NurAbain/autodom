import type { EncarListing, VinCheckResult } from "@autodom/core/vin";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  hasKoreanVinRecord,
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
    const { text, richHtml } = vinResultPresentation(result);
    const rendered = load(richHtml);
    expect(
      rendered("td b")
        .map((_index, node) => rendered(node).text())
        .get(),
    ).toEqual(expect.arrayContaining(["Avante", "0 км", "2024-05-02", "2010-01-15"]));
    expect(rendered("table, tg-button").first().is("table")).toBe(true);
    expect(text).toContain(result.vin);
    expect(text).toContain("0 км");
    expect(text).toContain("2024-05-02");
    expect(text).toContain("2010-01-15");
    expect(text).toMatch(/не куплен/);
    expect(text).toMatch(/полной гибели.*неизвестны/);
    expect(text).toMatch(/не текущий/);
    expect(text).not.toContain("attacker.invalid");
    expect(text).not.toContain("NHTSA");
    expect(text).not.toContain("vpic.nhtsa.dot.gov");
    expect(vinVisibleProviders(result)).toEqual(["car365", "carhistory"]);
    expect(vinResultActions(result).keyboard.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ callback_data: "vin-report-example" })]),
    );
    expect(rendered('tg-button[data="vin-report-example"]')).toHaveLength(1);
    expect(rendered('tg-button[data^="vin-report-buy:"]')).toHaveLength(0);
    for (const html of [text, richHtml]) {
      expect(html).not.toMatch(/vinarchive:|Google|США \/ ОАЭ|Фото и поиск в интернете|web_app/);
    }
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
    expect(vinVisibleProviders(decoded)).toEqual(["nhtsa_vpic"]);
    expect(vinResultNotice(decoded)).toBeNull();
    const actions = vinResultActions(decoded);
    expect(actions.report).toEqual([]);
    expect(actions.keyboard.inline_keyboard.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: `vinarchive:${result.vin}` }),
        expect.objectContaining({ url: expect.stringContaining("google.com/search") }),
      ]),
    );
    const { text, richHtml } = vinResultPresentation(decoded);
    expect(load(richHtml)("h3")).toHaveLength(1);
    for (const html of [text, richHtml]) {
      expect(html).toContain("HYUNDAI");
      expect(html).toContain("SOUTH KOREA");
      expect(html).not.toMatch(
        /Экспорт и пробег|Полный отчёт|vin-report-example|Avante|0 км|Заказ/,
      );
    }
  });

  it("keeps found facts and sample while disclosing failed checks without empty source sections", () => {
    const partial: VinCheckResult = {
      ...result,
      carhistory: { ...result.carhistory, status: "unavailable" },
    };
    expect(vinVisibleProviders(partial)).toEqual(["car365"]);
    expect(vinResultNotice(partial)).toMatch(/неполная.*не удалось/);
    const presentation = vinResultPresentation(partial);
    expect(load(presentation.richHtml)('tg-button[data="vin-report-example"]')).toHaveLength(1);
    for (const html of [presentation.text, presentation.richHtml]) {
      expect(html).toContain("Avante");
      expect(html).toMatch(/неполная/);
      expect(html).not.toContain("Наличие отчёта подтверждено");
    }
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
      expect(vinResultActions(stale).report).toEqual([]);
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

  it("keeps provider markup as visible text rather than links or purchase buttons in either format", () => {
    const model =
      '<tg-button type="url" url="https://attacker.invalid">Купить</tg-button> & <b>GT</b>';
    const presentation = vinResultPresentation({
      ...result,
      car365: { ...result.car365, data: { ...result.car365.data!, model } },
    });
    for (const html of [presentation.text, presentation.richHtml]) {
      const rendered = load(html);
      expect(rendered('a, script, [url*="attacker.invalid"]')).toHaveLength(0);
      expect(rendered.root().text()).toContain(model);
      expect(
        rendered("b")
          .map((_index, node) => rendered(node).text())
          .get(),
      ).toContain(model);
    }
  });

  it("never presents unknown or stale export mileage as zero or as a successful check", () => {
    const unknown = vinResultPresentation({
      ...result,
      car365: {
        ...result.car365,
        data: { ...result.car365.data!, last_mileage_km: null },
      },
    });
    const rendered = load(unknown.richHtml);
    expect(
      rendered("td b")
        .map((_index, node) => rendered(node).text())
        .get(),
    ).toContain("неизвестен");
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
      expect(vinResultActions(stale).report).toEqual([]);
      expect(vinResultNotice(stale)).toMatch(
        status === "not_found"
          ? /не найдены.*не подтверждает/
          : status === "unavailable"
            ? /неполная.*не удалось/
            : /не подключена.*не отправлен/,
      );
      expect(load(presentation.richHtml)("h3")).toHaveLength(0);
      for (const html of [presentation.text, presentation.richHtml]) {
        expect(html).not.toMatch(/Avante|0 км|2024-05-02|Найдена экспортная декларация/);
        expect(html).not.toContain("Наличие отчёта подтверждено");
        expect(html).not.toMatch(/vin-report-example|Полный отчёт|Заказ/);
      }
    }
  });
});
