import { normalizeVin, VIN_SOURCE_URLS, type VinCheckResult } from "@autodom/core/vin";
import type { MiniAppCar } from "../src/miniapp-contract.js";
import { VIN_CAUTION, VIN_DISCLOSURE, vinSourceText } from "../src/vin-text.js";

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

function sourceLink(url: string, text: string): HTMLAnchorElement {
  const link = element("a", "source-link", text);
  link.href = url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  link.addEventListener("click", (event) => {
    if (telegram?.openLink) {
      event.preventDefault();
      telegram.openLink(url);
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
  header.append(
    element("span", "brand", "Автодом"),
    button("Вернуться в чат", closeCard, "button button-quiet"),
  );
  const note = element("p", "footnote");
  note.id = "close-note";
  note.setAttribute("role", "status");
  root.replaceChildren(header, main, note);
  return main;
}

function showState(title: string, message: string, retry = false): void {
  const main = shell();
  const state = element("section", "state");
  state.append(element("p", "eyebrow", "Детали автомобиля"), element("h1", "", title));
  const description = element("p", "", message);
  description.setAttribute("role", "status");
  state.append(description);
  if (retry) state.append(button("Повторить загрузку", () => void load()));
  state.append(element("p", "footnote", "Подбор автомобилей и настройки поиска остаются в чате."));
  main.append(state);
}

function gallery(car: MiniAppCar): HTMLElement {
  const section = element("section", "gallery");
  section.setAttribute("aria-label", "Фотографии автомобиля");
  const photos = car.photoUrls.map(safeUrl).filter((url): url is string => url !== null);
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
    image.alt = `${car.title} — фото ${selected + 1}`;
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
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

function vinPanel(car: MiniAppCar): HTMLElement {
  const panel = element("section", "panel vin-panel");
  panel.append(
    element("p", "eyebrow", "История автомобиля"),
    element("h2", "", "Проверка корейского VIN"),
    element(
      "p",
      car.vin ? "vin" : "muted",
      car.vin
        ? `VIN из объявления: ${car.vin}`
        : "Источник не указал VIN или номер кузова. Введите VIN с автомобиля или документов.",
    ),
    element("p", "footnote", VIN_DISCLOSURE),
    element(
      "p",
      "footnote",
      "Введённый вручную VIN не подтверждён как VIN этого объявления. Даже номер от источника нужно сверить с автомобилем и документами.",
    ),
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
  input.value = car.vin ?? "";
  const submit = element("button", "button", "Проверить VIN");
  submit.type = "submit";
  const results = element("div", "vin-results");
  results.setAttribute("role", "status");
  results.setAttribute("aria-live", "polite");
  input.addEventListener("input", () => results.replaceChildren());
  form.append(label, input, submit);
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
    if (!telegram?.initData) {
      results.replaceChildren(
        element("p", "", "Откройте карточку заново из личного чата в Telegram."),
      );
      return;
    }
    input.value = vin;
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = "Проверяем…";
    results.replaceChildren(element("p", "", `Проверяем VIN ${vin} у подключённых провайдеров…`));
    const controller = new AbortController();
    const onHide = () => controller.abort();
    window.addEventListener("pagehide", onHide, { once: true });
    try {
      const response = await fetch("/miniapp/api/vin", {
        method: "POST",
        headers: { Authorization: `tma ${telegram.initData}`, "Content-Type": "application/json" },
        body: JSON.stringify({ vin }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = "Проверка временно недоступна. Результат неизвестен; повторите позже.";
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
          // An upstream proxy may return a non-JSON error.
        }
        results.replaceChildren(element("p", "", message));
        return;
      }
      const result = (await response.json()) as VinCheckResult;
      if (result.vin !== vin) throw new Error("VIN result mismatch");
      results.replaceChildren(element("p", "vin", `Результат для VIN ${result.vin}`));
      for (const provider of ["carhistory", "car365"] as const) {
        const section = element("section", "vin-source");
        section.dataset.status = result[provider].status;
        section.append(
          element("p", "vin-observation", vinSourceText(provider, result)),
          sourceLink(
            VIN_SOURCE_URLS[provider],
            provider === "carhistory" ? "Источник: CarHistory" : "Источник: Car365",
          ),
        );
        results.append(section);
      }
    } catch {
      results.replaceChildren(
        element(
          "p",
          "",
          "Не удалось завершить проверку VIN. Результат неизвестен — это не отсутствие записей. Попробуйте позже.",
        ),
      );
    } finally {
      window.removeEventListener("pagehide", onHide);
      input.disabled = false;
      submit.disabled = false;
      submit.textContent = "Проверить VIN";
    }
  }
  panel.append(form, results, element("p", "footnote", VIN_CAUTION));
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
  main.append(heading, gallery(car));
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
  main.append(vinPanel(car));
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

async function load(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("car");
  if (!id || id.length > 200 || params.getAll("car").length !== 1) {
    showState(
      "Выберите автомобиль в чате",
      "Откройте дополнительные сведения кнопкой под конкретным объявлением. Каталога в приложении нет.",
    );
    return;
  }
  const initData = telegram?.initData;
  if (!initData) {
    showState(
      "Откройте карточку в Telegram",
      "Обычная ссылка в браузере не даёт доступа к сведениям. Используйте кнопку под автомобилем в личном чате с ботом.",
    );
    return;
  }
  showState("Открываем карточку", "Загружаем сведения из объявления…");
  try {
    const response = await fetch(`/miniapp/api/car?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `tma ${initData}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const titles: Record<number, string> = {
        400: "Не удалось определить автомобиль",
        401: "Откройте карточку заново",
        403: "Нужен личный чат с ботом",
        404: "Карточка больше недоступна",
      };
      let message = "Не удалось загрузить сведения. Попробуйте ещё раз позже.";
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
        // Reverse proxies may respond without JSON.
      }
      showState(
        titles[response.status] ?? "Не удалось загрузить карточку",
        message,
        response.status >= 500,
      );
      return;
    }
    showCar((await response.json()) as MiniAppCar);
  } catch {
    showState(
      "Нет соединения",
      "Не удалось связаться с сервисом. Проверьте подключение и повторите загрузку.",
      true,
    );
  }
}

telegram?.ready?.();
telegram?.expand?.();
telegram?.BackButton?.onClick?.(closeCard);
telegram?.BackButton?.show?.();
void load();
