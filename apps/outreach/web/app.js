"use strict";

const $ = (id) => document.getElementById(id);
const MARKETPLACES = ["mashina.kg", "lalafo.kg"];
const SOCIAL = ["instagram", "facebook", "threads"];
const PLATFORMS = [...MARKETPLACES, ...SOCIAL];
const PLATFORM_LABELS = {
  "mashina.kg": "Mashina.kg",
  "lalafo.kg": "Lalafo.kg",
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
};
const DELIVERY_LABELS = { pending: "В очереди", sending: "Отправляется", sent: "Отправлено", failed: "Ошибка", unknown: "Неизвестно", skipped: "Пропущено" };
const CAMPAIGN_LABELS = { draft: "Черновик", running: "Запущена", paused: "На паузе", completed: "Завершена", cancelled: "Отменена" };
const state = {
  status: null,
  projects: [],
  projectDetail: null,
  projectId: null,
  campaigns: [],
  socialCampaigns: [],
  instagramWatches: [],
  selectedId: null,
  selectedSocialId: null,
  selectedInstagramWatchId: null,
  editingInstagramWatchId: null,
  detail: null,
  socialDetail: null,
  busy: false,
  refreshing: null,
  imageBusy: false,
  imageId: null,
  imageUrl: null,
  imageVersion: 0,
  previewVersion: 0,
  previewKey: null,
  previewCount: 0,
  previewBusy: false,
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value) => typeof value === "string";
const uuid = (value) => string(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

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
  return error instanceof Error ? error.message : "Неизвестная ошибка. Обновите состояние.";
}
function report(error) {
  show("notice", "");
  show("operation-error", errorText(error));
}
async function api(path, { method = "GET", body, validate } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(error instanceof Error && error.name === "AbortError" ? "Сервис не ответил за 60 секунд. Результат не подтверждён." : "Нет связи с сервисом. Результат не подтверждён.");
    }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Некорректный ответ сервиса (HTTP ${response.status}).`); }
    if (!response.ok || (record(data) && string(data.error))) throw new Error(record(data) && string(data.error) ? data.error : `Ошибка сервиса (HTTP ${response.status}).`);
    if (validate && !validate(data)) throw new Error("Сервис вернул неполные данные. Обновите страницу.");
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function currentProject() {
  return state.projects.find((project) => project.id === state.projectId) || null;
}
function currentConnection(platform) {
  return state.projectDetail?.connections.find((connection) => connection.platform === platform) || null;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Дата не указана" : date.toLocaleString("ru-RU");
}
function total(campaign) {
  return Object.keys(DELIVERY_LABELS).reduce((sum, key) => sum + Number(campaign.counts?.[key] || 0), 0);
}
function badge(status, labels = CAMPAIGN_LABELS) {
  return node("span", labels[status] || status, `badge ${status}`);
}
function connectionReady(platform) {
  const connection = currentConnection(platform);
  return Boolean(connection?.enabled && connection.ready);
}
function updateControls() {
  const hasProject = Boolean(state.projectId);
  $("preview-audience").disabled = state.busy || state.previewBusy || !hasProject || !currentConnection($("source").value)?.enabled;
  $("preview-audience").textContent = state.previewBusy ? "Получаем выборку…" : "Показать выборку";
  $("create-campaign").disabled = state.busy || state.imageBusy || state.previewBusy || state.previewCount === 0 || state.previewKey !== JSON.stringify(readFilter()) || !hasProject;
  $("refresh").disabled = state.busy || Boolean(state.refreshing);
  $("project-select").disabled = state.busy;
  $("save-instagram-watch").disabled = state.busy || !hasProject;
  for (const button of document.querySelectorAll("[data-action]")) button.disabled = state.busy || button.dataset.blocked === "true";
}

function renderProjects() {
  const select = $("project-select");
  const previous = state.projectId;
  select.replaceChildren(...state.projects.map((project) => {
    const option = node("option", project.name);
    option.value = project.id;
    option.selected = project.id === previous;
    return option;
  }));
  const project = currentProject();
  show("project-description", project?.description || "Описание проекта не указано.");
  if (!state.projects.length) show("project-description", "Создайте первый проект.");
}
function renderConnections() {
  const fragment = document.createDocumentFragment();
  for (const platform of PLATFORMS) {
    const connection = currentConnection(platform);
    const card = node("article", undefined, `connection-card ${connection?.ready ? "ready" : ""}`);
    const top = node("div", undefined, "campaign-topline");
    top.append(node("strong", PLATFORM_LABELS[platform]), badge(connection?.ready ? "sent" : connection?.enabled ? "paused" : "skipped", { sent: "Готово", paused: "Настроить", skipped: "Выключено" }));
    card.append(top);
    card.append(node("p", connection ? connection.accountLabel : "Аккаунт не подключён", "listing-meta"));
    card.append(node("p", connection?.message || "Добавьте отдельный аккаунт для этого проекта.", "hint"));
    const button = node("button", connection ? "Настроить" : "Подключить", "secondary");
    button.type = "button";
    button.dataset.platform = platform;
    button.addEventListener("click", () => openConnection(platform));
    card.append(button);
    fragment.append(card);
  }
  $("connection-grid").replaceChildren(fragment);
  show("vault-status", state.status?.credentialVaultConfigured ? "Секреты проекта шифруются AES-256-GCM. Сохранённые значения не показываются." : "Хранилище секретов не настроено: новые логины, пароли и access token сохранить нельзя.");
  for (const option of $("source").options) option.disabled = !currentConnection(option.value)?.enabled;
  for (const option of $("social-platform").options) option.disabled = !currentConnection(option.value)?.enabled;
}
function renderStatus() {
  if (!state.status) {
    show("global-status", "Состояние сервиса неизвестно · запуск заблокирован");
    $("source-status").replaceChildren();
    return;
  }
  show("global-status", state.status.sendEnabled ? "Отправка разрешена глобально · каждый запуск подтверждается отдельно" : "Отправка глобально отключена · SEND_ENABLED=false");
  const fragment = document.createDocumentFragment();
  for (const source of MARKETPLACES) {
    const status = state.status.sources?.find((item) => item.source === source);
    const item = node("li", undefined, status?.ready ? "ready" : "not-ready");
    item.append(node("strong", `${PLATFORM_LABELS[source]} · ${status?.ready ? "серверная сессия готова" : "недоступна"}`), node("span", status?.message || "Статус не получен."));
    fragment.append(item);
  }
  $("source-status").replaceChildren(fragment);
}

async function createProject(event) {
  event.preventDefault();
  const name = $("project-name").value.trim();
  const description = $("project-description-input").value.trim();
  if (!name) return;
  await operation(async () => {
    const data = await api("/api/projects", { method: "POST", body: { name, description }, validate: (value) => uuid(value?.project?.id) });
    state.projectId = data.project.id;
    state.selectedId = null;
    state.selectedSocialId = null;
    state.selectedInstagramWatchId = null;
    state.editingInstagramWatchId = null;
    event.target.reset();
    event.target.closest("details").open = false;
    await refreshData();
    show("notice", `Проект «${data.project.name}» создан. Подключите его платформы.`);
  });
}
function openConnection(platform) {
  const connection = currentConnection(platform);
  const instagram = platform === "instagram";
  const tokenPlatform = platform === "facebook" || platform === "threads";
  $("connection-platform").value = platform;
  $("connection-title").textContent = `${PLATFORM_LABELS[platform]} · ${currentProject()?.name || "проект"}`;
  $("connection-label").value = connection?.accountLabel || `${PLATFORM_LABELS[platform]} · ${currentProject()?.name || ""}`;
  $("connection-login-label").textContent = instagram ? "Логин Instagram" : tokenPlatform ? "ID аккаунта (необязательно)" : "Логин аккаунта";
  $("connection-login").value = connection?.login || "";
  $("connection-login").required = instagram;
  $("connection-secret-label").textContent = instagram ? "Пароль Instagram" : tokenPlatform ? "Официальный access token Meta" : "Пароль / секрет сессии";
  $("connection-secret").value = "";
  $("connection-secret").required = !connection?.credentialConfigured;
  $("connection-enabled").checked = connection?.enabled ?? true;
  $("connection-secret-help").textContent = instagram
    ? "Неофициальный Private API: пароль и сессия шифруются AES-256-GCM и не возвращаются в браузер. Пустое поле сохраняет текущий пароль."
    : tokenPlatform
      ? "Вставьте официальный access token Meta. Пустое поле сохраняет текущий token."
      : "Для нового проекта данные сохраняются зашифрованно. Реальная отправка станет доступна после создания изолированной серверной сессии этой площадки.";
  $("connection-dialog").showModal();
}
async function saveConnection(event) {
  event.preventDefault();
  if (!state.projectId) return;
  const secret = $("connection-secret").value;
  const body = {
    platform: $("connection-platform").value,
    accountLabel: $("connection-label").value.trim(),
    login: $("connection-login").value.trim(),
    ...(secret ? { secret } : {}),
    enabled: $("connection-enabled").checked,
  };
  await operation(async () => {
    await api(`/api/projects/${encodeURIComponent(state.projectId)}/connections`, { method: "POST", body, validate: (value) => record(value?.connection) });
    $("connection-secret").value = "";
    $("connection-dialog").close();
    await refreshData();
    show("notice", `${PLATFORM_LABELS[body.platform]} сохранён для проекта «${currentProject()?.name}».`);
  });
}

function readFilter() {
  const numeric = (id) => $(id).value === "" ? null : Number($(id).value);
  return { source: $("source").value, query: $("query").value.trim(), city: $("city").value.trim(), yearMin: numeric("year-min"), yearMax: numeric("year-max"), currency: $("currency").value, priceMin: numeric("price-min"), priceMax: numeric("price-max"), limit: Number($("limit").value) };
}
function invalidatePreview() {
  state.previewVersion++;
  state.previewKey = null;
  state.previewCount = 0;
  $("audience-results").replaceChildren();
  show("audience-summary", "Фильтры изменились. Снова проверьте выборку.");
  updateControls();
}
function safeListingUrl(candidate) {
  try {
    const url = new URL(candidate.url);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === candidate.source || url.hostname.endsWith(`.${candidate.source}`)) ? url.href : null;
  } catch { return null; }
}
function listing(candidate) {
  const card = node("div", undefined, "listing-card");
  const href = safeListingUrl(candidate);
  const title = node(href ? "a" : "p", candidate.title || "Объявление без названия", "listing-title");
  if (href) { title.href = href; title.target = "_blank"; title.rel = "noopener noreferrer"; }
  const price = candidate.price === null ? "Цена не указана" : `${candidate.price.toLocaleString("ru-RU")} ${candidate.currency}`;
  card.append(title, node("p", `${candidate.source} · ${candidate.year ?? "Год не указан"} · ${candidate.city || "Город не указан"} · ${price}`, "listing-meta"));
  return card;
}
async function previewAudience() {
  if (state.previewBusy || state.busy || !$("campaign-form").reportValidity()) return;
  if (!currentConnection($("source").value)?.enabled) { report(new Error("Сначала подключите площадку к проекту.")); return; }
  const filter = readFilter();
  if (filter.yearMin !== null && filter.yearMax !== null && filter.yearMin > filter.yearMax) { report(new Error("Неверный диапазон годов.")); return; }
  if (filter.priceMin !== null && filter.priceMax !== null && filter.priceMin > filter.priceMax) { report(new Error("Неверный диапазон цен.")); return; }
  const version = ++state.previewVersion;
  state.previewBusy = true;
  show("operation-error", "");
  show("audience-summary", "Получаем выборку…");
  updateControls();
  try {
    const data = await api("/api/preview", { method: "POST", body: filter, validate: (value) => Array.isArray(value?.candidates) });
    if (version !== state.previewVersion) return;
    state.previewKey = JSON.stringify(filter);
    state.previewCount = data.candidates.length;
    $("audience-results").replaceChildren(...data.candidates.map(listing));
    show("audience-summary", data.candidates.length ? `В выборке ${data.candidates.length} объявлений за последние ${data.freshHours} часов.` : "Подходящих объявлений нет.");
  } catch (error) {
    report(error);
    show("audience-summary", "Выборка не получена.");
  } finally {
    state.previewBusy = false;
    updateControls();
  }
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
  show("image-status", "Фото не выбрано.");
  updateControls();
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && reader.result.includes(",") ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("Не удалось прочитать фото."));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.readAsDataURL(file);
  });
}
async function uploadImage() {
  const file = $("image").files[0];
  if (!file) return;
  removeImage();
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) { report(new Error("Выберите JPEG или PNG до 5 МБ.")); return; }
  const version = ++state.imageVersion;
  state.imageBusy = true;
  state.imageUrl = URL.createObjectURL(file);
  $("message-image").src = state.imageUrl;
  $("message-image").hidden = false;
  $("remove-image").hidden = false;
  show("image-status", `${file.name} · загрузка…`);
  updateControls();
  try {
    const data = await fileBase64(file);
    const result = await api("/api/images", { method: "POST", body: { mime: file.type, data }, validate: (value) => uuid(value?.id) });
    if (version !== state.imageVersion) return;
    state.imageId = result.id;
    show("image-status", `${file.name} · сохранено`);
  } catch (error) {
    if (version === state.imageVersion) removeImage();
    report(error);
  } finally {
    if (version === state.imageVersion) state.imageBusy = false;
    updateControls();
  }
}
async function createCampaign(event) {
  event.preventDefault();
  if (!state.projectId || !state.previewCount || state.previewKey !== JSON.stringify(readFilter())) { report(new Error("Сначала получите непустую выборку.")); return; }
  const body = { projectId: state.projectId, name: $("name").value.trim(), text: $("message").value.trim(), imageId: state.imageId, filter: readFilter(), intervalSeconds: Number($("interval").value), dailyLimit: Number($("daily-limit").value) };
  await operation(async () => {
    const result = await api("/api/campaigns", { method: "POST", body, validate: (value) => uuid(value?.campaign?.id) });
    state.selectedId = result.campaign.id;
    invalidatePreview();
    await refreshData();
    show("notice", `Черновик «${result.campaign.name}» создан. Ничего не отправлено.`);
  });
}

function marketplaceBlock(campaign) {
  if (!state.status?.sendEnabled) return "Глобальная отправка отключена.";
  const connection = currentConnection(campaign.filter.source);
  if (!connection?.ready) return connection?.message || "Подключение проекта не готово.";
  if (!campaign.counts.pending) return "Нет ожидающих отправок.";
  return "";
}
function actionButton(text, kind, action, blocked = false, className = "") {
  const button = node("button", text, className);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.blocked = String(blocked);
  button.addEventListener("click", () => void transition(kind, action));
  return button;
}
function renderCampaigns() {
  const campaigns = state.campaigns.filter((campaign) => campaign.projectId === state.projectId);
  const fragment = document.createDocumentFragment();
  for (const campaign of campaigns) {
    const button = node("button", undefined, "campaign-select");
    button.type = "button";
    button.setAttribute("aria-pressed", String(campaign.id === state.selectedId));
    const top = node("span", undefined, "campaign-topline");
    top.append(node("span", campaign.name, "listing-title"), badge(campaign.status));
    button.append(top, node("span", `${PLATFORM_LABELS[campaign.filter.source]} · ${dateLabel(campaign.createdAt)} · ${total(campaign)} целей`, "listing-meta"));
    button.addEventListener("click", () => { state.selectedId = campaign.id; state.detail = null; void refreshData(); });
    fragment.append(button);
  }
  if (!campaigns.length) fragment.append(node("p", "У проекта пока нет рассылок.", "empty-state"));
  $("campaign-list").replaceChildren(fragment);
}
function renderDetail() {
  const root = $("campaign-detail");
  if (!state.detail || state.detail.campaign.projectId !== state.projectId) { root.replaceChildren(node("p", "Выберите кампанию.", "muted")); return; }
  const { campaign, deliveries } = state.detail;
  const fragment = document.createDocumentFragment();
  const top = node("div", undefined, "campaign-topline");
  top.append(node("h3", campaign.name), badge(campaign.status));
  fragment.append(top, node("p", `${PLATFORM_LABELS[campaign.filter.source]} · ${dateLabel(campaign.createdAt)} · интервал ${campaign.intervalSeconds} сек.`, "detail-meta"));
  if (campaign.lastError) fragment.append(node("p", campaign.lastError, "error"));
  const actions = node("div", undefined, "action-row");
  if (["draft", "paused"].includes(campaign.status)) {
    const block = marketplaceBlock(campaign);
    actions.append(actionButton(campaign.status === "paused" ? "Возобновить…" : "Запустить…", "marketplace", "start", Boolean(block)));
    if (block) fragment.append(node("p", block, "warning"));
  }
  if (campaign.status === "running") actions.append(actionButton("Приостановить", "marketplace", "pause", false, "secondary"));
  if (["draft", "running", "paused"].includes(campaign.status)) actions.append(actionButton("Отменить…", "marketplace", "cancel", false, "danger"));
  fragment.append(actions);
  const list = node("div", undefined, "delivery-list");
  for (const delivery of deliveries) {
    const card = node("article", undefined, "delivery-card");
    card.append(badge(delivery.status, DELIVERY_LABELS), listing(delivery.candidate));
    if (delivery.error) card.append(node("p", delivery.error, "error"));
    if (delivery.recipientId) {
      const suppress = node("button", "Исключить продавца…", "text-button");
      suppress.type = "button";
      suppress.addEventListener("click", () => void suppressSeller(delivery));
      card.append(suppress);
    }
    list.append(card);
  }
  fragment.append(node("h3", `Доставки · ${deliveries.length}`), list);
  root.replaceChildren(fragment);
}

function parseSocialTargets() {
  const targets = [];
  for (const [index, line] of $("social-targets").value.split("\n").entries()) {
    if (!line.trim()) continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 3 || !/^[A-Za-z0-9_:-]+$/.test(parts[0]) || !["photo", "video", "text"].includes(parts[2])) throw new Error(`Строка ${index + 1}: ожидается ID | HTTPS-ссылка | photo, video или text.`);
    let url;
    try { url = new URL(parts[1]); } catch { throw new Error(`Строка ${index + 1}: некорректная ссылка.`); }
    if (url.protocol !== "https:") throw new Error(`Строка ${index + 1}: требуется HTTPS-ссылка.`);
    targets.push({ externalId: parts[0], url: url.href, mediaType: parts[2] });
  }
  if (!targets.length) throw new Error("Укажите хотя бы одну публикацию.");
  return targets;
}
async function createSocialCampaign(event) {
  event.preventDefault();
  if (!state.projectId) return;
  let targets;
  try { targets = parseSocialTargets(); } catch (error) { report(error); return; }
  const body = { projectId: state.projectId, name: $("social-name").value.trim(), platform: $("social-platform").value, text: $("social-message").value.trim(), targets, intervalSeconds: Number($("social-interval").value), dailyLimit: Number($("social-daily-limit").value) };
  await operation(async () => {
    const result = await api("/api/social-campaigns", { method: "POST", body, validate: (value) => uuid(value?.campaign?.id) });
    state.selectedSocialId = result.campaign.id;
    await refreshData();
    show("notice", `Черновик «${result.campaign.name}» создан для ${targets.length} публикаций. Комментарии не отправлены.`);
  });
}
function socialBlock(campaign) {
  if (!state.status?.sendEnabled) return "Глобальная отправка отключена.";
  if (!state.status?.credentialVaultConfigured) return "Хранилище секретов проекта не настроено.";
  const connection = currentConnection(campaign.platform);
  if (!connection?.ready) return connection?.message || "Подключение проекта не готово.";
  if (!campaign.counts.pending) return "Нет ожидающих комментариев.";
  return "";
}
function safeSocialUrl(target, platform) {
  try {
    const url = new URL(target.url);
    const hosts = platform === "instagram" ? ["instagram.com", "www.instagram.com"] : platform === "facebook" ? ["facebook.com", "www.facebook.com", "m.facebook.com"] : ["threads.net", "www.threads.net"];
    return url.protocol === "https:" && hosts.includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function renderSocialCampaigns() {
  const campaigns = state.socialCampaigns.filter((campaign) => campaign.projectId === state.projectId);
  const fragment = document.createDocumentFragment();
  for (const campaign of campaigns) {
    const button = node("button", undefined, "campaign-select");
    button.type = "button";
    button.setAttribute("aria-pressed", String(campaign.id === state.selectedSocialId));
    const top = node("span", undefined, "campaign-topline");
    top.append(node("span", campaign.name, "listing-title"), badge(campaign.status));
    button.append(top, node("span", `${PLATFORM_LABELS[campaign.platform]} · ${dateLabel(campaign.createdAt)} · ${total(campaign)} публикаций`, "listing-meta"));
    button.addEventListener("click", () => { state.selectedSocialId = campaign.id; state.socialDetail = null; void refreshData(); });
    fragment.append(button);
  }
  if (!campaigns.length) fragment.append(node("p", "У проекта пока нет кампаний комментариев.", "empty-state"));
  $("social-list").replaceChildren(fragment);
}
function renderSocialDetail() {
  const root = $("social-detail");
  if (!state.socialDetail || state.socialDetail.campaign.projectId !== state.projectId) { root.replaceChildren(node("p", "Выберите кампанию.", "muted")); return; }
  const { campaign, deliveries } = state.socialDetail;
  const fragment = document.createDocumentFragment();
  const top = node("div", undefined, "campaign-topline");
  top.append(node("h3", campaign.name), badge(campaign.status));
  fragment.append(top, node("p", `${PLATFORM_LABELS[campaign.platform]} · ${dateLabel(campaign.createdAt)} · ${campaign.intervalSeconds} сек.`, "detail-meta"), node("p", campaign.text, "message-text"));
  if (campaign.lastError) fragment.append(node("p", campaign.lastError, "error"));
  const actions = node("div", undefined, "action-row");
  if (["draft", "paused"].includes(campaign.status)) {
    const block = socialBlock(campaign);
    actions.append(actionButton(campaign.status === "paused" ? "Возобновить…" : "Запустить…", "social", "start", Boolean(block)));
    if (block) fragment.append(node("p", block, "warning"));
  }
  if (campaign.status === "running") actions.append(actionButton("Приостановить", "social", "pause", false, "secondary"));
  if (["draft", "running", "paused"].includes(campaign.status)) actions.append(actionButton("Отменить…", "social", "cancel", false, "danger"));
  fragment.append(actions);
  const list = node("div", undefined, "delivery-list");
  for (const delivery of deliveries) {
    const card = node("article", undefined, "delivery-card");
    card.append(badge(delivery.status, DELIVERY_LABELS));
    const href = safeSocialUrl(delivery.target, campaign.platform);
    const title = node(href ? "a" : "p", `${delivery.target.mediaType} · ${delivery.target.externalId}`, "listing-title");
    if (href) { title.href = href; title.target = "_blank"; title.rel = "noopener noreferrer"; }
    card.append(title);
    if (delivery.remoteId) card.append(node("p", `ID комментария: ${delivery.remoteId}`, "detail-meta"));
    if (delivery.error) card.append(node("p", delivery.error, "error"));
    list.append(card);
  }
  fragment.append(node("h3", `Публикации · ${deliveries.length}`), list);
  root.replaceChildren(fragment);
}

function readInstagramAccounts() {
  const accounts = $("instagram-watch-accounts").value
    .split("\n")
    .map((value) => value.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (!accounts.length) throw new Error("Укажите хотя бы один Instagram-аккаунт.");
  if (accounts.some((value) => !/^[a-z0-9._]{1,30}$/.test(value)))
    throw new Error("Username Instagram может содержать только латинские буквы, цифры, точку и подчёркивание.");
  if (new Set(accounts).size !== accounts.length)
    throw new Error("Один Instagram-аккаунт указан несколько раз.");
  return accounts;
}
function readInstagramWatchForm() {
  const mediaTypes = [
    ...($("instagram-watch-photo").checked ? ["photo"] : []),
    ...($("instagram-watch-video").checked ? ["video"] : []),
  ];
  if (!mediaTypes.length) throw new Error("Выберите фото или видео.");
  return {
    name: $("instagram-watch-name").value.trim(),
    commentText: $("instagram-watch-message").value.trim(),
    accounts: readInstagramAccounts(),
    mediaTypes,
    intervalSeconds: Number($("instagram-watch-interval").value),
    dailyLimit: Number($("instagram-watch-daily-limit").value),
  };
}
function resetInstagramWatchForm() {
  state.editingInstagramWatchId = null;
  $("instagram-watch-form").reset();
  $("instagram-watch-photo").checked = true;
  $("instagram-watch-video").checked = true;
  $("instagram-watch-interval").value = "300";
  $("instagram-watch-daily-limit").value = "10";
  $("save-instagram-watch").textContent = "Создать мониторинг";
  $("cancel-instagram-watch-edit").hidden = true;
}
async function saveInstagramWatch(event) {
  event.preventDefault();
  if (!state.projectId) return;
  let settings;
  try { settings = readInstagramWatchForm(); } catch (error) { report(error); return; }
  await operation(async () => {
    const editing = state.editingInstagramWatchId;
    const path = editing ? `/api/instagram-watches/${encodeURIComponent(editing)}` : "/api/instagram-watches";
    const body = editing ? settings : { projectId: state.projectId, ...settings };
    const result = await api(path, { method: "POST", body, validate: (value) => uuid(value?.watch?.id) });
    state.selectedInstagramWatchId = result.watch.id;
    resetInstagramWatchForm();
    await refreshData();
    show("notice", editing ? `Мониторинг «${result.watch.name}» обновлён.` : `Черновик «${result.watch.name}» создан. Автокомментарии ещё не запущены.`);
  });
}
function editInstagramWatch(watch) {
  state.editingInstagramWatchId = watch.id;
  $("instagram-watch-name").value = watch.name;
  $("instagram-watch-accounts").value = watch.accounts.join("\n");
  $("instagram-watch-photo").checked = watch.mediaTypes.includes("photo");
  $("instagram-watch-video").checked = watch.mediaTypes.includes("video");
  $("instagram-watch-message").value = watch.commentText;
  $("instagram-watch-interval").value = String(watch.intervalSeconds);
  $("instagram-watch-daily-limit").value = String(watch.dailyLimit);
  $("save-instagram-watch").textContent = "Сохранить изменения";
  $("cancel-instagram-watch-edit").hidden = false;
  $("instagram-watch-name").focus();
}
function instagramWatchBlock(watch) {
  if (!state.status?.sendEnabled) return "Глобальная отправка отключена.";
  if (!state.status?.credentialVaultConfigured) return "Хранилище логина, пароля и сессии не настроено.";
  const connection = currentConnection("instagram");
  if (!connection?.ready) return connection?.message || "Instagram-аккаунт проекта не готов.";
  if (!watch.accounts.length) return "Список аккаунтов пуст.";
  return "";
}
function renderInstagramWatches() {
  const watches = state.instagramWatches.filter((watch) => watch.projectId === state.projectId);
  const fragment = document.createDocumentFragment();
  for (const watch of watches) {
    const button = node("button", undefined, "campaign-select");
    button.type = "button";
    button.setAttribute("aria-pressed", String(watch.id === state.selectedInstagramWatchId));
    const top = node("span", undefined, "campaign-topline");
    top.append(node("span", watch.name, "listing-title"), badge(watch.status));
    button.append(top, node("span", `${watch.accounts.length} аккаунтов · фото/видео · ${total(watch)} наблюдений`, "listing-meta"));
    button.addEventListener("click", () => {
      state.selectedInstagramWatchId = watch.id;
      renderInstagramWatches();
      renderInstagramWatchDetail();
    });
    fragment.append(button);
  }
  if (!watches.length) fragment.append(node("p", "У проекта пока нет мониторингов Instagram.", "empty-state"));
  $("instagram-watch-list").replaceChildren(fragment);
}
function renderInstagramWatchDetail() {
  const root = $("instagram-watch-detail");
  const watch = state.instagramWatches.find(
    (item) => item.id === state.selectedInstagramWatchId && item.projectId === state.projectId,
  );
  if (!watch) {
    root.replaceChildren(node("p", "Выберите мониторинг.", "muted"));
    return;
  }
  const fragment = document.createDocumentFragment();
  const top = node("div", undefined, "campaign-topline");
  top.append(node("h3", watch.name), badge(watch.status));
  fragment.append(
    top,
    node("p", `${watch.accounts.length} аккаунтов · проверка каждые 5 минут · без ограничения по возрасту публикации`, "detail-meta"),
    node("p", watch.commentText, "message-text"),
  );
  if (watch.lastPollAt) fragment.append(node("p", `Последняя проверка: ${dateLabel(watch.lastPollAt)}`, "detail-meta"));
  if (watch.lastError) fragment.append(node("p", watch.lastError, "error"));
  const actions = node("div", undefined, "action-row");
  if (["draft", "paused"].includes(watch.status)) {
    const block = instagramWatchBlock(watch);
    actions.append(actionButton(watch.status === "paused" ? "Возобновить…" : "Запустить…", "instagram-watch", "start", Boolean(block)));
    if (block) fragment.append(node("p", block, "warning"));
  }
  if (watch.status === "running")
    actions.append(actionButton("Приостановить", "instagram-watch", "pause", false, "secondary"));
  if (["draft", "running", "paused"].includes(watch.status)) {
    const edit = node("button", "Редактировать список", "secondary");
    edit.type = "button";
    edit.addEventListener("click", () => editInstagramWatch(watch));
    actions.append(edit, actionButton("Отменить…", "instagram-watch", "cancel", false, "danger"));
  }
  fragment.append(actions);
  const counts = node("div", undefined, "delivery-list");
  for (const status of Object.keys(DELIVERY_LABELS)) {
    const row = node("article", undefined, "delivery-card");
    row.append(badge(status, DELIVERY_LABELS), node("strong", String(watch.counts?.[status] || 0)));
    counts.append(row);
  }
  fragment.append(node("h3", "Наблюдения"), counts);
  root.replaceChildren(fragment);
}
async function transition(kind, action) {
  const watchMode = kind === "instagram-watch";
  const id = watchMode
    ? state.selectedInstagramWatchId
    : kind === "social"
      ? state.selectedSocialId
      : state.selectedId;
  const detail = watchMode
    ? state.instagramWatches.find((watch) => watch.id === id)
    : kind === "social"
      ? state.socialDetail
      : state.detail;
  if (!id || !detail) return;
  const campaign = watchMode ? detail : detail.campaign;
  const targetDescription = watchMode
    ? `Аккаунтов: ${campaign.accounts.length}. Публикации проверяются каждые 5 минут без ограничения по возрасту.`
    : `Целей: ${total(campaign)}. Интервал: ${campaign.intervalSeconds} сек. Суточный лимит: ${campaign.dailyLimit}.`;
  if (action === "start" && !window.confirm(`Запустить «${campaign.name}»?\n\n${targetDescription}\n\nЭто внешнее маркетинговое действие. Жалобы и блокировки возможны. Неизвестный результат не повторяется.`)) return;
  if (action === "cancel" && !window.confirm(`Отменить «${campaign.name}»? Возобновление будет невозможно.`)) return;
  await operation(async () => {
    const prefix = watchMode
      ? "/api/instagram-watches"
      : kind === "social"
        ? "/api/social-campaigns"
        : "/api/campaigns";
    await api(`${prefix}/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: { confirmed: true },
      validate: (value) => uuid(watchMode ? value?.watch?.id : value?.campaign?.id),
    });
    await refreshData();
    show("notice", `Состояние кампании «${campaign.name}» обновлено.`);
  });
}
async function suppressSeller(delivery) {
  const reason = window.prompt(`Исключить продавца ${delivery.recipientId}? Укажите причину:`);
  if (reason === null) return;
  if (!reason.trim()) { report(new Error("Укажите причину исключения.")); return; }
  await operation(async () => {
    await api("/api/suppress", { method: "POST", body: { source: delivery.candidate.source, recipientId: delivery.recipientId, reason: reason.trim() }, validate: (value) => value?.ok === true });
    await refreshData();
    show("notice", `Продавец ${delivery.recipientId} исключён.`);
  });
}
async function operation(work) {
  if (state.busy) return;
  state.busy = true;
  show("operation-error", "");
  show("notice", "");
  updateControls();
  try { await work(); } catch (error) { report(error); } finally { state.busy = false; updateControls(); }
}
async function refreshData() {
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    const base = await Promise.all([
      api("/api/status"),
      api("/api/projects"),
      api("/api/campaigns"),
      api("/api/social-campaigns"),
      api("/api/instagram-watches"),
    ]);
    state.status = base[0];
    state.projects = Array.isArray(base[1].projects) ? base[1].projects : [];
    state.campaigns = Array.isArray(base[2].campaigns) ? base[2].campaigns : [];
    state.socialCampaigns = Array.isArray(base[3].campaigns) ? base[3].campaigns : [];
    state.instagramWatches = Array.isArray(base[4].watches) ? base[4].watches : [];
    if (!state.projects.some((project) => project.id === state.projectId)) state.projectId = state.projects[0]?.id || null;
    state.projectDetail = state.projectId ? await api(`/api/projects/${encodeURIComponent(state.projectId)}`) : null;
    if (!state.campaigns.some((campaign) => campaign.id === state.selectedId && campaign.projectId === state.projectId)) { state.selectedId = null; state.detail = null; }
    if (!state.socialCampaigns.some((campaign) => campaign.id === state.selectedSocialId && campaign.projectId === state.projectId)) { state.selectedSocialId = null; state.socialDetail = null; }
    if (!state.instagramWatches.some((watch) => watch.id === state.selectedInstagramWatchId && watch.projectId === state.projectId)) {
      state.selectedInstagramWatchId = null;
      if (state.editingInstagramWatchId) resetInstagramWatchForm();
    }
    if (state.selectedId) state.detail = await api(`/api/campaigns/${encodeURIComponent(state.selectedId)}`);
    if (state.selectedSocialId) state.socialDetail = await api(`/api/social-campaigns/${encodeURIComponent(state.selectedSocialId)}`);
    renderProjects();
    renderConnections();
    renderStatus();
    renderCampaigns();
    renderDetail();
    renderSocialCampaigns();
    renderSocialDetail();
    renderInstagramWatches();
    renderInstagramWatchDetail();
    show("sync-error", "");
    $("refresh-time").textContent = `Обновлено: ${new Date().toLocaleTimeString("ru-RU")} · проверка каждые 5 секунд.`;
  })();
  updateControls();
  try { await state.refreshing; return true; } catch (error) { show("sync-error", errorText(error)); return false; } finally { state.refreshing = null; updateControls(); }
}
function selectMode(mode) {
  const social = mode === "social";
  const instagramWatch = mode === "instagram-watch";
  const marketplace = !social && !instagramWatch;
  $("social-workspace").hidden = !social;
  $("instagram-watch-workspace").hidden = !instagramWatch;
  $("marketplace-workspace").hidden = !marketplace;
  $("social-tab").setAttribute("aria-pressed", String(social));
  $("instagram-watch-tab").setAttribute("aria-pressed", String(instagramWatch));
  $("marketplace-tab").setAttribute("aria-pressed", String(marketplace));
  $("social-tab").classList.toggle("secondary", !social);
  $("instagram-watch-tab").classList.toggle("secondary", !instagramWatch);
  $("marketplace-tab").classList.toggle("secondary", !marketplace);
}
async function poll() {
  try { if (!document.hidden && !state.busy) await refreshData(); } finally { setTimeout(() => void poll(), 5000); }
}

$("project-select").addEventListener("change", () => {
  state.projectId = $("project-select").value || null;
  state.projectDetail = null;
  state.selectedId = null;
  state.selectedSocialId = null;
  state.selectedInstagramWatchId = null;
  resetInstagramWatchForm();
  invalidatePreview();
  void refreshData();
});
$("project-form").addEventListener("submit", (event) => void createProject(event));
$("connection-form").addEventListener("submit", (event) => void saveConnection(event));
$("close-connection").addEventListener("click", () => $("connection-dialog").close());
$("marketplace-tab").addEventListener("click", () => selectMode("marketplace"));
$("social-tab").addEventListener("click", () => selectMode("social"));
$("instagram-watch-tab").addEventListener("click", () => selectMode("instagram-watch"));
$("audience-fields").addEventListener("input", invalidatePreview);
$("audience-fields").addEventListener("change", invalidatePreview);
$("preview-audience").addEventListener("click", () => void previewAudience());
$("message").addEventListener("input", updateMessage);
$("image").addEventListener("change", () => void uploadImage());
$("remove-image").addEventListener("click", removeImage);
$("suggest-text").addEventListener("click", () => {
  if ($("message").value.trim() && !window.confirm("Заменить текущий текст?")) return;
  $("message").value = "Здравствуйте! Это рекламное предложение от Autodom. Если вам нужна информация по VIN автомобиля, можно обратиться к нашему Telegram-боту: https://t.me/autokgbot. Покрытие VIN-источников различается; отсутствие записей не подтверждает отсутствие ДТП. Если предложение неактуально, сообщите — мы исключим вас из дальнейших рассылок.";
  updateMessage();
});
$("campaign-form").addEventListener("submit", (event) => void createCampaign(event));
$("social-form").addEventListener("submit", (event) => void createSocialCampaign(event));
$("instagram-watch-form").addEventListener("submit", (event) => void saveInstagramWatch(event));
$("cancel-instagram-watch-edit").addEventListener("click", resetInstagramWatchForm);
$("refresh").addEventListener("click", () => void refreshData());
updateMessage();
updateControls();
void poll();
