import type { PaymentOrder } from "@autodom/core/payments";
import {
  encarHistoryDiscoveryUrl,
  encarListingUrl,
  isEncarPhotoUrl,
  normalizeVin,
  VIN_PROVIDERS,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  vinGoogleSearchUrl,
} from "@autodom/core/vin";
import type { Reply } from "../src/conversation.js";
import { KOREAN_REPORT_EXAMPLE } from "../src/korean-report-example.js";
import type { MiniAppCar } from "../src/miniapp-contract.js";
import { PAYMENT_PRIVACY_NOTICE, paymentOrderStatus } from "../src/payment-text.js";
import {
  confirmedEncarListings,
  encarHistorySummary,
  encarListingFacts,
  VIN_CAUTION,
  VIN_DISCLOSURE,
  VIN_GOOGLE_SEARCH_LABEL,
  VIN_GOOGLE_SEARCH_NOTICE,
  VIN_SOURCE_NAMES,
  vinSourceText,
} from "../src/vin-text.js";

type TelegramApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  BackButton?: {
    show?: () => void;
    onClick?: (callback: () => void) => void;
  };
};
const telegram = (window as Window & { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
const root = document.getElementById("app")!;

type View = "home" | "vin" | "buy" | "sell" | "report-example" | "car" | "orders";
let currentView: View = "home";
let generation = 0;
const pending = new Set<AbortController>();

function cancelRequests(): void {
  generation += 1;
  for (const controller of pending) controller.abort();
  pending.clear();
}

window.addEventListener("pagehide", cancelRequests);
window.addEventListener("popstate", () => void load());

function navigate(view: View, carId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("car");
  url.searchParams.delete("view");
  url.searchParams.delete("order_id");
  if (view === "car" && carId) url.searchParams.set("car", carId);
  else if (view !== "home") url.searchParams.set("view", view);
  window.history.pushState(null, "", url);
  void load();
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  if (!telegram?.initData) {
    throw new Error(
      "Откройте Автодом из личного чата в Telegram. Здесь нужен защищённый доступ, а не профиль покупателя.",
    );
  }
  const controller = new AbortController();
  const started = generation;
  pending.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `tma ${telegram.initData}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) {
      let message =
        response.status === 401
          ? "Сессия истекла. Откройте Автодом заново из личного чата с ботом."
          : "Сервис временно недоступен. Попробуйте ещё раз позже.";
      try {
        const error: unknown = await response.json();
        if (
          error &&
          typeof error === "object" &&
          "error" in error &&
          typeof error.error === "string"
        )
          message = error.error;
      } catch {
        // A proxy may return an HTML error.
      }
      throw new Error(message);
    }
    const result = (await response.json()) as T;
    if (started !== generation) throw new Error("Navigation interrupted");
    return result;
  } finally {
    window.clearTimeout(timeout);
    pending.delete(controller);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.name !== "AbortError"
    ? error.message
    : "Не удалось дождаться ответа. Проверьте соединение и попробуйте позже.";
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, action: () => void, className = "button"): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function closeCard(): void {
  if (telegram?.close) telegram.close();
  else {
    const note = document.getElementById("close-note");
    if (note) note.textContent = "Закройте эту вкладку и вернитесь в личный чат с ботом.";
  }
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function sourceLink(url: string | null, text: string): HTMLAnchorElement {
  const link = element("a", "source-link", text);
  if (url) link.href = url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  link.addEventListener("click", (event) => {
    if (telegram?.openLink && link.hasAttribute("href")) {
      event.preventDefault();
      telegram.openLink(link.href);
    }
  });
  return link;
}

// Parse into an inert document, then copy only formatting and the exact server-approved
// source URL. Never attach supplied markup, attributes, images or event handlers.
function richText(html: string, sourceUrl: string | null): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const fragment = document.createDocumentFragment();
  const allowed: Record<string, true> = {
    b: true,
    strong: true,
    i: true,
    em: true,
    u: true,
    s: true,
    code: true,
    pre: true,
    br: true,
    blockquote: true,
  };
  const blocked: Record<string, true> = {
    script: true,
    style: true,
    iframe: true,
    object: true,
    embed: true,
    svg: true,
    math: true,
    template: true,
  };
  const copy = (source: Node, destination: Node): void => {
    if (source.nodeType === Node.TEXT_NODE) {
      destination.appendChild(document.createTextNode(source.textContent ?? ""));
      return;
    }
    if (!(source instanceof Element)) return;
    const tag = source.tagName.toLowerCase();
    if (Object.hasOwn(blocked, tag)) return;
    let target = destination;
    if (Object.hasOwn(allowed, tag)) {
      target = destination.appendChild(document.createElement(tag));
    } else if (tag === "a") {
      const href = safeUrl(source.getAttribute("href"));
      if (href && href === sourceUrl) target = destination.appendChild(sourceLink(href, ""));
    }
    for (const child of source.childNodes) copy(child, target);
  };
  for (const child of parsed.body.childNodes) copy(child, fragment);
  return fragment;
}

function shell(): HTMLElement {
  const main = element("main");
  const header = element("header", "topbar");
  const brand = button("Автодом", () => navigate("home"), "brand");
  brand.setAttribute("aria-label", "Автодом — на главную");
  header.append(brand, button("В чат", closeCard, "button button-quiet"));
  if (currentView !== "home") {
    main.append(button("← На главную", () => navigate("home"), "back-link"));
  }
  const note = element("p", "footnote");
  note.id = "close-note";
  note.setAttribute("role", "status");
  root.replaceChildren(header, main, note);
  return main;
}

function showState(title: string, message: string, retry = false): void {
  const main = shell();
  const state = element("section", "state");
  state.append(element("p", "eyebrow", "Автодом"), element("h1", "", title));
  const description = element("p", "", message);
  description.setAttribute("role", "status");
  state.append(description);
  if (retry) state.append(button("Повторить загрузку", () => void load()));
  main.append(state);
}

function showHome(): void {
  const main = shell();
  const heading = element("section", "home-heading");
  heading.append(
    element("p", "eyebrow", "Авто · Кыргызстан"),
    element("h1", "", "С чего начнём?"),
    element("p", "muted", "Проверьте автомобиль, найдите покупателя или выберите свой следующий."),
  );
  const goals = element("nav", "goals");
  goals.setAttribute("aria-label", "Выберите цель");
  for (const [view, number, title, description] of [
    [
      "vin",
      "01",
      "Проверить VIN",
      "Бесплатная проверка корейских источников. VIN или фото в чате.",
    ],
    [
      "sell",
      "02",
      "Продать или обменять авто",
      "Продажа, обмен на недвижимость или первый взнос автомобилем.",
    ],
    ["buy", "03", "Купить авто", "Простой подбор по бюджету и вашим пожеланиям."],
  ] as const) {
    const goal = button("", () => navigate(view), "goal");
    const copy = element("span", "goal-copy");
    copy.append(
      element("strong", "goal-title", title),
      element("span", "goal-description", description),
    );
    goal.append(element("span", "goal-number", number), copy, element("span", "goal-arrow", "↗"));
    goals.append(goal);
  }
  main.append(
    heading,
    goals,
    element(
      "p",
      "footnote home-note",
      "Выберите только то, что нужно сейчас. Для проверки VIN не нужна анкета покупателя.",
    ),
    button("Мои заказы и оплата услуг", () => navigate("orders"), "back-link"),
  );
}

function premiumPanel(): HTMLElement {
  const panel = element("section", "panel premium-panel");
  panel.append(
    element("p", "eyebrow", "Следующий уровень проверки"),
    element("h2", "", "Как выглядит корейский отчёт"),
    element(
      "p",
      "",
      "Понятный перевод истории автомобиля: страховые события, ремонт и регистрационные сведения — в пределах данных источника.",
    ),
    element(
      "p",
      "footnote",
      "Покупка и выдача нового отчёта не подключены. Finik не используется для цифровых VIN-отчётов в Telegram.",
    ),
    button("Посмотреть реальный пример", () => navigate("report-example"), "button button-quiet"),
    element(
      "p",
      "footnote",
      "Пример относится к другому автомобилю. Это не результат проверки вашего VIN.",
    ),
  );
  return panel;
}

function showExample(): void {
  const main = shell();
  const example = KOREAN_REPORT_EXAMPLE;
  const heading = element("section", "example-heading");
  heading.append(
    element("p", "badge", "ПРИМЕР · НЕ НОВАЯ ПРОВЕРКА"),
    element("h1", "", example.title),
    element("p", "", example.notice),
    element("p", "muted", example.vehicle.name),
    element("p", "vin", example.vehicle.vin),
    element(
      "p",
      "footnote",
      `Дата запроса в документе: ${example.queryDate}. Дата документа: ${example.documentDate}.`,
    ),
  );
  const summary = element("section", "panel");
  summary.append(element("h2", "", "Коротко об этом примере"));
  const facts = element("dl", "facts");
  for (const row of example.summary) {
    const fact = element("div", "fact");
    fact.append(
      element("dt", "", row.label),
      element("dd", "", row.value),
      element("p", "footnote", `${row.korean} · стр. ${row.pages.join(", ")}`),
    );
    facts.append(fact);
  }
  summary.append(facts);
  main.append(heading, summary);
  for (const section of example.sections) {
    const details = element("details", "panel example-section");
    details.append(
      element("summary", "", section.title),
      element("p", "footnote", `${section.korean} · стр. ${section.pages.join(", ")}`),
    );
    for (const paragraph of section.paragraphs) details.append(element("p", "", paragraph));
    if ("rows" in section && section.rows) {
      const rows = element("dl", "report-rows");
      for (const row of section.rows) {
        const fact = element("div", "fact");
        fact.append(element("dt", "", row.label), element("dd", "", row.value));
        if ("korean" in row && row.korean) fact.append(element("p", "footnote", row.korean));
        rows.append(fact);
      }
      details.append(rows);
    }
    main.append(details);
  }
  const limits = element("section", "panel notice");
  limits.append(element("h2", "", "Как читать этот пример"));
  for (const limitation of example.limitations) limits.append(element("p", "", limitation));
  main.append(
    limits,
    button("Перейти к проверке своего VIN", () => navigate("vin")),
  );
}

function showDialogue(view: "buy" | "sell"): void {
  const main = shell();
  const started = generation;
  main.append(
    element("p", "eyebrow", view === "buy" ? "Подбор автомобиля" : "Ваш автомобиль"),
    element("h1", "", view === "buy" ? "Купить авто" : "Продать или обменять"),
    element(
      "p",
      "muted",
      view === "buy"
        ? "Выбирайте кнопками или отвечайте текстом. Настройки те же, что в чате."
        : "Расскажите об авто и цели. Анкета продажи отделена от поиска автомобиля.",
    ),
  );
  const content = element("div", "dialogue-content");
  const status = element("p", "footnote dialogue-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const form = element("form", "dialogue-form panel");
  const label = element("label", "", "Ваш ответ");
  label.htmlFor = "dialogue-input";
  const input = element("input", "text-input");
  input.id = "dialogue-input";
  input.type = "text";
  input.placeholder = "Напишите ответ…";
  input.autocomplete = "off";
  input.maxLength = 2048;
  input.required = true;
  const submit = element("button", "button", "Отправить");
  submit.type = "submit";
  form.append(label, input, submit);
  const cancel = button("Отменить текущий шаг", () => void send("/cancel"), "back-link");
  main.append(content, status, form, cancel);
  let busy = false;

  function runAction(command: string): void {
    if (busy) return;
    if (command === "/vin") navigate("vin");
    else if (command === "/start") navigate("home");
    else if (command === "/buy" && view !== "buy") navigate("buy");
    else if ((command === "/sell" || command === "/mycar") && view !== "sell") navigate("sell");
    else void send(command);
  }

  function renderReply(reply: Reply): HTMLElement {
    const section = element("section", "panel dialogue-reply");
    const text = element("div", "reply-text");
    text.append(richText(reply.text, null));
    section.append(text);
    if (reply.listingId) {
      section.append(
        button(
          "Открыть автомобиль и фото",
          () => navigate("car", reply.listingId),
          "button button-quiet",
        ),
      );
    }
    if (reply.miniAppView && reply.miniAppView !== view) {
      const target = reply.miniAppView;
      section.append(
        button(
          target === "report-example"
            ? "Посмотреть пример отчёта"
            : target === "vin"
              ? "Открыть проверку VIN"
              : "Открыть",
          () => navigate(target),
          "button button-quiet",
        ),
      );
    }
    const actions = element("div", "dialogue-actions");
    for (const row of reply.buttons) {
      const group = element("div", "button-row");
      for (const [label, command] of row) {
        const url = safeUrl(command);
        if (url) {
          const link = sourceLink(url, label);
          link.className = "button button-quiet";
          group.append(link);
        } else {
          group.append(button(label, () => runAction(command), "button button-quiet"));
        }
      }
      actions.append(group);
    }
    section.append(actions);
    return section;
  }

  async function send(text: string): Promise<void> {
    if (busy || !text.trim()) return;
    busy = true;
    status.textContent = "Сохраняем ответ и открываем следующий шаг…";
    content.querySelectorAll<HTMLButtonElement>("button").forEach((node) => {
      node.disabled = true;
    });
    input.disabled = true;
    submit.disabled = true;
    cancel.disabled = true;
    try {
      const result = await request<{ replies: Reply[] }>("/miniapp/api/dialogue", { text });
      if (started !== generation) return;
      content.replaceChildren(...result.replies.map(renderReply));
      if (result.replies.length === 0)
        content.append(
          element("p", "", "Ответ принят. Продолжите в чате или выберите другую цель."),
        );
      input.value = "";
      status.textContent = "";
      content.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (error) {
      if (started !== generation) return;
      status.textContent = `${errorText(error)} Если ответ успел сохраниться, продолжите с актуального шага в чате.`;
      if (!content.childElementCount)
        content.append(button("Открыть шаг заново", () => void send(text), "button button-quiet"));
    } finally {
      if (started === generation) {
        busy = false;
        content.querySelectorAll<HTMLButtonElement>("button").forEach((node) => {
          node.disabled = false;
        });
        input.disabled = false;
        submit.disabled = false;
        cancel.disabled = false;
      }
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runAction(input.value.trim());
  });
  void send(view === "buy" ? "/buy" : "/sell");
}

function gallery(title: string, photoUrls: readonly string[]): HTMLElement {
  const section = element("section", "gallery");
  section.setAttribute("aria-label", `Фотографии: ${title}`);
  const photos = photoUrls.map(safeUrl).filter((url): url is string => url !== null);
  if (!photos.length) {
    section.append(element("p", "photo-empty", "Фотографии не предоставлены источником."));
    return section;
  }
  let selected = 0;
  const frame = element("div", "photo-frame");
  const counter = element("span", "photo-counter");
  counter.setAttribute("aria-live", "polite");
  const previous = button(
    "Предыдущее",
    () => {
      selected -= 1;
      renderPhoto();
    },
    "button button-quiet",
  );
  const next = button(
    "Следующее",
    () => {
      selected += 1;
      renderPhoto();
    },
    "button button-quiet",
  );
  function renderPhoto(): void {
    const image = element("img");
    image.alt = `${title} — фото ${selected + 1}`;
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    image.loading = "lazy";
    image.src = photos[selected]!;
    image.addEventListener(
      "error",
      () => {
        if (frame.contains(image))
          frame.replaceChildren(
            element("p", "photo-empty", "Источник не смог загрузить это фото."),
          );
      },
      { once: true },
    );
    frame.replaceChildren(image);
    counter.textContent = `${selected + 1} / ${photos.length}`;
    previous.disabled = selected === 0;
    next.disabled = selected === photos.length - 1;
  }
  section.append(frame);
  if (photos.length > 1) {
    const controls = element("div", "gallery-controls");
    controls.append(previous, counter, next);
    section.append(controls);
  }
  renderPhoto();
  return section;
}

function vinPanel(car?: MiniAppCar): HTMLElement {
  const started = generation;
  const panel = element("section", "panel vin-panel");
  panel.append(
    element("p", "eyebrow", "Бесплатно · сначала Корея"),
    element(car ? "h2" : "h1", "", "Проверить VIN"),
    element(
      "p",
      "muted",
      "Проверим наличие отчёта CarHistory, экспортную запись Car365 и найденные объявления Encar с подтверждённым VIN. Полную историю бесплатно не получаем.",
    ),
  );
  if (car) {
    panel.append(
      element(
        "p",
        car.vin ? "vin" : "muted",
        car.vin
          ? `VIN из объявления: ${car.vin}`
          : "В объявлении нет VIN. Введите его с автомобиля или документов.",
      ),
      element(
        "p",
        "footnote",
        "Введённый вручную VIN не подтверждён как VIN этого объявления. Сверьте номер с автомобилем и документами.",
      ),
    );
  }
  panel.append(
    element(
      "p",
      "footnote",
      "Есть только фото VIN? Отправьте его в чат с ботом и подтвердите распознанный номер перед проверкой.",
    ),
  );
  const disclosure = element("details", "disclosure");
  disclosure.append(
    element("summary", "", "Какие источники проверяем и куда передаём VIN"),
    element("p", "footnote", VIN_DISCLOSURE),
  );
  const form = element("form", "vin-form");
  const label = element("label", "", "VIN — 17 латинских букв и цифр, без I, O, Q");
  label.htmlFor = "vin-input";
  const input = element("input", "vin-input");
  input.id = "vin-input";
  input.name = "vin";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 64;
  input.required = true;
  input.setAttribute("autocapitalize", "characters");
  input.value = car?.vin ?? "";
  const submit = element("button", "button", "Проверить VIN");
  submit.type = "submit";
  const search = sourceLink(vinGoogleSearchUrl(input.value), VIN_GOOGLE_SEARCH_LABEL);
  search.className = "button button-quiet";
  search.hidden = !search.hasAttribute("href");
  const results = element("div", "vin-results");
  results.setAttribute("role", "status");
  results.setAttribute("aria-live", "polite");
  input.addEventListener("input", () => {
    const url = vinGoogleSearchUrl(input.value);
    search.hidden = !url;
    if (url) search.href = url;
    else search.removeAttribute("href");
    results.replaceChildren();
  });
  form.append(label, input, submit, search, element("p", "footnote", VIN_GOOGLE_SEARCH_NOTICE));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!submit.disabled) void lookup();
  });
  async function lookup(): Promise<void> {
    const vin = normalizeVin(input.value);
    if (!vin) {
      results.replaceChildren(
        element(
          "p",
          "",
          "VIN должен содержать 17 латинских букв и цифр, без I, O, Q. Короткий номер кузова не подходит.",
        ),
      );
      input.focus();
      return;
    }
    if (started !== generation) return;
    input.value = vin;
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = "Проверяем…";
    results.replaceChildren(element("p", "", `Проверяем VIN ${vin} у подключённых провайдеров…`));
    try {
      const result = await request<VinCheckResult>("/miniapp/api/vin", { vin });
      if (started !== generation) return;
      if (result.vin !== vin)
        throw new Error(
          "Источник вернул ответ для другого VIN. Не используйте его для проверки автомобиля.",
        );
      results.replaceChildren(element("p", "vin", `VIN ${result.vin}`));
      const statuses = {
        available: "Запись найдена",
        not_found: "Не найдено",
        unavailable: "Результат неизвестен",
        disabled: "Не проверялось",
      };
      for (const provider of VIN_PROVIDERS) {
        const observation = result[provider];
        if (!observation) continue;
        const section = element("section", "vin-source");
        section.dataset.status = observation.status;
        section.append(
          element("h3", "", VIN_SOURCE_NAMES[provider]),
          element(
            "p",
            "badge",
            provider === "carhistory" && observation.status === "available"
              ? "Отчёт доступен у провайдера"
              : provider === "encar" && observation.status === "available"
                ? confirmedEncarListings(result).length
                  ? result.encar?.data?.partial
                    ? "Объявления найдены · частичный результат"
                    : "Подтверждённые объявления найдены"
                  : statuses.unavailable
                : statuses[observation.status],
          ),
        );
        if (provider === "car365" && observation.status === "available") {
          const record = result.car365.data;
          const facts = element("dl", "facts export-facts");
          for (const [label, value] of [
            ["Дата декларации об экспорте", record?.export_date ?? "Неизвестна"],
            [
              "Записанный пробег",
              record?.last_mileage_km == null
                ? "Неизвестен"
                : `${record.last_mileage_km.toLocaleString("ru-RU")} км`,
            ],
            ["Модель в записи", record?.model ?? "Неизвестна"],
            ["Первая регистрация", record?.first_registration_date ?? "Неизвестна"],
          ]) {
            const fact = element("div", "fact");
            fact.append(element("dt", "", label), element("dd", "", value));
            facts.append(fact);
          }
          section.append(
            facts,
            element(
              "p",
              "footnote",
              "Дата декларации — не дата отправки автомобиля и не дата замера пробега. Записанный пробег не равен текущему.",
            ),
            element(
              "p",
              "notice",
              record?.total_loss == null
                ? "Полная гибель: сведений нет. Состояние автомобиля неизвестно."
                : record.total_loss
                  ? "Внимание: в записи указана полная гибель автомобиля."
                  : "Полная гибель в записи не указана. Это не подтверждает отсутствие ДТП или повреждений.",
            ),
            element(
              "p",
              "footnote",
              observation.checked_at === null
                ? "Время проверки неизвестно."
                : `Проверено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bishkek" }).format(new Date(observation.checked_at * 1000))} · Бишкек`,
            ),
          );
        } else if (provider === "encar" && observation.status === "available") {
          section.append(element("p", "vin-observation", encarHistorySummary(result)));
          section.append(
            sourceLink(encarHistoryDiscoveryUrl(result.vin), "Поиск кандидатов: Carcheck"),
          );
          for (const listing of confirmedEncarListings(result)) {
            const advertisement = element("article", "encar-listing");
            advertisement.append(
              element("h4", "", `Объявление Encar №${listing.id}`),
              element("p", "footnote", `Подтверждённый VIN: ${listing.vin}`),
            );
            const facts = element("dl", "facts");
            for (const [label, value] of encarListingFacts(listing)) {
              const fact = element("div", "fact");
              fact.append(element("dt", "", label), element("dd", "", value));
              facts.append(fact);
            }
            advertisement.append(
              facts,
              gallery(
                `Encar №${listing.id} · ${listing.model ?? listing.vin}`,
                listing.photo_urls.filter((url) => isEncarPhotoUrl(url, listing.id)),
              ),
              sourceLink(
                encarListingUrl(listing.id),
                "Открыть официальное объявление и фотографии",
              ),
            );
            section.append(advertisement);
          }
          section.append(
            element(
              "p",
              "footnote",
              observation.checked_at === null
                ? "Время проверки неизвестно."
                : `Проверено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bishkek" }).format(new Date(observation.checked_at * 1000))} · Бишкек`,
            ),
          );
        } else {
          section.append(element("p", "vin-observation", vinSourceText(provider, result)));
        }
        section.append(
          sourceLink(VIN_SOURCE_URLS[provider], `Источник: ${VIN_SOURCE_NAMES[provider]}`),
        );
        results.append(section);
      }
    } catch (error) {
      if (started !== generation) return;
      results.replaceChildren(
        element(
          "p",
          "notice",
          `${errorText(error)} Результат неизвестен — это не отсутствие записей.`,
        ),
      );
    } finally {
      if (started === generation) {
        input.disabled = false;
        submit.disabled = false;
        submit.textContent = "Проверить VIN";
      }
    }
  }
  panel.append(form, results, element("p", "footnote", VIN_CAUTION), disclosure);
  return panel;
}

function showCar(car: MiniAppCar): void {
  const main = shell();
  const heading = element("section", "car-heading");
  heading.append(
    element("p", "eyebrow", `${car.market} · ${car.source}`),
    element("h1", "", car.title),
    element("p", "price", car.price),
  );
  main.append(heading, gallery(car.title, car.photoUrls));
  const facts = element("dl", "facts");
  for (const [label, value] of [
    ["Год", car.year === null ? "Не указан" : String(car.year)],
    ["Пробег", car.mileage || "Не указан"],
    ["Коробка передач", car.transmission || "Не указана"],
    ["Кузов", car.bodyType || "Не указан"],
    ["Город", car.city || "Не указан"],
    ["Статус у источника", car.availability || "Не указан"],
  ]) {
    const fact = element("div", "fact");
    fact.append(element("dt", "", label), element("dd", "", value));
    facts.append(fact);
  }
  main.append(facts);
  main.append(vinPanel(car), premiumPanel());
  const details = element("section", "panel");
  details.append(element("h2", "", "Сведения из объявления"));
  const text = element("div", "details");
  const url = safeUrl(car.url);
  text.append(richText(car.detailsHtml, url));
  details.append(text);
  if (url) details.append(sourceLink(url, "Открыть объявление у источника"));
  main.append(details);
  const observed =
    car.observedAt === null
      ? "Время наблюдения неизвестно."
      : `Последнее наблюдение: ${new Intl.DateTimeFormat("ru-RU", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Bishkek",
        }).format(new Date(car.observedAt * 1000))} (Бишкек, UTC+6).`;
  main.append(
    element(
      "p",
      "footnote",
      `${observed} Данные не проверены независимо. Цену и наличие подтвердите у продавца.`,
    ),
  );
}

async function showOrders(): Promise<void> {
  const started = generation;
  showState("Мои заказы", "Загружаем подтверждённые сервером статусы…");
  try {
    const { orders } = await request<{ orders: PaymentOrder[] }>("/miniapp/api/orders");
    if (started !== generation) return;
    const main = shell();
    main.append(
      element("p", "eyebrow", "Отдельные физические услуги"),
      element("h1", "", "Мои заказы"),
      element("p", "muted", "Бесплатный поиск, уведомления и проверка VIN не требуют покупки."),
      button("Обновить статус", () => void load(), "button button-quiet"),
    );
    if (!orders.length) {
      const empty = element("section", "state");
      empty.append(
        element("h2", "", "Заказов пока нет"),
        element(
          "p",
          "",
          "Здесь появится отдельно согласованная услуга с реальным исполнителем, составом, ценой и условиями. Счета без такого заказа не создаются.",
        ),
      );
      main.append(empty);
    }
    for (const order of orders) {
      const panel = element("section", "panel");
      panel.id = `order-${order.id}`;
      const status = element("p", "badge", paymentOrderStatus(order));
      status.setAttribute("role", "status");
      const price = `${(order.amount / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} KGS`;
      panel.append(
        status,
        element("h2", "", order.title),
        element("p", "price", price),
        element("p", "reply-text", order.description),
        element("p", "reply-text", `Продавец: ${order.seller}\nИсполнитель: ${order.executor}`),
        element(
          "p",
          "footnote",
          `Заказ ${order.id}\nПредложение до ${new Date(order.expiresAt).toLocaleString("ru-RU")}`,
        ),
      );
      const terms = element("details", "disclosure");
      terms.append(
        element("summary", "", "Условия услуги и возврата"),
        element("p", "reply-text", order.terms),
      );
      panel.append(terms);
      const support = new URL(order.supportUrl);
      if (support.protocol === "https:")
        panel.append(sourceLink(safeUrl(support.href), "Поддержка по заказу"));
      else if (support.protocol === "mailto:") {
        const link = element("a", "source-link", "Поддержка по заказу");
        link.href = support.href;
        panel.append(link);
      }
      const active =
        order.paymentStatus === "unpaid" &&
        !order.needsReview &&
        order.invoiceStatus !== "cancelled" &&
        Date.parse(order.expiresAt) > Date.now();
      if (active) {
        const form = element("form", "vin-form");
        const consent = element("label", "payment-consent");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.required = true;
        consent.append(
          checkbox,
          document.createTextNode(
            ` Подтверждаю состав, исполнителя, итог ${price} и условия услуги, включая возврат и хранение платёжных данных.`,
          ),
        );
        const submit = element("button", "button", "Перейти к оплате Finik");
        submit.type = "submit";
        const notice = element("p", "footnote");
        notice.setAttribute("role", "status");
        form.append(consent, submit, notice);
        let cancelButton: HTMLButtonElement | undefined;
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!checkbox.checked || submit.disabled) return;
          submit.disabled = true;
          notice.textContent = "Подтверждаем счёт. Статус оплаты проверяем только на сервере.";
          void request<{ order: PaymentOrder }>("/miniapp/api/orders/checkout", {
            orderId: order.id,
            acceptTerms: true,
          })
            .then(({ order: latest }) => {
              if (started !== generation) return;
              const url = safeUrl(latest.invoiceUrl);
              if (!url)
                throw new Error("Платёжная ссылка не подтверждена. Обновите статус заказа.");
              status.textContent = paymentOrderStatus(latest);
              if (latest.acceptedAt) cancelButton?.remove();
              const link = sourceLink(url, "Открыть подтверждённую страницу Finik");
              notice.replaceChildren(
                document.createTextNode("Если уже оплатили — не платите повторно. "),
                link,
              );
              if (telegram?.openLink) telegram.openLink(url);
              // Outside Telegram, a user-initiated anchor avoids blocked async popups.
            })
            .catch((error: unknown) => {
              if (started === generation) notice.textContent = errorText(error);
            })
            .finally(() => {
              if (started === generation) submit.disabled = false;
            });
        });
        panel.append(element("p", "footnote", PAYMENT_PRIVACY_NOTICE), form);
        if (!order.acceptedAt) {
          cancelButton = button(
            "Отказаться от предложения",
            () => {
              void request("/miniapp/api/orders/cancel", { orderId: order.id })
                .then(() => {
                  if (started === generation) void load();
                })
                .catch((error: unknown) => {
                  if (started === generation) notice.textContent = errorText(error);
                });
            },
            "button button-quiet",
          );
          panel.append(cancelButton);
        }
      }
      main.append(panel);
    }
    main.append(
      element(
        "p",
        "footnote",
        "Finik подтверждает платёж, а не выполнение осмотра. Возвращение из банковского приложения или сообщение платёжной страницы не заменяют серверное подтверждение.",
      ),
    );
    const focused = new URLSearchParams(window.location.search).get("order_id");
    if (focused) document.getElementById(`order-${focused}`)?.scrollIntoView({ block: "start" });
  } catch (error) {
    if (started === generation) showState("Заказы недоступны", errorText(error), true);
  }
}

async function load(): Promise<void> {
  cancelRequests();
  const started = generation;
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const id = params.get("car");
  currentView =
    view === "vin" ||
    view === "buy" ||
    view === "sell" ||
    view === "report-example" ||
    view === "orders"
      ? view
      : id !== null
        ? "car"
        : "home";
  window.scrollTo(0, 0);
  if (currentView === "home") {
    showHome();
    return;
  }
  if (currentView === "orders") {
    await showOrders();
    return;
  }
  if (currentView === "vin") {
    const main = shell();
    main.append(vinPanel(), premiumPanel());
    return;
  }
  if (currentView === "report-example") {
    showExample();
    return;
  }
  if (currentView === "buy" || currentView === "sell") {
    showDialogue(currentView);
    return;
  }
  if (!id || id.length > 200 || params.getAll("car").length !== 1) {
    showState(
      "Не удалось определить автомобиль",
      "Откройте карточку по кнопке под объявлением в чате или вернитесь на главную.",
    );
    return;
  }
  showState("Открываем карточку", "Загружаем сведения из объявления…");
  try {
    const car = await request<MiniAppCar>(`/miniapp/api/car?id=${encodeURIComponent(id)}`);
    if (started === generation) showCar(car);
  } catch (error) {
    if (started === generation) showState("Карточка недоступна", errorText(error), true);
  }
}

telegram?.ready?.();
telegram?.expand?.();
telegram?.BackButton?.onClick?.(() => (currentView === "home" ? closeCard() : navigate("home")));
telegram?.BackButton?.show?.();
void load();
