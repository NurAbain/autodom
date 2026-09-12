import { randomBytes } from "node:crypto";
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
import { type Button, type Buttons, escapeHtml, type Reply } from "./conversation.js";

const TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 2048;
type Step =
  | "consent"
  | "purpose"
  | "vehicle"
  | "price"
  | "city"
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
}
const EDIT_FIELDS: readonly (readonly [string, Step])[] = [
  ["Цель", "purpose"],
  ["Автомобиль и пробег", "vehicle"],
  ["Желаемая цена", "price"],
];
const PROPERTY_FIELDS: readonly (readonly [string, Step])[] = [
  ["Город недвижимости", "city"],
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

export class SellerConversation {
  private readonly drafts = new Map<number, Draft>();
  constructor(
    private readonly store: Pick<
      Store,
      "getOwnerVehicle" | "saveOwnerVehicle" | "deleteOwnerVehicle"
    >,
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

  private begin(userId: number, chatId: number, card: OwnerVehicle | null): Reply[] {
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
    };
    this.clear(userId);
    this.drafts.set(userId, draft);
    if (this.drafts.size > MAX_DRAFTS) this.clear(this.drafts.keys().next().value!);
    return this.prompt(draft);
  }

  private candidate(draft: Draft): OwnerVehicle {
    return validateOwnerVehicle(draft.data as OwnerVehicle);
  }

  private prompt(draft: Draft, error = ""): Reply[] {
    draft.nonce = randomBytes(12).toString("base64url");
    draft.expires = Date.now() + TTL_MS;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(() => {
      if (this.drafts.get(draft.userId) === draft) this.clear(draft.userId);
    }, TTL_MS);
    draft.timer.unref();
    const choice = (label: string, action: string): Button => [
      label,
      `seller:${draft.nonce}:${action}`,
    ];
    let text: string;
    let buttons: Buttons = [];
    switch (draft.step) {
      case "consent":
        text =
          "<b>Один автомобиль — продажа, обмен или взнос</b>\nСохраним вашу карточку автомобиля и пожелания вместе с Telegram ID и ID чата. Контакт не запрашиваем и никому ничего не отправляем. Данные хранятся отдельно от поиска покупки; карточку можно изменить или удалить через /mycar.\n\nЧерновик живёт только в памяти до 30 минут бездействия; при перезапуске или смене раздела он исчезает. В базу карточка попадёт только после проверки и нажатия «Сохранить». Удаление из резервных копий зависит от срока их хранения.\n\nСогласны на обработку и хранение этих данных?";
        buttons = [[choice("Согласен — продолжить", "consent")]];
        break;
      case "purpose":
        text =
          "Что хотите сделать со своим автомобилем? Это одна карточка: цель можно изменить позднее.";
        buttons = Object.entries(OWNER_PURPOSES).map(([value, label]) => [choice(label, value)]);
        break;
      case "vehicle":
        text =
          "Марка и модель, год, пробег (необязательно).\nНапример: <b>Toyota Camry, 2018, 120000</b>\nЕсли пробег неизвестен: <b>Toyota Camry, 2018</b>. Пробег — в километрах, без слова «км».";
        break;
      case "price":
        text =
          "За сколько хотели бы продать авто? Укажите сумму и валюту: <b>15000 USD</b> или <b>1300000 KGS</b>. Это ваше пожелание, не оценка автомобиля.\nЕсли цены пока нет, нажмите «Пока не знаю».";
        buttons = [[choice("Пока не знаю", "skip")]];
        break;
      case "city":
        text =
          "В каком городе нужна недвижимость? Например: <b>Бишкек</b>. Это пожелание, а не поиск подключённых объектов.";
        break;
      case "property_type":
        text = "Какая недвижимость интересует?";
        buttons = Object.entries(PROPERTY_TYPES).map(([value, label]) => [choice(label, value)]);
        break;
      case "cash":
        text =
          "Сколько готовы доплатить сейчас? Сумма с валютой, например <b>5000 USD</b>. Если без доплаты: <b>0 KGS</b>. Неизвестная сумма не равна нулю.";
        buttons = [[choice("Пока не знаю / пропустить", "skip")]];
        break;
      case "monthly":
        text =
          "Какой будущий платёж в месяц вам подходит? Сумма с валютой, например <b>30000 KGS</b>. Если без будущих платежей: <b>0 KGS</b>. Это пожелание, не расчёт кредита или рассрочки.";
        buttons = [[choice("Пока не знаю / пропустить", "skip")]];
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
          buttons = [[choice("Сохранить карточку", "save")]];
        } else {
          text += "\n\nКарточка сохранена только для вас, не опубликована и никому не отправлена.";
          buttons = [[choice("Текст для объявления", "description")]];
        }
        buttons = [
          ...buttons,
          ...[...EDIT_FIELDS, ...(card.purpose === "sale" ? [] : PROPERTY_FIELDS)].map(
            ([label, step]) => [choice(`Изменить: ${label}`, `edit.${step}`)],
          ),
        ];
        if (draft.step === "saved") buttons = [...buttons, [choice("Удалить карточку", "delete")]];
        break;
      }
      case "delete":
        text =
          "Удалить сохранённую карточку автомобиля и пожелания? Поиск покупки останется без изменений. Данные из резервных копий исчезнут по сроку их хранения.";
        buttons = [
          [choice("Да, удалить карточку", "confirm-delete")],
          [choice("Нет, оставить", "keep")],
        ];
        break;
    }
    if (draft.history.length || draft.returnReview)
      buttons = [...buttons, [choice("Назад — без изменения", "back")]];
    buttons = [...buttons, [choice(draft.step === "saved" ? "Закрыть" : "Отмена", "cancel")]];
    return [{ text: (error ? `${escapeHtml(error)}\n\n` : "") + text, buttons }];
  }

  private move(draft: Draft, step: Step): Reply[] {
    draft.history.push(draft.step);
    draft.step = step;
    return this.prompt(draft);
  }

  private advance(draft: Draft): Reply[] {
    if (draft.returnReview) {
      if (draft.data.purpose !== "sale" && !draft.data.property_city)
        return this.move(draft, "city");
      if (draft.data.purpose !== "sale" && !draft.data.property_type)
        return this.move(draft, "property_type");
      draft.returnReview = false;
      draft.beforeEdit = null;
      draft.history = [];
      draft.step = "review";
      return this.prompt(draft);
    }
    const next: Partial<Record<Step, Step>> = {
      purpose: "vehicle",
      vehicle: "price",
      price: draft.data.purpose === "sale" ? "review" : "city",
      city: "property_type",
      property_type: "cash",
      cash: "monthly",
      monthly: "review",
    };
    const step = next[draft.step] ?? "review";
    if (step === "review") draft.data.updated_at = Date.now() / 1000;
    return this.move(draft, step);
  }

  async handle(userId: number, chatId: number, input: string): Promise<Reply[] | null> {
    const text = input.trim();
    if (text === "/sell" || text === "/mycar") {
      this.current(userId);
      return this.begin(userId, chatId, await this.store.getOwnerVehicle(userId));
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
      if (parts.length !== 3 || parts[1] !== draft.nonce)
        return [
          { text: "Эта кнопка устарела. Используйте последнее сообщение или /mycar.", buttons: [] },
        ];
      action = parts[2]!;
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
      if (action.startsWith("edit.") && (draft.step === "saved" || draft.step === "review")) {
        const allowed = [...EDIT_FIELDS, ...(draft.data.purpose === "sale" ? [] : PROPERTY_FIELDS)];
        const field = allowed.find(([, step]) => `edit.${step}` === action);
        if (field) {
          draft.returnReview = true;
          draft.beforeEdit = { ...draft.data };
          draft.history = [];
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
          ...this.prompt(draft),
        ];
      }
      if (draft.step === "review" && action === "save") {
        draft.data.chat_id = chatId;
        draft.data.updated_at = Date.now() / 1000;
        const saved = await this.store.saveOwnerVehicle(this.candidate(draft));
        return this.begin(userId, chatId, saved);
      }
    }
    if (draft.step === "consent") {
      if (action !== "consent")
        return this.prompt(draft, "Сначала нужно ваше согласие — либо отмените ввод.");
      const now = Date.now() / 1000;
      draft.data = {
        user_id: userId,
        chat_id: chatId,
        mileage_km: null,
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
      return this.advance(draft);
    }
    if (draft.step === "property_type" && Object.hasOwn(PROPERTY_TYPES, action)) {
      draft.data.property_type = action as PropertyType;
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
    if (!callback && draft.step === "vehicle") {
      const parts = text.split(",").map((part) => part.trim());
      const [name = "", yearText = "", mileageText] = parts;
      const year = Number(yearText);
      const mileage = mileageText === undefined ? null : Number(mileageText.replaceAll(/\s/gu, ""));
      if (
        parts.length < 2 ||
        parts.length > 3 ||
        !name ||
        name.length > 120 ||
        !/^\d{4}$/u.test(yearText) ||
        year < 1900 ||
        year > new Date().getUTCFullYear() + 1 ||
        (mileageText !== undefined &&
          (!/^\d[\d\s]*$/u.test(mileageText) ||
            !Number.isSafeInteger(mileage) ||
            mileage! < 0 ||
            mileage! > 10_000_000))
      )
        return this.prompt(
          draft,
          "Формат: Toyota Camry, 2018, 120000. Последнее число можно не указывать; год должен быть действительным, пробег — от 0 до 10 000 000 км.",
        );
      draft.data.make_model = name;
      draft.data.year = year;
      draft.data.mileage_km = mileage;
      return this.advance(draft);
    }
    if (!callback && draft.step === "city") {
      if (!text || text.length > 80)
        return this.prompt(draft, "Введите город: от 1 до 80 символов.");
      draft.data.property_city = text;
      return this.advance(draft);
    }
    return this.prompt(draft, "Выберите действие кнопкой под сообщением.");
  }
}
