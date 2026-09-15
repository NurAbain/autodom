import type { PaymentOrder } from "@autodom/core/payments";
import { normalizeVin } from "@autodom/core/vin";

interface Session {
  authenticated: boolean;
  userId?: number;
  salesEnabled: boolean;
  priceLabel: string;
  terms: string;
  supportUrl: string;
}
interface Eligibility {
  vin: string;
  eligible: boolean;
  summary: string;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}
function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
function button(text: string, action: () => void, quiet = false): HTMLButtonElement {
  const result = node("button", quiet ? "button button-quiet" : "button", text);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
}
function externalUrl(value: string, hosts?: readonly string[]): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}
function link(text: string, href: string, newTab = false): HTMLAnchorElement {
  const result = node("a", "button button-quiet", text);
  result.href = href;
  result.rel = "noopener noreferrer";
  if (newTab) result.target = "_blank";
  return result;
}
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
function dateText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "уточните в поддержке" : date.toLocaleString("ru-RU");
}
function priceText(order: PaymentOrder): string {
  return `${(order.amount / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} сом`;
}

const auth = byId("auth");
const sessionStatus = byId("session-status");
const vinForm = byId<HTMLFormElement>("vin-form");
const vinInput = byId<HTMLInputElement>("vin");
const checkVin = byId<HTMLButtonElement>("check-vin");
const vinStatus = byId("vin-status");
const offerActions = byId("offer-actions");
const ordersStatus = byId("orders-status");
const refreshOrders = byId<HTMLButtonElement>("refresh-orders");
const orderList = byId("order-list");
const orderDetail = byId("order-detail");
let session: Session | null = null;
let orders: PaymentOrder[] = [];
let eligibility: Eligibility | null = null;
let generation = 0;
let vinGeneration = 0;
let orderRevision = 0;
let stopped = false;
let loadingSession = false;
let loadingOrders = false;
let mutatingOrder = false;
let checkingVin = false;
let creatingOffer = false;
let pollTimer: number | undefined;
let detailKey = "";
let downloadUrl: string | null = null;
const requests = new Set<AbortController>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const returnId = new URLSearchParams(window.location.search).get("order_id");
let currentId: string | null = returnId && uuid.test(returnId) ? returnId.toLowerCase() : null;

function stopPolling(): void {
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
}
function abortRequests(): void {
  for (const controller of requests) controller.abort();
  requests.clear();
}
function revokeDownload(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
}
function clearPrivateState(): void {
  generation++;
  vinGeneration++;
  stopPolling();
  abortRequests();
  revokeDownload();
  orders = [];
  eligibility = null;
  detailKey = "";
  loadingOrders = false;
  mutatingOrder = false;
  checkingVin = false;
  creatingOffer = false;
  vinInput.value = "";
  vinStatus.textContent = "";
  offerActions.replaceChildren();
  orderList.replaceChildren();
  orderDetail.replaceChildren();
  refreshOrders.disabled = true;
  vinForm.hidden = true;
}

async function request<T>(path: string, body?: object, pdf = false): Promise<T> {
  const controller = new AbortController();
  requests.add(controller);
  const started = generation;
  const timeout = setTimeout(() => controller.abort(), pdf || path === "/vin" ? 60_000 : 30_000);
  try {
    const response = await fetch(`/reports/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers:
        body === undefined
          ? { Accept: pdf ? "application/pdf" : "application/json" }
          : { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const message =
        typeof data?.error === "string"
          ? data.error
          : `Запрос не выполнен (${response.status}). Попробуйте обновить статус.`;
      if (response.status === 401 && started === generation && session?.authenticated) {
        clearPrivateState();
        session = { ...session, authenticated: false };
        renderAuth();
        sessionStatus.textContent =
          "Сессия истекла. Войдите снова; ваши заказы сохранены на сервере.";
        ordersStatus.textContent = "Для просмотра заказа войдите снова.";
      }
      throw new Error(message);
    }
    if (pdf) {
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf"))
        throw new Error("Сервер не вернул PDF. Обновите статус или напишите в поддержку.");
      return (await response.blob()) as T;
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "Ответ не получен. Действие могло выполниться: обновите статус, прежде чем повторять. Не оплачивайте повторно.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    requests.delete(controller);
  }
}

function renderAuth(): void {
  auth.replaceChildren();
  vinForm.hidden = !session?.authenticated;
  if (session?.authenticated) {
    sessionStatus.textContent = `Вы вошли через Telegram · ${session.userId ?? "аккаунт подтверждён"}. ${session.salesEnabled ? "Покупка отчётов доступна." : "Новые покупки временно недоступны; ваши заказы сохранены."}`;
    auth.append(button("Выйти", () => void logout(), true));
    checkVin.disabled = false;
    refreshOrders.disabled = false;
  } else {
    sessionStatus.textContent =
      "Войдите через личный чат с ботом. Оплата и получение PDF проходят на этом сайте.";
    auth.append(button("Войти через Telegram", () => void startLogin()));
  }
}

async function startLogin(): Promise<void> {
  const started = generation;
  const start = auth.querySelector("button");
  if (!start || start.disabled) return;
  start.disabled = true;
  sessionStatus.textContent = "Создаём запрос входа…";
  try {
    const challenge = await request<{ loginUrl: string; expiresAt: string }>("/login", {});
    if (started !== generation || stopped) return;
    const loginUrl = externalUrl(challenge.loginUrl, ["t.me"]);
    if (!loginUrl) throw new Error("Не удалось подтвердить ссылку входа. Попробуйте снова.");
    const form = node("form", "login-form");
    const label = node("label", "", "Код из личного чата с ботом");
    label.htmlFor = "login-code";
    const code = node("input", "text-input");
    code.id = "login-code";
    code.name = "code";
    code.required = true;
    code.autocomplete = "one-time-code";
    code.spellcheck = false;
    code.autocapitalize = "characters";
    code.maxLength = 8;
    const confirm = node("button", "button", "Подтвердить вход");
    confirm.type = "submit";
    const notice = node("p", "footnote");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    form.append(label, code, confirm, notice);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!code.value.trim() || confirm.disabled) return;
      confirm.disabled = true;
      notice.textContent = "Проверяем код…";
      void request<{ authenticated: true }>("/login/confirm", {
        code: code.value.trim().toUpperCase(),
      })
        .then(async () => {
          if (started !== generation || stopped) return;
          code.value = "";
          clearPrivateState();
          await loadSession();
        })
        .catch((error: unknown) => {
          if (started === generation) notice.textContent = errorText(error);
        })
        .finally(() => {
          if (started === generation) confirm.disabled = false;
        });
    });
    auth.replaceChildren(
      node(
        "p",
        "",
        "1. Откройте бот и явно запросите код входа в личном чате. 2. Вернитесь в эту вкладку и введите код. Никому не пересылайте его.",
      ),
      link("Открыть бот для получения кода", loginUrl, true),
      node("p", "footnote", `Запрос входа действует до ${dateText(challenge.expiresAt)}.`),
      form,
      button(
        "Получить новый запрос входа",
        () => {
          renderAuth();
          void startLogin();
        },
        true,
      ),
    );
    sessionStatus.textContent =
      "Ожидаем подтверждения входа. Сам переход в бот не авторизует на сайте.";
  } catch (error) {
    if (started === generation) {
      sessionStatus.textContent = errorText(error);
      start.disabled = false;
    }
  }
}

async function loadSession(): Promise<void> {
  if (loadingSession || stopped) return;
  loadingSession = true;
  const started = generation;
  try {
    const result = await request<Session>("/session");
    if (started !== generation || stopped) return;
    session = result;
    byId("price-label").textContent = result.priceLabel;
    byId("site-terms").textContent = result.terms;
    const support = byId<HTMLAnchorElement>("support-link");
    const supportUrl = externalUrl(result.supportUrl);
    support.hidden = !supportUrl;
    if (supportUrl) support.href = supportUrl;
    renderAuth();
    if (result.authenticated) await loadOrders();
    else {
      clearPrivateState();
      ordersStatus.textContent = "Войдите, чтобы увидеть свои заказы.";
    }
  } catch (error) {
    if (started === generation && !stopped) {
      sessionStatus.textContent = errorText(error);
      auth.replaceChildren(button("Повторить подключение", () => void loadSession()));
    }
  } finally {
    loadingSession = false;
  }
}

async function logout(): Promise<void> {
  clearPrivateState();
  session = null;
  auth.replaceChildren();
  sessionStatus.textContent = "Завершаем сессию…";
  ordersStatus.textContent = "Заказы скрыты.";
  try {
    await request<void>("/logout", {});
    renderAuth();
  } catch (error) {
    sessionStatus.textContent = `Выход не подтверждён. ${errorText(error)}`;
    auth.replaceChildren(
      button("Повторить выход", () => void logout()),
      button("Проверить сессию", () => void loadSession(), true),
    );
  }
}

vinInput.addEventListener("input", () => {
  vinGeneration++;
  eligibility = null;
  offerActions.replaceChildren();
  vinStatus.textContent = "";
});
vinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void checkEligibility();
});
async function checkEligibility(): Promise<void> {
  if (!session?.authenticated || checkingVin || creatingOffer) return;
  const vin = normalizeVin(vinInput.value);
  eligibility = null;
  offerActions.replaceChildren();
  if (!vin) {
    vinStatus.textContent = "Введите VIN: 17 латинских букв и цифр, без I, O, Q.";
    vinInput.focus();
    return;
  }
  vinInput.value = vin;
  const started = generation;
  const check = ++vinGeneration;
  checkingVin = true;
  checkVin.disabled = true;
  vinStatus.textContent = "Запрашиваем свежую проверку корейских источников…";
  try {
    const result = await request<Eligibility>("/vin", { vin });
    if (started !== generation || check !== vinGeneration || stopped) return;
    if (result.vin !== vin)
      throw new Error("VIN в ответе не совпал. Повторите проверку; заказ не создан.");
    eligibility = result;
    vinStatus.textContent = `${result.summary}\n${result.eligible ? "Доступность подтверждена. Сам PDF ещё не получен и не куплен." : "Покупка по этому VIN недоступна. Это не подтверждает отсутствие истории."}`;
    renderOffer();
  } catch (error) {
    if (started === generation && check === vinGeneration) vinStatus.textContent = errorText(error);
  } finally {
    if (started === generation) {
      checkingVin = false;
      checkVin.disabled = false;
    }
  }
}
function renderOffer(): void {
  offerActions.replaceChildren();
  if (!eligibility?.eligible) return;
  if (!session?.salesEnabled) {
    offerActions.append(
      node("p", "notice", "Новые покупки временно недоступны. Проверка остаётся бесплатной."),
    );
    return;
  }
  offerActions.append(button("Посмотреть состав заказа и условия", () => void createOffer()));
}
async function createOffer(): Promise<void> {
  if (
    !session?.authenticated ||
    !session.salesEnabled ||
    !eligibility?.eligible ||
    creatingOffer ||
    normalizeVin(vinInput.value) !== eligibility.vin
  )
    return;
  const started = generation;
  const vin = eligibility.vin;
  creatingOffer = true;
  const create = offerActions.querySelector("button");
  if (create) create.disabled = true;
  checkVin.disabled = true;
  vinStatus.textContent =
    "Повторно проверяем доступность и сохраняем предложение. Счёт ещё не создаётся…";
  try {
    const { order } = await request<{ order: PaymentOrder }>("/orders/report", { vin });
    if (started !== generation || stopped) return;
    acceptOrder(order);
    selectOrder(order.id);
    vinStatus.textContent =
      "Предложение сохранено. Проверьте VIN, цену и условия ниже. Оплата не произведена.";
    orderDetail.scrollIntoView({ block: "start" });
  } catch (error) {
    if (started === generation) {
      vinStatus.textContent = `${errorText(error)} Обновите список заказов: предложение могло сохраниться.`;
      await loadOrders();
    }
  } finally {
    if (started === generation) {
      creatingOffer = false;
      checkVin.disabled = false;
      if (create) create.disabled = false;
    }
  }
}

function websiteOrder(order: PaymentOrder): boolean {
  return order.provider === "finik" && order.product === "vin_report" && order.currency === "KGS";
}
function acceptOrder(order: PaymentOrder): void {
  if (!websiteOrder(order))
    throw new Error("Сервер вернул заказ другого канала. Обновите список заказов.");
  orderRevision++;
  const index = orders.findIndex((item) => item.id === order.id);
  if (index < 0) orders.unshift(order);
  else orders[index] = order;
}
function selectOrder(id: string): void {
  currentId = id;
  const url = new URL(window.location.href);
  url.searchParams.set("order_id", id);
  window.history.replaceState(null, "", url);
  detailKey = "";
  renderOrders();
  schedulePoll();
}
function statusText(order: PaymentOrder): string {
  if (order.needsReview) return "Требуется ручная проверка. Не оплачивайте повторно.";
  if (order.paymentStatus === "refunded") return "Возврат подтверждён исполнителем";
  if (order.refundPending)
    return "Возврат в обработке. Подтверждения ещё нет; выдача PDF приостановлена.";
  if (order.paymentStatus === "paid") {
    if (order.fulfillmentStatus === "fulfilled")
      return "Оплата подтверждена · PDF готов к скачиванию";
    if (order.fulfillmentStatus === "delivery_unknown")
      return "Оплата подтверждена · выдача требует проверки. Напишите в поддержку.";
    if (order.fulfillmentStatus === "cancelled")
      return "Оплата подтверждена · выдача отменена. Уточните полный возврат в поддержке.";
    if (order.paidAt && Date.parse(order.paidAt) + 3_600_000 <= Date.now())
      return "Оплата подтверждена · срок 1 час истёк. Запросите PDF или полный возврат в поддержке.";
    return "Оплата подтверждена · доступ к PDF в течение 1 часа";
  }
  if (order.invoiceStatus === "cancelled" || order.fulfillmentStatus === "cancelled")
    return "Заказ отменён";
  if (Date.parse(order.expiresAt) <= Date.now())
    return "Срок оплаты истёк. Если уже оплатили — обновите статус или напишите в поддержку.";
  if (order.invoiceStatus === "pending")
    return order.invoiceUrl
      ? "Ожидаем подтверждения оплаты от сервера"
      : "Счёт уточняется. Обновите статус; повторный запрос использует тот же заказ.";
  return "Предложение сохранено · счёт ещё не создан";
}
function payable(order: PaymentOrder): boolean {
  return (
    order.paymentStatus === "unpaid" &&
    !order.needsReview &&
    !order.refundPending &&
    order.invoiceStatus !== "cancelled" &&
    order.fulfillmentStatus !== "cancelled" &&
    Date.parse(order.expiresAt) > Date.now()
  );
}
function pending(order: PaymentOrder): boolean {
  if (
    order.needsReview ||
    order.refundPending ||
    order.paymentStatus === "refunded" ||
    order.fulfillmentStatus === "fulfilled" ||
    order.fulfillmentStatus === "cancelled" ||
    order.fulfillmentStatus === "delivery_unknown"
  )
    return false;
  return (
    order.paymentStatus === "paid" ||
    (order.invoiceStatus === "pending" && Date.parse(order.expiresAt) > Date.now())
  );
}
function schedulePoll(): void {
  stopPolling();
  const current = orders.find((order) => order.id === currentId);
  if (stopped || document.hidden || !session?.authenticated || !current || !pending(current))
    return;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    void loadOrders(true);
  }, 8_000);
}
async function loadOrders(background = false): Promise<void> {
  if (!session?.authenticated || stopped || loadingOrders || mutatingOrder) {
    schedulePoll();
    return;
  }
  stopPolling();
  loadingOrders = true;
  refreshOrders.disabled = true;
  const started = generation;
  const revision = orderRevision;
  if (!background) ordersStatus.textContent = "Загружаем статусы с сервера…";
  try {
    const result = await request<{ orders: PaymentOrder[]; reportSalesEnabled: boolean }>(
      "/orders",
    );
    if (started !== generation || revision !== orderRevision || stopped) return;
    orders = result.orders.filter(websiteOrder);
    if (session) session.salesEnabled = result.reportSalesEnabled;
    if (!currentId && orders.length) currentId = orders[0]!.id;
    renderOrders();
    renderOffer();
    ordersStatus.textContent =
      currentId && !orders.some((order) => order.id === currentId)
        ? "Заказ из ссылки не найден в этом аккаунте. Проверьте аккаунт или выберите свой заказ ниже. Возврат из Finik не подтверждает оплату."
        : orders.length
          ? `Статусы получены с сервера: ${new Date().toLocaleTimeString("ru-RU")}.`
          : "Заказов на сайте пока нет. Начните с бесплатной проверки VIN.";
  } catch (error) {
    if (started === generation && !stopped)
      ordersStatus.textContent = `${errorText(error)} Показан последний известный статус; это не подтверждение оплаты.`;
  } finally {
    if (started === generation) {
      loadingOrders = false;
      refreshOrders.disabled = !session?.authenticated;
      schedulePoll();
    }
  }
}

function renderOrders(): void {
  orderList.replaceChildren();
  for (const order of orders) {
    const choice = button(
      "",
      () => {
        selectOrder(order.id);
        orderDetail.scrollIntoView({ block: "start" });
      },
      true,
    );
    choice.classList.add("order-choice");
    choice.setAttribute("aria-pressed", String(order.id === currentId));
    choice.append(
      node("span", "", `${order.vin ?? "VIN"} · ${priceText(order)}`),
      node("small", "", statusText(order)),
      node("small", "muted", `Заказ от ${dateText(order.createdAt)}`),
    );
    orderList.append(choice);
  }
  const order = orders.find((item) => item.id === currentId);
  if (!order) {
    orderDetail.replaceChildren();
    detailKey = "";
    revokeDownload();
    return;
  }
  const key = JSON.stringify(order) + statusText(order) + session?.salesEnabled;
  if (key === detailKey) return;
  const draft =
    orderDetail.dataset.orderId === order.id
      ? (orderDetail.querySelector("textarea")?.value ?? "")
      : "";
  detailKey = key;
  orderDetail.dataset.orderId = order.id;
  revokeDownload();
  const panel = node("article", "panel");
  const status = node("p", "badge", statusText(order));
  status.setAttribute("role", "status");
  panel.append(
    status,
    node("h3", "", order.title),
    node("p", "vin", order.vin ?? ""),
    node("p", "price", priceText(order)),
    node("p", "details", order.description),
    node("p", "details", `Продавец: ${order.seller}\nИсполнитель: ${order.executor}`),
    node(
      "p",
      "footnote order-reference",
      `Заказ ${order.id}\nПредложение до ${dateText(order.expiresAt)}`,
    ),
  );
  const terms = node("details", "disclosure");
  terms.open = true;
  terms.append(
    node("summary", "", "Сохранённые условия заказа и возврата"),
    node("p", "details", order.terms),
  );
  panel.append(terms);
  if (order.acceptedAt)
    panel.append(node("p", "footnote", `Условия приняты: ${dateText(order.acceptedAt)}.`));
  if (order.paymentStatus === "refunded")
    panel.append(
      node(
        "p",
        "notice",
        "Это подтверждение исполнителя о ручном возврате, а не автоматическая квитанция Finik. Если деньги не поступили, напишите в поддержку.",
      ),
    );
  if (order.paymentStatus === "paid" && order.paidAt)
    panel.append(
      node(
        "p",
        "footnote",
        `Срок выдачи PDF: ${dateText(new Date(Date.parse(order.paidAt) + 3_600_000).toISOString())}.`,
      ),
    );
  if (
    order.paymentStatus === "paid" &&
    order.fulfillmentStatus === "fulfilled" &&
    !order.refundPending &&
    !order.needsReview
  )
    renderDownload(panel, order);
  if (payable(order)) renderCheckout(panel, order);
  else if (order.paymentStatus === "unpaid" && !order.needsReview && !order.refundPending)
    panel.append(
      node(
        "p",
        "footnote",
        "Для нового предложения повторите бесплатную проверку VIN. Если уже оплатили — не создавайте новый платёж, обратитесь в поддержку.",
      ),
    );
  renderSupport(panel, order, draft);
  orderDetail.replaceChildren(panel);
}

function renderCheckout(panel: HTMLElement, order: PaymentOrder): void {
  const confirmedUrl =
    order.acceptedAt && order.invoiceUrl
      ? externalUrl(order.invoiceUrl, ["qr.finik.kg", "beta.qr.finik.kg"])
      : null;
  if (confirmedUrl) {
    panel.append(
      link("Открыть подтверждённый счёт Finik", confirmedUrl),
      node(
        "p",
        "footnote",
        "Если уже оплатили, не платите повторно. Нажмите «Обновить статус». Сайт не считает переход или возвращение подтверждением оплаты.",
      ),
    );
    return;
  }
  if (order.invoiceUrl)
    panel.append(
      node(
        "p",
        "notice",
        "Ссылка счёта не прошла проверку. Не переходите по ней. Обновите статус или обратитесь в поддержку.",
      ),
    );
  if (!session?.salesEnabled) {
    panel.append(
      node(
        "p",
        "notice",
        "Создание новых счетов временно недоступно. Сохранённый заказ не потерян.",
      ),
    );
    return;
  }
  const form = node("form", "checkout-form");
  const label = node("label", "payment-consent");
  const consent = node("input");
  consent.type = "checkbox";
  consent.required = true;
  label.append(
    consent,
    document.createTextNode(
      `Подтверждаю VIN ${order.vin}, состав, исполнителя, итог ${priceText(order)} и сохранённые выше условия услуги, возврата и хранения платёжных данных.`,
    ),
  );
  const submit = node(
    "button",
    "button",
    order.invoiceStatus === "pending"
      ? "Повторить получение счёта этого заказа"
      : `Принять условия и получить счёт Finik · ${priceText(order)}`,
  );
  submit.type = "submit";
  submit.disabled = true;
  consent.addEventListener("change", () => {
    submit.disabled = !consent.checked || mutatingOrder;
  });
  const notice = node("p", "notice");
  notice.setAttribute("role", "status");
  form.append(label, submit, notice);
  let cancel: HTMLButtonElement | null = null;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!consent.checked || submit.disabled || mutatingOrder || loadingOrders) return;
    void mutateOrder(
      order,
      "/orders/checkout",
      { orderId: order.id, acceptTerms: true },
      notice,
      submit,
      cancel,
    );
  });
  panel.append(form);
  if (order.invoiceStatus === "offered" && !order.acceptedAt && !order.invoiceUrl) {
    cancel = button(
      "Отменить неиспользованное предложение",
      () => {
        if (mutatingOrder || loadingOrders || !cancel) return;
        void mutateOrder(order, "/orders/cancel", { orderId: order.id }, notice, cancel, submit);
      },
      true,
    );
    panel.append(cancel);
  }
}
async function mutateOrder(
  order: PaymentOrder,
  path: string,
  body: object,
  notice: HTMLElement,
  action: HTMLButtonElement,
  other: HTMLButtonElement | null,
): Promise<void> {
  const started = generation;
  mutatingOrder = true;
  stopPolling();
  action.disabled = true;
  if (other) other.disabled = true;
  refreshOrders.disabled = true;
  notice.textContent = "Отправляем запрос. Статус оплаты определяет только сервер…";
  try {
    const { order: latest } = await request<{ order: PaymentOrder }>(path, body);
    if (started !== generation || stopped) return;
    if (latest.id !== order.id)
      throw new Error("Ответ не соответствует заказу. Обновите статус; повторно не платите.");
    acceptOrder(latest);
    detailKey = "";
    renderOrders();
    ordersStatus.textContent =
      "Статус заказа обновлён с сервера. Счёт можно открыть только по подтверждённой ссылке в карточке.";
  } catch (error) {
    if (started === generation) {
      notice.textContent = `${errorText(error)} Заказ ${order.id} сохранён. Сначала обновите статус, затем при необходимости повторите получение счёта этого же заказа.`;
      ordersStatus.textContent =
        "Ответ на действие не подтверждён. Не создавайте другой заказ и не оплачивайте повторно. Обновите статус.";
    }
  } finally {
    if (started === generation) {
      mutatingOrder = false;
      action.disabled = false;
      if (other) other.disabled = false;
      refreshOrders.disabled = false;
      schedulePoll();
    }
  }
}

function renderDownload(panel: HTMLElement, order: PaymentOrder): void {
  const report = node("div");
  const notice = node("p", "notice");
  notice.setAttribute("role", "status");
  const download = button("Получить оплаченный PDF", () => {
    if (download.disabled) return;
    const started = generation;
    download.disabled = true;
    notice.textContent = "Проверяем доступ и загружаем ваш PDF…";
    void request<Blob>(`/orders/report?orderId=${encodeURIComponent(order.id)}`, undefined, true)
      .then((blob) => {
        if (started !== generation || !report.isConnected || stopped) return;
        revokeDownload();
        downloadUrl = URL.createObjectURL(blob);
        const save = link("Скачать PDF", downloadUrl);
        save.download = `korean-report-${order.vin ?? order.id}.pdf`;
        report.replaceChildren(
          node("p", "", "Ваш PDF получен с сервера."),
          save,
          link("Открыть PDF в новой вкладке", downloadUrl, true),
        );
      })
      .catch((error: unknown) => {
        if (started === generation && report.isConnected) notice.textContent = errorText(error);
      })
      .finally(() => {
        download.disabled = false;
      });
  });
  report.append(download, notice);
  panel.append(report);
}
function renderSupport(panel: HTMLElement, order: PaymentOrder, draft: string): void {
  const details = node("details", "disclosure");
  details.open = Boolean(draft);
  details.append(node("summary", "", "Вопрос, задержка или возврат по этому заказу"));
  const form = node("form", "support-form");
  const label = node("label", "", "Сообщение исполнителю");
  label.htmlFor = "support-message";
  const message = node("textarea", "text-input");
  message.id = "support-message";
  message.name = "message";
  message.required = true;
  message.maxLength = 1500;
  message.value = draft;
  const submit = node("button", "button", "Отправить вопрос по заказу");
  submit.type = "submit";
  const notice = node("p", "notice");
  notice.setAttribute("role", "status");
  form.append(
    label,
    message,
    node(
      "p",
      "footnote",
      "Ответ придёт в ваш личный чат с ботом. Не указывайте пароли, коды входа и полные данные карты. Номер заказа добавится автоматически.",
    ),
    submit,
    notice,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!message.value.trim() || submit.disabled) return;
    const started = generation;
    submit.disabled = true;
    notice.textContent = "Отправляем сообщение…";
    void request<void>("/support", {
      message: `Заказ сайта ${order.id}; VIN ${order.vin ?? "не указан"}\n${message.value.trim()}`,
    })
      .then(() => {
        if (started === generation && form.isConnected) {
          message.value = "";
          notice.textContent = "Сообщение отправлено. Ответ ожидайте в личном чате с ботом.";
        }
      })
      .catch((error: unknown) => {
        if (started === generation && form.isConnected) notice.textContent = errorText(error);
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  details.append(form);
  panel.append(details);
}

refreshOrders.addEventListener("click", () => void loadOrders());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else if (!stopped && session?.authenticated) {
    const current = orders.find((order) => order.id === currentId);
    if (current && pending(current)) void loadOrders(true);
  }
});
window.addEventListener("pagehide", () => {
  stopped = true;
  generation++;
  stopPolling();
  abortRequests();
  revokeDownload();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  stopped = false;
  clearPrivateState();
  loadingSession = false;
  void loadSession();
});
void loadSession();
