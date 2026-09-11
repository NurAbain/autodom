import type { VinCheckResult } from "@autodom/core/vin";
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
});
