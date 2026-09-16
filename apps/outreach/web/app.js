"use strict";

const $ = (id) => document.getElementById(id);
const sources = ["mashina.kg", "lalafo.kg"];
const deliveryLabels = { pending: "В очереди", sending: "Отправляется", sent: "Отправлено", failed: "Ошибка", unknown: "Неизвестно · ручная проверка", skipped: "Пропущено" };
const campaignLabels = { draft: "Черновик", running: "Запущена", paused: "На паузе", completed: "Завершена", cancelled: "Отменена" };
const state = { status: null, campaigns: [], detail: null, selectedId: null, busy: false, refreshing: null, imageBusy: false, imageId: null, imageUrl: null, imageVersion: 0, previewVersion: 0, previewKey: null, previewCount: 0, previewBusy: false, listKey: null, detailKey: null };
const integer = (value) => Number.isInteger(value) && value >= 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string";
const nullableString = (value) => value === null || string(value);
const uuid = (value) => string(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const numberOrNull = (value) => value === null || (typeof value === "number" && Number.isFinite(value));
const isFilter = (value) => record(value) && sources.includes(value.source) && string(value.query) && string(value.city) && numberOrNull(value.yearMin) && numberOrNull(value.yearMax) && numberOrNull(value.priceMin) && numberOrNull(value.priceMax) && ["USD", "KGS"].includes(value.currency) && integer(value.limit);
const isCandidate = (value) => record(value) && string(value.listingId) && sources.includes(value.source) && string(value.title) && string(value.url) && string(value.city) && numberOrNull(value.year) && numberOrNull(value.price) && ["USD", "KGS"].includes(value.currency);
const isCampaign = (value) => record(value) && string(value.id) && value.id.length > 0 && string(value.name) && string(value.text) && (value.imageId === null || uuid(value.imageId)) && isFilter(value.filter) && integer(value.intervalSeconds) && integer(value.dailyLimit) && Object.hasOwn(campaignLabels, value.status) && string(value.createdAt) && nullableString(value.lastError) && record(value.counts) && Object.keys(deliveryLabels).every((key) => integer(value.counts[key]));
const isDelivery = (value) => record(value) && string(value.id) && value.id.length > 0 && string(value.campaignId) && isCandidate(value.candidate) && nullableString(value.recipientId) && Object.hasOwn(deliveryLabels, value.status) && nullableString(value.error) && nullableString(value.remoteId) && string(value.updatedAt);
const isDetail = (value) => record(value) && isCampaign(value.campaign) && Array.isArray(value.deliveries) && value.deliveries.every((delivery) => isDelivery(delivery) && delivery.campaignId === value.campaign.id);
const isStatus = (value) => record(value) && typeof value.sendEnabled === "boolean" && Array.isArray(value.sources) && value.sources.every((source) => record(source) && sources.includes(source.source) && typeof source.ready === "boolean" && string(source.message));

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function show(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}
function errorText(error) {
  return error instanceof Error ? error.message : "Неизвестная ошибка. Обновите состояние перед повторным действием.";
}
function report(error) {
  show("notice", "");
  show("operation-error", errorText(error));
}
async function api(path, { method = "GET", body, validate } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    let response;
    try {
      response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
    } catch (error) {
      throw new Error(error instanceof Error && error.name === "AbortError" ? "Сервис не ответил за 60 секунд. Результат действия не подтверждён; обновите список перед повтором." : "Не удалось связаться с сервисом. Результат действия не подтверждён; проверьте соединение и обновите список перед повтором.");
    }
    let data;
    try { data = await response.json(); } catch {
      throw new Error(`Сервис вернул ответ не в формате JSON (HTTP ${response.status}). Результат действия не подтверждён. Обновите страницу; при повторе обратитесь к администратору.`);
    }
    if (!response.ok || (record(data) && Object.hasOwn(data, "error"))) {
      const message = record(data) && string(data.error) && data.error.trim() ? data.error : `Ошибка сервиса (HTTP ${response.status}).`;
      throw new Error(response.status === 401 ? `Нет доступа. Обновите страницу и войдите через окно авторизации браузера. ${message}` : message);
    }
    if (!validate || !validate(data)) throw new Error("Сервис вернул неполный или некорректный ответ. Результат действия не подтверждён; обновите состояние перед повтором.");
    return data;
  } finally { clearTimeout(timer); }
}
function readFilter() {
  const numeric = (id) => $(id).value === "" ? null : Number($(id).value);
  return { source: $("source").value, query: $("query").value.trim(), city: $("city").value.trim(), yearMin: numeric("year-min"), yearMax: numeric("year-max"), currency: $("currency").value, priceMin: numeric("price-min"), priceMax: numeric("price-max"), limit: Number($("limit").value) };
}
function validAudience() {
  const filter = readFilter();
  $("year-max").setCustomValidity(filter.yearMin !== null && filter.yearMax !== null && filter.yearMin > filter.yearMax ? "Год до должен быть не меньше года от." : "");
  $("price-max").setCustomValidity(filter.priceMin !== null && filter.priceMax !== null && filter.priceMin > filter.priceMax ? "Цена до должна быть не меньше цены от." : "");
  return [...$("audience-fields").querySelectorAll("input, select")].every((input) => input.reportValidity());
}
function updateControls() {
  $("preview-audience").disabled = state.busy || state.previewBusy;
  $("preview-audience").textContent = state.previewBusy ? "Получаем выборку…" : "Показать выборку";
  $("create-campaign").disabled = state.busy || state.imageBusy || state.previewBusy || state.previewCount === 0 || state.previewKey !== JSON.stringify(readFilter());
  $("refresh").disabled = state.busy || Boolean(state.refreshing);
  for (const button of $("campaign-detail").querySelectorAll("button")) button.disabled = state.busy || button.dataset.blocked === "true";
}
function invalidatePreview() {
  state.previewVersion++;
  state.previewKey = null;
  state.previewCount = 0;
  $("year-max").setCustomValidity("");
  $("price-max").setCustomValidity("");
  $("audience-results").replaceChildren();
  show("audience-summary", "Фильтры изменились. Снова проверьте выборку перед созданием.");
  updateControls();
}
function safeListingUrl(candidate) {
  try {
    const url = new URL(candidate.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && (url.hostname === candidate.source || url.hostname.endsWith(`.${candidate.source}`)) ? url.href : null;
  } catch { return null; }
}
function listing(candidate) {
  const card = node("div", undefined, "listing-card");
  const href = safeListingUrl(candidate);
  const title = node(href ? "a" : "p", candidate.title || "Объявление без названия", "listing-title");
  if (href) { title.href = href; title.target = "_blank"; title.rel = "noopener noreferrer"; title.setAttribute("aria-label", `${candidate.title || "Объявление"} — открыть на ${candidate.source} в новой вкладке`); }
  const price = candidate.price === null ? "Цена не указана" : `${candidate.price.toLocaleString("ru-RU")} ${candidate.currency}`;
  card.append(title, node("p", `${candidate.source} · ${candidate.year ?? "Год не указан"} · ${candidate.city || "Город не указан"} · ${price}`, "listing-meta"));
  if (!href) card.append(node("p", "Ссылка отсутствует или не относится к выбранной площадке.", "hint"));
  return card;
}
async function previewAudience() {
  if (state.previewBusy || state.busy || !validAudience()) return;
  const filter = readFilter();
  const version = ++state.previewVersion;
  state.previewBusy = true;
  state.previewKey = null;
  state.previewCount = 0;
  $("audience-results").replaceChildren();
  show("operation-error", "");
  show("audience-summary", "Получаем ограниченную выборку из каталога…");
  updateControls();
  try {
    const data = await api("/api/preview", { method: "POST", body: filter, validate: (value) => record(value) && value.freshHours === 48 && Array.isArray(value.candidates) && value.candidates.length <= filter.limit && value.candidates.every(isCandidate) });
    if (version !== state.previewVersion) return;
    state.previewKey = JSON.stringify(filter);
    state.previewCount = data.candidates.length;
    const fragment = document.createDocumentFragment();
    for (const candidate of data.candidates) fragment.append(listing(candidate));
    $("audience-results").replaceChildren(fragment);
    show("audience-summary", data.candidates.length ? `В этой выборке: ${data.candidates.length} объявлений при лимите ${filter.limit}. Только записи каталога за последние ${data.freshHours} часов. Это не общее число объявлений или уникальных продавцов на площадке. При создании состав будет зафиксирован заново.` : "По этим фильтрам в ограниченной выборке нет объявлений. Измените фильтры; создание недоступно.");
  } catch (error) {
    report(error);
    if (version === state.previewVersion) show("audience-summary", "Выборка не получена. Создание недоступно; исправьте ошибку и повторите проверку.");
  } finally { state.previewBusy = false; updateControls(); }
}
function updateMessage() {
  const text = $("message").value;
  $("message-count").textContent = `${text.length} / 2000`;
  $("message-preview-text").textContent = text || "Здесь появится текст сообщения.";
  $("message-preview-text").classList.toggle("muted", !text);
}
function removeImage() {
  state.imageVersion++;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.imageId = null;
  state.imageBusy = false;
  $("image").value = "";
  $("message-image").removeAttribute("src");
  $("message-image").hidden = true;
  $("remove-image").hidden = true;
  show("image-status", "Фото не выбрано. Можно отправить только текст.");
  updateControls();
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && reader.result.includes(",") ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("Не удалось прочитать фото."));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл. Выберите фото заново."));
    reader.onabort = () => reject(new Error("Чтение фото отменено."));
    reader.readAsDataURL(file);
  });
}
async function uploadImage() {
  const file = $("image").files[0];
  if (!file) return;
  removeImage();
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) {
    report(new Error("Выберите непустой JPEG или PNG размером не более 5 МБ."));
    return;
  }
  const version = ++state.imageVersion;
  state.imageBusy = true;
  state.imageUrl = URL.createObjectURL(file);
  $("message-image").src = state.imageUrl;
  $("message-image").hidden = false;
  $("remove-image").hidden = false;
  show("image-status", `${file.name} · загрузка на сервер…`);
  show("operation-error", "");
  updateControls();
  try {
    const data = await fileBase64(file);
    if (version !== state.imageVersion) return;
    const result = await api("/api/images", { method: "POST", body: { mime: file.type, data }, validate: (value) => record(value) && uuid(value.id) });
    if (version !== state.imageVersion) return;
    state.imageId = result.id;
    show("image-status", `${file.name} · фото сохранено (${(file.size / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} МБ)`);
  } catch (error) {
    if (version === state.imageVersion) {
      removeImage();
      show("image-status", "Фото не загружено и не будет приложено. Выберите его заново.");
    }
    report(error);
  } finally {
    if (version === state.imageVersion) state.imageBusy = false;
    updateControls();
  }
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Дата не указана" : date.toLocaleString("ru-RU");
}
function total(campaign) { return Object.keys(deliveryLabels).reduce((sum, status) => sum + campaign.counts[status], 0); }
function badge(status, labels) { return node("span", labels[status], `badge ${status}`); }
function renderStatus() {
  if (!state.status) {
    show("global-status", "Состояние отправки неизвестно · запуск заблокирован");
    $("source-status").replaceChildren();
    return;
  }
  show("global-status", state.status.sendEnabled ? "Отправка разрешена глобально · проверьте готовность площадки" : "Отправка глобально отключена · SEND_ENABLED=false");
  const fragment = document.createDocumentFragment();
  for (const source of sources) {
    const status = state.status.sources.find((item) => item.source === source);
    const item = node("li", undefined, status?.ready ? "ready" : "not-ready");
    item.append(node("strong", `${source} · ${status?.ready ? "интеграция готова" : "недоступна"}`), node("span", status?.message || "Статус интеграции не получен."));
    fragment.append(item);
  }
  $("source-status").replaceChildren(fragment);
}
function renderCampaigns() {
  const key = JSON.stringify([state.campaigns, state.selectedId]);
  if (key === state.listKey) return;
  state.listKey = key;
  const focused = document.activeElement?.dataset.campaignId;
  const fragment = document.createDocumentFragment();
  for (const campaign of state.campaigns) {
    const button = node("button", undefined, "campaign-select");
    button.type = "button";
    button.dataset.campaignId = campaign.id;
    button.setAttribute("aria-pressed", String(campaign.id === state.selectedId));
    const heading = node("span", undefined, "campaign-topline");
    heading.append(node("span", campaign.name, "listing-title"), badge(campaign.status, campaignLabels));
    button.append(heading, node("span", `${campaign.filter.source} · ${dateLabel(campaign.createdAt)} · Зафиксировано: ${total(campaign)}`, "listing-meta"), node("span", Object.entries(deliveryLabels).map(([status, label]) => `${label}: ${campaign.counts[status]}`).join(" · "), "listing-meta"));
    button.addEventListener("click", () => { void selectCampaign(campaign.id); });
    fragment.append(button);
  }
  if (!state.campaigns.length) fragment.append(node("p", "Кампаний пока нет. Подготовьте выборку и создайте первый черновик.", "empty-state"));
  $("campaign-list").replaceChildren(fragment);
  if (focused) [...$("campaign-list").querySelectorAll("button")].find((button) => button.dataset.campaignId === focused)?.focus({ preventScroll: true });
}
function startBlock(campaign) {
  if (!state.status) return "Состояние сервиса неизвестно. Обновите данные перед запуском.";
  if (!state.status.sendEnabled) return "Запуск недоступен: отправка глобально отключена (SEND_ENABLED=false).";
  const source = state.status.sources.find((item) => item.source === campaign.filter.source);
  if (!source?.ready) return `Запуск недоступен: ${campaign.filter.source} не готова. ${source?.message || "Статус интеграции не получен."}`;
  if (campaign.counts.pending === 0) return "Нет ожидающих отправки записей. Неизвестные результаты и ошибки автоматически не повторяются.";
  return "";
}
function actionButton(text, action, blocked = false, className = "") {
  const button = node("button", text, className);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.blocked = String(blocked);
  button.disabled = state.busy || blocked;
  button.addEventListener("click", () => { void transition(action); });
  return button;
}
function renderDetail() {
  const key = JSON.stringify([state.detail, state.status, state.selectedId]);
  if (key === state.detailKey) { updateControls(); return; }
  state.detailKey = key;
  const root = $("campaign-detail");
  const previousScroll = root.querySelector(".delivery-list")?.scrollTop ?? 0;
  const messageOpen = root.querySelector("details")?.open ?? false;
  const focused = root.contains(document.activeElement) ? { action: document.activeElement.dataset.action, delivery: document.activeElement.dataset.deliveryId } : null;
  if (!state.detail) {
    root.replaceChildren(node("p", state.selectedId ? "Детали ещё не получены. При ошибке нажмите «Обновить»." : "Выберите кампанию, чтобы проверить состав, запустить или приостановить отправку.", "muted"));
    return;
  }
  const { campaign, deliveries } = state.detail;
  const fragment = document.createDocumentFragment();
  const heading = node("div", undefined, "campaign-topline");
  heading.append(node("h3", campaign.name), badge(campaign.status, campaignLabels));
  fragment.append(heading, node("p", `${campaign.filter.source} · создана ${dateLabel(campaign.createdAt)}`, "detail-meta"), node("p", `Зафиксировано записей: ${total(campaign)}. Интервал: ${campaign.intervalSeconds} сек. Суточный лимит: ${campaign.dailyLimit}.`, "detail-meta"));
  if (campaign.filter.source === "lalafo.kg" && campaign.imageId) fragment.append(node("p", "Lalafo: текст и фото — два сообщения на продавца. Частичная доставка требует ручной проверки и не повторяется.", "warning"));
  const filter = campaign.filter;
  fragment.append(node("p", `Фильтры: ${filter.query || "любая марка / модель"} · ${filter.city || "любой город"} · годы ${filter.yearMin ?? "—"}–${filter.yearMax ?? "—"} · цена ${filter.priceMin ?? "—"}–${filter.priceMax ?? "—"} ${filter.currency} · лимит ${filter.limit}`, "detail-meta"));
  const counts = node("div", undefined, "counts");
  for (const [status, label] of Object.entries(deliveryLabels)) counts.append(node("span", `${label}: ${campaign.counts[status]}`, "count"));
  fragment.append(counts);
  if (campaign.lastError) fragment.append(node("p", campaign.lastError, "error"));
  if (campaign.counts.unknown > 0) fragment.append(node("p", "Требуется ручная проверка: у части сообщений неизвестен результат. Проверьте переписку на площадке. Эти записи не будут отправлены повторно, в том числе после возобновления кампании.", "warning"));
  const message = node("details");
  message.append(node("summary", "Сохранённое сообщение и фото"));
  const preview = node("div", undefined, "message-preview");
  if (campaign.imageId) {
    const image = node("img");
    image.src = `/api/images/${encodeURIComponent(campaign.imageId)}`;
    image.alt = "Сохранённое фото кампании";
    image.loading = "lazy";
    image.addEventListener("error", () => { image.replaceWith(node("p", "Не удалось загрузить сохранённое фото. Обновите данные перед запуском.", "error")); });
    preview.append(image);
  }
  preview.append(node("p", campaign.text, "message-text"));
  message.append(preview);
  fragment.append(message);
  const actions = node("div", undefined, "action-row");
  if (["draft", "paused"].includes(campaign.status)) {
    const block = startBlock(campaign);
    actions.append(actionButton(campaign.status === "paused" ? "Возобновить…" : "Запустить…", "start", Boolean(block)));
    if (block) fragment.append(node("p", block, "warning"));
  }
  if (campaign.status === "running") actions.append(actionButton("Приостановить", "pause", false, "secondary"));
  if (["draft", "running", "paused"].includes(campaign.status)) actions.append(actionButton("Отменить кампанию…", "cancel", false, "danger"));
  fragment.append(actions, node("p", "Пауза и отмена останавливают последующие отправки. Сообщение, уже переданное площадке, может завершить отправку после паузы или отмены.", "hint"));
  fragment.append(node("h3", `Доставки · ${deliveries.length}`, "detail-section-title"));
  const list = node("div", undefined, "delivery-list");
  for (const delivery of deliveries) {
    const card = node("article", undefined, "delivery-card");
    card.append(badge(delivery.status, deliveryLabels), listing(delivery.candidate));
    card.append(node("p", `Обновлено: ${dateLabel(delivery.updatedAt)}`, "detail-meta"));
    if (delivery.recipientId) {
      card.append(node("p", `Продавец: ${delivery.recipientId}`, "detail-meta"));
      const suppress = node("button", "Исключить продавца…", "text-button");
      suppress.type = "button";
      suppress.dataset.deliveryId = delivery.id;
      suppress.disabled = state.busy;
      suppress.addEventListener("click", () => { void suppressSeller(delivery); });
      card.append(suppress);
    } else card.append(node("p", "ID продавца пока неизвестен — исключение недоступно.", "hint"));
    if (delivery.error) card.append(node("p", delivery.error, "error"));
    if (delivery.status === "unknown") card.append(node("p", "Не повторяется автоматически. Проверьте фактическую доставку вручную на площадке.", "warning"));
    list.append(card);
  }
  if (!deliveries.length) list.append(node("p", "В сохранённой кампании нет записей доставки.", "empty-state"));
  fragment.append(list);
  root.replaceChildren(fragment);
  list.scrollTop = previousScroll;
  message.open = messageOpen;
  if (focused) [...root.querySelectorAll("button")].find((button) => (focused.action && button.dataset.action === focused.action) || (focused.delivery && button.dataset.deliveryId === focused.delivery))?.focus({ preventScroll: true });
}
async function refreshData() {
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    const selected = state.selectedId;
    const results = await Promise.allSettled([
      api("/api/status", { validate: isStatus }),
      api("/api/campaigns", { validate: (value) => record(value) && Array.isArray(value.campaigns) && value.campaigns.every(isCampaign) }),
      ...(selected ? [api(`/api/campaigns/${encodeURIComponent(selected)}`, { validate: isDetail })] : []),
    ]);
    const errors = [];
    if (results[0].status === "fulfilled") state.status = results[0].value;
    else { state.status = null; errors.push(`Готовность: ${errorText(results[0].reason)}`); }
    if (results[1].status === "fulfilled") state.campaigns = results[1].value.campaigns;
    else errors.push(`Список кампаний: ${errorText(results[1].reason)}`);
    if (selected && state.selectedId === selected) {
      if (results[2].status === "fulfilled" && results[2].value.campaign.id === selected) state.detail = results[2].value;
      else { state.detail = null; errors.push(`Детали кампании: ${results[2].status === "rejected" ? errorText(results[2].reason) : "Сервис вернул другую кампанию."}`); }
    }
    renderStatus();
    renderCampaigns();
    renderDetail();
    show("sync-error", errors.join("\n"));
    $("refresh-time").textContent = errors.length ? "Не все данные обновлены. Отображаемые ранее сведения могут быть устаревшими. Следующая попытка — через 5 секунд." : `Обновлено: ${new Date().toLocaleTimeString("ru-RU")} · проверка каждые 5 секунд.`;
    return errors.length === 0;
  })();
  updateControls();
  try { return await state.refreshing; } finally { state.refreshing = null; updateControls(); }
}
async function selectCampaign(id) {
  if (state.busy || state.selectedId === id) return;
  state.selectedId = id;
  state.detail = null;
  renderCampaigns();
  renderDetail();
  try {
    if (state.refreshing) await state.refreshing;
    await refreshData();
  } catch (error) { report(error); }
}
async function operation(work) {
  if (state.busy) return;
  state.busy = true;
  show("operation-error", "");
  show("notice", "");
  updateControls();
  try {
    if (state.refreshing) await state.refreshing;
    await work();
  } catch (error) { report(error); }
  finally { state.busy = false; updateControls(); }
}
async function createCampaign(event) {
  event.preventDefault();
  if (state.busy || state.imageBusy || !validAudience() || !$("campaign-form").reportValidity()) return;
  const filter = readFilter();
  if (!state.previewCount || state.previewKey !== JSON.stringify(filter)) { report(new Error("Сначала получите непустую выборку по текущим фильтрам.")); return; }
  const body = { name: $("name").value.trim(), text: $("message").value.trim(), imageId: state.imageId, filter, intervalSeconds: Number($("interval").value), dailyLimit: Number($("daily-limit").value) };
  if (!body.name || !body.text) { report(new Error("Название и текст сообщения не могут состоять только из пробелов.")); return; }
  await operation(async () => {
    const result = await api("/api/campaigns", { method: "POST", body, validate: (value) => record(value) && isCampaign(value.campaign) });
    state.selectedId = result.campaign.id;
    state.detail = null;
    invalidatePreview();
    await refreshData();
    show("notice", `Черновик «${result.campaign.name}» создан. Ничего не отправлено. Зафиксировано записей: ${total(result.campaign)}. Проверьте состав и запустите отдельно.`);
  });
}
async function transition(action) {
  const id = state.selectedId;
  if (!id) return;
  await operation(async () => {
    if (!await refreshData() || state.selectedId !== id || !state.detail) throw new Error("Не удалось подтвердить актуальное состояние кампании. Действие не выполнено.");
    const campaign = state.detail.campaign;
    if (action === "start") {
      const block = startBlock(campaign);
      if (block) throw new Error(block);
      if (!["draft", "paused"].includes(campaign.status)) throw new Error("Статус кампании изменился. Запуск сейчас недоступен.");
      if (!window.confirm(`Запустить холодную рекламную рассылку «${campaign.name}»?\n\nПлощадка: ${campaign.filter.source}. Зафиксировано записей: ${total(campaign)}; ожидают отправки: ${campaign.counts.pending}.\n\nПродавцы не запрашивали предложение. Возможны жалобы, нарушение правил площадки и блокировка аккаунта. Медленная отправка не устраняет риск.\n\nИнтервал: ${campaign.intervalSeconds} сек.; суточный лимит попыток: ${campaign.dailyLimit}. Неизвестные результаты не повторяются.${campaign.filter.source === "lalafo.kg" && campaign.imageId ? "\nLalafo: текст и фото будут двумя сообщениями. Частичная доставка останавливает кампанию." : ""}\n\nПодтверждаю запуск.`)) return;
    } else if (action === "cancel") {
      if (!["draft", "running", "paused"].includes(campaign.status)) throw new Error("Эта кампания уже завершена или отменена.");
      if (!window.confirm(`Отменить кампанию «${campaign.name}»? Возобновить отменённую кампанию нельзя. Уже начатое сообщение может дойти; отправленные сообщения не удаляются.`)) return;
    } else if (campaign.status !== "running") throw new Error("Кампания уже не запущена. Состояние обновлено.");
    const result = await api(`/api/campaigns/${encodeURIComponent(id)}/${action}`, { method: "POST", body: { confirmed: true }, validate: (value) => record(value) && isCampaign(value.campaign) && value.campaign.id === id });
    await refreshData();
    show("notice", `Сервис подтвердил состояние «${campaignLabels[result.campaign.status]}» для «${result.campaign.name}».${action === "pause" || action === "cancel" ? " Уже начатое сообщение может завершить отправку." : ""}`);
  });
}
async function suppressSeller(delivery) {
  if (state.busy || !delivery.recipientId) return;
  const reason = window.prompt(`Исключить продавца ${delivery.recipientId} на ${delivery.candidate.source}?\n\nИсключение останавливает только последующие отправки, в том числе в других кампаниях. Уже начатое сообщение может дойти.\n\nВведите причину исключения:`);
  if (reason === null) return;
  if (!reason.trim()) { report(new Error("Для исключения продавца укажите причину.")); return; }
  await operation(async () => {
    await api("/api/suppress", { method: "POST", body: { source: delivery.candidate.source, recipientId: delivery.recipientId, reason: reason.trim() }, validate: (value) => record(value) && value.ok === true });
    await refreshData();
    show("notice", `Продавец ${delivery.recipientId} исключён на ${delivery.candidate.source}. Это останавливает только последующие отправки; уже начатое сообщение может дойти.`);
  });
}
async function poll() {
  try { if (!document.hidden && !state.busy) await refreshData(); }
  catch (error) {
    state.status = null;
    renderStatus();
    renderDetail();
    show("sync-error", errorText(error));
  } finally { setTimeout(() => { void poll(); }, 5000); }
}

$("audience-fields").addEventListener("input", invalidatePreview);
$("audience-fields").addEventListener("change", invalidatePreview);
$("preview-audience").addEventListener("click", () => { void previewAudience(); });
$("message").addEventListener("input", updateMessage);
$("image").addEventListener("change", () => { void uploadImage(); });
$("remove-image").addEventListener("click", removeImage);
$("message-image").addEventListener("error", () => { show("image-status", "Не удалось показать локальный предпросмотр фото. Проверьте файл перед созданием кампании."); });
$("suggest-text").addEventListener("click", () => {
  if ($("message").value.trim() && !window.confirm("Заменить текущий текст нейтральным примером?")) return;
  $("message").value = "Здравствуйте! Это рекламное предложение от Autodom. Если вам нужна информация по VIN автомобиля, можно обратиться к нашему Telegram-боту: https://t.me/autokgbot. Покрытие VIN-источников различается; отсутствие записей не подтверждает отсутствие ДТП или других проблем. Если предложение неактуально, сообщите — мы исключим вас из дальнейших рассылок.";
  updateMessage();
  $("message").focus();
});
$("campaign-form").addEventListener("submit", (event) => { void createCampaign(event); });
$("refresh").addEventListener("click", () => { void refreshData().catch(report); });
updateMessage();
updateControls();
void poll();
