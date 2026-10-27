import { makeProfile } from "@autodom/core";
import { describe, expect, it } from "vitest";
import { countModelsByModel, filterProfileView } from "../src/miniapp-filter.js";

const models = [{ value: "Camry" }, { value: "X5 M" }, { value: "X5" }, { value: "Land Cruiser" }];

describe("model counts", () => {
  it("counts an ad by its catalogue model", () => {
    const counts = countModelsByModel([{ title: " bmw x5 m 2021 ", model: "X5 M" }], models);
    expect(counts.get("X5 M")).toBe(1);
  });

  it("counts an ad by the title when the marketplace only names the car there", () => {
    const counts = countModelsByModel([{ title: " toyota land cruiser 2020 ", model: "" }], models);
    expect(counts.get("Land Cruiser")).toBe(1);
    expect(counts.get("Camry")).toBeUndefined();
  });

  it("keeps a model with several words together", () => {
    const counts = countModelsByModel([{ title: " bmw x5 m competition ", model: "" }], models);
    expect(counts.get("X5 M")).toBe(1);
    expect(counts.get("X5")).toBe(1);
  });

  it("ignores ads that do not name the model", () => {
    const counts = countModelsByModel([{ title: " toyota camry 2019 ", model: "Camry" }], models);
    expect(counts.get("Camry")).toBe(1);
    expect(counts.get("X5")).toBeUndefined();
  });
});

describe("saved conditions", () => {
  it("drops a body type that the current editor does not know", () => {
    const profile = makeProfile({
      user_id: 42,
      chat_id: 42,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 100,
      query: "",
      market: "KG",
      body_type: "Любой кузов",
      transmission: "Любая коробка",
    });
    const view = filterProfileView(profile);
    expect(view.body_type).toBe("");
    expect(view.transmission).toBe("");
  });

  it("keeps a known body type", () => {
    const profile = makeProfile({
      user_id: 42,
      chat_id: 42,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 100,
      query: "",
      market: "KG",
      body_type: "sedan",
      transmission: "automatic",
    });
    const view = filterProfileView(profile);
    expect(view.body_type).toBe("sedan");
    expect(view.transmission).toBe("automatic");
  });
});
