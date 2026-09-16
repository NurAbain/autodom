import type { PaymentOrder, VinReportKind } from "@autodom/core/payments";
import { isEncarPhotoUrl, normalizeVin } from "@autodom/core/vin";
import {
  groupVinArchiveLots,
  isVinArchivePhotoUrl,
  VIN_ARCHIVE_AUCTION_NAMES,
  VIN_ARCHIVE_COVERAGE_NOTICE,
  VIN_ARCHIVE_PHOTO_MAX_BYTES,
  type VinArchivePhotoRequest,
  type VinArchiveResult,
} from "@autodom/core/vin-archive";
import {
  ANALYTICS_REASON_LABELS,
  type AnalyticsReason,
  NON_PURCHASE_REASONS,
  PURCHASE_REASONS,
} from "../src/analytics-contract.js";
import { type BotMode, loadReportBotUrl } from "../src/bot-mode.js";
import { CARFAX_REPORT_EXAMPLE_PDF } from "../src/carfax-report-example.js";
import type { Reply } from "../src/conversation.js";
import { KOREAN_REPORT_EXAMPLE_PDF } from "../src/korean-report-example.js";
import type { MiniAppCar, MiniAppFinikMethods, MiniAppVinResult } from "../src/miniapp-contract.js";
import {
  PAYMENT_PRIVACY_NOTICE,
  paymentAmountText,
  paymentOrderStatus,
  VIN_REPORT_SLA_MS,
} from "../src/payment-text.js";
import {
  confirmedEncarListings,
  confirmedVinReportKind,
  hasKoreanVinRecord,
  VIN_CAUTION,
  VIN_DISCLOSURE,
  vinSummary,
} from "../src/vin-text.js";

type TelegramApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  openInvoice?: (url: string, callback: (status: string) => void) => void;
  BackButton?: {
    show?: () => void;
    onClick?: (callback: () => void) => void;
  };
};
const telegram = (window as Window & { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
const root = document.getElementById("app")!;

type View =
  | "home"
  | "vin"
  | "checkout"
  | "buy"
  | "sell"
  | "report-example"
  | "carfax-example"
  | "car"
  | "orders"
  | "support";
let currentView: View = "home";
let generation = 0;
const pending = new Set<AbortController>();
const reportUrls = new Set<string>();
let config: { mode: BotMode; reportBotUrl?: string; analyticsEnabled: boolean } | undefined;
type CheckoutProduct = "vin_report" | "vin_photos";
let launchConsumed = false;

function appPath(path: string): string {
  return `${new URL(".", window.location.href).pathname}${path.slice("/miniapp/".length)}`;
}

async function loadConfig(): Promise<void> {
  const response = await fetch(appPath("/miniapp/api/config"), {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Не удалось загрузить настройки. Попробуйте ещё раз.");
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("mode" in value) ||
    (value.mode !== "full" && value.mode !== "vin")
  )
    throw new Error("Настройки недоступны. Откройте приложение заново.");
  let reportBotUrl: string | undefined;
  if (value.mode === "full" && "reportBotUrl" in value && value.reportBotUrl !== undefined) {
    if (typeof value.reportBotUrl !== "string") throw new Error("Адрес VIN-бота недоступен.");
    try {
      reportBotUrl = loadReportBotUrl({
        AUTODOM_BOT_MODE: value.mode,
        AUTODOM_REPORT_BOT_URL: value.reportBotUrl,
      });
    } catch {
      throw new Error("Адрес VIN-бота недоступен.");
    }
  }
  config = {
    mode: value.mode,
    analyticsEnabled: "analyticsEnabled" in value && value.analyticsEnabled === true,
    ...(reportBotUrl ? { reportBotUrl } : {}),
  };
  document.documentElement.dataset.botMode = config.mode;
  document.title =
    config.mode === "vin" ? "АвтоКГ — бесплатная проверка VIN" : "Автодом — автомобили";
}

function cancelRequests(): void {
  generation += 1;
  for (const controller of pending) controller.abort();
  pending.clear();
  for (const url of reportUrls) URL.revokeObjectURL(url);
  reportUrls.clear();
}

window.addEventListener("pagehide", cancelRequests);
window.addEventListener("popstate", () => void load());

function navigate(view: View, targetId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("car");
  url.searchParams.delete("view");
  url.searchParams.delete("order_id");
  url.searchParams.delete("vin");
  url.searchParams.delete("product");
  url.searchParams.delete("startapp");
  url.searchParams.delete("tgWebAppStartParam");
  url.searchParams.delete("start_param");
  if (view === "car" && targetId) url.searchParams.set("car", targetId);
  else if (view !== "home") url.searchParams.set("view", view);
  if (view === "orders" && targetId) url.searchParams.set("order_id", targetId);
  if (view === "vin" && targetId) url.searchParams.set("vin", targetId);
  window.history.pushState(null, "", url);
  void load();
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  readResponse?: (response: Response) => Promise<T>,
): Promise<T> {
  if (!telegram?.initData) {
    throw new Error(
      "Откройте приложение из личного чата с ботом в Telegram для защищённого доступа.",
    );
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const started = generation;
  pending.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(appPath(path), {
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
      throw new HttpError(response.status, message);
    }
    const result = readResponse ? await readResponse(response) : ((await response.json()) as T);
    if (started !== generation || controller.signal.aborted) throw new Error("Request interrupted");
    return result;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    pending.delete(controller);
  }
}

type ClientAnalytics =
  | { event: "miniapp_opened" }
  | { event: "report_sample_opened" | "report_checkout_started"; vin: string }
  | { event: "report_checkout_started"; orderId: string }
  | { event: "feedback_submitted"; polarity: "negative"; reason: AnalyticsReason; vin: string }
  | { event: "feedback_submitted"; polarity: "positive"; reason: AnalyticsReason; orderId: string };

async function track(event: ClientAnalytics): Promise<boolean> {
  if (!telegram?.initData || !config?.analyticsEnabled) return false;
  try {
    // Independent of view cancellation: following a link must not cancel its click event.
    // No retries, cookies, external trackers, or influence on the underlying action.
    const response = await fetch(appPath("/miniapp/api/analytics"), {
      method: "POST",
      headers: { Authorization: `tma ${telegram.initData}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...event, nonce: crypto.randomUUID() }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    });
    return response.ok && ((await response.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

function reportFeedback(context: { vin: string } | { orderId: string }): HTMLElement {
  const positive = "orderId" in context;
  const panel = element("details", "disclosure");
  panel.hidden = !config?.analyticsEnabled;
  panel.append(
    element(
      "summary",
      "",
      positive
        ? "Почему выбрали отчёт? Необязательно"
        : "Пока не покупаете? Поделитесь причиной — необязательно",
    ),
  );
  const form = element("form", "vin-form");
  const label = element("label", "footnote", "Выберите одну причину");
  const select = element("select", "text-input");
  select.setAttribute("aria-label", "Причина решения");
  select.required = true;
  const placeholder = element("option", "", "Выберите причину");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  for (const reason of positive ? PURCHASE_REASONS : NON_PURCHASE_REASONS) {
    const option = element("option", "", ANALYTICS_REASON_LABELS[reason]);
    option.value = reason;
    select.append(option);
  }
  const submit = element("button", "button button-quiet", "Отправить ответ");
  submit.type = "submit";
  const notice = element("p", "footnote");
  notice.setAttribute("role", "status");
  label.append(select);
  form.append(label, submit, notice);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    const reason = select.value as AnalyticsReason;
    void track(
      "orderId" in context
        ? { event: "feedback_submitted", polarity: "positive", reason, orderId: context.orderId }
        : { event: "feedback_submitted", polarity: "negative", reason, vin: context.vin },
    ).then((recorded) => {
      notice.textContent = recorded
        ? "Спасибо за ответ."
        : "Сейчас ответ не удалось сохранить. Это не влияет на проверку и заказ.";
      submit.disabled = recorded;
    });
  });
  panel.append(form);
  return panel;
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

function reportBotLink(payload: string, label: string, className = "button"): HTMLAnchorElement {
  const url = new URL(config!.reportBotUrl!);
  url.searchParams.delete("start");
  url.searchParams.delete("startapp");
  url.searchParams.set(payload.startsWith("buy_") ? "startapp" : "start", payload);
  const link = element("a", className, label);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (event) => {
    if (telegram?.openTelegramLink) {
      event.preventDefault();
      telegram.openTelegramLink(link.href);
    }
  });
  return link;
}

function showSupport(): void {
  const main = shell();
  main.append(
    element("h1", "", "Помощь с отчётом"),
    element("p", "", "Вопрос по оплате, PDF или полному возврату? Напишите в чат с ботом:"),
    element("p", "notice", "/paysupport — номер заказа и ваш вопрос"),
    element(
      "p",
      "footnote",
      "Не отправляйте данные карты или коды банка. Заявка на возврат не означает, что деньги уже возвращены.",
    ),
    config?.reportBotUrl
      ? reportBotLink("paysupport", "Открыть поддержку VIN-бота")
      : button("Перейти в чат", closeCard),
  );
}

function showDelegatedOrders(): void {
  const main = shell();
  main.append(
    element("h1", "", "Ваши отчёты — в VIN-боте"),
    element(
      "p",
      "muted",
      "Покупка, статусы оплаты и PDF собраны в одном боте. Бесплатная проверка VIN остаётся здесь.",
    ),
    reportBotLink("orders", "Открыть мои заказы"),
    reportBotLink("paysupport", "Поддержка и возврат", "source-link"),
  );
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
  const brandName = config?.mode === "vin" ? "АвтоКГ · VIN" : "Автодом";
  const brand = button(brandName, () => navigate("home"), "brand");
  brand.setAttribute("aria-label", `${brandName} — на главную`);
  header.append(brand, button("В чат", closeCard, "button button-quiet"));
  if (config?.mode === "vin") {
    const nav = element("nav", "vin-navigation");
    nav.setAttribute("aria-label", "VIN и отчёты");
    for (const [view, label] of [
      ["vin", "Проверка VIN"],
      ["orders", "Заказы"],
      ["support", "Помощь"],
    ] as const) {
      const item = button(label, () => navigate(view), "vin-nav-item");
      if (currentView === view) item.setAttribute("aria-current", "page");
      nav.append(item);
    }
    header.append(nav);
  }
  if (currentView !== "home" && !(config?.mode === "vin" && currentView === "vin")) {
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
  state.append(
    element("p", "eyebrow", config?.mode === "vin" ? "АвтоКГ · VIN" : "Автодом"),
    element("h1", "", title),
  );
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
    ["vin", "01", "Проверить VIN", "Бесплатные данные об автомобиле. VIN или фото в чате."],
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

function samplePdfLink(reportKind: VinReportKind = "korea", vin?: string): HTMLAnchorElement {
  const example = reportKind === "carfax" ? CARFAX_REPORT_EXAMPLE_PDF : KOREAN_REPORT_EXAMPLE_PDF;
  const link = element(
    "a",
    "button sample-pdf",
    reportKind === "carfax" ? example.label : "Открыть оригинальный PDF",
  );
  link.href = reportKind === "carfax" ? example.path : appPath(example.path);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (vin)
    link.addEventListener("click", () => {
      void track({ event: "report_sample_opened", vin });
    });
  return link;
}

function navigateCheckout(
  vin: string,
  product: CheckoutProduct,
  orderId?: string,
  reportKind?: VinReportKind | null,
): void {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("view", "checkout");
  url.searchParams.set("vin", vin);
  url.searchParams.set("product", product);
  if (orderId) url.searchParams.set("order_id", orderId);
  if (reportKind) url.searchParams.set("report_kind", reportKind);
  window.history.pushState(null, "", url);
  void load();
}

function purchaseAction(
  result: MiniAppVinResult,
  product: CheckoutProduct,
  label: string,
): HTMLElement {
  if (config?.reportBotUrl) {
    const link = reportBotLink(
      `buy_${product === "vin_photos" ? "photos" : "report"}_${result.vin}${product === "vin_report" && result.reportKind ? `_${result.reportKind}` : ""}`,
      label,
    );
    if (product === "vin_report")
      link.addEventListener("click", () => {
        void track({ event: "report_checkout_started", vin: result.vin });
      });
    return link;
  }
  const buy = button(label, () => {
    if (buy.disabled) return;
    buy.disabled = true;
    navigateCheckout(
      result.vin,
      product,
      undefined,
      product === "vin_report" ? result.reportKind : null,
    );
  });
  return buy;
}

function premiumPanel(result: MiniAppVinResult): HTMLElement | null {
  const reportKind = confirmedVinReportKind(result);
  if (!reportKind || reportKind !== result.reportKind) return null;
  const panel = element("section", "panel premium-panel");
  const sample = samplePdfLink(reportKind, result.vin);
  sample.textContent = "Посмотреть образец PDF";
  panel.append(
    element(
      "h2",
      "",
      reportKind === "carfax" ? "Для вашего авто есть полный отчёт CARFAX" : "Полный отчёт найден",
    ),
    element("p", "footnote", "Образец показывает формат, а не историю вашего автомобиля."),
    sample,
  );
  const price = result.reportPrice ? paymentAmountText(result.reportPrice) : null;
  if (price && (config?.reportBotUrl || result.reportSalesEnabled))
    panel.append(purchaseAction(result, "vin_report", `Получить отчёт · ${price}`));
  else panel.append(element("p", "footnote", "Покупка доступа пока недоступна."));
  panel.append(
    element(
      "p",
      "footnote",
      `Доступ к отчёту — в течение ${VIN_REPORT_SLA_MS / 60_000} минут после подтверждённой оплаты. Если получить отчёт невозможно — полный возврат.`,
    ),
    reportFeedback({ vin: result.vin }),
  );
  return panel;
}

function photoAccessPanel(result: MiniAppVinResult): HTMLElement | null {
  const access = result.photoAccess;
  if (!access?.available || access.granted) return null;
  const panel = element("section", "panel photo-access");
  panel.append(
    element("h2", "", "Найдены фотографии автомобиля"),
    element(
      "p",
      "footnote",
      "Одна покупка открывает все найденные фотографии этого VIN: Корея и архивы аукционов. Отчёт приобретается отдельно.",
    ),
  );
  if (access.salesEnabled || config?.reportBotUrl)
    panel.append(
      purchaseAction(
        result,
        "vin_photos",
        `Получить фотографии · ${paymentAmountText(access.price)}`,
      ),
    );
  else panel.append(element("p", "footnote", "Покупка фотографий пока недоступна."));
  return panel;
}

function showExample(): void {
  const main = shell();
  const heading = element("section", "example-heading");
  heading.append(
    element("p", "badge", "ПРИМЕР · НЕ НОВАЯ ПРОВЕРКА"),
    element("h1", "", "Оригинальный отчёт · PDF"),
    element("p", "footnote", KOREAN_REPORT_EXAMPLE_PDF.caption),
    samplePdfLink(),
    element(
      "p",
      "footnote",
      "Если документ не отображается, откройте оригинальный PDF по ссылке выше.",
    ),
  );
  const viewer = element("iframe", "report-pdf-viewer");
  viewer.title = "Пример оригинального корейского отчёта";
  viewer.src = appPath(KOREAN_REPORT_EXAMPLE_PDF.path);
  main.append(
    heading,
    viewer,
    button("Перейти к проверке своего VIN", () => navigate("vin")),
  );
}

function showCarfaxExample(): void {
  const main = shell();
  main.append(
    element("p", "badge", "ПУБЛИЧНЫЙ ОБРАЗЕЦ · НЕ ВАШ ОТЧЁТ"),
    element("h1", "", "CARFAX · образец PDF"),
    element("p", "footnote", CARFAX_REPORT_EXAMPLE_PDF.caption),
    samplePdfLink("carfax"),
    element(
      "p",
      "footnote",
      "Внешний публичный образец, не отчёт по вашему VIN. PDF откроется на сайте источника только после нажатия.",
    ),
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
        ? "Настройте условия и проверьте подбор перед сохранением. В приложении и чате — один поиск."
        : "Расскажите об авто и цели. Анкета продажи отделена от поиска автомобиля.",
    ),
  );
  const content = element("div", "dialogue-content");
  const status = element("p", "footnote dialogue-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const form = element("form", "dialogue-form");
  const label = element("label", "", "Ваш ответ");
  label.htmlFor = "dialogue-input";
  const input = element("input", "text-input");
  input.id = "dialogue-input";
  input.name = "answer";
  input.type = "text";
  input.placeholder = "Напишите ответ…";
  input.autocomplete = "off";
  input.maxLength = 2048;
  input.required = true;
  const submit = element("button", "button", "Отправить");
  submit.type = "submit";
  form.append(label, input, submit);
  form.hidden = true;
  const cancel = button("Отменить текущий шаг", () => void send("/cancel"), "back-link");
  main.append(content, status, cancel);
  let busy = false;
  let inputContext = "";
  const expandedFilters = new Map<string, boolean>();

  function runAction(command: string): void {
    if (busy) return;
    if (command === "vin-report-example") samplePdfLink().click();
    else if (command === "/vin") navigate("vin");
    else if (command === "/start") navigate("home");
    else if (command === "/buy" && view !== "buy") navigate("buy");
    else if ((command === "/sell" || command === "/mycar") && view !== "sell") navigate("sell");
    else void send(command);
  }

  function renderReply(reply: Reply): HTMLElement {
    const section = element("section", "panel dialogue-reply");
    section.tabIndex = -1;
    const editor = view === "buy" ? reply.filterEditor : undefined;
    const representedCommands = new Set<string>();
    if (reply.picker) {
      section.classList.add("dialogue-picker");
      const heading = element("header", "picker-heading");
      if (reply.picker.subtitle)
        heading.append(element("p", "picker-breadcrumb", reply.picker.subtitle));
      heading.append(element("h2", "", reply.picker.title));
      const meta = element("div", "picker-meta");
      meta.append(
        element("span", "badge", `Выбрано: ${reply.picker.selected}`),
        element("span", "footnote", `Страница ${reply.picker.page} из ${reply.picker.pages}`),
      );
      heading.append(meta);
      section.append(heading);
      section.setAttribute("aria-label", reply.picker.title);
    }
    const text = element("div", "reply-text");
    text.append(richText(reply.text, null));
    const repeatedTitle = text.firstChild;
    if (
      reply.picker &&
      repeatedTitle instanceof HTMLElement &&
      (repeatedTitle.tagName === "B" || repeatedTitle.tagName === "STRONG") &&
      repeatedTitle.textContent === reply.picker.title
    ) {
      repeatedTitle.remove();
      const firstLine = text.firstChild;
      const prefix = `\n${reply.picker.subtitle ?? ""}\n`;
      if (firstLine?.nodeType === Node.TEXT_NODE && firstLine.textContent?.startsWith(prefix))
        firstLine.textContent = firstLine.textContent.slice(prefix.length);
    }
    if (editor) {
      section.classList.add("dialogue-filter-editor");
      section.setAttribute("aria-label", "Условия поиска");
      section.append(element("h2", "", "Условия поиска"));
      if (editor.description)
        section.append(element("p", "filter-description", editor.description));
      if (editor.chips.length) {
        const selected = element("div", "filter-selected");
        selected.append(element("h3", "", "Выбранные условия"));
        const chips = element("div", "filter-chips");
        for (const chip of editor.chips) {
          representedCommands.add(chip.command);
          const control = button(
            "",
            () => runAction(chip.command),
            "button button-quiet filter-chip",
          );
          control.setAttribute("aria-label", `Убрать условие: ${chip.label}`);
          control.dataset.focusLabel = `chip:${chip.label}`;
          const remove = element("span", "filter-chip-remove", "×");
          remove.setAttribute("aria-hidden", "true");
          control.append(element("span", "", chip.label), remove);
          chips.append(control);
        }
        selected.append(chips);
        section.append(selected);
      }
      for (const [index, group] of editor.sections.entries()) {
        const fields = element("div", "filter-fields");
        for (const field of group.fields) {
          representedCommands.add(field.command);
          const control = button(
            "",
            () => runAction(field.command),
            "button button-quiet filter-field",
          );
          control.dataset.focusLabel = `field:${group.title}:${field.label}`;
          const edit = element("span", "filter-field-edit", "Изменить");
          edit.setAttribute("aria-hidden", "true");
          control.append(
            element("span", "filter-field-label", field.label),
            element("span", "filter-field-value", field.value),
            edit,
          );
          fields.append(control);
        }
        if (index === 0) {
          const primary = element("fieldset", "filter-group");
          primary.append(element("legend", "", group.title), fields);
          section.append(primary);
        } else {
          const secondary = element("details", "filter-group filter-secondary");
          secondary.open = expandedFilters.get(group.title) ?? index < 3;
          secondary.addEventListener("toggle", () => {
            if (secondary.isConnected) expandedFilters.set(group.title, secondary.open);
          });
          secondary.append(element("summary", "", group.title), fields);
          section.append(secondary);
        }
      }
      const summary = element("details", "filter-summary");
      summary.append(element("summary", "", "Сводка и пояснения"), text);
      section.append(summary);
    } else {
      section.append(text);
    }
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
            ? "Разобрать пример на русском"
            : target === "vin"
              ? "Открыть проверку VIN"
              : "Открыть",
          () => navigate(target),
          "button button-quiet",
        ),
      );
    }
    const actions = element("div", "dialogue-actions");
    const options = element("div", "picker-options");
    const pickerOptions = new Map(reply.picker?.options.map((option) => [option.command, option]));
    if (reply.picker) {
      options.setAttribute("role", "group");
      options.setAttribute("aria-label", `Варианты: ${reply.picker.title}`);
    }
    for (const row of reply.buttons) {
      const group = element("div", "button-row");
      for (const [label, command] of row) {
        if (representedCommands.has(command)) continue;
        const url = safeUrl(command);
        let control: HTMLButtonElement | HTMLAnchorElement;
        if (command === "vin-report-example") {
          control = samplePdfLink();
        } else if (url) {
          control = sourceLink(url, label);
          control.className = "button button-quiet";
        } else {
          control = button(label, () => runAction(command), "button button-quiet");
        }
        control.dataset.focusLabel = label.replace(/^✓\s*/, "");
        const option = pickerOptions.get(command);
        if (option) {
          control.classList.add("picker-option");
          control.setAttribute("aria-pressed", String(option.selected));
          options.append(control);
        } else {
          if (reply.picker?.applyCommand === command) {
            control.classList.remove("button-quiet");
            control.classList.add("picker-apply");
          }
          if (editor?.applyCommand === command) {
            control.classList.remove("button-quiet");
            control.classList.add("filter-save");
            group.classList.add("filter-save-row");
          }
          group.append(control);
        }
      }
      if (group.childElementCount) actions.append(group);
    }
    if (options.childElementCount) section.append(options);
    section.append(actions);
    if (editor?.applyCommand)
      section.append(
        element(
          "p",
          "filter-save-note",
          "Уведомления включатся только при выборе сохранения с мониторингом.",
        ),
      );
    return section;
  }

  function positionInput(replies: Reply[], sections: HTMLElement[]): void {
    const index = replies.length - 1;
    const reply = replies[index];
    const section = sections[index];
    if (!reply || !section) {
      form.remove();
      return;
    }
    const searching = reply.picker?.searchable === true;
    const context =
      searching || reply.input
        ? JSON.stringify([reply.picker?.title, reply.picker?.subtitle, reply.input])
        : "";
    if (searching) input.value = reply.picker!.search;
    else if (!context || context !== inputContext) input.value = "";
    inputContext = context;
    form.hidden = !reply.input && (view === "buy" || !!reply.picker) && !searching;
    label.textContent = reply.input?.label ?? (searching ? "Поиск по справочнику" : "Ваш ответ");
    input.placeholder =
      reply.input?.placeholder ?? (searching ? "Введите название…" : "Напишите ответ…");
    input.type = searching ? "search" : "text";
    input.inputMode = reply.input?.mode ?? "text";
    input.enterKeyHint = searching ? "search" : "send";
    input.spellcheck = !reply.picker && input.inputMode === "text";
    submit.textContent = searching ? "Найти" : reply.input ? "Применить" : "Отправить";
    form.classList.toggle("dialogue-search", searching);
    const searchPosition = searching ? section.querySelector(".picker-heading")?.nextSibling : null;
    section.insertBefore(
      form,
      searchPosition ?? section.querySelector(".picker-options, .dialogue-actions"),
    );
  }

  async function send(text: string): Promise<void> {
    if (busy || !text.trim()) return;
    const focused = document.activeElement;
    const restoreInput = focused === input || focused === submit;
    const focusLabel = focused instanceof HTMLElement ? focused.dataset.focusLabel : undefined;
    busy = true;
    status.textContent = "Открываем следующий шаг…";
    content.setAttribute("aria-busy", "true");
    content.querySelectorAll<HTMLButtonElement>("button").forEach((node) => {
      node.disabled = true;
    });
    input.disabled = true;
    submit.disabled = true;
    cancel.disabled = true;
    try {
      const result = await request<{ replies: Reply[] }>("/miniapp/api/dialogue", { text });
      if (started !== generation) return;
      const sections = result.replies.map(renderReply);
      content.replaceChildren(...sections);
      positionInput(result.replies, sections);
      if (result.replies.length === 0)
        content.append(
          element("p", "", "Ответ принят. Продолжите в чате или выберите другую цель."),
        );
      const picker = result.replies.at(-1)?.picker;
      status.textContent = picker
        ? `${picker.title}. Выбрано: ${picker.selected}. Страница ${picker.page} из ${picker.pages}.`
        : "Шаг обновлён.";
      input.disabled = false;
      const matching = focusLabel
        ? Array.from(content.querySelectorAll<HTMLElement>("[data-focus-label]")).find(
            (node) => node.dataset.focusLabel === focusLabel,
          )
        : undefined;
      if (!form.hidden && form.isConnected && (restoreInput || (view === "buy" && !matching))) {
        input.focus({ preventScroll: true });
      } else if (focusLabel) {
        if (matching instanceof HTMLButtonElement) matching.disabled = false;
        (matching ?? sections.at(-1))?.focus({ preventScroll: true });
      }
      if (!picker || (!focusLabel && !restoreInput)) {
        content.scrollIntoView({
          block: "start",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }
    } catch (error) {
      if (started !== generation) return;
      status.textContent = `${errorText(error)} Ваш последний шаг оставлен на экране. Если ответ успел сохраниться, продолжите с актуального шага в чате.`;
      if (!content.childElementCount)
        content.append(button("Открыть шаг заново", () => void send(text), "button button-quiet"));
      if (focused instanceof HTMLButtonElement || focused instanceof HTMLInputElement) {
        focused.disabled = false;
        if (focused.isConnected) focused.focus({ preventScroll: true });
      }
    } finally {
      if (started === generation) {
        busy = false;
        content.setAttribute("aria-busy", "false");
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

function gallery(
  title: string,
  photoUrls: readonly string[],
  archive?: { request: Omit<VinArchivePhotoRequest, "photo_url">; signal: AbortSignal },
  signal: AbortSignal | undefined = archive?.signal,
): HTMLElement {
  const section = element("section", "gallery");
  section.setAttribute("aria-label", `Фотографии: ${title}`);
  const photos = photoUrls.map(safeUrl).filter((url): url is string => url !== null);
  if (!photos.length) {
    section.append(element("p", "photo-empty", "Фотографии не предоставлены источником."));
    return section;
  }
  let selected = 0;
  let photoController: AbortController | undefined;
  let blobUrl: string | undefined;
  let visible = !archive;
  let observer: IntersectionObserver | undefined;
  const releasePhoto = (): void => {
    photoController?.abort();
    photoController = undefined;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = undefined;
  };
  signal?.addEventListener(
    "abort",
    () => {
      observer?.disconnect();
      releasePhoto();
      for (const image of section.querySelectorAll("img")) image.removeAttribute("src");
    },
    { once: true },
  );
  const failed = archive ? new Set<number>() : undefined;
  const photoLink = archive ? sourceLink(null, "Открыть оригинал фото") : undefined;
  const photoNotice = archive ? element("p", "notice") : undefined;
  if (photoNotice) photoNotice.hidden = true;
  const frame = element("div", "photo-frame");
  const progress = element("p", "footnote");
  progress.setAttribute("role", "status");
  section.append(progress);
  const counter = element("span", "photo-counter");
  counter.setAttribute("aria-live", "polite");
  const previous = button(
    archive ? "←" : "Предыдущее",
    () => {
      selected -= 1;
      renderPhoto();
    },
    "button button-quiet",
  );
  const next = button(
    archive ? "→" : "Следующее",
    () => {
      selected += 1;
      renderPhoto();
    },
    "button button-quiet",
  );
  if (archive) {
    previous.setAttribute("aria-label", "Предыдущее фото");
    next.setAttribute("aria-label", "Следующее фото");
  }
  function renderPhoto(): void {
    releasePhoto();
    if (signal?.aborted) return;
    progress.textContent = "Загружаем фотографию…";
    frame.setAttribute("aria-busy", "true");
    const index = selected;
    const imageUrl = photos[index];
    if (imageUrl === undefined) throw new RangeError("Photo index is out of bounds");
    if (failed?.has(index)) {
      frame.replaceChildren(element("p", "photo-empty", "Это фото источника недоступно."));
      progress.textContent = "Фотография недоступна.";
      frame.setAttribute("aria-busy", "false");
    } else {
      const image = element("img");
      image.alt = `${title} — фото ${selected + 1}`;
      image.referrerPolicy = "no-referrer";
      image.decoding = "async";
      image.loading = "lazy";
      image.addEventListener(
        "load",
        () => {
          if (!frame.contains(image) || signal?.aborted) return;
          progress.textContent = "";
          frame.setAttribute("aria-busy", "false");
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          failed?.add(index);
          if (photoNotice) {
            photoNotice.hidden = false;
            photoNotice.textContent =
              "Часть фотографий сейчас недоступна. Лот и события сохранены. Повторите проверку VIN.";
          }
          if (frame.contains(image)) {
            progress.textContent = "Фотография недоступна.";
            frame.setAttribute("aria-busy", "false");
            frame.replaceChildren(
              element("p", "photo-empty", "Источник не смог загрузить это фото."),
            );
            if (archive)
              counter.textContent = `Фото ${index + 1} недоступно · ${photos.length} ссылок`;
          }
        },
        { once: true },
      );
      frame.replaceChildren(image);
      if (!archive) image.src = imageUrl;
      if (archive && visible) {
        const controller = new AbortController();
        photoController = controller;
        void request<Blob>(
          "/miniapp/api/vin/archive-photo",
          { ...archive.request, photo_url: imageUrl },
          controller.signal,
          async (response) => {
            const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
            if (!["image/jpeg", "image/png", "image/webp"].includes(type))
              throw new Error("Источник не вернул фото.");
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Источник не вернул фото.");
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let size = 0;
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > VIN_ARCHIVE_PHOTO_MAX_BYTES) throw new Error("Фото слишком большое.");
                chunks.push(chunk.value);
              }
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
            if (!size) throw new Error("Источник не вернул фото.");
            return new Blob(chunks, { type });
          },
        )
          .then((blob) => {
            if (controller.signal.aborted || archive.signal.aborted || !frame.contains(image))
              return;
            blobUrl = URL.createObjectURL(blob);
            image.src = blobUrl;
          })
          .catch(() => {
            if (!controller.signal.aborted && !archive.signal.aborted && frame.contains(image))
              image.dispatchEvent(new Event("error"));
          });
      }
    }
    counter.textContent = archive
      ? `${failed?.has(selected) ? "Фото недоступно" : `Ссылка ${selected + 1}`} · ${photos.length} ссылок`
      : `${selected + 1} / ${photos.length}`;
    if (photoLink) photoLink.href = imageUrl;
    previous.disabled = selected === 0;
    next.disabled = selected === photos.length - 1;
  }
  section.append(frame);
  if (photos.length > 1 || archive) {
    const controls = element("div", "gallery-controls");
    controls.append(previous, counter, next);
    section.append(controls);
  }
  if (photoNotice && photoLink) section.append(photoNotice, photoLink);
  renderPhoto();
  if (archive && !signal?.aborted) {
    if (typeof IntersectionObserver === "undefined") {
      visible = true;
      queueMicrotask(renderPhoto);
    } else {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        visible = true;
        renderPhoto();
      });
      observer.observe(section);
    }
  }
  return section;
}

function vinPanel(car?: MiniAppCar): HTMLElement {
  const started = generation;
  const panel = element("section", "panel vin-panel");
  panel.append(
    element("p", "eyebrow", "Бесплатная проверка"),
    element(car ? "h2" : "h1", "", "Проверить VIN"),
    element(
      "p",
      "muted",
      "Введите VIN — бесплатно покажем найденные сведения об автомобиле и доступную историю.",
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
  const disclosure = element("details", "disclosure");
  disclosure.append(
    element("summary", "", "Конфиденциальность проверки"),
    element("p", "footnote", VIN_DISCLOSURE),
  );
  if (config?.analyticsEnabled) {
    disclosure.append(
      element(
        "p",
        "footnote",
        "Для улучшения продукта сохраняем псевдонимные события действий на 90 дней, без текста сообщений, VIN и контактов. Внешних трекеров нет. Подтверждённый /delete в боте удаляет аналитику и отключает дальнейший сбор; финансовые записи заказа сохраняются отдельно.",
      ),
    );
  }
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
  input.value =
    car?.vin ?? normalizeVin(new URLSearchParams(window.location.search).get("vin") ?? "") ?? "";
  input.placeholder = "Введите VIN автомобиля";
  const submit = element("button", "button", "Проверить VIN");
  submit.type = "submit";
  let lookupRevision = 0;
  let lookupController: AbortController | undefined;
  const results = element("div", "vin-results");
  results.setAttribute("role", "status");
  results.setAttribute("aria-live", "polite");
  input.addEventListener("input", () => {
    lookupRevision += 1;
    lookupController?.abort();
    lookupController = undefined;
    submit.disabled = false;
    submit.textContent = "Проверить VIN";
    input.removeAttribute("aria-invalid");
    results.setAttribute("aria-busy", "false");
    results.replaceChildren();
    disclosure.hidden = false;
  });
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!submit.disabled) void lookup();
  });
  function renderArchive(
    result: VinArchiveResult,
    vin: string,
    controller: AbortController,
    revision: number,
  ): HTMLElement {
    const archiveResults = element("section", "vin-results");
    archiveResults.append(element("h2", "", "Фотографии из архивов"));
    try {
      if (result.vin !== vin)
        throw new Error("Источник вернул результат для другого VIN. Этот результат не показан.");
      const sections: HTMLElement[] = [];
      for (const group of groupVinArchiveLots({
        ...result,
        sources: result.sources.filter((source) => source.status !== "disabled"),
      })) {
        const title = `${VIN_ARCHIVE_AUCTION_NAMES[group.auction]} · лот ${group.lot_id}`;
        const lotSection = element("section", "vin-source");
        lotSection.append(element("h3", "", title));
        const galleries = group.sources
          .map(({ provider, lot }) => ({
            provider,
            photoUrls: [
              ...new Set(
                lot.photos.filter((photo) =>
                  isVinArchivePhotoUrl(photo, provider, lot.auction, lot.lot_id, vin),
                ),
              ),
            ],
            lot,
          }))
          .filter(
            (candidate, index, all) =>
              candidate.photoUrls.length > 0 &&
              !all
                .slice(0, index)
                .some(
                  (previous) =>
                    previous.photoUrls.length === candidate.photoUrls.length &&
                    candidate.photoUrls.every((photo) => previous.photoUrls.includes(photo)),
                ),
          );
        if (galleries.length) {
          const galleryHost = element("div");
          const controls = element("div", "button-row");
          controls.setAttribute("aria-label", "Источник фотографий");
          const choices: HTMLButtonElement[] = [];
          let galleryController: AbortController | undefined;
          controller.signal.addEventListener("abort", () => galleryController?.abort(), {
            once: true,
          });
          const showGallery = (index: number): void => {
            if (
              started !== generation ||
              revision !== lookupRevision ||
              controller.signal.aborted ||
              normalizeVin(input.value) !== vin
            )
              return;
            galleryController?.abort();
            galleryController = new AbortController();
            if (controller.signal.aborted) galleryController.abort();
            const selected = galleries[index]!;
            galleryHost.replaceChildren(
              element(
                "p",
                "footnote",
                galleries.length > 1 ? `Набор фотографий ${index + 1}` : "Сохранившиеся фотографии",
              ),
              gallery(title, selected.photoUrls, {
                request: {
                  vin,
                  provider: selected.provider,
                  auction: selected.lot.auction,
                  lot_id: selected.lot.lot_id,
                },
                signal: galleryController.signal,
              }),
            );
            choices.forEach((choice, choiceIndex) => {
              choice.setAttribute("aria-pressed", String(choiceIndex === index));
            });
          };
          if (galleries.length > 1) {
            galleries.forEach((_, index) => {
              const choice = button(
                `Набор фото ${index + 1}`,
                () => showGallery(index),
                "button button-quiet",
              );
              choices.push(choice);
              controls.append(choice);
            });
            lotSection.append(controls);
          }
          lotSection.append(element("p", "footnote", "Найдены архивные фотографии."), galleryHost);
          showGallery(
            Math.max(
              0,
              galleries.findIndex(
                (candidate) => candidate.provider === group.photo_source.provider,
              ),
            ),
          );
        }
        if (galleries.length) sections.push(lotSection);
      }
      archiveResults.append(...sections);
    } catch (error) {
      archiveResults.append(
        element("p", "notice", `${errorText(error)} Часть архивных данных недоступна.`),
      );
    }
    archiveResults.append(element("p", "footnote", VIN_ARCHIVE_COVERAGE_NOTICE));
    return archiveResults;
  }
  async function lookup(): Promise<void> {
    if (started !== generation || submit.disabled) return;
    lookupController?.abort();
    lookupController = undefined;
    disclosure.hidden = false;
    const vin = normalizeVin(input.value);
    if (!vin) {
      input.setAttribute("aria-invalid", "true");
      results.replaceChildren(
        element(
          "p",
          "notice",
          "VIN должен содержать 17 латинских букв и цифр, без I, O, Q. Короткий номер кузова не подходит.",
        ),
      );
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    results.setAttribute("aria-busy", "true");
    const revision = ++lookupRevision;
    const controller = new AbortController();
    lookupController = controller;
    pending.add(controller);
    controller.signal.addEventListener("abort", () => pending.delete(controller), { once: true });
    input.value = vin;
    submit.disabled = true;
    submit.textContent = "Проверяем…";
    results.replaceChildren(element("p", "", `Проверяем VIN ${vin}…`));
    try {
      const result = await request<MiniAppVinResult>(
        "/miniapp/api/vin",
        { vin },
        controller.signal,
      );
      if (
        started !== generation ||
        revision !== lookupRevision ||
        controller.signal.aborted ||
        normalizeVin(input.value) !== vin
      )
        return;
      if (result.vin !== vin)
        throw new Error(
          "Источник вернул ответ для другого VIN. Не используйте его для проверки автомобиля.",
        );
      results.replaceChildren(element("p", "vin", `VIN ${result.vin}`));
      const korean = hasKoreanVinRecord(result);
      disclosure.hidden = korean;
      const summary = vinSummary(result);
      const section = element("section", "vin-source");
      if (summary.facts.length) section.append(element("h2", "", "Об автомобиле"));
      const facts = element("dl", "facts vin-summary-facts");
      for (const [label, value] of summary.facts) {
        const fact = element("div", "fact");
        const detail = element("dd");
        detail.append(element("strong", "", value));
        fact.append(element("dt", "", label), detail);
        facts.append(fact);
      }
      section.append(facts, ...summary.notes.map((note) => element("p", "footnote", note)));
      results.append(section);
      for (const listing of confirmedEncarListings(result)) {
        if (!result.photoAccess?.granted) continue;
        const photoUrls = [
          ...new Set(listing.photo_urls.filter((url) => isEncarPhotoUrl(url, listing.id))),
        ];
        if (photoUrls.length)
          results.append(
            gallery(`Объявление №${listing.id}`, photoUrls, undefined, controller.signal),
          );
      }
      if (
        result.photoAccess?.granted &&
        result.archives?.vin === vin &&
        result.archives.sources.some((source) => source.status !== "disabled" && source.lots.length)
      )
        results.append(renderArchive(result.archives, vin, controller, revision));
      const photos = photoAccessPanel(result);
      if (photos) results.append(photos);
      const report = premiumPanel(result);
      if (report) results.append(report);
    } catch (error) {
      if (started !== generation || revision !== lookupRevision || controller.signal.aborted)
        return;
      results.replaceChildren(
        element(
          "p",
          "notice",
          `${errorText(error)} Результат неизвестен — это не отсутствие записей.`,
        ),
      );
    } finally {
      if (started === generation && revision === lookupRevision) {
        submit.disabled = false;
        submit.textContent = "Проверить VIN";
        results.setAttribute("aria-busy", "false");
      }
    }
  }
  const photoHelp = element(
    "p",
    "footnote vin-photo-help",
    "VIN на фото? Отправьте фото в чат и подтвердите распознанный номер перед проверкой.",
  );
  panel.append(form, photoHelp, results, element("p", "footnote", VIN_CAUTION), disclosure);
  if (!car && normalizeVin(new URLSearchParams(window.location.search).get("vin") ?? ""))
    queueMicrotask(() => {
      if (started === generation && panel.isConnected) void lookup();
    });
  return panel;
}

function showCar(car: MiniAppCar): void {
  const main = shell();
  const heading = element("section", "car-heading");
  heading.append(
    element("p", "eyebrow", car.market),
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
    ["Статус объявления", car.availability || "Не указан"],
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
  text.append(richText(car.detailsHtml, null));
  details.append(text);
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

function finikMethods(order: PaymentOrder): HTMLElement {
  const started = generation;
  const panel = element("section", "payment-methods");
  const list = element("div", "payment-method-list");
  const notice = element("p", "footnote");
  notice.setAttribute("role", "status");
  const current = () => started === generation && panel.isConnected;
  const card = button(
    "Visa / Mastercard",
    () => {
      if (card.disabled) return;
      card.disabled = true;
      card.setAttribute("aria-busy", "true");
      notice.textContent = "Открываем защищённую форму оплаты картой…";
      void request<{ cardUrl: string }>("/miniapp/api/orders/card-payment", { orderId: order.id })
        .then(({ cardUrl }) => {
          if (!current()) return;
          const url = safeUrl(cardUrl);
          if (!url) throw new Error("Форма оплаты не подтверждена. Откройте Finik ниже.");
          const link = sourceLink(url, "Открыть форму оплаты картой");
          notice.replaceChildren(link);
          if (telegram?.openLink) telegram.openLink(url);
          else link.click();
        })
        .catch((error: unknown) => {
          if (current()) notice.textContent = errorText(error);
        })
        .finally(() => {
          if (current()) {
            card.disabled = false;
            card.setAttribute("aria-busy", "false");
          }
        });
    },
    "button button-quiet payment-card",
  );
  const refresh = button("Обновить список банков", () => void loadBanks(), "back-link");
  async function loadBanks(): Promise<void> {
    if (refresh.disabled) return;
    refresh.disabled = true;
    list.setAttribute("aria-busy", "true");
    notice.textContent = "Загружаем банки для этого счёта…";
    list.replaceChildren();
    try {
      const { banks } = await request<MiniAppFinikMethods>("/miniapp/api/orders/payment-methods", {
        orderId: order.id,
      });
      if (!current()) return;
      for (const bank of banks) {
        const url = safeUrl(bank.url);
        if (!url) continue;
        const link = sourceLink(url, "");
        link.className = "payment-method";
        const badge = element("span", "payment-method-badge", bank.name.slice(0, 1));
        badge.setAttribute("aria-hidden", "true");
        if (bank.logoUrl?.startsWith("https://images.averspay.kg/")) {
          const image = element("img");
          image.alt = "";
          image.decoding = "async";
          image.referrerPolicy = "no-referrer";
          image.addEventListener("load", () => badge.replaceChildren(image), { once: true });
          image.src = bank.logoUrl;
        }
        const copy = element("span", "payment-method-copy");
        copy.append(
          element("strong", "", bank.name),
          element("span", "footnote", "Открыть приложение банка"),
        );
        const arrow = element("span", "payment-method-arrow", "›");
        arrow.setAttribute("aria-hidden", "true");
        link.append(badge, copy, arrow);
        list.append(link);
      }
      notice.textContent = list.childElementCount
        ? ""
        : "Банки сейчас не доступны в списке. Можно выбрать карту или открыть Finik.";
    } catch (error) {
      if (current())
        notice.textContent = `${errorText(error)} Можно открыть официальную страницу Finik ниже.`;
    } finally {
      if (current()) {
        refresh.disabled = false;
        list.setAttribute("aria-busy", "false");
      }
    }
  }
  const fallback = sourceLink(safeUrl(order.invoiceUrl), "Другой банк / открыть Finik");
  fallback.className = "button button-quiet";
  panel.append(
    element("h3", "", "Выберите банк или способ оплаты"),
    element(
      "p",
      "footnote",
      "Приложение банка или защищённая форма карты откроется отдельно. Сумма счёта — " +
        paymentAmountText(order) +
        ".",
    ),
    list,
    card,
    fallback,
    notice,
    refresh,
    element(
      "p",
      "footnote",
      "Уже оплатили? Не оплачивайте повторно. Вернитесь в бот или обновите статус — нужна серверная квитанция Finik.",
    ),
    button("Проверить оплату", () => void load()),
  );
  // Loading methods reuses the accepted invoice; it never creates another invoice.
  queueMicrotask(() => {
    if (current()) void loadBanks();
  });
  return panel;
}

async function showCheckout(params: URLSearchParams): Promise<void> {
  const started = generation;
  const vin = normalizeVin(params.get("vin") ?? "");
  const product = params.get("product");
  showState("Подготовка оплаты", "Проверяем доступ и подготавливаем способы оплаты…");
  root.querySelector("main")?.setAttribute("aria-busy", "true");
  try {
    if (!vin || (product !== "vin_report" && product !== "vin_photos"))
      throw new Error("Ссылка на покупку неполная. Вернитесь к проверке VIN.");
    if (config?.reportBotUrl) {
      const main = shell();
      main.append(
        element("h1", "", "Оплата в VIN-боте"),
        reportBotLink(
          `buy_${product === "vin_photos" ? "photos" : "report"}_${vin}${params.get("report_kind") === "carfax" || params.get("report_kind") === "korea" ? `_${params.get("report_kind")}` : ""}`,
          "Выбрать банк или карту",
        ),
      );
      return;
    }
    const savedId = params.get("order_id");
    const requestedKind = params.get("report_kind");
    if (requestedKind !== null && requestedKind !== "korea" && requestedKind !== "carfax")
      throw new Error("Неизвестный вид отчёта. Вернитесь к проверке VIN.");
    let reportKind = requestedKind;
    const { orders } = await request<{ orders: PaymentOrder[] }>("/miniapp/api/orders");
    if (started !== generation) return;
    const canPay = (value: PaymentOrder) =>
      value.paymentStatus === "unpaid" &&
      !value.needsReview &&
      !value.refundPending &&
      !value.preCheckoutId &&
      value.invoiceStatus !== "cancelled" &&
      Date.parse(value.expiresAt) > Date.now();
    const candidates = orders.filter(
      (order) =>
        order.vin === vin &&
        order.product === product &&
        (savedId ||
          (order.provider === "finik" &&
            (product === "vin_photos" || reportKind === null || order.reportKind === reportKind))),
    );
    let order = savedId
      ? candidates.find((candidate) => candidate.id === savedId)
      : (candidates.find((candidate) => candidate.paymentStatus === "paid") ??
        candidates.find(
          (candidate) => canPay(candidate) && candidate.acceptedAt && candidate.invoiceUrl,
        ));
    if (savedId && !order) throw new Error("Заказ не найден. Откройте раздел «Заказы».");
    if (!order) {
      const offerPath =
        product === "vin_photos" ? "/miniapp/api/orders/photos" : "/miniapp/api/orders/report";
      try {
        // The authenticated server already remembers the recent bot/Mini App lookup.
        // Browser state and URL parameters are never proof that a product exists.
        ({ order } = await request<{ order: PaymentOrder }>(offerPath, {
          vin,
          ...(product === "vin_report" && reportKind ? { reportKind } : {}),
        }));
      } catch (error) {
        if (started !== generation) return;
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
        const result = await request<MiniAppVinResult>("/miniapp/api/vin", { vin });
        if (started !== generation) return;
        if (result.vin !== vin) throw new Error("Получены данные для другого VIN.");
        if (product === "vin_report") {
          if (reportKind && result.reportKind !== reportKind)
            throw new Error(
              "Этот отчёт сейчас недоступен. Вернитесь к проверке VIN и обновите результат.",
            );
          reportKind = result.reportKind;
          if (
            !result.reportSalesEnabled ||
            !reportKind ||
            confirmedVinReportKind(result) !== reportKind
          )
            throw new Error("Покупка отчёта сейчас недоступна. Вернитесь к проверке VIN.");
        } else if (!result.photoAccess?.available || !result.photoAccess.salesEnabled) {
          throw new Error("Покупка фотографий сейчас недоступна. Вернитесь к проверке VIN.");
        }
        ({ order } = await request<{ order: PaymentOrder }>(offerPath, {
          vin,
          ...(product === "vin_report" && reportKind ? { reportKind } : {}),
        }));
      }
    }
    if (started !== generation) return;
    if (product === "vin_report" && canPay(order))
      void track({ event: "report_checkout_started", orderId: order.id });
    if (started !== generation) return;
    const url = new URL(window.location.href);
    url.searchParams.set("order_id", order.id);
    window.history.replaceState(null, "", url);
    if (canPay(order) && !(order.acceptedAt && order.invoiceUrl)) {
      ({ order } = await request<{ order: PaymentOrder }>("/miniapp/api/orders/checkout", {
        orderId: order.id,
        acceptTerms: true,
      }));
    }
    if (started !== generation) return;
    const main = shell();
    const panel = element("section", "panel checkout-panel");
    panel.id = `order-${order.id}`;
    const status = element("p", "badge", paymentOrderStatus(order));
    status.setAttribute("role", "status");
    const terms = element("details", "disclosure");
    terms.append(
      element("summary", "", "Условия покупки и возврата"),
      element("p", "reply-text", order.terms),
      element("p", "footnote", PAYMENT_PRIVACY_NOTICE),
    );
    panel.append(
      element("h1", "", product === "vin_photos" ? "Фотографии автомобиля" : "Полный отчёт по VIN"),
      element("p", "vin", `VIN ${vin}`),
      element("p", "price", paymentAmountText(order)),
      status,
      terms,
    );
    if (order.paymentStatus === "paid") {
      panel.append(element("p", "notice", "Оплата подтверждена. Повторно оплачивать не нужно."));
      if (
        product === "vin_photos" &&
        order.acceptedAt &&
        !order.refundPending &&
        !order.needsReview &&
        order.invoiceStatus !== "cancelled" &&
        order.fulfillmentStatus !== "cancelled"
      )
        panel.append(button("Открыть фотографии", () => navigate("vin", vin)));
    } else if (canPay(order) && order.acceptedAt && order.invoiceUrl) {
      if (order.provider === "finik") panel.append(finikMethods(order));
      else panel.append(sourceLink(safeUrl(order.invoiceUrl), "Открыть существующий счёт"));
    } else {
      panel.append(
        element(
          "p",
          "notice",
          "Этот заказ сейчас нельзя оплатить. Проверьте его статус или обратитесь в поддержку.",
        ),
      );
    }
    const orderId = order.id;
    panel.append(button("Открыть заказ", () => navigate("orders", orderId), "back-link"));
    main.append(panel);
  } catch (error) {
    if (started === generation) {
      showState("Не удалось подготовить оплату", errorText(error), true);
      if (vin)
        root.querySelector("main")?.append(button("Вернуться к VIN", () => navigate("vin", vin)));
    }
  }
}

async function showOrders(): Promise<void> {
  const started = generation;
  showState("Мои заказы", "Загружаем подтверждённые сервером статусы…");
  try {
    const { orders } = await request<{ orders: PaymentOrder[] }>("/miniapp/api/orders");
    if (started !== generation) return;
    const main = shell();
    main.append(
      element(
        "p",
        "eyebrow",
        config?.mode === "vin"
          ? "Фотографии и отчёты по VIN"
          : "Отчёты и отдельно согласованные услуги",
      ),
      element("h1", "", "Мои заказы"),
      element(
        "p",
        "muted",
        config?.mode === "vin"
          ? "Статусы оплаты, ваши фотографии и PDF. Проверка VIN бесплатна."
          : "Бесплатный поиск, уведомления и проверка VIN не требуют покупки.",
      ),
      button("Обновить статус", () => void load(), "button button-quiet"),
    );
    if (!orders.length) {
      const empty = element("section", "state");
      empty.append(
        element("h2", "", "Заказов пока нет"),
        element(
          "p",
          "",
          config?.mode === "vin"
            ? "Проверьте VIN бесплатно. Если полный отчёт найден, можно посмотреть образец PDF и получить доступ."
            : "Здесь появится отдельно согласованная услуга с реальным исполнителем, составом, ценой и условиями. Счета без такого заказа не создаются.",
        ),
      );
      if (config?.mode === "vin") empty.append(button("Проверить VIN", () => navigate("vin")));
      main.append(empty);
    }
    for (const order of orders) {
      const panel = element("section", "panel");
      panel.id = `order-${order.id}`;
      const status = element("p", "badge", paymentOrderStatus(order));
      status.setAttribute("role", "status");
      const price = paymentAmountText(order);
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
      if (order.product === "vin_report") terms.open = !order.acceptedAt;
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
      if (order.product === "vin_report" && order.paymentStatus === "paid" && order.paidAt) {
        const deadline = new Date(Date.parse(order.paidAt) + VIN_REPORT_SLA_MS);
        panel.append(
          element(
            "p",
            "footnote",
            `Срок предоставления доступа к PDF: ${deadline.toLocaleString("ru-RU")}.`,
          ),
        );
        panel.append(reportFeedback({ orderId: order.id }));
      }
      if (
        order.product === "vin_report" &&
        order.paymentStatus === "paid" &&
        order.fulfillmentStatus === "fulfilled" &&
        !order.needsReview &&
        !order.refundPending
      ) {
        const report = element("div", "paid-report");
        const notice = element("p", "footnote");
        notice.setAttribute("role", "status");
        const open = button("Открыть оплаченный PDF", () => {
          if (open.disabled) return;
          open.disabled = true;
          notice.textContent = "Загружаем ваш отчёт по защищённому соединению…";
          void request<Blob>(
            `/miniapp/api/orders/report?orderId=${encodeURIComponent(order.id)}`,
            undefined,
            undefined,
            (response) => response.blob(),
          )
            .then((blob) => {
              if (started !== generation) return;
              const url = URL.createObjectURL(blob);
              reportUrls.add(url);
              const link = element("a", "button button-quiet", "Скачать оплаченный PDF");
              link.href = url;
              link.download = `vin-report-${order.vin}.pdf`;
              const viewer = element("iframe", "report-pdf-viewer");
              viewer.title = `Оплаченный отчёт · VIN ${order.vin}`;
              viewer.src = url;
              report.replaceChildren(
                element("p", "footnote", "Если просмотрщик недоступен, скачайте PDF."),
                link,
                viewer,
              );
            })
            .catch((error: unknown) => {
              if (started === generation) notice.textContent = errorText(error);
            })
            .finally(() => {
              if (started === generation) open.disabled = false;
            });
        });
        report.append(open, notice);
        panel.append(report);
      }
      if (
        order.product === "vin_photos" &&
        order.vin &&
        order.paymentStatus === "paid" &&
        order.acceptedAt &&
        !order.needsReview &&
        !order.refundPending &&
        order.invoiceStatus !== "cancelled" &&
        order.fulfillmentStatus !== "cancelled"
      ) {
        panel.append(button("Открыть фотографии", () => navigate("vin", order.vin!)));
      }
      const active =
        order.paymentStatus === "unpaid" &&
        !order.needsReview &&
        !order.refundPending &&
        !order.preCheckoutId &&
        order.invoiceStatus !== "cancelled" &&
        Date.parse(order.expiresAt) > Date.now();
      if (
        active &&
        (order.product === "vin_report" || order.product === "vin_photos") &&
        order.provider === "finik" &&
        order.acceptedAt &&
        order.invoiceUrl
      ) {
        panel.append(finikMethods(order));
      } else if (active && order.product === "vin_photos" && order.vin) {
        panel.append(
          button(`Выбрать банк · ${price}`, () =>
            navigateCheckout(order.vin!, "vin_photos", order.id),
          ),
        );
      } else if (active) {
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
        const submit = element(
          "button",
          "button",
          order.currency === "XTR"
            ? `Оплатить ${price}`
            : order.product === "vin_report"
              ? `Выбрать банк · ${price}`
              : "Перейти к оплате Finik",
        );
        submit.type = "submit";
        const notice = element("p", "footnote");
        notice.setAttribute("role", "status");
        form.append(consent, submit, notice);
        let cancelButton: HTMLButtonElement | undefined;
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!checkbox.checked || submit.disabled) return;
          if (order.product === "vin_report")
            void track({ event: "report_checkout_started", orderId: order.id });
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
              if (latest.product === "vin_report" && latest.provider === "finik") {
                terms.open = false;
                form.replaceWith(finikMethods(latest));
                return;
              }
              const stars = latest.currency === "XTR";
              const link = sourceLink(
                url,
                stars ? "Открыть счёт Telegram Stars" : "Открыть подтверждённую страницу Finik",
              );
              notice.replaceChildren(
                document.createTextNode("Если уже оплатили — не платите повторно. "),
                link,
              );
              if (stars) {
                if (telegram?.openInvoice)
                  telegram.openInvoice(url, () => {
                    // paid/cancelled/pending in the client is not a financial receipt.
                    if (started === generation) void load();
                  });
              } else if (telegram?.openLink) telegram.openLink(url);
              // The explicit link also works when a client cannot open native invoices.
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
        "Оплату подтверждает сервер по квитанции Telegram или Finik. Закрытие счёта или возвращение из платёжного приложения не подтверждают оплату и не означают выдачу PDF или выполнение осмотра.",
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
  if (!config) {
    showState("Открываем приложение", "Загружаем настройки…");
    root.querySelector("main")?.setAttribute("aria-busy", "true");
    try {
      await loadConfig();
      void track({ event: "miniapp_opened" });
    } catch (error) {
      if (started === generation)
        showState("Не удалось открыть приложение", errorText(error), true);
      return;
    }
    if (started !== generation) return;
  }
  const launchUrl = new URL(window.location.href);
  if (!launchConsumed) {
    launchConsumed = true;
    const start =
      launchUrl.searchParams.get("tgWebAppStartParam") ??
      launchUrl.searchParams.get("startapp") ??
      launchUrl.searchParams.get("start_param") ??
      new URLSearchParams(telegram?.initData ?? "").get("start_param");
    const purchase = /^(buy_report|buy_photos)_([A-HJ-NPR-Z0-9]{17})(?:_(korea|carfax))?$/.exec(
      start ?? "",
    );
    if (purchase && !launchUrl.searchParams.has("view")) {
      launchUrl.searchParams.set("view", "checkout");
      launchUrl.searchParams.set("vin", purchase[2]!);
      launchUrl.searchParams.set(
        "product",
        purchase[1] === "buy_photos" ? "vin_photos" : "vin_report",
      );
      if (purchase[1] === "buy_report" && purchase[3])
        launchUrl.searchParams.set("report_kind", purchase[3]);
      launchUrl.searchParams.delete("car");
      launchUrl.searchParams.delete("order_id");
      window.history.replaceState(null, "", launchUrl);
    }
  }
  const params = launchUrl.searchParams;
  const view = params.get("view");
  const id = params.get("car");
  currentView =
    view === "vin" ||
    view === "checkout" ||
    view === "carfax-example" ||
    view === "buy" ||
    view === "sell" ||
    view === "report-example" ||
    view === "orders" ||
    view === "support"
      ? view
      : id !== null
        ? "car"
        : "home";
  if (
    config?.mode === "vin" &&
    currentView !== "orders" &&
    currentView !== "checkout" &&
    currentView !== "support" &&
    currentView !== "report-example" &&
    currentView !== "carfax-example"
  ) {
    currentView = "vin";
    const url = new URL(window.location.href);
    url.searchParams.delete("car");
    url.searchParams.delete("order_id");
    url.searchParams.set("view", "vin");
    window.history.replaceState(null, "", url);
  }
  window.scrollTo(0, 0);
  if (currentView === "home") {
    showHome();
    return;
  }
  if (currentView === "checkout") {
    await showCheckout(params);
    return;
  }
  if (currentView === "support") {
    showSupport();
    return;
  }
  if (currentView === "orders") {
    if (config?.reportBotUrl) showDelegatedOrders();
    else await showOrders();
    return;
  }
  if (currentView === "carfax-example") {
    showCarfaxExample();
    return;
  }
  if (currentView === "vin") {
    const main = shell();
    main.append(vinPanel());
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
