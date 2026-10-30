import { describe, expect, it } from "vitest";
import {
  ownerCardToDraft,
  ownerDraftSchema,
  ownerDraftToCard,
  ownerVehicleName,
} from "../src/owner-filter.js";
import type { OwnerVehicle } from "../src/owner-vehicle.js";

const draft = {
  purpose: "sale",
  make: { id: "1", value: "Toyota", label: "Toyota" },
  model: { id: "11", value: "Camry", label: "Camry" },
  make_model: "",
  year: 2018,
  mileage_km: 120_000,
  body_type: "sedan",
  transmission: "automatic",
  city: "Бишкек",
  sale_price_minor: 1_500_000,
  sale_currency: "USD",
  property_city: null,
  property_type: null,
  cash_minor: null,
  cash_currency: null,
  monthly_minor: null,
  monthly_currency: null,
};

const saved: OwnerVehicle = {
  user_id: 1,
  chat_id: 1,
  purpose: "sale",
  make_model: "Toyota Camry",
  make_id: "1",
  make_value: "Toyota",
  make_label: "Toyota",
  model_id: "11",
  model_value: "Camry",
  model_label: "Camry",
  year: 2018,
  mileage_km: 120_000,
  body_type: "sedan",
  transmission: "automatic",
  city: "Бишкек",
  sale_price_minor: 1_500_000,
  sale_currency: "USD",
  property_city: null,
  property_type: null,
  cash_minor: null,
  cash_currency: null,
  monthly_minor: null,
  monthly_currency: null,
  consent_at: 100,
  updated_at: 200,
};

describe("owner draft", () => {
  it("keeps the conditions of the shared filter", () => {
    const parsed = ownerDraftSchema.parse(draft);
    expect(parsed.make?.value).toBe("Toyota");
    expect(parsed.model?.value).toBe("Camry");
    expect(parsed.city).toBe("Бишкек");
    expect(parsed.body_type).toBe("sedan");
    expect(parsed.transmission).toBe("automatic");
    expect(parsed.year).toBe(2018);
    expect(parsed.mileage_km).toBe(120_000);
  });

  it("names the car by the catalogue labels and by the own text", () => {
    expect(ownerVehicleName(draft)).toBe("Toyota Camry");
    expect(ownerVehicleName({ make: draft.make, model: null })).toBe("Toyota");
    expect(ownerVehicleName({ make: null, model: null, make_model: " Toyota Camry " })).toBe(
      "Toyota Camry",
    );
  });

  it("refuses a price without a currency and a missing year", () => {
    expect(ownerDraftSchema.safeParse({ ...draft, sale_currency: null }).success).toBe(false);
    expect(ownerDraftSchema.safeParse({ ...draft, year: undefined }).success).toBe(false);
  });

  it("refuses a property goal without the property wishes", () => {
    expect(ownerDraftSchema.safeParse({ ...draft, purpose: "property" }).success).toBe(false);
    expect(
      ownerDraftSchema.safeParse({
        ...draft,
        purpose: "property",
        property_city: "Бишкек",
        property_type: "apartment",
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown body type", () => {
    expect(ownerDraftSchema.safeParse({ ...draft, body_type: "truck" }).success).toBe(false);
  });

  it("builds the card and keeps the consent of the saved one", () => {
    const card = ownerDraftToCard(1, 1, ownerDraftSchema.parse(draft), saved, 300);
    expect(card).toMatchObject({
      user_id: 1,
      chat_id: 1,
      purpose: "sale",
      make_model: "Toyota Camry",
      make_id: "1",
      make_value: "Toyota",
      make_label: "Toyota",
      model_id: "11",
      model_value: "Camry",
      model_label: "Camry",
      body_type: "sedan",
      transmission: "automatic",
      city: "Бишкек",
      year: 2018,
      mileage_km: 120_000,
      sale_price_minor: 1_500_000,
      sale_currency: "USD",
      consent_at: 100,
      updated_at: 300,
    });
  });

  it("reads the card back into the draft", () => {
    // The card keeps the readable name of the car next to the catalogue choice.
    expect(ownerCardToDraft(saved)).toEqual({
      ...ownerDraftSchema.parse(draft),
      make_model: "Toyota Camry",
    });
  });

  it("keeps a card of the older editor without the catalogue choice", () => {
    const older: OwnerVehicle = {
      ...saved,
      make_model: "Toyota Camry",
      make_id: null,
      make_value: null,
      make_label: null,
      model_id: null,
      model_value: null,
      model_label: null,
      body_type: null,
      transmission: null,
      city: null,
    };
    const parsed = ownerCardToDraft(older);
    expect(parsed.make).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.make_model).toBe("Toyota Camry");
    expect(parsed.body_type).toBe("");
    expect(parsed.city).toBe("");
  });
});
