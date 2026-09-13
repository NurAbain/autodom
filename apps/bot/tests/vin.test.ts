import type { EncarListing, VinCheckResult } from "@autodom/core/vin";
import { describe, expect, it } from "vitest";
import { vinResultText, vinSourceText } from "../src/vin-text.js";

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
    const text = vinResultText(result);
    expect(text).toContain(result.vin);
    expect(text).toContain("0 км");
    expect(text).toContain("2024-05-02");
    expect(text).toContain("2010-01-15");
    expect(text).toMatch(/не куплен/);
    expect(text).toMatch(/полной гибели.*неизвестны/);
    expect(text).toMatch(/не текущий/);
    expect(text).toContain("https://www.carhistory.or.kr/");
    expect(text).toContain("https://www.car365.go.kr/");
    expect(text).not.toContain("attacker.invalid");
    expect(text).not.toContain("NHTSA");
    expect(text).not.toContain("vpic.nhtsa.dot.gov");
  });

  it("does not turn disabled, failing or no-data providers into a clean-car claim", () => {
    const unavailable = vinSourceText("car365", {
      ...result,
      car365: { ...result.car365, status: "unavailable", data: null },
    });
    const disabled = vinSourceText("car365", {
      ...result,
      car365: { ...result.car365, status: "disabled", data: null, checked_at: null },
    });
    const missing = vinSourceText("carhistory", {
      ...result,
      carhistory: { ...result.carhistory, status: "not_found" },
    });
    expect(unavailable).toMatch(/недоступен/);
    expect(disabled).toMatch(/отключён/);
    expect(missing).toMatch(/не подтвержден/);
    expect(missing).toMatch(/корейский.*номер/);
    expect(
      vinSourceText("car365", {
        ...result,
        car365: { ...result.car365, data: { ...result.car365.data!, last_mileage_km: null } },
      }),
    ).toMatch(/Пробег.*неизвестен/);
  });

  it("presents decoder specifications separately from vehicle history and uses the trusted source", () => {
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
    expect(section).toMatch(/NHTSA vPIC.*США.*характеристики/);
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
    const text = vinResultText(decoded);
    expect(text).toContain("https://vpic.nhtsa.dot.gov/api/");
    expect(text).not.toContain("attacker.invalid");
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

  it("distinguishes an undecodable VIN from unavailable and disabled decoder requests", () => {
    const observation = {
      source_url: "https://vpic.nhtsa.dot.gov/api/",
      checked_at: result.checked_at,
      data: null,
    };
    const missing = vinSourceText("nhtsa_vpic", {
      ...result,
      nhtsa_vpic: { ...observation, status: "not_found" },
    });
    const unavailable = vinSourceText("nhtsa_vpic", {
      ...result,
      nhtsa_vpic: { ...observation, status: "unavailable" },
    });
    const disabled = vinSourceText("nhtsa_vpic", {
      ...result,
      nhtsa_vpic: { ...observation, status: "disabled", checked_at: null },
    });
    expect(missing).toMatch(/Декодер не смог установить характеристики/);
    expect(missing).toMatch(/не подтверждает отсутствие ДТП/);
    expect(unavailable).toMatch(/недоступен.*Результат проверки неизвестен/);
    expect(disabled).toMatch(/отключён; запрос не отправлен/);
    expect(disabled).not.toMatch(/Проверено:/);
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
    expect(section).toContain("Auto.dev");
    expect(section).toContain("Hyundai");
    expect(section).toContain("2010");
    expect(section).toMatch(/неоднозначн/);
    expect(section).toMatch(/не история ДТП/);
    expect(section).toMatch(/происхождени.*South Korea/);
    expect(section).not.toMatch(/0 км|2024-05-02|null|undefined|Двигатель:/);
    const text = vinResultText(decoded);
    expect(text).toContain("https://docs.auto.dev/v2/products/vin-decode");
    expect(text).not.toContain("attacker.invalid");
  });

  it("does not mislabel missing global specifications as missing government history", () => {
    const section = vinSourceText("autodev", {
      ...result,
      autodev: {
        status: "not_found",
        source_url: "https://docs.auto.dev/v2/products/vin-decode",
        checked_at: result.checked_at,
        data: null,
      },
    });
    expect(section).toMatch(/Декодер.*характеристики/);
    expect(section).not.toMatch(/государственная запись|экспорте/);
    expect(section).toMatch(/не подтверждает отсутствие ДТП/);
  });

  it("keeps only full-VIN Encar matches and generates canonical links instead of trusting supplied URLs", () => {
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
    const text = vinResultText(history);
    expect(text).toContain("https://fem.encar.com/cars/detail/39720103");
    expect(text).toContain("2024-05-02T11:12:13");
    expect(text).not.toMatch(
      /39711062|40122438|OTHER VIN|UNKNOWN VIN|INVALID ID|attacker\.invalid/,
    );
    for (const status of ["disabled", "unavailable", "not_found"] as const) {
      expect(
        vinSourceText("encar", { ...history, encar: { ...history.encar, status } }),
      ).not.toContain("39720103");
    }
    history.encar.data.vin = "WBA51AG03NCK98884";
    expect(vinSourceText("encar", history)).not.toContain("39720103");
  });
});
