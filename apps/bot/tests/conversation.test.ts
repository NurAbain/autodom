import { type Listing, makeListing, matches, type Profile } from "@autodom/core";
import type { VinLookup } from "@autodom/core/vin";
import type { Store } from "@autodom/storage";
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
  const privacy = await conversation.handle(user, user, "/start");
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
async function save(
  conversation: Conversation,
  query = "Toyota Camry",
  user = 1,
  currency = "USD",
  budget = "15000",
) {
  const replies = await review(conversation, query, user, currency, budget);
  return conversation.handle(user, user, button(replies, "Сохранить"));
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
let store: InteractionStore;
let conversation: Conversation;
beforeEach(() => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  store = new InteractionStore();
  conversation = new Conversation(store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("explicit consent and save safety", () => {
  it("persists nothing before current explicit consent, including on restart", async () => {
    const old = button(await conversation.handle(1, 1, "/start"), "Согласен");
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
      const currencies = await conversation.handle(1, 1, "/edit");
      const original = await store.getProfile(1);
      await conversation.handle(1, 1, button(currencies, "KGS"));
      await conversation.handle(1, 1, "1000000");
      await conversation.handle(1, 1, invalid);
      expect(await store.getProfile(1)).toEqual(original);
      expect((await store.getDraft(1))?.[0]).toBe("query");
    },
  );
  it("binds review choices to user, current prompt and a single save, surviving restart", async () => {
    const first = await review(conversation, "Toyota");
    const oldSave = button(first, "Сохранить");
    const oldCity = button(first, "Город");
    const city = await conversation.handle(1, 1, oldCity);
    const current = await store.getDraft(1);
    for (const stale of [oldSave, oldCity, oldCity.replace(":review:", ":city:")]) {
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
      button(await conversation.handle(1, 1, "/start"), "Согласен"),
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
        await conversation.handle(1, 1, button(current, "Город"));
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
    const currencies = await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, button(currencies, "USD"));
    await conversation.handle(1, 1, "12000");
    const current = await conversation.handle(1, 1, "Honda");
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
      await conversation.handle(1, 1, button(current, label));
      current = await conversation.handle(1, 1, value);
    }
    await conversation.handle(1, 1, button(current, "Сохранить"));
    const before = await store.getProfile(1);
    const currencies = await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, button(currencies, "USD"));
    await conversation.handle(1, 1, "12000");
    current = await conversation.handle(1, 1, "Honda");
    for (const [label, invalid] of [
      ["Год от", "1899"],
      ["Пробег до", "-1"],
      ["Планируемая", "2025-02-29"],
      ["Город", "123 !!!"],
    ]) {
      await conversation.handle(1, 1, button(current, label!));
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
    const next = await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, button(next, "USD"));
    await conversation.handle(1, 1, "12000");
    current = await conversation.handle(1, 1, "Honda");
    const city = await conversation.handle(1, 1, button(current, "Город"));
    current = await conversation.handle(1, 1, button(city, "пропустить"));
    await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.city).toBe("");
    expect((await store.getProfile(1))?.body_type).toBe("suv");
  });
  it("currency correction requires new amount and back discards pending currency", async () => {
    let current = await review(conversation);
    const currencies = await conversation.handle(1, 1, button(current, "Валюта"));
    const amount = await conversation.handle(1, 1, button(currencies, "KGS"));
    expect((await store.getDraft(1))?.[0]).toBe("budget");
    current = await conversation.handle(1, 1, button(amount, "Назад"));
    expect((await store.getDraft(1))?.[1].currency).toBe("USD");
    const again = await conversation.handle(1, 1, button(current, "Валюта"));
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
    const currencies = await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, button(currencies, "USD"));
    await conversation.handle(1, 1, "15000");
    let current = await conversation.handle(1, 1, "Honda Accord");
    expect(rendered(await conversation.handle(1, 1, "/search"))).toContain("/toyota");
    await conversation.handle(1, 1, button(current, "Город"));
    current = await conversation.handle(1, 1, "Бишкек");
    expect(rendered(await conversation.handle(1, 1, "/search"))).toContain("/toyota");
    const saved = rendered(await conversation.handle(1, 1, button(current, "Сохранить")));
    expect(saved).toContain("/honda-local");
    expect(saved).not.toContain("/honda-other");
    expect(saved).not.toContain("/toyota");
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
    const privacy = await conversation.handle(1, 1, "/start");
    const markets = await conversation.handle(1, 1, button(privacy, "Согласен"));
    const market = button(markets, "Корея");
    const currencies = await conversation.handle(1, 1, market);
    const currency = button(currencies, "USD");
    await conversation.handle(1, 1, currency);
    await conversation.handle(1, 1, "15000");
    const current = await conversation.handle(1, 1, "Hyundai");
    const results = await conversation.handle(1, 1, button(current, "Сохранить"));
    expect((await store.getProfile(1))?.market).toBe("KR");
    expect(rendered(results)).toContain("https://fem.encar.com/cars/detail/1");
    expect(rendered(results)).not.toContain("/local");
    expect(rendered(results)).not.toContain("/american");
    const saved = await store.getProfile(1);
    await conversation.handle(1, 1, market);
    expect(await store.getProfile(1)).toEqual(saved);
    await conversation.handle(1, 1, "/resume");
    await conversation.handle(1, 1, "/edit");
    await conversation.handle(1, 1, currency);
    expect((await store.getDraft(1))?.[0]).toBe("market");
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
      for (const [other, item] of store.listings.entries())
        expect(rendered(page).includes(item.url)).toBe(other === index);
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
    expect(rendered(await conversation.handle(1, 1, firstNext))).not.toContain("/details/");
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
    expect(rendered(replies)).toContain("/affordable");
    expect(rendered(replies)).not.toContain("/expensive");
    expect((await store.getProfile(1))?.monitoring).toBe(false);
  });
  it("escapes free text in both review and saved profile", async () => {
    let current = await review(conversation, "<b>Toyota</b>");
    await conversation.handle(1, 1, button(current, "Город"));
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
  function telegram(checkVin?: VinLookup) {
    const bot = createTelegramBot(store as unknown as Store, "100:test-token", {
      ...(checkVin ? { checkVin } : {}),
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
  it("runs only explicit private VIN commands without changing the buyer draft or requiring a profile", async () => {
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
    const text = String(calls.at(-1)?.payload.text);
    expect(text).toMatch(/CarHistory[\s\S]*не подтверждена/);
    expect(text).toMatch(/Car365[\s\S]*отключён/);
    await bot.handleUpdate({ update_id: 5, message: { ...message, text: "/help" } });
    expect(String(calls.at(-1)?.payload.text)).toContain("/search");
    expect(checkVin).toHaveBeenCalledTimes(1);
  });
  it("does not infer a check from buyer text and explains an unconfigured explicit command", async () => {
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
    expect(await store.getDraft(1)).toBeNull();
    const checkVin = vi.fn<VinLookup>();
    const enabled = telegram(checkVin);
    await enabled.bot.init();
    await enabled.bot.handleUpdate({
      update_id: 2,
      message: { ...message, text: "KMHDU41DBAU123456" },
    });
    expect(checkVin).not.toHaveBeenCalled();
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
    expect(await store.getDraft(1)).toEqual(draft);
    await bot.handleUpdate({ update_id: 2, message: { ...message, text: "/help" } });
    expect(String(calls.at(-1)?.payload.text)).toContain("/search");
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
  it("orders same-user messages and callbacks without blocking another user", async () => {
    const { bot, calls } = telegram();
    await bot.init();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let hold = true;
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendMessage" && "chat_id" in payload && payload.chat_id === 1 && hold) {
        hold = false;
        entered.resolve();
        await gate.promise;
      }
      return previous(method, payload, signal);
    });
    const from = { id: 1, is_bot: false, first_name: "Buyer" };
    const message = {
      message_id: 1,
      date: 1,
      from,
      chat: { id: 1, type: "private" as const, first_name: "Buyer" },
      text: "/privacy",
    };
    const first = bot.handleUpdate({ update_id: 1, message });
    await entered.promise;
    const second = bot.handleUpdate({
      update_id: 2,
      callback_query: { id: "own", from, chat_instance: "one", data: "/help", message },
    });
    try {
      await bot.handleUpdate({
        update_id: 3,
        message: { ...message, from: { ...from, id: 2 }, chat: { ...message.chat, id: 2 } },
      });
      expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(false);
    } finally {
      gate.resolve();
      await Promise.all([first, second]);
    }
    expect(
      calls.some(
        (call) => call.method === "answerCallbackQuery" && call.payload.callback_query_id === "own",
      ),
    ).toBe(true);
  });
});
