import { type Listing, makeListing, matches, type Profile } from "@autodom/core";
import type { CatalogLookup } from "@autodom/core/catalog-filter";
import {
  CATALOG_OPTION_LABELS,
  CATALOG_RANGE_LABELS,
  type CatalogChoice,
  type CatalogFilter,
  type CatalogOptionKey,
  catalogFilterSchema,
} from "@autodom/core/catalog-filter";
import type { VinLookup } from "@autodom/core/vin";
import type {
  VinArchiveLookup,
  VinArchivePhotoLookup,
  VinArchiveResult,
} from "@autodom/core/vin-archive";
import type { Store } from "@autodom/storage";
import { load } from "cheerio";
import { InputFile } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Conversation,
  listingReplies,
  listingText,
  packReplies,
  type Reply,
} from "../src/conversation.js";
import { configureTelegramBot, createTelegramBot } from "../src/telegram.js";

// An interaction fixture only: persistence, SQL locking and cursor semantics are
// independently exercised against PostgreSQL in the storage package.
class InteractionStore {
  profiles = new Map<number, Profile>();
  drafts = new Map<number, [string, Record<string, unknown>]>();
  listings: Listing[] = [];
  revision = 1_789_000_000_000_000_000n;
  locks: string[] = [];
  async getProfile(id: number) {
    return structuredClone(this.profiles.get(id) ?? null);
  }
  async getDraft(id: number) {
    return structuredClone(this.drafts.get(id) ?? null);
  }
  async setDraft(id: number, state: string, data: Record<string, unknown>) {
    this.drafts.set(id, structuredClone([state, data]));
  }
  async clearDraft(id: number) {
    this.drafts.delete(id);
  }
  async saveProfile(profile: Profile) {
    const saved = {
      ...profile,
      revision: String(++this.revision),
    };
    this.profiles.set(profile.user_id, saved);
    return structuredClone(saved);
  }
  async setMonitoring(id: number, monitoring: boolean) {
    return this.saveProfile({ ...this.profiles.get(id)!, monitoring });
  }
  async setQuietHours(
    id: number,
    quiet_start_minute: number | null,
    quiet_end_minute: number | null,
  ) {
    return this.saveProfile({ ...this.profiles.get(id)!, quiet_start_minute, quiet_end_minute });
  }
  async deleteUser(id: number) {
    this.profiles.delete(id);
    this.drafts.delete(id);
  }
  async countMatches(profile: Profile) {
    return this.listings.filter((item) => matches(profile, item)).length;
  }
  async search(profile: Profile, limit = 5, offset = 0) {
    return this.listings.filter((item) => matches(profile, item)).slice(offset, offset + limit);
  }
  async getMeta(_key: string, fallback: string | null = null) {
    return fallback;
  }
  async setMeta(_key: string, _value: string) {
    throw new Error("Conversation must not mutate catalog metadata");
  }
  async sourceStats() {
    return {};
  }
  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.locks.push(key);
    return action();
  }
}
function button(replies: readonly Reply[], label: string): string {
  const result = replies
    .flatMap((reply) => reply.buttons.flat())
    .find(([text]) => text.includes(label));
  if (!result) throw new Error(`Button not found: ${label}`);
  return result[1];
}
const rendered = (replies: readonly Reply[]) => replies.map((reply) => reply.text).join("\n");
async function begin(conversation: Conversation, user = 1, currency = "USD") {
  const privacy = await conversation.handle(user, user, "/buy");
  const currencies = await conversation.handle(user, user, button(privacy, "Согласен"));
  return conversation.handle(user, user, button(currencies, currency));
}
async function review(
  conversation: Conversation,
  query = "Toyota Camry",
  user = 1,
  currency = "USD",
  budget = "15000",
) {
  await begin(conversation, user, currency);
  const queries = await conversation.handle(user, user, budget);
  return conversation.handle(user, user, query || button(queries, "Пока не знаю"));
}
async function field(replies: Reply[], label: string): Promise<Reply[]> {
  const options = await conversation.handle(1, 1, button(replies, "Уточнить фильтры"));
  return conversation.handle(1, 1, button(options, label));
}
async function editModels(query: string, budget = "12000") {
  const current = await conversation.handle(1, 1, "/edit");
  await conversation.handle(1, 1, button(current, "Бюджет"));
  const updated = await conversation.handle(1, 1, budget);
  await conversation.handle(1, 1, button(updated, "Марки"));
  return conversation.handle(1, 1, query);
}
async function save(
  conversation: Conversation,
  query = "Toyota Camry",
  user = 1,
  currency = "USD",
  budget = "15000",
) {
  const replies = await review(conversation, query, user, currency, budget);
  return conversation.handle(user, user, button(replies, "Сохранить без"));
}
const car = (id: string, title = "Toyota Camry", extra: Partial<Listing> = {}) =>
  makeListing({
    id,
    title,
    url: `https://mashina.kg/details/${id}`,
    price_usd_minor: 1_200_000,
    price_kgs_minor: 100_000_000,
    observed_at: Date.now() / 1000,
    availability: "В наличии",
    ...extra,
  });
const catalogFixture: CatalogLookup = {
  async getOptions(key, parentId) {
    if (key === "make")
      return [
        "Toyota",
        "Honda",
        "Audi",
        "BMW",
        "Ford",
        "Kia",
        "Lexus",
        "Mazda",
        "Nissan",
        "Volvo",
      ].map((label) => ({ id: label, value: label.toLowerCase(), label }));
    const children: Record<string, CatalogChoice[]> = {
      "model:Toyota": [{ id: "camry", value: "Camry", label: "Camry" }],
      "model:Honda": [{ id: "accord", value: "Accord", label: "Accord" }],
      "generation:camry": [{ id: "xv70", value: "XV70", label: "XV70" }],
      "generation:accord": [{ id: "accord10", value: "10", label: "10" }],
      "modification:xv70": [{ id: "camry25", value: "2.5 AT", label: "2.5 AT" }],
      "modification:accord10": [{ id: "accord20", value: "2.0 AT", label: "2.0 AT" }],
      "city:region-a": [{ id: "city-a", value: "city canonical a", label: "Город А" }],
      "city:region-b": [{ id: "city-b", value: "city canonical b", label: "Город Б" }],
    };
    if (["model", "generation", "modification", "city"].includes(key)) {
      const result = children[`${key}:${parentId}`];
      if (!result) throw new Error("Invalid fixture parent");
      return result;
    }
    if (key === "region")
      return [
        { id: "region-a", value: "region canonical a", label: "Регион А" },
        { id: "region-b", value: "region canonical b", label: "Регион Б" },
      ];
    return [
      {
        id: `${key}-lookup`,
        value: `${key}-canonical`,
        label: `${CATALOG_OPTION_LABELS[key as CatalogOptionKey]} вариант`,
      },
    ];
  },
};
let store: InteractionStore;
let conversation: Conversation;
beforeEach(() => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  store = new InteractionStore();
  conversation = new Conversation(store, { catalog: catalogFixture });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("explicit consent and save safety", () => {
  it("keeps three goals independent and resumes the buyer draft without accepting suspended free text", async () => {
    const home = await conversation.handle(1, 1, "/start");
    expect(home.flatMap((reply) => reply.buttons.flat().map(([, action]) => action))).toEqual([
      "/vin",
      "/sell",
      "/buy",
    ]);
    await conversation.handle(1, 1, "/vin");
    expect(await store.getDraft(1)).toBeNull();
    expect(await store.getProfile(1)).toBeNull();
    await begin(conversation);
    const original = await store.getDraft(1);
    await conversation.handle(1, 1, "/start");
    await conversation.handle(1, 1, "90000");
    await conversation.handle(1, 1, "/vin");
    await conversation.handle(1, 1, "/cancel");
    expect(await store.getDraft(1)).toEqual(original);
    await conversation.handle(1, 1, "/buy");
    await conversation.handle(1, 1, "12000");
    expect((await store.getDraft(1))?.[1].maximum).toBe(1_200_000);
    expect(await store.getProfile(1)).toBeNull();
  });
  it("requires explicit buyer resumption after losing the active goal on restart", async () => {
    await begin(conversation);
    await conversation.handle(1, 1, "15000");
    const buyerDraft = await store.getDraft(1);
    await conversation.handle(1, 1, "/sell");
    const restarted = new Conversation(store);
    await restarted.handle(1, 1, "Toyota Camry, 2018, 120000");
    expect(await store.getDraft(1)).toEqual(buyerDraft);
    await restarted.handle(1, 1, "/cancel");
    expect(await store.getDraft(1)).toEqual(buyerDraft);
    await restarted.handle(1, 1, "/buy");
    await restarted.handle(1, 1, "Honda Fit");
    expect((await store.getDraft(1))?.[1].query).toBe("Honda Fit");
  });
  it("enables monitoring only for the chosen save and rejects the alternate consumed button", async () => {
    const first = await review(conversation);
    const monitor = button(first, "бесплатный мониторинг");
    await conversation.handle(1, 1, button(first, "Сохранить без"));
    const silent = await store.getProfile(1);
    expect(silent?.monitoring).toBe(false);
    await conversation.handle(1, 1, monitor);
    expect(await store.getProfile(1)).toEqual(silent);
    const edited = await conversation.handle(1, 1, "/edit");
    const enabled = button(edited, "бесплатный мониторинг");
    await conversation.handle(2, 2, enabled);
    expect(await store.getProfile(2)).toBeNull();
    await conversation.handle(1, 1, enabled);
    expect((await store.getProfile(1))?.monitoring).toBe(true);
    expect(await store.getDraft(1)).toBeNull();
  });
  it("persists nothing before current explicit consent, including on restart", async () => {
    const old = button(await conversation.handle(1, 1, "/buy"), "Согласен");
    for (const command of ["/privacy", "/begin", "/edit", "consent:accept", old]) {
      await conversation.handle(1, 1, command);
      expect(await store.getDraft(1)).toBeNull();
      expect(await store.getProfile(1)).toBeNull();
    }
    const fresh = button(await conversation.handle(1, 1, "/privacy"), "Согласен");
    await new Conversation(store).handle(1, 1, fresh);
    expect(await store.getDraft(1)).toBeNull();
    await conversation.handle(1, 1, fresh);
    expect((await store.getDraft(1))?.[0]).toBe("currency");
  });
  it.each(["currency:KGS", "query:unexpected", "!!!", "___", ", ,", "Toyota, !!!"])(
    "does not save invalid query %s",
    async (invalid) => {
      await save(conversation);
      const current = await conversation.handle(1, 1, "/edit");
      const original = await store.getProfile(1);
      await conversation.handle(1, 1, button(current, "Марки"));
      await conversation.handle(1, 1, invalid);
      expect(await store.getProfile(1)).toEqual(original);
      expect((await store.getDraft(1))?.[0]).toBe("query");
    },
  );
  it("binds review choices to user, current prompt and a single save, surviving restart", async () => {
    const first = await review(conversation, "Toyota");
    const oldSave = button(first, "Сохранить");
    const options = await conversation.handle(1, 1, button(first, "Уточнить фильтры"));
    const oldCity = button(options, "Город");
    const city = await conversation.handle(1, 1, oldCity);
    const current = await store.getDraft(1);
    for (const stale of [oldSave, oldCity, oldCity.replace(":refine:", ":city:")]) {
      await conversation.handle(1, 1, stale);
      expect(await store.getDraft(1)).toEqual(current);
      expect(await store.getProfile(1)).toBeNull();
    }
    await review(conversation, "Honda", 2);
    const other = await store.getDraft(2);
    await conversation.handle(2, 2, button(city, "пропустить"));
    expect(await store.getDraft(2)).toEqual(other);
    const restarted = new Conversation(store);
    const currentReview = await restarted.handle(1, 1, button(city, "Назад"));
    await restarted.handle(1, 1, oldSave);
    expect(await store.getProfile(1)).toBeNull();
    const currentSave = button(currentReview, "Сохранить");
    await restarted.handle(1, 1, currentSave);
    const saved = await store.getProfile(1);
    expect(saved?.query).toBe("Toyota");
    await restarted.handle(1, 1, currentSave);
    expect(await store.getProfile(1)).toEqual(saved);
  });
  it("prevents stale and unknown callback payloads becoming free text", async () => {
    const currencies = await conversation.handle(
      1,
      1,
      button(await conversation.handle(1, 1, "/buy"), "Согласен"),
    );
    const stale = button(currencies, "KGS");
    await conversation.handle(1, 1, button(currencies, "USD"));
    await conversation.handle(1, 1, "15000");
    for (const state of ["query", "city"]) {
      const draft = await store.getDraft(1);
      expect(draft?.[0]).toBe(state);
      for (const payload of ["unexpected:Toyota", "city:Ош", stale, "/unknown", "Toyota\u0000"]) {
        await conversation.handle(1, 1, payload);
        expect(await store.getDraft(1)).toEqual(draft);
      }
      if (state === "query") {
        const current = await conversation.handle(1, 1, "Toyota");
        await field(current, "Город");
      }
    }
  });
  it("does not expose or mutate private preferences from a group", async () => {
    await save(conversation);
    const original = await store.getProfile(1);
    for (const command of ["/profile", "/search", "/edit", "/resume", "/delete", "/quiet off"]) {
      const replies = await conversation.handle(1, -100, command);
      expect(rendered(replies)).not.toContain("Toyota");
      expect(await store.getProfile(1)).toEqual(original);
      expect(await store.getDraft(1)).toBeNull();
    }
  });
});

describe("catalogue buyer filters", () => {
  it("completes the full vehicle hierarchy and silent save with buttons only", async () => {
    let current = await begin(conversation);
    current = await conversation.handle(1, 1, button(current, "15"));
    current = await conversation.handle(1, 1, button(current, "Выбрать автомобиль"));
    current = await conversation.handle(1, 1, button(current, "Добавить"));
    for (const label of ["Toyota", "Camry", "XV70", "2.5 AT"])
      current = await conversation.handle(1, 1, button(current, label));
    current = await conversation.handle(1, 1, button(current, "Назад к автомобилям"));
    current = await conversation.handle(1, 1, button(current, "Готово"));
    expect(await store.getProfile(1)).toBeNull();
    await conversation.handle(1, 1, button(current, "Сохранить без"));
    const saved = await store.getProfile(1);
    expect(saved?.catalog_filter.vehicles).toEqual([
      {
        make: { id: "Toyota", value: "toyota", label: "Toyota" },
        model: { id: "camry", value: "Camry", label: "Camry" },
        generation: { id: "xv70", value: "XV70", label: "XV70" },
        modification: { id: "camry25", value: "2.5 AT", label: "2.5 AT" },
      },
    ]);
    expect(saved?.budget_max_minor).toBe(1_500_000);
    expect(saved?.query).toBe("");
    expect(saved?.monitoring).toBe(false);
  });

  it("keeps an inclusive fractional-mile boundary consistent with ingested mileage", async () => {
    store.listings = [
      car("boundary", "Honda Fit", { catalog_numbers: { mileage: 0.1609344 } }),
      car("below", "Honda Fit", { catalog_numbers: { mileage: 0.16 } }),
    ];
    let current = await review(conversation, "");
    current = await conversation.handle(1, 1, button(current, "Все фильтры"));
    current = await conversation.handle(1, 1, button(current, CATALOG_RANGE_LABELS.mileage));
    current = await conversation.handle(1, 1, button(current, "Задать минимум"));
    current = await conversation.handle(1, 1, "0.1 miles");
    current = await conversation.handle(1, 1, button(current, "Готово"));
    current = await conversation.handle(1, 1, button(current, "К сохранению"));
    const saved = await conversation.handle(1, 1, button(current, "Сохранить без"));
    expect(saved.flatMap((reply) => reply.listingId ?? [])).toEqual(["boundary"]);
  });

  it("replaces catalogue restrictions through equivalent legacy controls only on save", async () => {
    await save(conversation);
    const profile = (await store.getProfile(1))!;
    profile.catalog_filter.options.body_type = [{ id: "1", value: "Седан", label: "Седан" }];
    await store.saveProfile(profile);
    store.listings = [car("suv", "Toyota Camry", { body_type: "suv" })];
    let current = await conversation.handle(1, 1, "/edit");
    current = await field(current, "Кузов");
    current = await conversation.handle(1, 1, "suv");
    expect((await store.getProfile(1))!.catalog_filter.options.body_type).toEqual(
      profile.catalog_filter.options.body_type,
    );
    const saved = await conversation.handle(1, 1, button(current, "Сохранить без"));
    expect(saved.flatMap((reply) => reply.listingId ?? [])).toEqual(["suv"]);
    expect((await store.getProfile(1))!.catalog_filter.options.body_type).toBeUndefined();
  });

  it("rejects forged and previous-page options and restores searchable selections after lookup failure", async () => {
    let unavailable = false;
    const lookup: CatalogLookup = {
      getOptions: (key, parent) =>
        unavailable
          ? Promise.reject(new Error("Unavailable"))
          : catalogFixture.getOptions(key, parent),
    };
    conversation = new Conversation(store, { catalog: lookup });
    let current = await review(conversation, "");
    current = await conversation.handle(1, 1, button(current, "Все фильтры"));
    current = await conversation.handle(1, 1, button(current, "Марка"));
    current = await conversation.handle(1, 1, button(current, "Добавить"));
    const oldToyota = button(current, "Toyota");
    current = await conversation.handle(1, 1, button(current, "Следующая страница"));
    const page = await store.getDraft(1);
    for (const invalid of [oldToyota, oldToyota.replace(/:[^:]+$/, ":czzz")]) {
      await conversation.handle(1, 1, invalid);
      expect(await store.getDraft(1)).toEqual(page);
    }
    current = await conversation.handle(1, 1, "Toy");
    expect(current.find((reply) => reply.picker)?.picker).toMatchObject({
      page: 1,
      pages: 1,
      searchable: true,
    });
    const chooseToyota = button(current, "Toyota");
    unavailable = true;
    current = await conversation.handle(1, 1, chooseToyota);
    const selected = (await store.getDraft(1))?.[1].catalog_filter;
    expect((selected as CatalogFilter).vehicles[0]?.make?.value).toBe("toyota");
    current = await conversation.handle(1, 1, button(current, "Повторить"));
    expect((await store.getDraft(1))?.[1].catalog_filter).toEqual(selected);
    expect(current.find((reply) => reply.picker)?.picker?.searchable).toBe(false);
    unavailable = false;
    current = await conversation.handle(1, 1, button(current, "Повторить"));
    current = await conversation.handle(1, 1, button(current, "Camry"));
    await conversation.handle(1, 1, chooseToyota);
    expect(
      catalogFilterSchema.parse((await store.getDraft(1))?.[1].catalog_filter).vehicles[0]?.model
        ?.value,
    ).toBe("Camry");
  });

  it("clears descendants when changing a vehicle ancestor and enforces five alternatives", async () => {
    let current = await review(conversation, "");
    current = await conversation.handle(1, 1, button(current, "Все фильтры"));
    current = await conversation.handle(1, 1, button(current, "Марка"));
    current = await conversation.handle(1, 1, button(current, "Добавить"));
    for (const label of ["Toyota", "Camry", "XV70", "2.5 AT"])
      current = await conversation.handle(1, 1, button(current, label));
    current = await conversation.handle(1, 1, button(current, "Марка"));
    current = await conversation.handle(1, 1, button(current, "Honda"));
    expect(
      catalogFilterSchema.parse((await store.getDraft(1))?.[1].catalog_filter).vehicles,
    ).toEqual([{ make: { id: "Honda", value: "honda", label: "Honda" } }]);
    current = await conversation.handle(1, 1, button(current, "Готово"));
    current = await conversation.handle(1, 1, button(current, "Назад к автомобилям"));
    for (let index = 1; index < 5; index++) {
      current = await conversation.handle(1, 1, button(current, "Добавить"));
      current = await conversation.handle(1, 1, button(current, "Toyota"));
      current = await conversation.handle(1, 1, button(current, "Готово"));
      current = await conversation.handle(1, 1, button(current, "Назад к автомобилям"));
    }
    expect(
      current
        .flatMap((reply) => reply.buttons.flat())
        .some(([label]) => label.includes("Добавить")),
    ).toBe(false);
    current = await conversation.handle(1, 1, button(current, "1. Honda"));
    current = await conversation.handle(1, 1, button(current, "Удалить"));
    expect(
      catalogFilterSchema.parse((await store.getDraft(1))?.[1].catalog_filter).vehicles,
    ).toHaveLength(4);
  });

  it("applies every category, scopes city to its region, and clears legacy conflicts only in the draft", async () => {
    await save(conversation);
    const profile = (await store.getProfile(1))!;
    profile.city = "Прежний город";
    profile.body_type = "sedan";
    profile.transmission = "manual";
    store.profiles.set(1, profile);
    let current = await conversation.handle(1, 1, "/edit");
    current = await conversation.handle(1, 1, button(current, "Все фильтры"));
    current = await conversation.handle(1, 1, button(current, CATALOG_OPTION_LABELS.city));
    expect(
      current.flatMap((reply) => reply.buttons.flat()).some(([label]) => label === "Город А"),
    ).toBe(false);
    current = await conversation.handle(1, 1, button(current, "Назад"));
    const keys = Object.keys(CATALOG_OPTION_LABELS) as CatalogOptionKey[];
    for (const key of [
      ...keys.filter((key) => key !== "city" && key !== "region"),
      "region",
      "city",
    ] as CatalogOptionKey[]) {
      current = await conversation.handle(1, 1, button(current, CATALOG_OPTION_LABELS[key]));
      current = await conversation.handle(
        1,
        1,
        button(
          current,
          key === "region"
            ? "Регион А"
            : key === "city"
              ? "Город А"
              : `${CATALOG_OPTION_LABELS[key]} вариант`,
        ),
      );
      current = await conversation.handle(1, 1, button(current, "Готово"));
    }
    const draft = (await store.getDraft(1))![1];
    expect(Object.keys((draft.catalog_filter as CatalogFilter).options).sort()).toEqual(
      keys.sort(),
    );
    expect([draft.city, draft.body_type, draft.transmission]).toEqual(["", "", ""]);
    expect((await store.getProfile(1))?.city).toBe("Прежний город");
    current = await conversation.handle(1, 1, button(current, CATALOG_OPTION_LABELS.region));
    current = await conversation.handle(1, 1, button(current, "Регион Б"));
    current = await conversation.handle(1, 1, button(current, "Готово"));
    const changed = (await store.getDraft(1))![1].catalog_filter as CatalogFilter;
    expect(changed.options.city).toBeUndefined();
    current = await conversation.handle(1, 1, button(current, CATALOG_OPTION_LABELS.city));
    expect(
      current.flatMap((reply) => reply.buttons.flat()).some(([label]) => label === "Город А"),
    ).toBe(false);
    current = await conversation.handle(1, 1, button(current, "Город Б"));
    current = await conversation.handle(1, 1, button(current, "Готово"));
    current = await conversation.handle(1, 1, button(current, "К сохранению"));
    await conversation.handle(1, 1, button(current, "Сохранить без"));
    expect((await store.getProfile(1))?.catalog_filter.options.city?.[0]?.value).toBe(
      "city canonical b",
    );
    expect((await store.getProfile(1))?.city).toBe("");
  });

  it("validates arbitrary range bounds, converts miles without rounding km, and persists source discount thresholds", async () => {
    let current = await review(conversation, "", 1, "USD", "10000.50–15000.75");
    current = await conversation.handle(1, 1, button(current, "Все фильтры"));
    current = await conversation.handle(1, 1, button(current, CATALOG_RANGE_LABELS.mileage));
    current = await conversation.handle(1, 1, button(current, "Задать максимум"));
    current = await conversation.handle(1, 1, "100 miles");
    expect(
      catalogFilterSchema.parse((await store.getDraft(1))?.[1].catalog_filter).ranges.mileage,
    ).toEqual({ min: null, max: 160.9344 });
    current = await conversation.handle(1, 1, button(current, "Задать минимум"));
    for (const invalid of ["200 км", "-1", "NaN", "10 л"]) {
      current = await conversation.handle(1, 1, invalid);
      expect(
        catalogFilterSchema.parse((await store.getDraft(1))?.[1].catalog_filter).ranges.mileage,
      ).toEqual({ min: null, max: 160.9344 });
    }
    current = await conversation.handle(1, 1, "100 км");
    current = await conversation.handle(1, 1, button(current, "Готово"));
    current = await conversation.handle(1, 1, button(current, CATALOG_RANGE_LABELS.engine_volume));
    current = await conversation.handle(1, 1, button(current, "Задать минимум"));
    current = await conversation.handle(1, 1, "1,6");
    current = await conversation.handle(1, 1, button(current, "Задать максимум"));
    current = await conversation.handle(1, 1, "2.5");
    current = await conversation.handle(1, 1, button(current, "Готово"));
    current = await conversation.handle(1, 1, button(current, "Ниже рынка"));
    current = await conversation.handle(1, 1, button(current, "От 15%"));
    current = await conversation.handle(1, 1, button(current, "Назад"));
    current = await conversation.handle(1, 1, button(current, "К сохранению"));
    await conversation.handle(1, 1, button(current, "Сохранить +"));
    const saved = await store.getProfile(1);
    expect(saved?.catalog_filter.ranges.engine_volume).toEqual({ min: 1.6, max: 2.5 });
    expect(saved?.catalog_filter.below_market_percent).toBe(15);
    expect([saved?.budget_min_minor, saved?.budget_max_minor]).toEqual([1_000_050, 1_500_075]);
    expect(saved?.monitoring).toBe(true);
  });
});

describe("editing, monitoring and deletion", () => {
  it("keeps monitoring paused after edit cancellation and rejects older resume buttons", async () => {
    const old = button(await save(conversation), "Включить мониторинг");
    await conversation.handle(1, 1, "/resume");
    await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, "/resume");
    expect((await store.getProfile(1))?.monitoring).toBe(false);
    await conversation.handle(1, 1, "/cancel");
    await conversation.handle(1, 1, old);
    expect((await store.getProfile(1))?.monitoring).toBe(false);
    const fresh = button(await conversation.handle(1, 1, "/profile"), "Включить мониторинг");
    await new Conversation(store).handle(1, 1, fresh);
    expect((await store.getProfile(1))?.monitoring).toBe(true);
    await conversation.handle(1, 1, "/pause");
    expect((await store.getProfile(1))?.monitoring).toBe(false);
  });
  it("deletion is cancellable, user-bound, single-use and invalidates prior resume", async () => {
    const oldResume = button(await save(conversation), "Включить мониторинг");
    const old = button(await conversation.handle(1, 1, "/delete"), "Удалить мои данные");
    await conversation.handle(2, 2, old);
    await conversation.handle(1, 1, "/resume");
    expect((await store.getProfile(1))?.monitoring).toBe(false);
    await conversation.handle(1, 1, "/cancel");
    await conversation.handle(1, 1, old);
    expect(await store.getProfile(1)).not.toBeNull();
    const deletion = button(await conversation.handle(1, 1, "/delete"), "Удалить мои данные");
    await conversation.handle(1, 1, deletion);
    expect(await store.getProfile(1)).toBeNull();
    expect(await store.getDraft(1)).toBeNull();
    await save(conversation, "Honda");
    const recreated = await store.getProfile(1);
    await conversation.handle(1, 1, deletion);
    await conversation.handle(1, 1, oldResume);
    expect(await store.getProfile(1)).toEqual(recreated);
  });
  it("restores consented draft after repeated delete and cancel without accepting stale deletion", async () => {
    await begin(conversation);
    const original = await store.getDraft(1);
    const deletion = button(await conversation.handle(1, 1, "/delete"), "Удалить мои данные");
    await conversation.handle(1, 1, "/delete");
    await conversation.handle(1, 1, "/cancel");
    await conversation.handle(1, 1, deletion);
    expect(await store.getDraft(1)).toEqual(original);
    await conversation.handle(1, 1, "15000");
    const current = await conversation.handle(1, 1, "Toyota");
    await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.query).toBe("Toyota");
  });
  it("preserves quiet hours through edit and rejects invalid intervals", async () => {
    await save(conversation);
    await conversation.handle(1, 1, "/quiet 22:30-07:15");
    const quiet = await store.getProfile(1);
    expect([quiet?.quiet_start_minute, quiet?.quiet_end_minute]).toEqual([1350, 435]);
    for (const invalid of ["24:00-07:00", "23:00-23:00", "23:60-07:00", "7:00-09:00"]) {
      await conversation.handle(1, 1, `/quiet ${invalid}`);
      expect(await store.getProfile(1)).toEqual(quiet);
    }
    const current = await editModels("Honda");
    await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.quiet_start_minute).toBe(1350);
    await conversation.handle(1, 1, "/quiet off");
    expect((await store.getProfile(1))?.quiet_start_minute).toBeNull();
    expect((await store.getProfile(1))?.quiet_end_minute).toBeNull();
  });
  it("preserves optional values until deliberately cleared, rejecting malformed numeric/date/city input", async () => {
    let current = await review(conversation, "не знаю");
    for (const [label, value] of Object.entries({
      "Что входит": "total",
      Город: "Бишкек",
      Кузов: "suv",
      "Год от": "2015",
      "Пробег до": "90 000",
      Коробка: "automatic",
      "Для чего": "family",
      Готовность: "no",
      Планируемая: "29.02.2024",
    })) {
      await field(current, label);
      current = await conversation.handle(1, 1, value);
    }
    await conversation.handle(1, 1, button(current, "Сохранить"));
    const before = await store.getProfile(1);
    current = await editModels("Honda");
    for (const [label, invalid] of [
      ["Год от", "1899"],
      ["Пробег до", "-1"],
      ["Планируемая", "2025-02-29"],
      ["Город", "123 !!!"],
    ]) {
      await field(current, label!);
      const prompt = await conversation.handle(1, 1, invalid!);
      current = await conversation.handle(1, 1, button(prompt, "Назад"));
    }
    await conversation.handle(1, 1, button(current, "Сохранить"));
    const changed = await store.getProfile(1);
    for (const key of [
      "budget_scope",
      "city",
      "body_type",
      "year_min",
      "mileage_max_km",
      "transmission",
      "use_case",
      "allow_import",
      "purchase_by",
    ] as const)
      expect(changed?.[key]).toEqual(before?.[key]);
    expect(changed?.budget_max_minor).toBe(1_200_000);
    expect(changed?.purchase_by).toBe("2024-02-29");
    current = await conversation.handle(1, 1, "/edit");
    const city = await field(current, "Город");
    current = await conversation.handle(1, 1, button(city, "пропустить"));
    await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.city).toBe("");
    expect((await store.getProfile(1))?.body_type).toBe("suv");
  });
  it("currency correction requires new amount and back discards pending currency", async () => {
    let current = await review(conversation);
    const currencies = await field(current, "Валюта");
    const amount = await conversation.handle(1, 1, button(currencies, "KGS"));
    expect((await store.getDraft(1))?.[0]).toBe("budget");
    current = await conversation.handle(1, 1, button(amount, "Назад"));
    expect((await store.getDraft(1))?.[1].currency).toBe("USD");
    const again = await field(current, "Валюта");
    await conversation.handle(1, 1, button(again, "KGS"));
    current = await conversation.handle(1, 1, "1400000");
    expect(await store.getProfile(1)).toBeNull();
    await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.currency).toBe("KGS");
    expect((await store.getProfile(1))?.budget_max_minor).toBe(140_000_000);
  });
});

describe("search and safe rendering", () => {
  it("shows review corrections only after explicit save", async () => {
    store.listings = [
      car("toyota", "Toyota Camry", { city: "Бишкек" }),
      car("honda-local", "Honda Accord", { city: "Бишкек" }),
      car("honda-other", "Honda Accord", { city: "Ош" }),
    ];
    await save(conversation);
    let current = await editModels("Honda Accord", "15000");
    expect(
      (await conversation.handle(1, 1, "/search")).flatMap((reply) => reply.listingId ?? []),
    ).toEqual(["toyota"]);
    await field(current, "Город");
    current = await conversation.handle(1, 1, "Бишкек");
    expect(
      (await conversation.handle(1, 1, "/search")).flatMap((reply) => reply.listingId ?? []),
    ).toEqual(["toyota"]);
    const saved = await conversation.handle(1, 1, button(current, "Сохранить"));
    expect(saved.flatMap((reply) => reply.listingId ?? [])).toEqual(["honda-local"]);
  });
  it("offers enabled markets and preserves the selected foreign market through stale callbacks and cancel", async () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg,encar.com,truecar.com");
    store.listings = [
      car("local", "Hyundai"),
      car("korean", "Hyundai", {
        market: "KR",
        source: "encar.com",
        url: "https://fem.encar.com/cars/detail/1",
        original_currency: "KRW",
        original_price_minor: 18_000_000,
        fx_expires_at: Date.now() / 1000 + 3600,
      }),
      car("american", "Hyundai", { market: "US", source: "truecar.com", original_currency: "USD" }),
    ];
    let current = await review(conversation, "Hyundai");
    const markets = await field(current, "Рынок");
    const market = button(markets, "Корея");
    current = await conversation.handle(1, 1, market);
    const results = await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.market).toBe("KR");
    expect(results.flatMap((reply) => reply.listingId ?? [])).toEqual(["korean"]);
    const saved = await store.getProfile(1);
    await conversation.handle(1, 1, market);
    expect(await store.getProfile(1)).toEqual(saved);
    await conversation.handle(1, 1, "/resume");
    await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, market);
    expect((await store.getDraft(1))?.[0]).toBe("review");
    await conversation.handle(1, 1, "/cancel");
    expect((await store.getProfile(1))?.market).toBe("KR");
    expect((await store.getProfile(1))?.monitoring).toBe(false);
  });
  it("browses one vehicle and its photos in both directions and rejects stale pagination", async () => {
    store.listings = Array.from({ length: 7 }, (_, i) =>
      car(String(i), i < 3 ? "Toyota Camry" : "Honda Accord", {
        photo_url: `https://im.mashina.kg/images/${i}.jpg`,
      }),
    );
    store.listings.push(car("other", "Kia Rio"));
    let page = await save(conversation, "Toyota Camry, Honda Accord", 1, "KGS", "1000000");
    const firstNext = button(page, "Следующий");
    for (let index = 0; index < 7; index++) {
      expect(page.flatMap((reply) => (reply.listingId ? [reply.listingId] : []))).toEqual([
        String(index),
      ]);
      expect(page.flatMap((reply) => reply.photos ?? [])).toEqual([
        `https://im.mashina.kg/images/${index}.jpg`,
      ]);
      expect(
        page.flatMap((reply) => reply.buttons.flat()).some(([label]) => label === "Предыдущий"),
      ).toBe(index > 0);
      expect(
        page.flatMap((reply) => reply.buttons.flat()).some(([label]) => label === "Следующий"),
      ).toBe(index < 6);
      if (index < 6) page = await conversation.handle(1, 1, button(page, "Следующий"));
    }
    page = await new Conversation(store).handle(1, 1, button(page, "Предыдущий"));
    expect(page.at(-1)?.listingId).toBe("5");
    await conversation.handle(1, 1, "/quiet 22:00-07:00");
    expect((await conversation.handle(1, 1, firstNext)).some((reply) => reply.listingId)).toBe(
      false,
    );
  });
  it("never exposes a vehicle for invalid, cross-user or vanished pagination", async () => {
    store.listings = [car("first"), car("second")];
    const first = await save(conversation);
    const next = button(first, "Следующий");
    await save(conversation, "Toyota", 2);
    expect((await conversation.handle(2, 2, next)).some((reply) => reply.listingId)).toBe(false);
    const revision = (await store.getProfile(1))!.revision;
    for (const offset of ["-1", "1.5", "1000001", "9007199254740993"]) {
      const replies = await conversation.handle(1, 1, `page:${revision}:${offset}`);
      expect(replies.some((reply) => reply.listingId)).toBe(false);
    }
    store.listings.pop();
    expect((await conversation.handle(1, 1, next)).some((reply) => reply.listingId)).toBe(false);
    expect(button(await conversation.handle(1, 1, "/search"), "Изменить")).toBe("/edit");
  });
  it("unknown model removes only model filter, not the budget", async () => {
    store.listings = [
      car("affordable", "Honda Fit"),
      car("expensive", "Toyota", { price_usd_minor: 2_000_000 }),
    ];
    const replies = await save(conversation, "");
    expect((await store.getProfile(1))?.query).toBe("");
    expect(replies.flatMap((reply) => reply.listingId ?? [])).toEqual(["affordable"]);
    expect((await store.getProfile(1))?.monitoring).toBe(false);
  });
  it("escapes free text in both review and saved profile", async () => {
    let current = await review(conversation, "<b>Toyota</b>");
    await field(current, "Город");
    current = await conversation.handle(1, 1, "<i>Бишкек</i>");
    await conversation.handle(1, 1, button(current, "Сохранить"));
    for (const output of [
      rendered(current),
      rendered(await conversation.handle(1, 1, "/profile")),
    ]) {
      expect(output).toContain("&lt;b&gt;Toyota&lt;/b&gt;");
      expect(output).toContain("&lt;i&gt;Бишкек&lt;/i&gt;");
      expect(output).not.toContain("<i>Бишкек</i>");
    }
  });
  it("renders actual observation time, allowed links only, and international auction warnings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const item = car("auction", "<script>evil</script>", {
      url: "https://attacker.invalid/",
      market: "US",
      source: "bid.cars",
      observed_at: Date.parse("2026-09-09T18:00:00Z") / 1000,
      original_currency: "USD",
      price_kind: "auction",
      auction_status: "ended",
      auction_house: "Copart",
      current_bid_minor: 0,
      final_bid_minor: 1_000_000,
      estimated_min_minor: 1_000_000,
      estimated_max_minor: 2_000_000,
      condition: "<b>unknown</b>",
      published_at: "yesterday",
    });
    const output = listingText(item, "USD");
    expect(output).not.toContain("<a href=");
    expect(output).not.toContain("<script>");
    expect(output).toContain("10.09.2026 00:00");
    expect(output).not.toContain("yesterday");
    expect(output).toContain("не цена покупки");
    expect(output).toContain("не предложение");
    expect(output).toContain("Доставка, таможня");
    expect(output).toContain("Buy Now");
    expect(output).toContain("&lt;b&gt;unknown&lt;/b&gt;");
  });
  it("does not invent conversion for expired Korean prices", () => {
    const output = listingText(
      car("kr", "Hyundai", {
        market: "KR",
        source: "encar.com",
        original_currency: "KRW",
        original_price_minor: 1_000_000,
        fx_expires_at: 1,
      }),
      "USD",
    );
    expect(output).toContain("1 000 000 KRW");
    expect(output).toContain("пересчёт");
    expect(output).not.toContain("по НБКР");
  });
  it("keeps full escaped descriptions and vehicle details across message boundaries", () => {
    const description = '<script>unsafe & "quoted"</script>\n'.repeat(300) + "Описание до конца";
    const item = car("full", "Полное название ".repeat(20), {
      condition: "<b>Состояние со слов продавца</b>",
      description,
      vin: "VIN<123>",
      sale_document: "Документы & ограничения",
      primary_damage: "Передняя часть",
      secondary_damage: "Задняя часть",
      start_code: "Запуск не проверен",
    });
    const replies = listingReplies(item, "USD", [[["Далее", "page:revision:1"]]]);
    const output = replies.map((reply) => reply.text.replace(/<[^>]+>/g, "")).join("");
    expect(output).toContain(item.title);
    expect(output).toContain("&lt;b&gt;Состояние со слов продавца&lt;/b&gt;");
    expect(output).toContain("Описание до конца");
    expect(output).toContain("VIN&lt;123&gt;");
    expect(output).toContain("Документы &amp; ограничения");
    for (const value of [item.primary_damage, item.secondary_damage, item.start_code])
      expect(output).toContain(value);
    expect(output).not.toContain("<script>");
    expect(replies.every((reply) => reply.text.length <= 3800)).toBe(true);
    expect(
      replies.slice(0, -1).every((reply) => !reply.listingId && reply.buttons.length === 0),
    ).toBe(true);
    expect(replies.at(-1)?.listingId).toBe(item.id);
    expect(
      replies.map((reply) => reply.richHtml!.replace(/<[^>]+>/g, "").replace(/\s/g, "")).join(""),
    ).toBe(replies.map((reply) => reply.text.replace(/<[^>]+>/g, "").replace(/\s/g, "")).join(""));
  });
  it("packs oversized HTML safely without losing text and attaches buttons only to the last message", () => {
    const text = "Текст &amp; &lt;машина&gt; ".repeat(600);
    const replies = packReplies("<b>Заголовок</b>", [`<b>${text}</b>`], [[["Поиск", "/search"]]]);
    expect(replies.every((reply) => reply.text.length <= 3800)).toBe(true);
    expect(replies.slice(0, -1).every((reply) => reply.buttons.length === 0)).toBe(true);
    expect(replies.at(-1)?.buttons[0]?.[0]?.[1]).toBe("/search");
    for (const reply of replies) {
      expect((reply.text.match(/<b>/g) ?? []).length).toBe(
        (reply.text.match(/<\/b>/g) ?? []).length,
      );
      expect(reply.text.replace(/&(?:amp|lt|gt);/g, "")).not.toContain("&");
    }
    expect(replies.map((reply) => reply.text.replace(/<[^>]+>/g, "")).join("")).toBe(
      `Заголовок${text}`,
    );
  });
});

describe("grammY transport boundaries", () => {
  const identity = {
    id: 100,
    is_bot: true as const,
    first_name: "Autodom",
    username: "autodom_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  function telegram(
    checkVin?: VinLookup,
    checkVinArchive?: VinArchiveLookup,
    getVinArchivePhoto?: VinArchivePhotoLookup,
  ) {
    const bot = createTelegramBot(store as unknown as Store, "100:test-token", {
      ...(checkVin ? { checkVin } : {}),
      ...(checkVinArchive ? { checkVinArchive } : {}),
      ...(getVinArchivePhoto ? { getVinArchivePhoto } : {}),
    });
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as unknown as Record<string, unknown> });
      const result =
        method === "getMe"
          ? identity
          : method === "getWebhookInfo"
            ? { url: "", pending_update_count: 0 }
            : true;
      return { ok: true, result } as never;
    });
    return { bot, calls };
  }
  async function uploadedBytes(photo: unknown): Promise<unknown> {
    expect(photo).toBeInstanceOf(InputFile);
    return (photo as InputFile).toRaw();
  }
  it("acknowledges archive clicks during photo delivery without overlapping the searches", async () => {
    const vin = "WBA51AG03NCK98884";
    const archive = vi.fn<VinArchiveLookup>(async () => ({
      vin,
      checked_at: 1_789_000_000,
      coverage: "indexed_lots_only",
      sources: [],
    }));
    const { bot, calls } = telegram(
      async () => ({
        vin,
        checked_at: 1_789_000_000,
        carhistory: { status: "disabled", source_url: "", checked_at: null },
        car365: { status: "disabled", source_url: "", checked_at: null, data: null },
        encar: {
          status: "available",
          source_url: "https://fem.encar.com/",
          checked_at: 1_789_000_000,
          data: {
            vin,
            discovery_url: `https://carcheck.by/auto/${vin}`,
            partial: false,
            listings: [
              {
                id: "39720103",
                vin,
                source_url: "https://fem.encar.com/cars/detail/39720103",
                model: "BMW",
                mileage_km: null,
                advertisement_status: "SOLD",
                created_at: null,
                first_advertised_at: null,
                modified_at: null,
                re_registered: null,
                photo_urls: [
                  "https://ci.encar.com/carpicture/carpicture02/pic3972/39720103_001.jpg",
                ],
              },
            ],
          },
        },
      }),
      archive,
    );
    const photoEntered = Promise.withResolvers<void>();
    const photoReleased = Promise.withResolvers<void>();
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendPhoto") {
        photoEntered.resolve();
        await photoReleased.promise;
      }
      return previous(method, payload, signal);
    });
    await bot.init();
    const message = {
      message_id: 1,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Buyer" },
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    const vinWork = bot.handleUpdate({
      update_id: 1,
      message: { ...message, text: `/vin ${vin}` },
    });
    await photoEntered.promise;
    const archiveWork = bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "archive-during-photo",
        from: message.from,
        chat_instance: "private",
        message,
        data: `vinarchive:${vin}`,
      },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls.filter((call) => call.method === "answerCallbackQuery")).toEqual([
        {
          method: "answerCallbackQuery",
          payload: { callback_query_id: "archive-during-photo" },
        },
      ]);
      expect(archive).not.toHaveBeenCalled();
    } finally {
      photoReleased.resolve();
      await Promise.all([vinWork, archiveWork]);
    }
    expect(archive).toHaveBeenCalledExactlyOnceWith(vin);
  });

  it("requires a valid owner callback before archive lookup and keeps all photos separated by lot", async () => {
    const vin = "KMHDU41DBAU123456";
    const firstPhotos = Array.from(
      { length: 12 },
      (_, index) => `https://cs.copart.com/v1/AUTH_svc.pdoc00001/first/${index}.jpg`,
    );
    const secondPhoto = "https://cs.copart.com/v1/AUTH_svc.pdoc00001/second/0.jpg";
    const result: VinArchiveResult = {
      vin,
      checked_at: 1_789_000_000,
      coverage: "indexed_lots_only",
      sources: [
        {
          provider: "copart",
          status: "available",
          source_url: "https://www.copart.com/",
          checked_at: 1_789_000_000,
          partial: false,
          lots: [
            {
              auction: "copart",
              lot_id: "12345678",
              source_url: "https://www.copart.com/lot/12345678",
              events: [
                { status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: null },
              ],
              photos: firstPhotos,
              photos_complete: true,
            },
            {
              auction: "copart",
              lot_id: "23456789",
              source_url: "https://www.copart.com/lot/23456789",
              events: [
                { status: "sold", auction_at: null, auction_date: null, final_bid_usd_minor: null },
              ],
              photos: [secondPhoto],
              photos_complete: true,
            },
          ],
        },
        {
          provider: "bidcars",
          status: "available",
          source_url: "https://bid.cars/",
          checked_at: 1_789_000_000,
          partial: false,
          lots: [
            {
              auction: "copart",
              lot_id: "12345678",
              source_url: `https://bid.cars/en/lot/1-12345678/2011-Hyundai-Elantra-${vin}`,
              events: [
                {
                  status: "ended",
                  auction_at: null,
                  auction_date: "2026-08-01",
                  final_bid_usd_minor: 1250000,
                },
              ],
              photos: [`https://mercury.bid.cars/1-12345678/2011-Hyundai-Elantra-${vin}-1.jpg`],
              photos_complete: true,
            },
          ],
        },
      ],
    };
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<VinArchiveResult>();
    const archive = vi.fn<VinArchiveLookup>(async () => {
      entered.resolve();
      return released.promise;
    });
    const firstBytes = firstPhotos.map((_, index) => new Uint8Array([255, 216, index, 255, 217]));
    const secondBytes = new Uint8Array([255, 216, 99, 255, 217]);
    const { bot, calls } = telegram(
      async () => ({
        vin,
        checked_at: 1_789_000_000,
        carhistory: { status: "disabled", source_url: "", checked_at: null },
        car365: { status: "disabled", source_url: "", checked_at: null, data: null },
      }),
      archive,
      async (request) => {
        if (request.vin !== vin || request.provider !== "copart" || request.auction !== "copart")
          throw new Error("Unknown archive photo");
        const index = firstPhotos.indexOf(request.photo_url);
        const bytes =
          request.lot_id === "12345678" && index !== -1
            ? firstBytes[index]
            : request.lot_id === "23456789" && request.photo_url === secondPhoto
              ? secondBytes
              : undefined;
        if (!bytes) throw new Error("Unknown archive photo");
        return { bytes, content_type: "image/jpeg" };
      },
    );
    await bot.init();
    const message = {
      message_id: 1,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Buyer" },
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    await bot.handleUpdate({ update_id: 1, message: { ...message, text: `/vin ${vin}` } });
    expect(archive).not.toHaveBeenCalled();
    const archiveMessage = calls.at(-1)?.payload.rich_message;
    if (
      !archiveMessage ||
      typeof archiveMessage !== "object" ||
      !("html" in archiveMessage) ||
      typeof archiveMessage.html !== "string"
    )
      throw new Error("Expected rich archive actions");
    const archiveControls = load(archiveMessage.html);
    expect(archiveControls(`tg-button[data="vinarchive:${vin}"]`)).toHaveLength(1);
    for (const [data, from] of [
      ["vinarchive:invalid", message.from],
      [`vinarchive:${vin}`, { ...message.from, id: 2 }],
    ] as const) {
      await bot.handleUpdate({
        update_id: 2,
        callback_query: { id: "invalid", from, chat_instance: "private", message, data },
      });
    }
    expect(archive).not.toHaveBeenCalled();
    const work = bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "archive",
        from: message.from,
        chat_instance: "private",
        message,
        data: `vinarchive:${vin}`,
      },
    });
    await entered.promise;
    expect(calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "archive" },
    });
    released.resolve(result);
    await work;
    const albums = await Promise.all(
      calls
        .filter((call) => call.method === "sendMediaGroup")
        .map((call) =>
          Promise.all(
            (call.payload.media as { media: unknown }[]).map((photo) => uploadedBytes(photo.media)),
          ),
        ),
    );
    expect(albums).toEqual([firstBytes.slice(0, 10), firstBytes.slice(10)]);
    expect(
      await Promise.all(
        calls
          .filter((call) => call.method === "sendPhoto")
          .map((call) => uploadedBytes(call.payload.photo)),
      ),
    ).toEqual([secondBytes]);
    const archiveText = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .join("\n");
    expect(archiveText).toContain("2026-08-01");
    expect(await store.getProfile(1)).toBeNull();
  });

  it.each(["missing", "expired"] as const)(
    "retains proven events when the photo loader is %s",
    async (failure) => {
      const vin = "KMHDU41DBAU123456";
      const photo = "https://cs.copart.com/v1/AUTH_svc.pdoc00001/expired.jpg";
      const sourceUrl = "https://www.copart.com/lot/12345678";
      const lookup: VinArchiveLookup = async () => ({
        vin,
        checked_at: 1_789_000_000,
        coverage: "indexed_lots_only",
        sources: [
          {
            provider: "copart",
            status: "available",
            source_url: "https://www.copart.com/",
            checked_at: 1_789_000_000,
            partial: false,
            lots: [
              {
                auction: "copart",
                lot_id: "12345678",
                source_url: sourceUrl,
                events: [
                  {
                    status: "sold",
                    auction_at: null,
                    auction_date: null,
                    final_bid_usd_minor: null,
                  },
                ],
                photos: [photo],
                photos_complete: true,
              },
            ],
          },
        ],
      });
      const { bot, calls } = telegram(
        undefined,
        lookup,
        failure === "expired"
          ? async () => {
              throw new Error("Photo grant expired");
            }
          : undefined,
      );
      await bot.init();
      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "archive",
          from: { id: 1, is_bot: false, first_name: "Buyer" },
          chat_instance: "private",
          data: `vinarchive:${vin}`,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private", first_name: "Buyer" },
          },
        },
      });
      const fallback = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text))
        .join("\n");
      expect(fallback).toContain("12345678");
      expect(calls.filter((call) => ["sendPhoto", "sendMediaGroup"].includes(call.method))).toEqual(
        [],
      );
    },
  );
  it.each(["download", "upload"] as const)(
    "delivers remaining archive photos after a partial %s failure without losing events",
    async (failure) => {
      const vin = "KMHDU41DBAU123456";
      const photos = Array.from(
        { length: 4 },
        (_, index) => `https://cs.copart.com/v1/AUTH_svc.pdoc00001/partial/${index}.jpg`,
      );
      const bytes = photos.map((_, index) => new Uint8Array([255, 216, index, 255, 217]));
      const sourceUrl = "https://www.copart.com/lot/12345678";
      const { bot, calls } = telegram(
        undefined,
        async () => ({
          vin,
          checked_at: 1_789_000_000,
          coverage: "indexed_lots_only",
          sources: [
            {
              provider: "copart",
              status: "available",
              source_url: "https://www.copart.com/",
              checked_at: 1_789_000_000,
              partial: false,
              lots: [
                {
                  auction: "copart",
                  lot_id: "12345678",
                  source_url: sourceUrl,
                  events: [
                    {
                      status: "sold",
                      auction_at: null,
                      auction_date: null,
                      final_bid_usd_minor: null,
                    },
                  ],
                  photos,
                  photos_complete: true,
                },
              ],
            },
          ],
        }),
        async (request) => {
          const index = photos.indexOf(request.photo_url);
          if (index < 0 || (failure === "download" && index === 1))
            throw new Error("Photo unavailable");
          return { bytes: bytes[index]!, content_type: "image/jpeg" };
        },
      );
      if (failure === "upload") {
        bot.api.config.use(async (previous, method, payload, signal) => {
          let rejected = method === "sendMediaGroup";
          if (method === "sendPhoto" && "photo" in payload && payload.photo instanceof InputFile) {
            const raw = await payload.photo.toRaw();
            rejected = raw instanceof Uint8Array && raw[2] === 1;
          }
          if (rejected)
            return { ok: false, error_code: 400, description: "Bad Request: IMAGE_PROCESS_FAILED" };
          return previous(method, payload, signal);
        });
      }
      await bot.init();
      await bot.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "archive",
          from: { id: 1, is_bot: false, first_name: "Buyer" },
          chat_instance: "private",
          data: `vinarchive:${vin}`,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private", first_name: "Buyer" },
          },
        },
      });
      const delivered = calls.flatMap((call) =>
        call.method === "sendMediaGroup"
          ? (call.payload.media as { media: unknown }[]).map((photo) => photo.media)
          : call.method === "sendPhoto"
            ? [call.payload.photo]
            : [],
      );
      expect(await Promise.all(delivered.map(uploadedBytes))).toEqual([
        bytes[0],
        bytes[2],
        bytes[3],
      ]);
      const text = calls
        .filter((call) => call.method === "sendMessage")
        .map((call) => String(call.payload.text))
        .join("\n");
      expect(text).toContain("12345678");
    },
  );

  it("checks VIN only for its private owner without changing buyer preferences or requiring a profile", async () => {
    const checkVin = vi.fn<VinLookup>(async (vin) => ({
      vin,
      checked_at: 1_789_000_000,
      carhistory: {
        status: "not_found",
        source_url: "https://www.carhistory.or.kr/",
        checked_at: 1_789_000_000,
      },
      car365: {
        status: "disabled",
        source_url: "https://www.car365.go.kr/",
        checked_at: null,
        data: null,
      },
    }));
    const { bot, calls } = telegram(checkVin);
    await bot.init();
    await begin(conversation);
    const draft = await store.getDraft(1);
    const message = {
      message_id: 1,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Buyer" },
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    for (const text of ["/vin", "/vin invalid", "/vin@another_bot KMHDU41DBAU123456"]) {
      await bot.handleUpdate({ update_id: 1, message: { ...message, text } });
    }
    await bot.handleUpdate({
      update_id: 2,
      message: {
        ...message,
        chat: { id: -100, type: "group", title: "Group" },
        text: "/vin KMHDU41DBAU123456",
      },
    });
    await bot.handleUpdate({
      update_id: 3,
      message: { ...message, chat: { ...message.chat, id: 2 }, text: "/vin KMHDU41DBAU123456" },
    });
    expect(checkVin).not.toHaveBeenCalled();
    await bot.handleUpdate({
      update_id: 4,
      message: { ...message, text: "/vin@autodom_test_bot kmhdu41dbau123456" },
    });
    expect(checkVin).toHaveBeenCalledExactlyOnceWith("KMHDU41DBAU123456");
    expect(await store.getProfile(1)).toBeNull();
    expect(await store.getDraft(1)).toEqual(draft);
    const rich = calls.at(-1)?.payload.rich_message as { html: string };
    expect(load(rich.html)('tg-button[type="url"]').attr("url")).toBe(
      "https://www.google.com/search?q=%22KMHDU41DBAU123456%22",
    );
    await bot.handleUpdate({ update_id: 5, message: { ...message, text: "/help" } });
    expect(String(calls.at(-1)?.payload.text)).toContain("/search");
    expect(checkVin).toHaveBeenCalledTimes(1);
  });
  it("accepts an exact VIN without requiring a buyer profile", async () => {
    const { bot, calls } = telegram();
    await bot.init();
    const message = {
      message_id: 1,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Buyer" },
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    await bot.handleUpdate({
      update_id: 1,
      message: { ...message, text: "/vin KMHDU41DBAU123456" },
    });
    expect(String(calls.at(-1)?.payload.text)).toMatch(/не подключена/);
    expect(calls.at(-1)?.payload.reply_markup).toBeUndefined();
    expect(await store.getDraft(1)).toBeNull();
    const checkVin = vi.fn<VinLookup>();
    const enabled = telegram(checkVin);
    await enabled.bot.init();
    await enabled.bot.handleUpdate({
      update_id: 2,
      message: { ...message, text: "KMHDU41DBAU123456" },
    });
    expect(checkVin).toHaveBeenCalledExactlyOnceWith("KMHDU41DBAU123456");
  });
  it("reports remote failure as unknown without exposing secrets or disturbing search", async () => {
    const { bot, calls } = telegram(async () => {
      throw new Error("private-api-token");
    });
    await bot.init();
    await begin(conversation);
    const draft = await store.getDraft(1);
    const message = {
      message_id: 1,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Buyer" },
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    await bot.handleUpdate({
      update_id: 1,
      message: { ...message, text: "/vin KMHDU41DBAU123456" },
    });
    const text = String(calls.at(-1)?.payload.text);
    expect(text).toMatch(/неизвестен/);
    expect(text).not.toContain("private-api-token");
    expect(calls.at(-1)?.payload.reply_markup).toBeUndefined();
    expect(await store.getDraft(1)).toEqual(draft);
    await bot.handleUpdate({ update_id: 2, message: { ...message, text: "/help" } });
    expect(String(calls.at(-1)?.payload.text)).toContain("/search");
  });
  it.each(["rich", "legacy"] as const)(
    "delivers long VIN results in %s mode without losing ads, controls or literal data",
    async (mode) => {
      const literal = "<literal & data>".repeat(32);
      const { bot, calls } = telegram(async (vin) => ({
        vin,
        checked_at: 1_789_000_000,
        carhistory: { status: "disabled", source_url: "", checked_at: null },
        car365: { status: "disabled", source_url: "", checked_at: null, data: null },
        encar: {
          status: "available",
          source_url: "https://fem.encar.com",
          checked_at: 1_789_000_000,
          data: {
            vin,
            discovery_url: `https://carcheck.by/auto/${vin}`,
            partial: true,
            listings: Array.from({ length: 5 }, (_, index) => ({
              id: String(39720103 + index),
              vin,
              source_url: `https://fem.encar.com/cars/detail/${39720103 + index}`,
              model: `Ad ${index}: ${"<Encar & record>".repeat(20)}`,
              mileage_km: 10000 + index,
              advertisement_status: "SOLD" as const,
              created_at: `2024-05-0${index + 1}T11:12:13`,
              first_advertised_at: null,
              modified_at: null,
              re_registered: false,
              photo_urls: [
                `https://ci.encar.com/carpicture/carpicture07/pic3972/${39720103 + index}_001.jpg`,
              ],
            })),
          },
        },
        autodev: {
          status: "available",
          source_url: "https://docs.auto.dev/v2/products/vin-decode",
          checked_at: 1_789_000_000,
          data: {
            vin,
            make: literal,
            model: literal,
            model_year: 2010,
            trim: literal,
            body_class: literal,
            engine: literal,
            drive: literal,
            transmission: literal,
            origin_country: literal,
            ambiguous: false,
          },
        },
      }));
      if (mode === "legacy") {
        bot.api.config.use(async (previous, method, payload, signal) =>
          method === "sendRichMessage"
            ? { ok: false, error_code: 404, description: "Not Found" }
            : previous(method, payload, signal),
        );
      }
      await bot.init();
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          from: { id: 1, is_bot: false, first_name: "Buyer" },
          chat: { id: 1, type: "private", first_name: "Buyer" },
          text: "/vin KMHDU41DBAU123456",
        },
      });
      const sent = calls.filter(
        (call) => call.method === "sendMessage" || call.method === "sendRichMessage",
      );
      const html = sent
        .map((call) => {
          if (call.method === "sendRichMessage") {
            const rich = call.payload.rich_message as { html: string };
            expect(Buffer.byteLength(rich.html, "utf8")).toBeLessThanOrEqual(32768);
            return rich.html;
          }
          expect(String(call.payload.text).length).toBeLessThanOrEqual(4096);
          expect(call.payload.parse_mode).toBe("HTML");
          return String(call.payload.text);
        })
        .join("");
      const rendered = load(html);
      expect(rendered("literal, encar")).toHaveLength(0);
      expect(
        rendered
          .root()
          .text()
          .match(/<literal & data>/g),
      ).toHaveLength(32 * 8);
      expect(
        rendered
          .root()
          .text()
          .match(/<Encar & record>/g),
      ).toHaveLength(5 * 20);
      for (let index = 0; index < 5; index += 1) {
        expect(html).toContain(String(39720103 + index));
        expect(html).toContain(`2024-05-0${index + 1}T11:12:13`);
      }
      if (mode === "rich") {
        expect(rendered('tg-button[type="url"], tg-button[type="web_app"]')).toHaveLength(0);
        expect(rendered('tg-button[type="callback_data"]').attr("data")).toBe("vin-report-example");
        expect(sent.every((call) => call.payload.reply_markup === undefined)).toBe(true);
      } else {
        expect(sent.slice(0, -1).every((call) => call.payload.reply_markup === undefined)).toBe(
          true,
        );
        expect(sent.at(-1)?.payload.reply_markup).toMatchObject({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                callback_data: "vin-report-example",
              }),
            ]),
          ]),
        });
        expect(JSON.stringify(sent.at(-1)?.payload.reply_markup)).not.toMatch(
          /vinarchive:|google\.com|web_app/,
        );
      }
    },
  );
  it("keeps VIN photo albums bound to their verified advertisements across Telegram batch boundaries", async () => {
    const photo = (id: string, index: number) =>
      `https://ci.encar.com/carpicture/carpicture02/pic3972/${id}_${String(index).padStart(3, "0")}.jpg`;
    const firstPhotos = Array.from({ length: 21 }, (_, index) => photo("39720103", index + 1));
    const secondPhotos = [photo("39720104", 1), photo("39720104", 2)];
    const { bot, calls } = telegram(async (vin) => {
      const listing = {
        id: "39720103",
        vin,
        source_url: "https://fem.encar.com/cars/detail/39720103",
        model: "BMW",
        mileage_km: null,
        advertisement_status: "SOLD" as const,
        created_at: null,
        first_advertised_at: null,
        modified_at: null,
        re_registered: null,
        photo_urls: firstPhotos,
      };
      return {
        vin,
        checked_at: 1_789_000_000,
        carhistory: { status: "disabled", source_url: "", checked_at: null },
        car365: { status: "disabled", source_url: "", checked_at: null, data: null },
        encar: {
          status: "available",
          source_url: "https://fem.encar.com/",
          checked_at: 1_789_000_000,
          data: {
            vin,
            discovery_url: `https://carcheck.by/auto/${vin}`,
            partial: true,
            listings: [
              {
                ...listing,
                photo_urls: [
                  ...firstPhotos,
                  photo("39720103", 1),
                  "https://attacker.invalid/photo.jpg",
                  photo("39720104", 1),
                ],
              },
              { ...listing, id: "39720104", photo_urls: secondPhotos },
              {
                ...listing,
                id: "39720105",
                vin: "WBA51AG03NCK98884",
                photo_urls: [photo("39720105", 1)],
              },
              listing,
            ],
          },
        },
      };
    });
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: { id: 1, is_bot: false, first_name: "Buyer" },
        chat: { id: 1, type: "private", first_name: "Buyer" },
        text: "/vin KMHDU41DBAU123456",
      },
    });
    const albums = calls
      .filter((call) => call.method === "sendPhoto" || call.method === "sendMediaGroup")
      .map((call) =>
        call.method === "sendPhoto"
          ? [String(call.payload.photo)]
          : (call.payload.media as { media: string }[]).map((item) => item.media),
      );
    expect(albums.map((album) => album.length)).toEqual([10, 10, 1, 2]);
    expect(albums.flat()).toEqual([...firstPhotos, ...secondPhotos]);
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain(
      "KMHDU41DBAU123456",
    );
  });
  it("rejects a result for another VIN before attributing its photographs to the requested car", async () => {
    const otherVin = "WBA51AG03NCK98884";
    const { bot, calls } = telegram(async () => ({
      vin: otherVin,
      checked_at: 1_789_000_000,
      carhistory: { status: "disabled", source_url: "", checked_at: null },
      car365: { status: "disabled", source_url: "", checked_at: null, data: null },
      encar: {
        status: "available",
        source_url: "https://fem.encar.com/",
        checked_at: 1_789_000_000,
        data: {
          vin: otherVin,
          discovery_url: `https://carcheck.by/auto/${otherVin}`,
          partial: false,
          listings: [
            {
              id: "39720103",
              vin: otherVin,
              source_url: "https://fem.encar.com/cars/detail/39720103",
              model: "BMW",
              mileage_km: null,
              advertisement_status: "SOLD",
              created_at: null,
              first_advertised_at: null,
              modified_at: null,
              re_registered: null,
              photo_urls: ["https://ci.encar.com/carpicture/carpicture02/pic3972/39720103_001.jpg"],
            },
          ],
        },
      },
    }));
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: { id: 1, is_bot: false, first_name: "Buyer" },
        chat: { id: 1, type: "private", first_name: "Buyer" },
        text: "/vin KMHDU41DBAU123456",
      },
    });
    expect(
      calls.filter((call) => call.method === "sendPhoto" || call.method === "sendMediaGroup"),
    ).toEqual([]);
    const text = calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => String(call.payload.text))
      .join("\n");
    expect(text).not.toContain(otherVin);
    expect(text).toContain("Результат неизвестен");
  });
  it("refuses an existing webhook without replacing it or registering commands", async () => {
    const { bot, calls } = telegram();
    bot.api.config.use(async (previous, method, payload, signal) =>
      method === "getWebhookInfo"
        ? ({
            ok: true,
            result: { url: "https://existing.invalid", pending_update_count: 0 },
          } as never)
        : previous(method, payload, signal),
    );
    await expect(configureTelegramBot(bot, new AbortController().signal)).rejects.toThrow(
      /webhook/,
    );
    expect(
      calls.some((call) => ["deleteWebhook", "setWebhook", "setMyCommands"].includes(call.method)),
    ).toBe(false);
  });
  it("ignores group messages and rejects foreign callbacks without disclosing a profile", async () => {
    const { bot, calls } = telegram();
    await bot.init();
    const from = { id: 1, is_bot: false, first_name: "Buyer" };
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from,
        chat: { id: -100, type: "group", title: "Group" },
        text: "/start",
      },
    });
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "foreign",
        from,
        chat_instance: "one",
        data: "/profile",
        message: { message_id: 2, date: 1, chat: { id: 2, type: "private", first_name: "Other" } },
      },
    });
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
    expect(
      calls.some(
        (call) =>
          call.method === "answerCallbackQuery" && call.payload.callback_query_id === "foreign",
      ),
    ).toBe(true);
  });
  it("preserves currency and budget input order during a slow acknowledgement without blocking another user", async () => {
    const { bot, calls } = telegram();
    await bot.init();
    const from = { id: 1, is_bot: false, first_name: "Buyer" };
    const message = {
      message_id: 1,
      date: 1,
      from,
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
    };
    function action(label: string): string {
      const markup = calls.findLast(
        (call) => call.method === "sendMessage" && call.payload.chat_id === 1,
      )?.payload.reply_markup as
        | { inline_keyboard: { text: string; callback_data?: string }[][] }
        | undefined;
      const choice = markup?.inline_keyboard.flat().find((item) => item.text.includes(label));
      if (!choice?.callback_data) throw new Error(`Button not found: ${label}`);
      return choice.callback_data;
    }
    await bot.handleUpdate({ update_id: 1, message: { ...message, text: "/buy" } });
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "consent",
        from,
        chat_instance: "one",
        data: action("Согласен"),
        message,
      },
    });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (
        method === "answerCallbackQuery" &&
        "callback_query_id" in payload &&
        payload.callback_query_id === "currency"
      ) {
        entered.resolve();
        await gate.promise;
      }
      return previous(method, payload, signal);
    });
    const currency = bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "currency",
        from,
        chat_instance: "one",
        data: action("USD"),
        message,
      },
    });
    await entered.promise;
    const budget = bot.handleUpdate({
      update_id: 4,
      message: { ...message, text: "15000" },
    });
    try {
      await bot.handleUpdate({
        update_id: 5,
        message: {
          ...message,
          from: { ...from, id: 2 },
          chat: { ...message.chat, id: 2 },
          text: "/privacy",
        },
      });
      expect(
        calls.some((call) => call.method === "sendMessage" && call.payload.chat_id === 2),
      ).toBe(true);
    } finally {
      gate.resolve();
      await Promise.all([currency, budget]);
    }
    await bot.handleUpdate({
      update_id: 6,
      message: { ...message, text: "Toyota Camry" },
    });
    await bot.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "save",
        from,
        chat_instance: "one",
        data: action("Сохранить без"),
        message,
      },
    });
    expect(await store.getProfile(1)).toMatchObject({
      currency: "USD",
      budget_max_minor: 1_500_000,
      query: "Toyota Camry",
    });
  });
});
