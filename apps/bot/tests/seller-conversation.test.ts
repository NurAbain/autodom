import type { CatalogLookup } from "@autodom/core/catalog-filter";
import type { OwnerVehicle } from "@autodom/core/owner-vehicle";
import { describe, expect, it } from "vitest";
import type { Reply } from "../src/conversation.js";
import { SellerConversation } from "../src/seller-conversation.js";

class OwnerStore {
  card: OwnerVehicle | null = null;
  deleted = 0;
  async getOwnerVehicle() {
    return this.card;
  }
  async saveOwnerVehicle(card: OwnerVehicle) {
    this.card = card;
    return card;
  }
  async deleteOwnerVehicle() {
    this.deleted += 1;
    this.card = null;
  }
  async countMakes() {
    return new Map([
      ["Toyota", 12],
      ["Kia", 4],
    ]);
  }
  async countCities() {
    return [
      { city: "Бишкек", matches: 30 },
      { city: "Ош", matches: 4 },
    ];
  }
}

const catalogue: CatalogLookup = {
  async getOptions(key, parentId) {
    if (key === "make")
      return [
        { id: "1", value: "Toyota", label: "Toyota" },
        { id: "2", value: "Kia", label: "Kia" },
      ];
    if (key === "model" && parentId === "1")
      return [
        { id: "11", value: "Camry", label: "Camry" },
        { id: "12", value: "Corolla", label: "Corolla" },
      ];
    return [];
  },
};

function action(replies: readonly Reply[], label: string): string {
  const found = replies
    .flatMap((reply) => reply.buttons.flat())
    .find(([text]) => text.includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found[1];
}
const text = (replies: readonly Reply[]): string => replies.map((reply) => reply.text).join("\n");
const labels = (replies: readonly Reply[]): string[] =>
  replies.flatMap((reply) => reply.buttons.flat()).map(([label]) => label);

function seller(store: OwnerStore, lookup: CatalogLookup = catalogue): SellerConversation {
  return new SellerConversation(store, lookup);
}

async function start(store: OwnerStore, lookup: CatalogLookup = catalogue): Promise<Reply[]> {
  const conversation = seller(store, lookup);
  return (await conversation.handle(1, 1, "/sell")) ?? [];
}

describe("SellerConversation", () => {
  it("offers the three goals of the owner card", async () => {
    const conversation = seller(new OwnerStore());
    const replies = (await conversation.handle(1, 1, "/sell")) ?? [];
    expect(text(replies)).toContain("Согласны на обработку и хранение этих данных?");
    const goals = (await conversation.handle(1, 1, action(replies, "Согласен"))) ?? [];
    expect(labels(goals)).toEqual(
      expect.arrayContaining([
        "Продать автомобиль",
        "Обменять авто на недвижимость",
        "Авто как первоначальный взнос",
      ]),
    );
  });

  it("asks the conditions in the order of the shared filter", async () => {
    const store = new OwnerStore();
    const conversation = seller(store);
    let replies = (await conversation.handle(1, 1, "/sell")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Согласен"))) ?? [];
    expect(text(replies)).toContain("Что хотите сделать со своим автомобилем?");
    replies = (await conversation.handle(1, 1, action(replies, "Продать автомобиль"))) ?? [];
    expect(text(replies)).toContain("За сколько хотели бы продать авто?");
    replies = (await conversation.handle(1, 1, "15000 USD")) ?? [];
    expect(text(replies)).toContain("Какая марка автомобиля?");
    expect(labels(replies)).toEqual(expect.arrayContaining(["Toyota", "Kia", "Все марки"]));
    replies = (await conversation.handle(1, 1, action(replies, "Toyota"))) ?? [];
    expect(text(replies)).toContain("Какая модель?");
    expect(labels(replies)).toEqual(expect.arrayContaining(["Camry", "Corolla"]));
    replies = (await conversation.handle(1, 1, action(replies, "Camry"))) ?? [];
    expect(text(replies)).toContain("В каком городе стоит автомобиль?");
    expect(labels(replies)).toEqual(expect.arrayContaining(["Бишкек", "Ош"]));
    replies = (await conversation.handle(1, 1, action(replies, "Бишкек"))) ?? [];
    expect(text(replies)).toContain("Какой кузов у автомобиля?");
    replies = (await conversation.handle(1, 1, action(replies, "Седан"))) ?? [];
    expect(text(replies)).toContain("Какая коробка передач?");
    replies = (await conversation.handle(1, 1, action(replies, "Автомат"))) ?? [];
    expect(text(replies)).toContain("Какой год выпуска автомобиля?");
    replies =
      (await conversation.handle(1, 1, action(replies, String(new Date().getUTCFullYear())))) ?? [];
    expect(text(replies)).toContain("Какой пробег, в километрах?");
    replies = (await conversation.handle(1, 1, "120000")) ?? [];
    expect(text(replies)).toContain("Проверьте перед сохранением");
  });

  it("saves the card with the catalogue choice and the characteristics", async () => {
    const store = new OwnerStore();
    const conversation = seller(store);
    let replies = (await conversation.handle(1, 1, "/sell")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Согласен"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Продать автомобиль"))) ?? [];
    replies = (await conversation.handle(1, 1, "15000 USD")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Toyota"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Camry"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Бишкек"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Седан"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Автомат"))) ?? [];
    replies =
      (await conversation.handle(1, 1, action(replies, String(new Date().getUTCFullYear())))) ?? [];
    replies = (await conversation.handle(1, 1, "120000")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Сохранить карточку"))) ?? [];
    expect(text(replies)).toContain("Сохранённая карточка");
    expect(store.card).toMatchObject({
      purpose: "sale",
      make_id: "1",
      make_value: "Toyota",
      make_label: "Toyota",
      model_id: "11",
      model_value: "Camry",
      model_label: "Camry",
      make_model: "Toyota Camry",
      body_type: "sedan",
      transmission: "automatic",
      city: "Бишкек",
      mileage_km: 120_000,
      sale_price_minor: 1_500_000,
      sale_currency: "USD",
    });
    expect(store.card?.year).toBe(new Date().getUTCFullYear());
  });

  it("asks the property wishes for the exchange goal", async () => {
    const store = new OwnerStore();
    const conversation = seller(store);
    let replies = (await conversation.handle(1, 1, "/sell")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Согласен"))) ?? [];
    replies =
      (await conversation.handle(1, 1, action(replies, "Обменять авто на недвижимость"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Пока не знаю"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Toyota"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Camry"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Бишкек"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Не указан"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Не указан"))) ?? [];
    replies =
      (await conversation.handle(1, 1, action(replies, String(new Date().getUTCFullYear())))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Не указан"))) ?? [];
    expect(text(replies)).toContain("В каком городе нужна недвижимость?");
    replies = (await conversation.handle(1, 1, "Бишкек")) ?? [];
    expect(text(replies)).toContain("Какая недвижимость интересует?");
    replies = (await conversation.handle(1, 1, action(replies, "Квартира"))) ?? [];
    expect(text(replies)).toContain("Сколько готовы доплатить сейчас?");
    replies = (await conversation.handle(1, 1, "5000 USD")) ?? [];
    expect(text(replies)).toContain("Какой будущий платёж в месяц вам подходит?");
    replies = (await conversation.handle(1, 1, "30000 KGS")) ?? [];
    expect(text(replies)).toContain("Проверьте перед сохранением");
    expect(text(replies)).toContain("Город: Бишкек. Тип: Квартира.");
  });

  it("keeps the car name when the catalogue does not know it", async () => {
    const store = new OwnerStore();
    const broken: CatalogLookup = {
      async getOptions() {
        throw new Error("Справочник временно недоступен");
      },
    };
    const conversation = seller(store, broken);
    let replies = (await conversation.handle(1, 1, "/sell")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Согласен"))) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Продать автомобиль"))) ?? [];
    replies = (await conversation.handle(1, 1, "15000 USD")) ?? [];
    expect(text(replies)).toContain("Справочник марок и моделей временно недоступен");
    replies = (await conversation.handle(1, 1, action(replies, "Написать марку текстом"))) ?? [];
    expect(text(replies)).toContain("Напишите марку и модель автомобиля");
    replies = (await conversation.handle(1, 1, "Toyota Camry")) ?? [];
    expect(text(replies)).toContain("В каком городе стоит автомобиль?");
  });

  it("opens the saved card without a new questionnaire", async () => {
    const store = new OwnerStore();
    store.card = {
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
      consent_at: 1,
      updated_at: 2,
    };
    const replies = await start(store);
    expect(text(replies)).toContain("Сохранённая карточка");
    expect(text(replies)).toContain("Toyota Camry, 2018 г.");
    expect(text(replies)).toContain("Бишкек");
    expect(labels(replies)).toEqual(
      expect.arrayContaining(["Изменить: Марка", "Удалить карточку"]),
    );
  });

  it("lets the owner rewrite the name of a card of the older editor", async () => {
    const store = new OwnerStore();
    store.card = {
      user_id: 1,
      chat_id: 1,
      purpose: "sale",
      make_model: "Toyota Camry",
      make_id: null,
      make_value: null,
      make_label: null,
      model_id: null,
      model_value: null,
      model_label: null,
      year: 2018,
      mileage_km: null,
      body_type: null,
      transmission: null,
      city: null,
      sale_price_minor: null,
      sale_currency: null,
      property_city: null,
      property_type: null,
      cash_minor: null,
      cash_currency: null,
      monthly_minor: null,
      monthly_currency: null,
      consent_at: 1,
      updated_at: 2,
    };
    const conversation = seller(store);
    let replies = (await conversation.handle(1, 1, "/mycar")) ?? [];
    replies = (await conversation.handle(1, 1, action(replies, "Изменить: Модель"))) ?? [];
    expect(text(replies)).toContain("Напишите марку и модель автомобиля");
    replies = (await conversation.handle(1, 1, "Toyota Camry")) ?? [];
    expect(text(replies)).toContain("Проверьте перед сохранением");
    expect(text(replies)).toContain("Toyota Camry");
  });
});
