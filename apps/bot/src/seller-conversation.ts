import { randomBytes } from "node:crypto";
import { BODY_TYPES, TRANSMISSIONS } from "@autodom/core";
import type { CatalogChoice, CatalogLookup } from "@autodom/core/catalog-filter";
import { ownerVehicleName } from "@autodom/core/owner-filter";
import {
  OWNER_PURPOSES,
  type OwnerCurrency,
  type OwnerPurpose,
  type OwnerVehicle,
  ownerExchangeSummary,
  ownerSaleDescription,
  PROPERTY_TYPES,
  type PropertyType,
  validateOwnerVehicle,
} from "@autodom/core/owner-vehicle";
import type { Store } from "@autodom/storage";
import type { AnalyticsEvent } from "./analytics-contract.js";
import type { Button, Buttons, Reply } from "./conversation.js";
import { escapeHtml } from "./html.js";
import { marketProfile } from "./market-profile.js";
import { CatalogPendingError, vehicleCatalog } from "./vehicle-catalog.js";

const TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 2048;
/** The catalogue lists show one page of buttons at a time. */
const PAGE_SIZE = 12;
/** The makes shown before the owner opens the whole catalogue. */
const POPULAR_MAKES = 10;
/** The years offered as buttons. */
const YEAR_PAGE = 12;
const MAX_YEAR = new Date().getUTCFullYear() + 1;

type Step =
  | "consent"
  | "purpose"
  | "price"
  | "make"
  | "model"
  | "city"
  | "body"
  | "transmission"
  | "year"
  | "mileage"
  | "property_city"
  | "property_type"
  | "cash"
  | "monthly"
  | "review"
  | "saved"
  | "delete";
type Fields = Partial<OwnerVehicle>;
interface Draft {
  userId: number;
  timer?: NodeJS.Timeout;
  beforeEdit: Fields | null;
  chatId: number;
  step: Step;
  data: Fields;
  nonce: string;
  expires: number;
  returnReview: boolean;
  history: Step[];
  /** The page of the catalogue list the owner is looking at. */
  page: number;
  /** The catalogue is unavailable: the owner names the car in free text. */
  textOnly: boolean;
  /** The city names of the current page; the buttons carry their index. */
  cities: string[];
}
const EDIT_FIELDS: readonly (readonly [string, Step])[] = [
  ["Цель", "purpose"],
  ["Марка", "make"],
  ["Модель", "model"],
  ["Город автомобиля", "city"],
  ["Кузов", "body"],
  ["Коробка", "transmission"],
  ["Год", "year"],
  ["Пробег", "mileage"],
  ["Желаемая цена", "price"],
];
const PROPERTY_FIELDS: readonly (readonly [string, Step])[] = [
  ["Город недвижимости", "property_city"],
  ["Тип недвижимости", "property_type"],
  ["Доплата сейчас", "cash"],
  ["Платёж в месяц", "monthly"],
];

function money(
  text: string,
  allowZero: boolean,
): { amount: number; currency: OwnerCurrency } | null {
  const match = /^(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(USD|KGS|\$|сом|сомов|сомы)$/iu.exec(text.trim());
  if (!match) return null;
  const [whole, fraction = ""] = match[1]!.replaceAll(/\s/gu, "").replace(",", ".").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) return null;
  return { amount, currency: /^(?:USD|\$)$/iu.test(match[2]!) ? "USD" : "KGS" };
}

function summary(card: OwnerVehicle): string {
  return (
    `<b>Ваш автомобиль</b>\n${escapeHtml(ownerSaleDescription(card))}\n` +
    (card.mileage_km === null ? "Пробег: не указан.\n" : "") +
    (card.sale_price_minor === null ? "Желаемая цена: пока не определена.\n" : "") +
    `\n${escapeHtml(ownerExchangeSummary(card))}\n\nДанные со слов владельца; автомобиль не проверен, рыночная оценка не рассчитана.`
  );
}

/** A button of the draft; the nonce makes an old button harmless. */
function choice(draft: Draft, label: string, action: string): Button {
  return [label, `seller:${draft.nonce}:${action}`];
}

/** The choices the owner picks from, in the order of the shared conditions. */
function yearButtons(): { value: string; label: string }[] {
  const year = new Date().getUTCFullYear();
  const values: { value: string; label: string }[] = [];
  for (let offset = 0; offset < YEAR_PAGE; offset += 1) {
    const value = year - offset;
    values.push({ value: String(value), label: String(value) });
  }
  return values;
}

export class SellerConversation {
  private readonly drafts = new Map<number, Draft>();
  constructor(
    private readonly store: Pick<
      Store,
      "getOwnerVehicle" | "saveOwnerVehicle" | "deleteOwnerVehicle" | "countMakes" | "countCities"
    >,
    private readonly catalog: CatalogLookup = vehicleCatalog,
  ) {}

  clear(userId: number): void {
    clearTimeout(this.drafts.get(userId)?.timer);
    this.drafts.delete(userId);
  }

  private current(userId: number): Draft | undefined {
    const now = Date.now();
    for (const [id, draft] of this.drafts) if (draft.expires <= now) this.clear(id);
    return this.drafts.get(userId);
  }

  private async begin(userId: number, chatId: number, card: OwnerVehicle | null): Promise<Reply[]> {
    const draft: Draft = {
      userId,
      chatId,
      beforeEdit: null,
      step: card ? "saved" : "consent",
      data: card ? { ...card } : {},
      nonce: "",
      expires: 0,
      returnReview: false,
      history: [],
      page: 0,
      textOnly: false,
      cities: [],
    };
    this.clear(userId);
    this.drafts.set(userId, draft);
    if (this.drafts.size > MAX_DRAFTS) this.clear(this.drafts.keys().next().value!);
    return await this.prompt(draft);
  }

  private candidate(draft: Draft): OwnerVehicle {
    return validateOwnerVehicle({
      ...draft.data,
      user_id: draft.userId,
      chat_id: draft.chatId,
      updated_at: Date.now() / 1000,
    } as OwnerVehicle);
  }

  /** The catalogue of the market; the owner waits while the worker warms it up. */
  private async catalogue(
    key: "make" | "model",
    parentId?: string,
  ): Promise<{ ok: true; items: CatalogChoice[] } | { ok: false; message: string }> {
    try {
      const items = await this.catalog.getOptions(key, parentId);
      return { ok: true, items: [...items] };
    } catch (error) {
      if (error instanceof CatalogPendingError) return { ok: false, message: error.message };
      return {
        ok: false,
        message:
          "Справочник марок и моделей временно недоступен. Напишите марку и модель текстом — карточка сохранится.",
      };
    }
  }

  private async prompt(draft: Draft, error = ""): Promise<Reply[]> {
    draft.nonce = randomBytes(12).toString("base64url");
    draft.expires = Date.now() + TTL_MS;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(() => {
      if (this.drafts.get(draft.userId) === draft) this.clear(draft.userId);
    }, TTL_MS);
    draft.timer.unref();
    let text: string;
    let buttons: Buttons = [];
    switch (draft.step) {
      case "consent":
        text =
          "<b>Один автомобиль — продажа, обмен или взнос</b>\nСохраним вашу карточку автомобиля и пожелания вместе с Telegram ID и ID чата. Контакт не запрашиваем и никому ничего не отправляем. Данные хранятся отдельно от поиска покупки; карточку можно изменить или удалить через /mycar.\n\nЧерновик живёт только в памяти до 30 минут бездействия; при перезапуске или смене раздела он исчезает. В базу карточка попадёт только после проверки и нажатия «Сохранить». Удаление из резервных копий зависит от срока их хранения.\n\nСогласны на обработку и хранение этих данных?";
        buttons = [[choice(draft, "Согласен — продолжить", "consent")]];
        break;
      case "purpose":
        text =
          "Что хотите сделать со своим автомобилем? Это одна карточка: цель можно изменить позднее.";
        buttons = Object.entries(OWNER_PURPOSES).map(([value, label]) => [
          choice(draft, label, value),
        ]);
        break;
      case "price":
        text =
          "За сколько хотели бы продать авто? Укажите сумму и валюту: <b>15000 USD</b> или <b>1300000 KGS</b>. Это ваше пожелание, не оценка автомобиля.\nЕсли цены пока нет, нажмите «Пока не знаю».";
        buttons = [[choice(draft, "Пока не знаю", "skip")]];
        break;
      case "make": {
        if (draft.textOnly) {
          text =
            "Напишите марку и модель автомобиля: <b>Toyota Camry</b>. Справочник сейчас недоступен, поэтому название сохранится текстом.";
          buttons = [[choice(draft, "Вернуться к справочнику", "catalogue")]];
          break;
        }
        const catalogue = await this.catalogue("make");
        if (!catalogue.ok) {
          text = catalogue.message;
          buttons = [
            [choice(draft, "Написать марку текстом", "make-text")],
            [choice(draft, "Повторить", "retry")],
          ];
          break;
        }
        const counts = await this.store.countMakes(marketProfile(draft.userId));
        const ranked = [...catalogue.items].sort(
          (left, right) =>
            (counts.get(left.value) ?? 0) - (counts.get(right.value) ?? 0) ||
            left.label.localeCompare(right.label, "ru"),
        );
        const popular = ranked
          .slice(0, POPULAR_MAKES)
          .sort(
            (left, right) =>
              (counts.get(right.value) ?? 0) - (counts.get(left.value) ?? 0) ||
              left.label.localeCompare(right.label, "ru"),
          );
        text = "Какая марка автомобиля? Выберите кнопкой — так модель найдётся в справочнике.";
        buttons = popular.map((make) => [choice(draft, make.label, `make:${make.id}`)]);
        buttons = [...buttons, [choice(draft, "Все марки", "makes:0")]];
        break;
      }
      case "model": {
        const makeId = draft.data.make_id;
        if (!makeId) {
          // The card of an older editor carries the name only: the owner rewrites it.
          draft.textOnly = true;
          text = "Напишите марку и модель автомобиля: <b>Toyota Camry</b>.";
          break;
        }
        if (draft.textOnly) {
          text = `Какая модель? Напишите её: <b>Camry</b>. Марка: ${draft.data.make_model ?? ""}.`;
          buttons = [[choice(draft, "Пропустить модель", "model-skip")]];
          break;
        }
        const catalogue = await this.catalogue("model", makeId);
        if (!catalogue.ok) {
          text = catalogue.message;
          buttons = [
            [choice(draft, "Написать модель текстом", "model-text")],
            [choice(draft, "Повторить", "retry")],
          ];
          break;
        }
        const items = catalogue.items;
        const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        const page = Math.min(draft.page, pages - 1);
        draft.page = page;
        const slice = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
        text = `Какая модель? Марка: <b>${escapeHtml(draft.data.make_model ?? "")}</b>.`;
        buttons = slice.map((model) => [choice(draft, model.label, `model:${model.id}`)]);
        const navigation: Button[] = [];
        if (page > 0) navigation.push(choice(draft, "◀ Назад", `models:${page - 1}`));
        if (page + 1 < pages) navigation.push(choice(draft, "Ещё ▶", `models:${page + 1}`));
        if (navigation.length) buttons = [...buttons, navigation];
        buttons = [
          ...buttons,
          [
            choice(draft, "Написать модель текстом", "model-text"),
            choice(draft, "Пропустить модель", "model-skip"),
          ],
        ];
        break;
      }
      case "city": {
        const cities = await this.store.countCities(marketProfile(draft.userId), 40);
        draft.cities = cities.map((item) => item.city);
        const page = Math.min(
          draft.page,
          Math.max(0, Math.ceil(draft.cities.length / PAGE_SIZE) - 1),
        );
        draft.page = page;
        const slice = draft.cities.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
        text = "В каком городе стоит автомобиль? Это город объявления, не адрес доставки.";
        buttons = slice.map((city, index) => [
          choice(draft, city, `city:${page * PAGE_SIZE + index}`),
        ]);
        const pages = Math.max(1, Math.ceil(draft.cities.length / PAGE_SIZE));
        const navigation: Button[] = [];
        if (page > 0) navigation.push(choice(draft, "◀ Назад", `cities:${page - 1}`));
        if (page + 1 < pages) navigation.push(choice(draft, "Ещё ▶", `cities:${page + 1}`));
        if (navigation.length) buttons = [...buttons, navigation];
        buttons = [...buttons, [choice(draft, "Написать город текстом", "city-text")]];
        break;
      }
      case "body":
        text = "Какой кузов у автомобиля? Это характеристика для подбора, не оценка.";
        buttons = [
          ...Object.entries(BODY_TYPES).map(([value, label]) => [
            choice(draft, label, `body:${value}`),
          ]),
          [choice(draft, "Не указан", "body:none")],
        ];
        break;
      case "transmission":
        text = "Какая коробка передач?";
        buttons = [
          ...Object.entries(TRANSMISSIONS).map(([value, label]) => [
            choice(draft, label, `transmission:${value}`),
          ]),
          [choice(draft, "Не указан", "transmission:none")],
        ];
        break;
      case "year":
        text = "Какой год выпуска автомобиля?";
        buttons = [
          ...yearButtons().map((year) => [choice(draft, year.label, `year:${year.value}`)]),
          [choice(draft, "Написать год текстом", "year-text")],
        ];
        break;
      case "mileage":
        text =
          "Какой пробег, в километрах? Например: <b>120000</b>. Если пробег неизвестен, нажмите «Не указан» — неизвестный пробег не становится нулём.";
        buttons = [[choice(draft, "Не указан", "mileage:none")]];
        break;
      case "property_city":
        text =
          "В каком городе нужна недвижимость? Например: <b>Бишкек</b>. Это пожелание, а не поиск подключённых объектов.";
        break;
      case "property_type":
        text = "Какая недвижимость интересует?";
        buttons = Object.entries(PROPERTY_TYPES).map(([value, label]) => [
          choice(draft, label, value),
        ]);
        break;
      case "cash":
        text =
          "Сколько готовы доплатить сейчас? Сумма с валютой, например <b>5000 USD</b>. Если без доплаты: <b>0 KGS</b>. Неизвестная сумма не равна нулю.";
        buttons = [[choice(draft, "Пока не знаю / пропустить", "skip")]];
        break;
      case "monthly":
        text =
          "Какой будущий платёж в месяц вам подходит? Сумма с валютой, например <b>30000 KGS</b>. Если без будущих платежей: <b>0 KGS</b>. Это пожелание, не расчёт кредита или рассрочки.";
        buttons = [[choice(draft, "Пока не знаю / пропустить", "skip")]];
        break;
      case "review":
      case "saved": {
        const card = this.candidate(draft);
        text =
          (draft.step === "review"
            ? "<b>Проверьте перед сохранением</b>\n\n"
            : "<b>Сохранённая карточка</b>\n\n") + summary(card);
        if (draft.step === "review") {
          text +=
            "\n\nСохранить карточку и пожелания на условиях вашего согласия? Старые данные заменятся только после сохранения.";
          buttons = [[choice(draft, "Сохранить карточку", "save")]];
        } else {
          text += "\n\nКарточка сохранена только для вас, не опубликована и никому не отправлена.";
          buttons = [[choice(draft, "Текст для объявления", "description")]];
        }
        buttons = [
          ...buttons,
          ...[...EDIT_FIELDS, ...(card.purpose === "sale" ? [] : PROPERTY_FIELDS)].map(
            ([label, step]) => [choice(draft, `Изменить: ${label}`, `edit.${step}`)],
          ),
        ];
        if (draft.step === "saved")
          buttons = [...buttons, [choice(draft, "Удалить карточку", "delete")]];
        break;
      }
      case "delete":
        text =
          "Удалить сохранённую карточку автомобиля и пожелания? Поиск покупки останется без изменений. Данные из резервных копий исчезнут по сроку их хранения.";
        buttons = [
          [choice(draft, "Да, удалить карточку", "confirm-delete")],
          [choice(draft, "Нет, оставить", "keep")],
        ];
        break;
    }
    if (draft.history.length || draft.returnReview)
      buttons = [...buttons, [choice(draft, "Назад — без изменения", "back")]];
    buttons = [
      ...buttons,
      [choice(draft, draft.step === "saved" ? "Закрыть" : "Отмена", "cancel")],
    ];
    return [{ text: (error ? `${escapeHtml(error)}\n\n` : "") + text, buttons }];
  }

  private async move(draft: Draft, step: Step): Promise<Reply[]> {
    draft.history.push(draft.step);
    draft.step = step;
    draft.page = 0;
    return this.prompt(draft);
  }

  private async advance(draft: Draft): Promise<Reply[]> {
    if (draft.returnReview) {
      if (draft.data.purpose !== "sale" && !draft.data.property_city)
        return this.move(draft, "property_city");
      if (draft.data.purpose !== "sale" && !draft.data.property_type)
        return this.move(draft, "property_type");
      draft.returnReview = false;
      draft.beforeEdit = null;
      draft.history = [];
      draft.step = "review";
      return this.prompt(draft);
    }
    const next: Partial<Record<Step, Step>> = {
      purpose: "make",
      // A name written by hand carries the model already.
      make: draft.data.make_id ? "model" : "city",
      model: "city",
      city: "body",
      body: "transmission",
      transmission: "year",
      year: "mileage",
      mileage: draft.data.purpose === "sale" ? "price" : "property_city",
      property_city: "property_type",
      property_type: "cash",
      cash: "monthly",
      monthly: "price",
      // The price is the last question before the review.
      price: "review",
    };
    const step = next[draft.step] ?? "review";
    if (step === "review") draft.data.updated_at = Date.now() / 1000;
    return this.move(draft, step);
  }

  /** The make of the catalogue the owner picked; the card keeps its label and value. */
  private async chooseMake(draft: Draft, id: string): Promise<boolean> {
    const catalogue = await this.catalogue("make");
    if (!catalogue.ok) return false;
    const make = catalogue.items.find((item) => item.id === id);
    if (!make) return false;
    draft.data.make_id = make.id;
    draft.data.make_value = make.value;
    draft.data.make_label = make.label;
    draft.data.model_id = null;
    draft.data.model_value = null;
    draft.data.model_label = null;
    draft.data.make_model = ownerVehicleName({ make: { ...make } });
    return true;
  }

  private async chooseModel(draft: Draft, id: string): Promise<boolean> {
    const makeId = draft.data.make_id;
    if (!makeId) return false;
    const catalogue = await this.catalogue("model", makeId);
    if (!catalogue.ok) return false;
    const model = catalogue.items.find((item) => item.id === id);
    if (!model) return false;
    draft.data.model_id = model.id;
    draft.data.model_value = model.value;
    draft.data.model_label = model.label;
    draft.data.make_model = ownerVehicleName({
      make: draft.data.make_id
        ? {
            id: draft.data.make_id,
            value: draft.data.make_value ?? "",
            label: draft.data.make_label ?? "",
          }
        : null,
      model: { ...model },
    });
    return true;
  }

  async handle(
    userId: number,
    chatId: number,
    input: string,
    record?: (event: Omit<AnalyticsEvent, "actorId" | "surface" | "dedupeKey">) => Promise<void>,
  ): Promise<Reply[] | null> {
    if (chatId !== userId) return null;
    const text = input.trim();
    if (text === "/sell" || text === "/mycar") {
      this.current(userId);
      const card = await this.store.getOwnerVehicle(userId);
      try {
        await record?.({ event: "goal_selected", flow: "seller", step: "sell" });
      } catch {}
      return this.begin(userId, chatId, card);
    }
    const callback = text.startsWith("seller:");
    if (text.startsWith("/") || (!callback && /^[a-z][a-z_-]*:/iu.test(text))) {
      this.clear(userId);
      return null;
    }
    const draft = this.current(userId);
    if (!draft || draft.chatId !== chatId) {
      if (!callback) return null;
      return [
        {
          text: "Эта кнопка устарела. /mycar — открыть сохранённую карточку или начать заново.",
          buttons: [],
        },
      ];
    }
    let action = "";
    if (callback) {
      const parts = text.split(":");
      if (parts.length < 3 || parts[0] !== "seller" || parts[1] !== draft.nonce)
        return [
          { text: "Эта кнопка устарела. Используйте последнее сообщение или /mycar.", buttons: [] },
        ];
      action = parts.slice(2).join(":");
      if (action === "cancel") {
        this.clear(userId);
        return [
          {
            text: "Ввод закрыт. Сохранённая карточка и поиск покупки не изменены. /mycar — открыть карточку.",
            buttons: [],
          },
        ];
      }
      if (action === "back") {
        if (draft.returnReview && draft.beforeEdit) {
          draft.data = draft.beforeEdit;
          draft.beforeEdit = null;
          draft.returnReview = false;
          draft.history = [];
          draft.step = "review";
        } else draft.step = draft.history.pop() ?? draft.step;
        return this.prompt(draft);
      }
      if (action === "retry") return this.prompt(draft);
      if (action.startsWith("edit.") && (draft.step === "saved" || draft.step === "review")) {
        const allowed = [...EDIT_FIELDS, ...(draft.data.purpose === "sale" ? [] : PROPERTY_FIELDS)];
        const field = allowed.find(([, step]) => `edit.${step}` === action);
        if (field) {
          draft.returnReview = true;
          draft.beforeEdit = { ...draft.data };
          draft.history = [];
          draft.textOnly = false;
          return this.move(draft, field[1]);
        }
      }
      if (draft.step === "saved" && action === "delete") return this.move(draft, "delete");
      if (draft.step === "delete" && action === "keep") {
        draft.history = [];
        draft.step = "saved";
        return this.prompt(draft);
      }
      if (draft.step === "delete" && action === "confirm-delete") {
        await this.store.deleteOwnerVehicle(userId);
        this.clear(userId);
        return [
          {
            text: "Карточка автомобиля и пожелания удалены. Поиск покупки не изменён. /sell — создать новую карточку.",
            buttons: [],
          },
        ];
      }
      if (draft.step === "saved" && action === "description") {
        const card = this.candidate(draft);
        return [
          {
            text: `<b>Текст для копирования</b>\n${escapeHtml(ownerSaleDescription(card))}\n\nТолько ваши факты; контакты не добавлены. Текст не опубликован.`,
            buttons: [],
          },
          ...(await this.prompt(draft)),
        ];
      }
      if (draft.step === "review" && action === "save") {
        draft.data.chat_id = chatId;
        draft.data.updated_at = Date.now() / 1000;
        const saved = await this.store.saveOwnerVehicle(this.candidate(draft));
        try {
          await record?.({
            event: "profile_saved",
            flow: "seller",
            step: "saved",
            outcome: "success",
          });
        } catch {}
        return this.begin(userId, chatId, saved);
      }
      if (draft.step === "make") {
        if (action === "make-text") {
          draft.textOnly = true;
          return this.prompt(draft);
        }
        if (action === "catalogue") {
          draft.textOnly = false;
          return this.prompt(draft);
        }
        if (action === "make-close") return this.prompt(draft);
        if (action.startsWith("makes:")) {
          draft.page = Math.max(0, Number(action.slice("makes:".length)) || 0);
          const catalogue = await this.catalogue("make");
          if (!catalogue.ok) return this.prompt(draft, catalogue.message);
          const items = [...catalogue.items].sort((left, right) =>
            left.label.localeCompare(right.label, "ru"),
          );
          const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
          const page = Math.min(draft.page, pages - 1);
          draft.page = page;
          const slice = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
          const buttons: Button[][] = slice.map((make) => [
            choice(draft, make.label, `make:${make.id}`),
          ]);
          const navigation: Button[] = [];
          if (page > 0) navigation.push(choice(draft, "◀ Назад", `makes:${page - 1}`));
          if (page + 1 < pages) navigation.push(choice(draft, "Ещё ▶", `makes:${page + 1}`));
          if (navigation.length) buttons.push(navigation);
          buttons.push([choice(draft, "Назад к популярным маркам", "make-close")]);
          return [
            {
              text: "Все марки справочника. Выберите свою.",
              buttons: [...buttons, [choice(draft, "Отмена", "cancel")]],
            },
          ];
        }
        if (action.startsWith("make:")) {
          const id = action.slice("make:".length);
          if (!(await this.chooseMake(draft, id)))
            return this.prompt(draft, "Марка больше не найдена в справочнике. Выберите другую.");
          draft.textOnly = false;
          return this.advance(draft);
        }
      }
      if (draft.step === "model") {
        if (action === "model-text") {
          draft.textOnly = true;
          return this.prompt(draft);
        }
        if (action === "model-skip") {
          draft.data.model_id = null;
          draft.data.model_value = null;
          draft.data.model_label = null;
          draft.data.make_model = ownerVehicleName({
            make: draft.data.make_id
              ? {
                  id: draft.data.make_id,
                  value: draft.data.make_value ?? "",
                  label: draft.data.make_label ?? "",
                }
              : null,
          });
          return this.advance(draft);
        }
        if (action.startsWith("models:")) {
          draft.page = Math.max(0, Number(action.slice("models:".length)) || 0);
          return this.prompt(draft);
        }
        if (action.startsWith("model:")) {
          const id = action.slice("model:".length);
          if (!(await this.chooseModel(draft, id)))
            return this.prompt(draft, "Модель больше не найдена в справочнике. Выберите другую.");
          return this.advance(draft);
        }
      }
      if (draft.step === "city") {
        if (action === "city-text") {
          draft.textOnly = true;
          return this.prompt(draft);
        }
        if (action.startsWith("cities:")) {
          draft.page = Math.max(0, Number(action.slice("cities:".length)) || 0);
          return this.prompt(draft);
        }
        if (action.startsWith("city:")) {
          const index = Number(action.slice("city:".length));
          const city = draft.cities[index];
          if (!city) return this.prompt(draft, "Город не найден. Выберите его снова.");
          draft.data.city = city;
          draft.textOnly = false;
          return this.advance(draft);
        }
      }
      if (draft.step === "body" && action.startsWith("body:")) {
        const value = action.slice("body:".length);
        draft.data.body_type = value === "none" ? null : value;
        return this.advance(draft);
      }
      if (draft.step === "transmission" && action.startsWith("transmission:")) {
        const value = action.slice("transmission:".length);
        draft.data.transmission = value === "none" ? null : value;
        return this.advance(draft);
      }
      if (draft.step === "year") {
        if (action === "year-text") {
          draft.textOnly = true;
          return this.prompt(draft);
        }
        if (action.startsWith("year:")) {
          const year = Number(action.slice("year:".length));
          if (!Number.isInteger(year) || year < 1900 || year > MAX_YEAR)
            return this.prompt(draft, "Год должен быть от 1900 до текущего.");
          draft.data.year = year;
          return this.advance(draft);
        }
      }
      if (draft.step === "mileage" && action === "mileage:none") {
        draft.data.mileage_km = null;
        return this.advance(draft);
      }
      if (draft.step === "property_type" && Object.hasOwn(PROPERTY_TYPES, action)) {
        draft.data.property_type = action as PropertyType;
        return this.advance(draft);
      }
    }
    if (draft.step === "consent") {
      if (action !== "consent")
        return this.prompt(draft, "Сначала нужно ваше согласие — либо отмените ввод.");
      const now = Date.now() / 1000;
      draft.data = {
        user_id: userId,
        chat_id: chatId,
        make_id: null,
        make_value: null,
        make_label: null,
        model_id: null,
        model_value: null,
        model_label: null,
        make_model: "",
        year: 0,
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
        consent_at: now,
        updated_at: now,
      };
      return this.move(draft, "purpose");
    }
    if (draft.step === "purpose" && Object.hasOwn(OWNER_PURPOSES, action)) {
      draft.data.purpose = action as OwnerPurpose;
      try {
        await record?.({
          event: "goal_selected",
          flow: "seller",
          step: action === "sale" ? "sell" : "exchange",
        });
      } catch {}
      return this.advance(draft);
    }
    if (["price", "cash", "monthly"].includes(draft.step)) {
      const parsed =
        action === "skip" ? null : callback ? undefined : money(text, draft.step !== "price");
      if (parsed === undefined || (parsed === null && action !== "skip"))
        return this.prompt(
          draft,
          "Введите одну сумму и валюту USD или KGS, либо нажмите «Пока не знаю».",
        );
      if (draft.step === "price") {
        draft.data.sale_price_minor = parsed?.amount ?? null;
        draft.data.sale_currency = parsed?.currency ?? null;
      } else if (draft.step === "cash") {
        draft.data.cash_minor = parsed?.amount ?? null;
        draft.data.cash_currency = parsed?.currency ?? null;
      } else {
        draft.data.monthly_minor = parsed?.amount ?? null;
        draft.data.monthly_currency = parsed?.currency ?? null;
      }
      return this.advance(draft);
    }
    if (!callback && draft.step === "make" && draft.textOnly) {
      if (!text || text.length > 120)
        return this.prompt(draft, "Напишите марку и модель: от 1 до 120 символов.");
      draft.data.make_id = null;
      draft.data.make_value = null;
      draft.data.make_label = null;
      draft.data.model_id = null;
      draft.data.model_value = null;
      draft.data.model_label = null;
      draft.data.make_model = text;
      return this.advance(draft);
    }
    if (!callback && draft.step === "model" && draft.textOnly) {
      if (!text || text.length > 120)
        return this.prompt(draft, "Напишите модель: от 1 до 120 символов.");
      draft.data.model_id = null;
      draft.data.model_value = null;
      draft.data.model_label = null;
      // The catalogue does not know this model: the card keeps the owner's own words.
      draft.data.make_model = `${draft.data.make_label ?? ""} ${text}`.trim();
      return this.advance(draft);
    }
    if (!callback && draft.step === "city" && draft.textOnly) {
      if (!text || text.length > 80)
        return this.prompt(draft, "Введите город: от 1 до 80 символов.");
      draft.data.city = text;
      return this.advance(draft);
    }
    if (!callback && draft.step === "year") {
      const year = Number(text);
      if (!/^\d{4}$/u.test(text) || !Number.isInteger(year) || year < 1900 || year > MAX_YEAR)
        return this.prompt(draft, "Год должен быть четырёхзначным: от 1900 до текущего.");
      draft.data.year = year;
      return this.advance(draft);
    }
    if (!callback && draft.step === "mileage") {
      const mileage = Number(text.replaceAll(/\s/gu, ""));
      if (
        !/^\d[\d\s]*$/u.test(text) ||
        !Number.isSafeInteger(mileage) ||
        mileage < 0 ||
        mileage > 10_000_000
      )
        return this.prompt(draft, "Пробег: целое число от 0 до 10 000 000 км.");
      draft.data.mileage_km = mileage;
      return this.advance(draft);
    }
    if (!callback && draft.step === "property_city") {
      if (!text || text.length > 80)
        return this.prompt(draft, "Введите город: от 1 до 80 символов.");
      draft.data.property_city = text;
      return this.advance(draft);
    }
    return this.prompt(draft, "Выберите действие кнопкой под сообщением.");
  }
}
