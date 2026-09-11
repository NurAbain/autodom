import type { MiniAppCar, MiniAppCars, MiniAppSession } from "../src/miniapp-contract.js";

type NativeButton = {
  setText?: (text: string) => unknown;
  show?: () => unknown;
  hide?: () => unknown;
  enable?: () => unknown;
  disable?: () => unknown;
  onClick?: (callback: () => void) => unknown;
};
type Insets = { top: number; bottom: number; left: number; right: number };
type TelegramApp = {
  initData?: string;
  version?: string;
  colorScheme?: string;
  themeParams?: Record<string, string>;
  viewportStableHeight?: number;
  viewportHeight?: number;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  isFullscreen?: boolean;
  ready?: () => void;
  expand?: () => void;
  onEvent?: (event: string, callback: (...args: unknown[]) => void) => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  MainButton?: NativeButton;
  SecondaryButton?: NativeButton;
  BackButton?: NativeButton;
  HapticFeedback?: {
    selectionChanged?: () => void;
    notificationOccurred?: (type: "success" | "error" | "warning") => void;
  };
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  requestWriteAccess?: (callback: (allowed: boolean) => void) => void;
  shareMessage?: (id: string, callback: (sent: boolean) => void) => void;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  addToHomeScreen?: () => void;
  checkHomeScreenStatus?: (callback: (status: string) => void) => void;
  hideKeyboard?: () => void;
  DeviceStorage?: {
    getItem?: (
      key: string,
      callback: (error: string | null, value?: string | null) => void,
    ) => void;
    setItem?: (key: string, value: string, callback: (error: string | null) => void) => void;
    removeItem?: (key: string, callback: (error: string | null) => void) => void;
  };
};
const telegram = (window as Window & { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp;
const root = document.getElementById("app")!;
const state = {
  session: null as MiniAppSession | null,
  tab: "catalog" as "catalog" | "favorites" | "compare",
  cars: [] as MiniAppCar[],
  total: 0,
  nextOffset: null as number | null,
  revision: "",
  favorites: [] as string[],
  compare: [] as string[],
  saved: new Map<string, MiniAppCar | "unavailable" | "error">(),
  detail: null as MiniAppCar | null,
  detailId: null as string | null,
  sheet: null as "settings" | "car" | null,
  busy: false,
  loading: false,
  savedLoading: false,
  error: "",
  message: "",
  fatal: false,
  homeStatus: "unknown",
};
let retry: (() => void) | null = null;
let primaryAction: (() => void) | null = null;
let secondaryAction: (() => void) | null = null;
let requestGeneration = 0;
let savedGeneration = 0;
let detailGeneration = 0;
let persistQueue: Promise<void> = Promise.resolve();
let opener: HTMLElement | null = null;

function version(minimum: string): boolean {
  const actual = (telegram?.version ?? "0").split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    if ((actual[index] ?? 0) !== (required[index] ?? 0))
      return (actual[index] ?? 0) > (required[index] ?? 0);
  }
  return true;
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
  node.disabled = state.busy;
  node.addEventListener("click", action);
  return node;
}
function haptic(): void {
  if (version("6.1")) telegram?.HapticFeedback?.selectionChanged?.();
}
function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function openExternal(url: string): void {
  const safe = safeUrl(url);
  if (!safe) return;
  if (version("6.1") && telegram?.openLink) telegram.openLink(safe);
  else
    notify(
      "Для открытия источника обновите Telegram. Приложение не перенаправляет вас на другой сайт.",
    );
}
// The parsed document is inert. Only newly created allowlisted nodes enter the live DOM.
function richText(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const fragment = document.createDocumentFragment();
  const allowed: Record<string, true> = {
    b: true,
    i: true,
    u: true,
    s: true,
    a: true,
    code: true,
    pre: true,
  };
  const copy = (source: Node, destination: Node): void => {
    if (source.nodeType === Node.TEXT_NODE) {
      destination.appendChild(document.createTextNode(source.textContent ?? ""));
      return;
    }
    if (!(source instanceof Element)) return;
    const tag = source.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "svg", "math", "template"].includes(tag))
      return;
    let target = destination;
    if (Object.hasOwn(allowed, tag)) {
      if (tag === "a") {
        const href = safeUrl(source.getAttribute("href"));
        if (href) {
          const link = element("a");
          link.href = href;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.addEventListener("click", (event) => {
            event.preventDefault();
            openExternal(href);
          });
          link.addEventListener("auxclick", (event) => {
            event.preventDefault();
            openExternal(href);
          });
          target = destination.appendChild(link);
        }
      } else target = destination.appendChild(document.createElement(tag));
    }
    for (const child of source.childNodes) copy(child, target);
  };
  for (const child of parsed.body.childNodes) copy(child, fragment);
  return fragment;
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/miniapp/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `tma ${telegram?.initData ?? ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) {
    let message = "Не удалось выполнить запрос. Попробуйте ещё раз.";
    try {
      const result: unknown = await response.json();
      if (
        typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string"
      )
        message = result.error;
    } catch {
      /* Non-JSON proxy errors still have a useful HTTP status. */
    }
    if (response.status === 401) {
      state.fatal = true;
      state.session = null;
      state.cars = [];
      state.saved.clear();
      state.detail = null;
      state.sheet = null;
      throw new ApiError(
        401,
        "Сессия истекла. Закройте приложение и откройте его заново из личного чата с ботом в Telegram.",
      );
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}
function fail(error: unknown, again?: () => void): void {
  state.error =
    error instanceof Error ? error.message : "Нет связи с сервером. Попробуйте ещё раз.";
  retry = again ?? null;
  render();
}
function notify(message: string): void {
  state.message = message;
  render();
}
function storageKey(): string {
  return `autodom_favorites_${state.session!.user.id}`;
}
async function loadFavorites(): Promise<void> {
  try {
    let value: string | null | undefined;
    if (version("9.0") && telegram?.DeviceStorage?.getItem && telegram.DeviceStorage.setItem) {
      value = await new Promise<string | null | undefined>((resolve, reject) => {
        telegram.DeviceStorage!.getItem!(storageKey(), (error, result) =>
          error ? reject(new Error(error)) : resolve(result),
        );
      });
    } else value = localStorage.getItem(storageKey());
    const parsed: unknown = JSON.parse(value ?? "[]");
    state.favorites = Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 512,
            ),
          ),
        ].slice(0, 100)
      : [];
  } catch {
    state.message = "Хранилище избранного недоступно. В этом сеансе можно продолжить подбор.";
  }
}
function persistFavorites(): void {
  const key = storageKey();
  const value = JSON.stringify(state.favorites);
  persistQueue = persistQueue
    .then(async () => {
      if (version("9.0") && telegram?.DeviceStorage?.getItem && telegram.DeviceStorage.setItem) {
        await new Promise<void>((resolve, reject) => {
          const done = (error: string | null): void =>
            error ? reject(new Error(error)) : resolve();
          if (value === "[]" && telegram.DeviceStorage!.removeItem)
            telegram.DeviceStorage!.removeItem(key, done);
          else telegram.DeviceStorage!.setItem!(key, value, done);
        });
      } else if (value === "[]") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    })
    .catch(() => {
      notify(
        "Изменения избранного не записаны на устройство. В следующем сеансе может вернуться прежний список. Проверьте доступ к хранилищу Telegram.",
      );
    });
}
function toggleFavorite(id: string): void {
  if (state.favorites.includes(id))
    state.favorites = state.favorites.filter((value) => value !== id);
  else {
    if (state.favorites.length >= 100) {
      notify("В избранном уже 100 автомобилей. Удалите ненужный, чтобы добавить новый.");
      return;
    }
    state.favorites.push(id);
    const car =
      state.cars.find((item) => item.id === id) ?? (state.detail?.id === id ? state.detail : null);
    if (car) state.saved.set(id, car);
  }
  persistFavorites();
  haptic();
  render();
}
function toggleCompare(id: string): void {
  if (state.compare.includes(id)) state.compare = state.compare.filter((value) => value !== id);
  else {
    if (state.compare.length === 3) {
      notify("Сравнивайте не больше трёх автомобилей. Сначала уберите один из сравнения.");
      return;
    }
    state.compare.push(id);
    const car =
      state.cars.find((item) => item.id === id) ?? (state.detail?.id === id ? state.detail : null);
    if (car) state.saved.set(id, car);
  }
  haptic();
  render();
}
async function refreshSaved(): Promise<void> {
  const generation = ++savedGeneration;
  const ids = [...new Set([...state.favorites, ...state.compare])];
  for (const id of ids) state.saved.delete(id);
  state.savedLoading = ids.length > 0;
  render();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (index < ids.length && generation === savedGeneration && !state.fatal) {
        const id = ids[index++]!;
        try {
          const car = await api<MiniAppCar>(`/car?id=${encodeURIComponent(id)}`);
          if (generation === savedGeneration) state.saved.set(id, car);
        } catch (error) {
          if (generation !== savedGeneration) return;
          if (error instanceof ApiError && error.status === 401) {
            state.error = error.message;
            return;
          }
          state.saved.set(
            id,
            error instanceof ApiError && error.status === 404 ? "unavailable" : "error",
          );
        }
      }
    }),
  );
  if (generation === savedGeneration) {
    state.savedLoading = false;
    render();
  }
}
async function loadCars(reset = false): Promise<void> {
  if (!state.session?.profile || state.fatal) return;
  const generation = ++requestGeneration;
  const offset = reset ? 0 : state.nextOffset;
  if (offset === null) return;
  if (reset) {
    state.cars = [];
    state.revision = "";
    state.nextOffset = null;
    state.total = 0;
  }
  state.loading = true;
  state.error = "";
  render();
  try {
    const page = await api<MiniAppCars>(
      `/cars?offset=${offset}${state.revision ? `&revision=${encodeURIComponent(state.revision)}` : ""}`,
    );
    if (generation !== requestGeneration) return;
    const existing = new Set(state.cars.map((car) => car.id));
    state.cars.push(...page.cars.filter((car) => !existing.has(car.id)));
    state.total = page.total;
    state.nextOffset = page.nextOffset;
    state.revision = page.revision;
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error instanceof ApiError && error.status === 409) {
      state.cars = [];
      state.nextOffset = null;
      state.revision = "";
      state.error =
        "Параметры поиска изменились. Обновите выдачу, чтобы увидеть актуальные автомобили.";
      retry = () => {
        void boot();
      };
    } else
      fail(error, () => {
        void loadCars(reset);
      });
  } finally {
    if (generation === requestGeneration) {
      state.loading = false;
      render();
    }
  }
}
async function action(input: string): Promise<void> {
  if (state.busy || state.fatal) return;
  state.busy = true;
  state.error = "";
  state.message = "";
  render();
  try {
    if (input === "/resume" || /^monitor:[^:]+:on$/.test(input)) {
      if (!version("6.9") || !telegram?.requestWriteAccess) {
        state.message =
          "Обновите Telegram или включите мониторинг командой /resume в личном чате с ботом.";
        return;
      }
      const allowed = await new Promise<boolean>((resolve) =>
        telegram.requestWriteAccess!(resolve),
      );
      if (!allowed) {
        state.message = "Разрешение на сообщения не выдано. Мониторинг не включён.";
        return;
      }
    }
    const previousDraft = state.session?.draftState;
    const session = await api<MiniAppSession>("/action", { input });
    state.session = session;
    if (
      previousDraft === "delete_confirm" &&
      input.startsWith("delete:") &&
      !session.profile &&
      !session.draftState
    ) {
      state.favorites = [];
      state.compare = [];
      state.saved.clear();
      persistFavorites();
    }
    state.cars = [];
    state.nextOffset = null;
    requestGeneration++;
    savedGeneration++;
    if (input === "/search" || input.startsWith("page:")) {
      state.sheet = null;
      state.tab = "catalog";
    } else state.sheet = "settings";
    haptic();
    if (session.profile) await loadCars(true);
    await refreshSaved();
  } catch (error) {
    // A POST may have committed before connection loss; never automatically repeat consent/save/delete.
    fail(error, () => {
      void boot();
    });
  } finally {
    state.busy = false;
    render();
  }
}
function navigate(tab: typeof state.tab): void {
  state.tab = tab;
  haptic();
  render();
  if (tab !== "catalog") void refreshSaved();
}
function openSettings(): void {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.sheet = "settings";
  render();
}
function closeSheet(): void {
  state.sheet = null;
  state.detail = null;
  state.detailId = null;
  detailGeneration++;
  render();
  (opener?.id
    ? document.getElementById(opener.id)
    : document.getElementById("settings-button")
  )?.focus();
}
async function openCar(id: string): Promise<void> {
  const generation = ++detailGeneration;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.sheet = "car";
  state.detailId = id;
  state.detail = null;
  state.error = "";
  render();
  try {
    const car = await api<MiniAppCar>(`/car?id=${encodeURIComponent(id)}`);
    if (generation === detailGeneration) {
      state.detail = car;
      state.saved.set(id, car);
    }
  } catch (error) {
    if (generation !== detailGeneration) return;
    if (error instanceof ApiError && error.status === 404) {
      state.saved.set(id, "unavailable");
      state.cars = state.cars.filter((car) => car.id !== id);
      state.error = "Объявление больше недоступно: оно удалено, устарело или источник выключен.";
      retry = null;
    } else
      fail(error, () => {
        void openCar(id);
      });
  } finally {
    if (generation === detailGeneration) render();
  }
}
async function shareCar(): Promise<void> {
  const car = state.detail;
  if (!car || state.busy) return;
  if (!version("8.0") || !telegram?.shareMessage) {
    const url = safeUrl(car.url);
    if (!url) {
      notify("У объявления нет доступной ссылки для отправки.");
      return;
    }
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(car.title)}`;
    if (version("6.1") && telegram?.openTelegramLink) telegram.openTelegramLink(shareUrl);
    else openExternal(shareUrl);
    return;
  }
  state.busy = true;
  state.error = "";
  render();
  try {
    let prepared = await api<{ id: string; expiresAt: number }>("/share", { id: car.id });
    const expiry = (value: number): number => (value < 1e12 ? value * 1000 : value);
    if (expiry(prepared.expiresAt) <= Date.now() + 2000)
      prepared = await api<{ id: string; expiresAt: number }>("/share", { id: car.id });
    if (expiry(prepared.expiresAt) <= Date.now())
      throw new Error("Срок отправки истёк. Нажмите «Поделиться» ещё раз.");
    const sent = await new Promise<boolean>((resolve) =>
      telegram.shareMessage!(prepared.id, resolve),
    );
    state.message = sent
      ? "Объявление отправлено. Ваш бюджет и профиль не передавались."
      : "Отправка отменена или сообщение истекло. Можно попробовать снова.";
  } catch (error) {
    fail(error, () => {
      void shareCar();
    });
  } finally {
    state.busy = false;
    render();
  }
}
function photo(car: MiniAppCar, large = false): HTMLElement {
  const frame = element("div", `photo${large ? " photo-large" : ""}`);
  const fallback = element("span", "photo-fallback", "Фото не предоставлено");
  frame.append(fallback);
  const url = safeUrl(car.photoUrl);
  if (url) {
    fallback.textContent = "Загружаем фото…";
    const img = element("img");
    img.alt = car.title;
    img.loading = large ? "eager" : "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => {
      fallback.hidden = true;
    });
    img.addEventListener("error", () => {
      img.remove();
      fallback.hidden = false;
      fallback.textContent = "Фото недоступно в источнике";
    });
    img.src = url;
    frame.append(img);
  }
  return frame;
}
function fact(value: unknown): string {
  return value === null || value === undefined || value === "" ? "Не указано" : String(value);
}
function card(car: MiniAppCar): HTMLElement {
  const node = element("article", "car-card");
  const preview = button(
    "",
    () => {
      void openCar(car.id);
    },
    "car-preview",
  );
  preview.id = `preview-${car.id}`;
  preview.setAttribute("aria-label", `Открыть ${car.title}, ${car.price}`);
  preview.append(photo(car));
  const badge = element("span", "source-badge", car.source);
  preview.append(badge);
  const body = element("div", "car-body");
  const heading = element("h3");
  heading.append(
    button(
      car.title,
      () => {
        void openCar(car.id);
      },
      "title-button",
    ),
  );
  body.append(element("p", "price", car.price), heading);
  body.append(
    element(
      "p",
      "car-meta",
      `${fact(car.year)} · ${fact(car.mileage)} · ${fact(car.transmission)}`,
    ),
  );
  body.append(element("p", "car-location", `${fact(car.city)} · ${fact(car.market)}`));
  const controls = element("div", "card-controls");
  const favorite = button(
    state.favorites.includes(car.id) ? "В избранном" : "В избранное",
    () => toggleFavorite(car.id),
    "button button-small",
  );
  favorite.id = `favorite-${car.id}`;
  favorite.setAttribute("aria-pressed", String(state.favorites.includes(car.id)));
  const compare = button(
    state.compare.includes(car.id) ? "В сравнении" : "Сравнить",
    () => toggleCompare(car.id),
    "button button-small",
  );
  compare.id = `compare-${car.id}`;
  compare.setAttribute("aria-pressed", String(state.compare.includes(car.id)));
  controls.append(favorite, compare);
  body.append(controls);
  node.append(preview, body);
  return node;
}
function empty(
  title: string,
  description: string,
  label?: string,
  callback?: () => void,
): HTMLElement {
  const node = element("section", "empty-state");
  node.append(
    element("span", "empty-symbol", "A"),
    element("h2", "", title),
    element("p", "muted", description),
  );
  if (label && callback) node.append(button(label, callback, "button button-primary"));
  return node;
}
function unavailable(
  id: string,
  status: "unavailable" | "error" | undefined,
  compare = false,
): HTMLElement {
  const node = element("article", "unavailable-card");
  node.append(
    element(
      "h3",
      "",
      status === "error"
        ? "Не удалось загрузить"
        : status === undefined
          ? "Загружаем объявление…"
          : "Объявление недоступно",
    ),
  );
  node.append(
    element(
      "p",
      "muted",
      status === "error"
        ? "Ошибка связи — это не означает, что автомобиль снят с продажи."
        : "Удалённые, устаревшие объявления и выключенные источники не показываются.",
    ),
  );
  if (status === "error")
    node.append(
      button("Повторить загрузку", () => {
        void refreshSaved();
      }),
    );
  node.append(
    button(
      compare ? "Убрать из сравнения" : "Удалить из избранного",
      () => (compare ? toggleCompare(id) : toggleFavorite(id)),
      "button button-small",
    ),
  );
  return node;
}
function compareView(): HTMLElement {
  const wrapper = element("div", "compare-scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute(
    "aria-label",
    "Сравнение автомобилей; таблицу можно прокручивать по горизонтали",
  );
  const table = element("table", "compare-table");
  table.append(element("caption", "sr-only", "Сравнение до трёх автомобилей по данным объявлений"));
  const head = element("thead");
  const header = element("tr");
  const corner = element("th", "", "Параметр");
  corner.scope = "col";
  header.append(corner);
  for (const id of state.compare) {
    const cell = element("th");
    cell.scope = "col";
    const car = state.saved.get(id);
    if (typeof car === "object") {
      cell.append(
        photo(car),
        button(
          car.title,
          () => {
            void openCar(id);
          },
          "title-button",
        ),
        button("Убрать", () => toggleCompare(id), "button button-small"),
      );
    } else cell.append(unavailable(id, car, true));
    header.append(cell);
  }
  head.append(header);
  const body = element("tbody");
  const rows: [string, (car: MiniAppCar) => unknown][] = [
    ["Цена объявления", (car) => car.price],
    ["Год", (car) => car.year],
    ["Пробег", (car) => car.mileage],
    ["Коробка", (car) => car.transmission],
    ["Кузов", (car) => car.bodyType],
    ["Город", (car) => car.city],
    ["Рынок", (car) => car.market],
    ["Источник", (car) => car.source],
  ];
  for (const [label, value] of rows) {
    const row = element("tr");
    const heading = element("th", "", label);
    heading.scope = "row";
    row.append(heading);
    for (const id of state.compare) {
      const car = state.saved.get(id);
      row.append(element("td", "", typeof car === "object" ? fact(value(car)) : "Нет данных"));
    }
    body.append(row);
  }
  const condition = element("tr");
  const label = element("th", "", "Описание и состояние");
  label.scope = "row";
  condition.append(label);
  for (const id of state.compare) {
    const cell = element("td", "rich-text comparison-details");
    const car = state.saved.get(id);
    if (typeof car === "object") cell.append(richText(car.detailsHtml));
    else cell.textContent = "Нет данных";
    condition.append(cell);
  }
  body.append(condition);
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}
const inputs: Record<
  string,
  { label: string; placeholder: string; type?: string; mode?: "numeric" | "text" }
> = {
  budget: { label: "Бюджет без обозначения валюты", placeholder: "10000–15000", mode: "text" },
  query: { label: "Марки и модели через запятую", placeholder: "Toyota Camry, Honda Accord" },
  city: { label: "Город объявления", placeholder: "Бишкек" },
  year_min: {
    label: "Самый ранний год выпуска",
    placeholder: "2015",
    type: "number",
    mode: "numeric",
  },
  mileage_max_km: { label: "Максимальный пробег, км", placeholder: "150000", mode: "numeric" },
  purchase_by: { label: "Планируемая дата покупки", placeholder: "ГГГГ-ММ-ДД", type: "date" },
};
function submitInput(): void {
  const form = document.getElementById("draft-form");
  if (form instanceof HTMLFormElement) form.requestSubmit();
}
function repliesPanel(): HTMLElement {
  const panel = element("div", "replies");
  for (const reply of state.session?.replies ?? []) {
    const section = element("section", "reply");
    const content = element("div", "rich-text");
    content.append(richText(reply.text));
    section.append(content);
    if (reply.buttons.length) {
      const choices = element("div", "reply-buttons");
      for (const row of reply.buttons) {
        const group = element("div", "reply-row");
        for (const [label, input] of row) {
          group.append(
            button(
              label,
              () => {
                void action(input);
              },
              `button${input.endsWith(":save") || input.startsWith("consent:") ? " button-primary" : ""}${input.startsWith("delete:") ? " button-danger" : ""}`,
            ),
          );
        }
        choices.append(group);
      }
      section.append(choices);
    }
    panel.append(section);
  }
  const stateInput = inputs[state.session?.draftState ?? ""];
  if (stateInput) {
    const form = element("form", "input-form");
    form.id = "draft-form";
    const label = element("label", "input-label", stateInput.label);
    label.htmlFor = "draft-input";
    const input = element("input");
    input.id = "draft-input";
    input.name = "value";
    input.type = stateInput.type ?? "text";
    input.inputMode = stateInput.mode ?? "text";
    input.placeholder = stateInput.placeholder;
    input.maxLength = state.session?.draftState === "city" ? 80 : 160;
    input.required = true;
    input.autocomplete = "off";
    input.disabled = state.busy;
    if (state.session?.draftState === "year_min") {
      input.min = "1900";
      input.max = String(new Date().getUTCFullYear() + 1);
      input.step = "1";
    }
    const submit = element("button", "button button-primary", "Продолжить");
    submit.type = "submit";
    submit.disabled = state.busy;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      input.blur();
      if (version("9.1")) telegram?.hideKeyboard?.();
      void action(value);
    });
    form.append(label, input, submit);
    panel.append(form);
  }
  return panel;
}
function settingsContents(): HTMLElement {
  const content = element("div", "settings-content");
  content.append(
    element("p", "eyebrow", state.session?.draftState ? "НЕСОХРАНЁННЫЙ ЧЕРНОВИК" : "ВАШ ПОИСК"),
  );
  content.append(repliesPanel());
  const commands = element("details", "settings-commands");
  commands.append(element("summary", "", "Профиль, уведомления и данные"));
  const grid = element("div", "command-grid");
  for (const [label, input] of [
    ["Мой профиль и условия фильтрации", "/profile"],
    ["Изменить поиск", "/edit"],
    ["Включить мониторинг", "/resume"],
    ["Пауза мониторинга", "/pause"],
    ["Какие данные хранятся", "/privacy"],
    ["Состояние источников", "/status"],
    ["Отменить текущий ввод", "/cancel"],
    ["Помощь", "/help"],
    ["Удалить мои данные", "/delete"],
  ] as const)
    grid.append(
      button(
        label,
        () => {
          void action(input);
        },
        input === "/delete" ? "button button-danger" : "button",
      ),
    );
  commands.append(grid);
  const quiet = element("form", "quiet-form");
  const label = element("label", "input-label", "Тихие часы · Бишкек, UTC+6");
  label.htmlFor = "quiet-start";
  const start = element("input");
  start.id = "quiet-start";
  start.type = "time";
  start.required = true;
  start.setAttribute("aria-label", "Начало тихих часов");
  const end = element("input");
  end.type = "time";
  end.id = "quiet-end";
  end.required = true;
  end.setAttribute("aria-label", "Конец тихих часов");
  const submit = element("button", "button", "Сохранить тихие часы");
  submit.type = "submit";
  submit.disabled = state.busy;
  quiet.append(
    label,
    start,
    end,
    submit,
    button("Отключить тихие часы", () => {
      void action("/quiet off");
    }),
  );
  quiet.addEventListener("submit", (event) => {
    event.preventDefault();
    if (version("9.1")) telegram?.hideKeyboard?.();
    void action(`/quiet ${start.value}-${end.value}`);
  });
  commands.append(quiet);
  content.append(commands);
  const device = element("div", "device-actions");
  if (version("8.0") && telegram?.requestFullscreen && telegram.exitFullscreen) {
    device.append(
      button(telegram.isFullscreen ? "Выйти из полного экрана" : "На весь экран", () => {
        if (telegram.isFullscreen) telegram.exitFullscreen!();
        else telegram.requestFullscreen!();
      }),
    );
  }
  if (
    version("8.0") &&
    telegram?.addToHomeScreen &&
    state.homeStatus !== "unsupported" &&
    state.homeStatus !== "added"
  ) {
    device.append(button("Добавить на главный экран", () => telegram.addToHomeScreen!()));
  }
  content.append(
    device,
    element(
      "p",
      "footnote",
      "Избранное: на устройстве сохраняются только ID объявлений, отдельно для вашего Telegram-аккаунта. Сравнение — только в текущем сеансе. Хранилище избранного не содержит бюджета или данных авторизации.",
    ),
  );
  return content;
}
function detailContents(): HTMLElement {
  const content = element("div", "detail-content");
  const car = state.detail;
  if (!car) {
    content.append(
      element(
        "p",
        "muted",
        state.error ? "Автомобиль не загружен." : "Проверяем актуальность объявления…",
      ),
    );
    if (state.detailId && state.favorites.includes(state.detailId))
      content.append(button("Удалить из избранного", () => toggleFavorite(state.detailId!)));
    return content;
  }
  content.append(
    photo(car, true),
    element("p", "price detail-price", car.price),
    element("h2", "", car.title),
  );
  const facts = element("dl", "detail-facts");
  for (const [label, value] of [
    ["Год", car.year],
    ["Пробег", car.mileage],
    ["Коробка", car.transmission],
    ["Кузов", car.bodyType],
    ["Город", car.city],
    ["Рынок", car.market],
    ["Источник", car.source],
  ]) {
    const item = element("div");
    item.append(element("dt", "muted", String(label)), element("dd", "", fact(value)));
    facts.append(item);
  }
  content.append(facts);
  const description = element("section", "rich-text detail-description");
  description.append(richText(car.detailsHtml));
  content.append(description);
  if (car.observedAt) {
    const date = new Date(car.observedAt < 1e12 ? car.observedAt * 1000 : car.observedAt);
    if (!Number.isNaN(date.getTime()))
      content.append(
        element(
          "p",
          "footnote",
          `Наблюдение: ${date.toLocaleString("ru-RU")}. Наличие и состояние нужно уточнить у продавца.`,
        ),
      );
  }
  const controls = element("div", "detail-actions");
  const url = safeUrl(car.url);
  if (url)
    controls.append(
      button("Открыть в источнике", () => openExternal(url), "button button-primary"),
    );
  else controls.append(element("p", "muted", "Ссылка на источник недоступна."));
  controls.append(
    button(state.favorites.includes(car.id) ? "Удалить из избранного" : "В избранное", () =>
      toggleFavorite(car.id),
    ),
    button(state.compare.includes(car.id) ? "Убрать из сравнения" : "Сравнить", () =>
      toggleCompare(car.id),
    ),
    button("Поделиться объявлением", () => {
      void shareCar();
    }),
  );
  content.append(
    controls,
    element(
      "p",
      "footnote",
      "Перед отправкой вы выбираете чат и подтверждаете действие в Telegram. Отправляется только объявление, без ваших настроек и бюджета.",
    ),
  );
  return content;
}
function notice(): HTMLElement {
  const area = element("div", "notices");
  if (state.error) {
    const error = element("div", "notice notice-error");
    error.setAttribute("role", "alert");
    error.append(element("p", "", state.error));
    if (retry && !state.fatal) error.append(button("Повторить", retry, "button button-small"));
    area.append(error);
  }
  if (state.message) {
    const message = element("div", "notice");
    message.setAttribute("role", "status");
    message.append(
      element("p", "", state.message),
      button(
        "Понятно",
        () => {
          state.message = "";
          render();
        },
        "button button-small",
      ),
    );
    area.append(message);
  }
  return area;
}
function nativeButton(native: NativeButton | undefined, text: string, enabled: boolean): void {
  if (!native?.setText || !native.show || !native.hide || !native.onClick) return;
  if (!text) {
    native.hide();
    return;
  }
  native.setText(text.slice(0, 64));
  if (enabled) native.enable?.();
  else native.disable?.();
  native.show();
}
function syncNative(): void {
  primaryAction = null;
  secondaryAction = null;
  let primary = "";
  let secondary = "";
  if (state.session && !state.fatal) {
    if (state.sheet === "car" && state.detail) {
      const url = safeUrl(state.detail.url);
      primary = url ? "Открыть в источнике" : "Назад к автомобилям";
      primaryAction = url ? () => openExternal(url) : closeSheet;
      secondary = "Поделиться";
      secondaryAction = () => {
        void shareCar();
      };
    } else if (state.sheet === "settings") {
      const first = state.session.replies.flatMap((reply) => reply.buttons.flat())[0];
      if (inputs[state.session.draftState ?? ""]) {
        primary = "Продолжить";
        primaryAction = submitInput;
      } else if (first) {
        primary = first[0];
        primaryAction = () => {
          void action(first[1]);
        };
      }
    } else if (state.session.draftState || !state.session.profile) {
      primary = state.session.draftState ? "Продолжить настройку" : "Настроить поиск";
      primaryAction = openSettings;
    } else if (state.tab === "catalog" && state.nextOffset !== null) {
      primary = "Ещё автомобили";
      primaryAction = () => {
        void loadCars();
      };
    } else {
      primary = "Настройки поиска";
      primaryAction = openSettings;
    }
    if (!state.sheet && state.compare.length && state.tab !== "compare") {
      secondary = `Сравнить · ${state.compare.length}/3`;
      secondaryAction = () => navigate("compare");
    }
  }
  nativeButton(telegram?.MainButton, primary, !state.busy && !state.loading);
  if (version("7.10")) nativeButton(telegram?.SecondaryButton, secondary, !state.busy);
  if (version("6.1") && telegram?.BackButton?.onClick) {
    if (state.sheet) telegram.BackButton.show?.();
    else telegram.BackButton.hide?.();
  }
  if (version("6.2")) {
    if (state.session?.draftState) telegram?.enableClosingConfirmation?.();
    else telegram?.disableClosingConfirmation?.();
  }
}
function render(): void {
  const previousInput = document.getElementById("draft-input");
  const inputValue = previousInput instanceof HTMLInputElement ? previousInput.value : "";
  const inputState = previousInput?.dataset.state;
  const activeId = document.activeElement?.id;
  const quietValues = Array.from(
    document.querySelectorAll<HTMLInputElement>(".quiet-form input"),
  ).map((input) => [input.id, input.value] as const);
  const openDetails = Array.from(
    document.querySelectorAll<HTMLDetailsElement>("details[open]"),
  ).map((node) => node.className);
  const priorDialog = document.querySelector("dialog");
  const previousSheet = priorDialog?.dataset.sheet;
  const previousScroll = priorDialog?.scrollTop ?? 0;
  const shell = element("div", "app-shell");
  const header = element("header", "app-header");
  const brand = element("div", "brand");
  brand.append(element("span", "brand-mark", "A"));
  const title = element("div");
  title.append(
    element("span", "brand-name", "Автодом"),
    element("span", "brand-tagline", "Ваш следующий автомобиль"),
  );
  brand.append(title);
  header.append(brand);
  if (state.session) {
    const settings = button("Настройки", openSettings, "button button-small");
    settings.id = "settings-button";
    header.append(settings);
  }
  shell.append(header);
  const main = element("main", "main-content");
  if (state.fatal) {
    main.append(
      empty(
        "Откройте Автодом в Telegram",
        state.error ||
          "Запустите приложение кнопкой в личном чате с ботом. Доступ к вашему поиску защищён авторизацией Telegram.",
      ),
    );
  } else if (!state.session) {
    main.append(empty("Подключаем ваш поиск", "Получаем защищённую сессию Telegram…"), notice());
  } else {
    const hero = element("section", "hero");
    hero.append(
      element("p", "eyebrow", "ПОДБОР БЕЗ ЛИШНЕГО ШУМА"),
      element("h1", "", "Найдите свой автомобиль"),
    );
    hero.append(
      element(
        "p",
        "muted",
        "Свежие объявления, ваши пожелания и спокойное сравнение. Подбор и мониторинг бесплатны.",
      ),
    );
    main.append(hero);
    const profile = element("details", "profile-summary");
    profile.append(
      element(
        "summary",
        "",
        state.session.draftState
          ? "Есть несохранённый поиск · продолжить"
          : state.session.profile
            ? "Мой поиск и условия подбора"
            : "Сначала настройте поиск",
      ),
    );
    profile.append(
      element(
        "p",
        "muted",
        state.session.draftState
          ? "Черновик не меняет сохранённый поиск до явного подтверждения. Нажмите «Продолжить», проверьте условия и сохраните."
          : "Полный профиль, ограничения фильтрации и управление уведомлениями — в настройках. Неизвестные характеристики могут исключать объявления из выдачи.",
      ),
      button(state.session.draftState ? "Продолжить" : "Открыть настройки", openSettings),
    );
    main.append(profile);
    const tabs = element("nav", "tabs");
    tabs.setAttribute("aria-label", "Разделы подбора");
    for (const [id, label] of [
      ["catalog", "Каталог"],
      ["favorites", `Избранное · ${state.favorites.length}`],
      ["compare", `Сравнение · ${state.compare.length}/3`],
    ] as const) {
      const tab = button(label, () => navigate(id), `tab${state.tab === id ? " active" : ""}`);
      tab.id = `tab-${id}`;
      if (state.tab === id) tab.setAttribute("aria-current", "page");
      tabs.append(tab);
    }
    main.append(tabs);
    if (!state.sheet) main.append(notice());
    const section = element("section", "catalog-section");
    section.setAttribute("aria-busy", String(state.loading || state.savedLoading));
    if (state.tab === "catalog") {
      const toolbar = element("div", "catalog-toolbar");
      toolbar.append(
        element(
          "h2",
          "",
          state.session.profile ? `Подходящие · ${state.total}` : "Ваш персональный подбор",
        ),
      );
      if (state.session.profile) {
        const refresh = button(
          "Обновить",
          () => {
            void loadCars(true);
          },
          "button button-small",
        );
        refresh.disabled = state.loading || state.busy;
        toolbar.append(refresh);
      }
      section.append(toolbar);
      if (!state.session.profile)
        section.append(
          empty(
            "Хороший выбор начинается с вас",
            "Выберите рынок, бюджет и модели. Перед сохранением мы покажем весь поиск и попросим согласие на хранение данных.",
            "Настроить поиск",
            openSettings,
          ),
        );
      else {
        if (state.cars.length) {
          const grid = element("div", "car-grid");
          grid.append(...state.cars.map(card));
          section.append(grid);
        } else if (!state.loading && !state.error)
          section.append(
            empty(
              "Пока нет совпадений",
              "Это только свежая собранная часть рынка, а не все автомобили. Измените параметры или включите бесплатный мониторинг в настройках.",
              "Изменить пожелания",
              () => {
                void action("/edit");
              },
            ),
          );
        if (state.loading) {
          const progress = element("p", "loading", "Загружаем автомобили…");
          progress.setAttribute("role", "status");
          section.append(progress);
        }
        if (state.nextOffset !== null) {
          const more = button(
            "Показать ещё автомобили",
            () => {
              void loadCars();
            },
            "button button-primary load-more",
          );
          more.disabled = state.loading || state.busy;
          section.append(more);
        }
      }
    } else if (state.tab === "favorites") {
      section.append(
        element("h2", "", "Оставьте лучшее на потом"),
        element(
          "p",
          "muted",
          "До 100 объявлений на этом устройстве. Доступность проверяется заново при открытии раздела.",
        ),
      );
      if (!state.favorites.length)
        section.append(
          empty(
            "Здесь будут ваши фавориты",
            "Нажмите «В избранное» на карточке понравившегося автомобиля.",
            "Смотреть каталог",
            () => navigate("catalog"),
          ),
        );
      const grid = element("div", "car-grid");
      for (const id of state.favorites) {
        const car = state.saved.get(id);
        grid.append(typeof car === "object" ? card(car) : unavailable(id, car));
      }
      section.append(grid);
    } else {
      section.append(
        element("h2", "", "Сравните без спешки"),
        element(
          "p",
          "muted",
          "До трёх автомобилей. Цены разных валют не равны полной стоимости покупки; состояние приводится только по данным источника.",
        ),
      );
      if (!state.compare.length)
        section.append(
          empty(
            "Что поставим рядом?",
            "Добавьте до трёх автомобилей кнопкой «Сравнить» в каталоге или избранном.",
            "Выбрать автомобили",
            () => navigate("catalog"),
          ),
        );
      else section.append(compareView());
    }
    if (state.savedLoading && state.tab !== "catalog")
      section.append(element("p", "loading", "Проверяем доступность сохранённых автомобилей…"));
    main.append(
      section,
      element(
        "p",
        "footnote catalog-note",
        "Не весь рынок: только наблюдения за последние 48 часов. Публикация не подтверждает наличие, состояние и возможность экспорта. Зарубежная цена не включает доставку, таможню, оформление и ремонт.",
      ),
    );
  }
  shell.append(main);
  root.replaceChildren(shell);
  if (state.sheet && state.session && !state.fatal) {
    const dialog = element("dialog", "sheet");
    dialog.dataset.sheet = state.sheet;
    dialog.setAttribute("aria-labelledby", "sheet-title");
    const top = element("div", "sheet-header");
    const heading = element(
      "h2",
      "",
      state.sheet === "settings" ? "Поиск и настройки" : "Об автомобиле",
    );
    heading.id = "sheet-title";
    const close = button("Закрыть", closeSheet, "button button-small");
    close.id = "sheet-close";
    close.disabled = false;
    top.append(heading, close);
    dialog.append(
      top,
      notice(),
      state.sheet === "settings" ? settingsContents() : detailContents(),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeSheet();
    });
    shell.append(dialog);
    dialog.showModal();
    if (previousSheet === state.sheet) dialog.scrollTop = previousScroll;
    const input = document.getElementById("draft-input");
    if (input instanceof HTMLInputElement) {
      input.dataset.state = state.session.draftState ?? "";
      if (inputState === state.session.draftState) input.value = inputValue;
      if (activeId === "draft-input" && !state.busy) input.focus({ preventScroll: true });
    }
  }
  for (const details of document.querySelectorAll("details")) {
    if (openDetails.includes(details.className)) details.open = true;
  }
  if (previousSheet === state.sheet) {
    for (const [id, value] of quietValues) {
      const input = document.getElementById(id);
      if (input instanceof HTMLInputElement) input.value = value;
    }
  }
  if (activeId && (!state.sheet || previousSheet === state.sheet)) {
    document.getElementById(activeId)?.focus({ preventScroll: true });
  }
  syncNative();
}
function themeAndViewport(): void {
  const style = document.documentElement.style;
  const theme = telegram?.themeParams ?? {};
  const variables: Record<string, string> = {
    bg_color: "--bg",
    text_color: "--text",
    hint_color: "--muted",
    button_color: "--accent",
    button_text_color: "--accent-text",
    secondary_bg_color: "--surface",
    section_bg_color: "--card",
    link_color: "--link",
  };
  for (const [key, variable] of Object.entries(variables)) {
    const value = theme[key];
    if (value && /^#[0-9a-f]{6}$/i.test(value)) style.setProperty(variable, value);
    else style.removeProperty(variable);
  }
  document.documentElement.dataset.theme = telegram?.colorScheme === "dark" ? "dark" : "light";
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const safe = version("8.0") ? (telegram?.safeAreaInset?.[side] ?? 0) : 0;
    const content = version("8.0") ? (telegram?.contentSafeAreaInset?.[side] ?? 0) : 0;
    style.setProperty(`--safe-${side}`, `${Math.max(0, safe) + Math.max(0, content)}px`);
  }
  if (telegram?.viewportStableHeight)
    style.setProperty("--viewport-stable", `${telegram.viewportStableHeight}px`);
  if (telegram?.viewportHeight)
    style.setProperty("--viewport-height", `${telegram.viewportHeight}px`);
}
async function boot(): Promise<void> {
  state.error = "";
  retry = null;
  render();
  try {
    const firstLoad = state.session === null;
    state.session = await api<MiniAppSession>("/session");
    if (firstLoad) await loadFavorites();
    if (!state.session.profile || state.session.draftState) state.sheet = "settings";
    render();
    await Promise.all([loadCars(true), refreshSaved()]);
  } catch (error) {
    fail(error, () => {
      void boot();
    });
  }
}
function initialize(): void {
  themeAndViewport();
  if (!telegram?.initData) {
    state.fatal = true;
    state.error =
      "Запустите приложение из личного чата с ботом в Telegram. Обычная ссылка в браузере не даёт доступа к вашему профилю.";
    render();
    return;
  }
  telegram.ready?.();
  telegram.expand?.();
  telegram.onEvent?.("themeChanged", themeAndViewport);
  telegram.onEvent?.("viewportChanged", themeAndViewport);
  telegram.MainButton?.onClick?.(() => {
    if (!state.busy && !state.loading) primaryAction?.();
  });
  if (version("6.1")) telegram.BackButton?.onClick?.(closeSheet);
  if (version("7.10"))
    telegram.SecondaryButton?.onClick?.(() => {
      if (!state.busy) secondaryAction?.();
    });
  if (version("8.0")) {
    for (const event of ["safeAreaChanged", "contentSafeAreaChanged", "fullscreenChanged"])
      telegram.onEvent?.(event, () => {
        themeAndViewport();
        if (event === "fullscreenChanged") render();
      });
    telegram.onEvent?.("fullscreenFailed", () =>
      notify("Полноэкранный режим недоступен на этом устройстве."),
    );
    telegram.onEvent?.("homeScreenAdded", () => {
      state.homeStatus = "added";
      notify("Ярлык добавлен на главный экран.");
    });
    telegram.checkHomeScreenStatus?.((status) => {
      state.homeStatus = status;
      render();
    });
  }
  void boot();
}
initialize();
