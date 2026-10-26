import type { Listing } from "@autodom/core";
import {
  CATALOG_OPTION_LABELS,
  CATALOG_RANGE_LABELS,
  CATALOG_VEHICLE_LABELS,
} from "@autodom/core/catalog-filter";
import type { CatalogQuery } from "@autodom/core/catalog-query";
import { catalogQueryParams } from "@autodom/core/catalog-query";

/** Attribute keys of the shared reference data with their human labels. */
const ATTRIBUTE_LABELS: Readonly<Record<string, string>> = {
  ...CATALOG_VEHICLE_LABELS,
  ...CATALOG_OPTION_LABELS,
  ...CATALOG_RANGE_LABELS,
};

export interface SiteBrand {
  value: string;
  count: number;
}

export interface SitePricePoint {
  observed_at: number;
  price_usd_minor: number | null;
  price_kgs_minor: number | null;
  original_price_minor: number | null;
  original_currency: string;
}

export interface SiteCar {
  listing: Listing;
  photos: readonly string[];
  history: readonly SitePricePoint[];
  similar: readonly Listing[];
}

export interface SiteContext {
  query: CatalogQuery;
  listings: readonly Listing[];
  total: number;
  pages: number;
  brands: readonly SiteBrand[];
  botUsername?: string | undefined;
  publicUrl: string;
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const MONEY = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const CURRENCY_SIGN: Record<string, string> = { USD: "$", KGS: "с" };

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMoney(minor: number | null, currency: string): string {
  if (minor === null || !Number.isFinite(minor)) return "цена не указана";
  const sign = CURRENCY_SIGN[currency] ?? currency;
  return `${MONEY.format(Math.round(minor / 100))} ${sign}`;
}

export function formatDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "дата неизвестна";
  const date = new Date(epochSeconds * 1000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function carTitle(listing: Listing): string {
  return plain(listing.title) || listing.id;
}

export function carPrice(listing: Listing, currency: string): number | null {
  return currency === "USD" ? listing.price_usd_minor : listing.price_kgs_minor;
}

/** The price the source asked for, with its own currency and conversion date. */
export function originalPriceLabel(listing: Listing): string | null {
  if (!listing.original_currency || listing.original_price_minor === null) return null;
  const amount = formatMoney(listing.original_price_minor, listing.original_currency);
  if (!listing.fx_date) return amount;
  return `${amount} (курс на ${listing.fx_date})`;
}

export function carHref(listing: Listing): string {
  return `/cars/${encodeURIComponent(listing.id)}`;
}

export function brandHref(make: string, query?: CatalogQuery): string {
  const params = query ? catalogQueryParams(query) : new URLSearchParams();
  if (query) {
    params.delete("make");
    params.delete("model");
    params.delete("page");
  }
  params.set("make", make);
  return `/brands/${encodeURIComponent(make)}?${params.toString()}`;
}

function catalogHref(query: CatalogQuery, overrides: Partial<CatalogQuery> = {}): string {
  const merged = { ...query, ...overrides };
  const params = catalogQueryParams(merged);
  const suffix = params.toString();
  return suffix ? `/cars?${suffix}` : "/cars";
}

function optionList(
  items: readonly { label: string; value: string; selected: boolean; href: string }[],
): string {
  return items
    .map(
      (item) =>
        `<a class="chip${item.selected ? " chip--active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`,
    )
    .join("");
}

function carCard(listing: Listing, currency: string, photo: string | null): string {
  const price = carPrice(listing, currency);
  const original = originalPriceLabel(listing);
  const facts = [
    listing.year ? `${listing.year} г.` : null,
    plain(listing.mileage) || null,
    plain(listing.body_type) || null,
    plain(listing.city) || null,
  ].filter((value): value is string => Boolean(value));
  return [
    `<article class="car">`,
    photo
      ? `<a class="car__photo" href="${escapeHtml(carHref(listing))}"><img src="${escapeHtml(photo)}" alt="${escapeHtml(carTitle(listing))}" loading="lazy" referrerpolicy="no-referrer"></a>`
      : `<a class="car__photo car__photo--empty" href="${escapeHtml(carHref(listing))}">Фото источника недоступны</a>`,
    `<div class="car__body">`,
    `<h3 class="car__title"><a href="${escapeHtml(carHref(listing))}">${escapeHtml(carTitle(listing))}</a></h3>`,
    `<p class="car__price">${escapeHtml(formatMoney(price, currency))}${original ? ` <span class="car__original">${escapeHtml(original)}</span>` : ""}</p>`,
    facts.length ? `<p class="car__facts">${escapeHtml(facts.join(" · "))}</p>` : "",
    `<p class="car__source">Источник: ${escapeHtml(listing.source)} · обновлено ${escapeHtml(formatDate(listing.observed_at ?? 0))}</p>`,
    `</div></article>`,
  ].join("");
}

function filterForm(query: CatalogQuery, action: string): string {
  const budgetMin = query.budget_min_minor === null ? "" : String(query.budget_min_minor / 100);
  const budgetMax = query.budget_max_minor === null ? "" : String(query.budget_max_minor / 100);
  const field = (name: string, label: string, value: string, type = "text"): string =>
    `<label class="field"><span class="field__label">${escapeHtml(label)}</span><input class="field__input" type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${type === "number" ? ' min="0" step="1"' : ""}></label>`;
  const select = (
    name: string,
    label: string,
    value: string,
    options: readonly [string, string][],
  ): string =>
    `<label class="field"><span class="field__label">${escapeHtml(label)}</span><select class="field__input" name="${escapeHtml(name)}">${options
      .map(
        ([optionValue, optionLabel]) =>
          `<option value="${escapeHtml(optionValue)}"${optionValue === value ? " selected" : ""}>${escapeHtml(optionLabel)}</option>`,
      )
      .join("")}</select></label>`;
  // The make and model live in the path of a brand page; keep them when the form is sent.
  const hidden = [
    query.make ? `<input type="hidden" name="make" value="${escapeHtml(query.make)}">` : "",
    query.model ? `<input type="hidden" name="model" value="${escapeHtml(query.model)}">` : "",
  ].join("");
  return [
    `<form class="filters" method="get" action="${escapeHtml(action)}">`,
    hidden,
    field("q", "Поиск по названию", query.q),
    field("budget_min", `Бюджет от, ${query.currency === "USD" ? "$" : "с"}`, budgetMin, "number"),
    field("budget_max", `Бюджет до, ${query.currency === "USD" ? "$" : "с"}`, budgetMax, "number"),
    field("year_min", "Год от", query.year_min === null ? "" : String(query.year_min), "number"),
    field(
      "mileage_max_km",
      "Пробег до, км",
      query.mileage_max_km === null ? "" : String(query.mileage_max_km),
      "number",
    ),
    select("market", "Направление", query.market, [
      ["ALL", "Все рынки"],
      ["KG", "Кыргызстан"],
    ]),
    select("currency", "Валюта", query.currency, [
      ["KGS", "Сомы (KGS)"],
      ["USD", "Доллары (USD)"],
    ]),
    select("sort", "Сортировка", query.sort, [
      ["new", "Сначала новые"],
      ["price_asc", "Сначала дешевле"],
      ["price_desc", "Сначала дороже"],
      ["mileage_asc", "Сначала меньше пробег"],
    ]),
    `<button class="button" type="submit">Показать</button>`,
    `</form>`,
  ].join("");
}

function emptyState(query: CatalogQuery): string {
  const relaxations: { label: string; href: string }[] = [];
  if (query.budget_max_minor !== null)
    relaxations.push({
      label: `Поднять бюджет до ${Math.round((query.budget_max_minor * 1.5) / 100)}`,
      href: catalogHref(query, { budget_max_minor: Math.round(query.budget_max_minor * 1.5) }),
    });
  if (query.year_min !== null)
    relaxations.push({
      label: "Не ограничивать год",
      href: catalogHref(query, { year_min: null }),
    });
  if (query.mileage_max_km !== null)
    relaxations.push({
      label: "Не ограничивать пробег",
      href: catalogHref(query, { mileage_max_km: null }),
    });
  if (query.make)
    relaxations.push({
      label: "Искать все марки",
      href: catalogHref(query, { make: "", model: "" }),
    });
  if (query.market !== "ALL")
    relaxations.push({
      label: "Искать по всем рынкам",
      href: catalogHref(query, { market: "ALL" }),
    });
  if (query.q)
    relaxations.push({
      label: "Искать без текстового запроса",
      href: catalogHref(query, { q: "" }),
    });
  const list = relaxations.length
    ? `<ul class="relax">${relaxations.map((item) => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`).join("")}</ul>`
    : `<p>Под текущие условия в нашем каталоге ничего не нашлось. Попробуйте изменить бюджет или снять ограничения.</p>`;
  return [
    `<section class="empty">`,
    `<h2>Под текущие условия ничего не нашлось</h2>`,
    `<p>Мы показываем только автомобили, которые действительно есть в нашем каталоге на сейчас. Это не значит, что таких машин нет на рынке: возможно, они не попали в подборку или не подходят под ограничения.</p>`,
    list,
    `</section>`,
  ].join("");
}

function pagination(query: CatalogQuery, pages: number): string {
  if (pages <= 1) return "";
  const current = query.page;
  const links: string[] = [];
  const push = (page: number, label: string, disabled = false): void => {
    links.push(
      disabled
        ? `<span class="page page--disabled">${escapeHtml(label)}</span>`
        : `<a class="page" href="${escapeHtml(catalogHref(query, { page }))}">${escapeHtml(label)}</a>`,
    );
  };
  push(current - 1, "←", current <= 1);
  const first = Math.max(1, current - 2);
  const last = Math.min(pages, first + 4);
  for (let page = first; page <= last; page += 1) {
    links.push(
      page === current
        ? `<span class="page page--current" aria-current="page">${page}</span>`
        : `<a class="page" href="${escapeHtml(catalogHref(query, { page }))}">${page}</a>`,
    );
  }
  push(current + 1, "→", current >= pages);
  return `<nav class="pagination" aria-label="Страницы каталога">${links.join("")}</nav>`;
}

function page(options: {
  title: string;
  description: string;
  canonical: string;
  body: string;
  publicUrl: string;
  botUsername?: string | undefined;
}): string {
  const canonical = new URL(options.canonical, options.publicUrl).href;
  const bot = options.botUsername
    ? `<a class="button button--bot" href="https://t.me/${escapeHtml(options.botUsername)}">Открыть бота подбора</a>`
    : "";
  return [
    `<!doctype html><html lang="ru"><head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<link rel="stylesheet" href="/site.css">`,
    `</head><body>`,
    `<header class="top"><a class="top__brand" href="/">Autodom</a>`,
    `<nav class="top__nav"><a href="/cars">Каталог</a><a href="/cars?sort=new">Новые объявления</a></nav>`,
    bot,
    `</header>`,
    `<main class="main">${options.body}</main>`,
    `<footer class="footer">`,
    `<p>Каталог собран из объявлений разрешённых площадок. Цена объявления не равна цене сделки; отсутствие данных не означает отсутствие проблем.</p>`,
    `<p>Проверка VIN, отчёты и оплата — в отдельном боте @autokgbot.</p>`,
    `</footer>`,
    `</body></html>`,
  ].join("");
}

export function renderHome(context: SiteContext, photos: ReadonlyMap<string, string>): string {
  const cards = context.listings
    .map((listing) => carCard(listing, context.query.currency, photos.get(listing.id) ?? null))
    .join("");
  const brands = context.brands.length
    ? optionList(
        context.brands.map((brand) => ({
          label: `${brand.value} (${brand.count})`,
          value: brand.value,
          selected: false,
          href: brandHref(brand.value),
        })),
      )
    : `<p>Марки появятся, как только каталог соберёт объявления.</p>`;
  const body = [
    `<section class="hero">`,
    `<h1>Автомобили с ценами из нашего каталога</h1>`,
    `<p>Показываем машины, которые действительно сейчас есть в объявлениях разрешённых площадок, с источником и датой проверки. Без подписки и без платного барьера.</p>`,
    filterForm(context.query, "/cars"),
    `</section>`,
    `<section class="section"><h2>Марки в каталоге</h2><div class="chips">${brands}</div></section>`,
    `<section class="section"><h2>Свежие объявления</h2><div class="cars">${cards}</div>`,
    `<p class="more"><a href="/cars">Весь каталог</a></p></section>`,
  ].join("");
  return page({
    title: "Autodom — каталог автомобилей",
    description:
      "Каталог автомобилей с ценами, источниками и датой проверки. Бесплатный поиск и мониторинг.",
    canonical: "/",
    body,
    publicUrl: context.publicUrl,
    botUsername: context.botUsername,
  });
}

export function renderCatalog(context: SiteContext, photos: ReadonlyMap<string, string>): string {
  const cards = context.listings
    .map((listing) => carCard(listing, context.query.currency, photos.get(listing.id) ?? null))
    .join("");
  const body = [
    `<section class="hero hero--compact">`,
    `<h1>Каталог автомобилей</h1>`,
    `<p>Найдено ${NUMBER.format(context.total)} в нашем каталоге на ${escapeHtml(formatDate(Date.now() / 1000))}. Показаны цены с учётом курса на дату проверки; исходная цена источника показана рядом.</p>`,
    filterForm(context.query, "/cars"),
    `</section>`,
    context.total === 0
      ? emptyState(context.query)
      : `<div class="cars">${cards}</div>${pagination(context.query, context.pages)}`,
  ].join("");
  return page({
    title: "Каталог автомобилей — Autodom",
    description: "Каталог автомобилей с фильтрами по бюджету, году, пробегу и рынку.",
    canonical: `/cars${catalogQueryParams(context.query).toString() ? `?${catalogQueryParams(context.query).toString()}` : ""}`,
    body,
    publicUrl: context.publicUrl,
    botUsername: context.botUsername,
  });
}

export function renderCar(car: SiteCar, context: SiteContext): string {
  const listing = car.listing;
  const photos = car.photos
    .map(
      (photo, index) =>
        `<a class="gallery__item" href="${escapeHtml(photo)}" rel="noopener noreferrer"><img src="${escapeHtml(photo)}" alt="${escapeHtml(`${carTitle(listing)} — фото ${index + 1}`)}" loading="${index === 0 ? "eager" : "lazy"}" referrerpolicy="no-referrer"></a>`,
    )
    .join("");
  const attributes = Object.entries(listing.catalog_attributes)
    .filter(([, value]) => Boolean(value))
    .map(
      ([key, value]) =>
        `<div class="spec"><dt>${escapeHtml(ATTRIBUTE_LABELS[key] ?? key)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("");
  const rows = [
    ["Цена", formatMoney(carPrice(listing, context.query.currency), context.query.currency)],
    originalPriceLabel(listing) ? ["Исходная цена", originalPriceLabel(listing)!] : null,
    listing.year ? ["Год выпуска", String(listing.year)] : null,
    plain(listing.mileage) ? ["Пробег", plain(listing.mileage)] : null,
    plain(listing.body_type) ? ["Кузов", plain(listing.body_type)] : null,
    plain(listing.transmission) ? ["Коробка", plain(listing.transmission)] : null,
    plain(listing.city) ? ["Город", plain(listing.city)] : null,
    plain(listing.trim) ? ["Комплектация", plain(listing.trim)] : null,
    listing.vin ? ["VIN", listing.vin] : null,
    ["Источник", listing.source],
    ["Дата проверки", formatDate(listing.observed_at ?? 0)],
  ].filter((row): row is [string, string] => row !== null);
  const history = car.history.length
    ? `<section class="section"><h2>История цены</h2><table class="history"><thead><tr><th>Дата</th><th>Цена</th></tr></thead><tbody>${car.history
        .map((point) => {
          const value =
            point.price_usd_minor !== null || point.price_kgs_minor !== null
              ? formatMoney(
                  context.query.currency === "USD" ? point.price_usd_minor : point.price_kgs_minor,
                  context.query.currency,
                )
              : point.original_price_minor !== null
                ? formatMoney(point.original_price_minor, point.original_currency || "USD")
                : "цена не зафиксирована";
          return `<tr><td>${escapeHtml(formatDate(point.observed_at))}</td><td>${escapeHtml(value)}</td></tr>`;
        })
        .join("")}</tbody></table></section>`
    : `<section class="section"><h2>История цены</h2><p>Мы не нашли зафиксированных изменений цены по этому объявлению. Это не значит, что цена никогда не менялась.</p></section>`;
  const similar = car.similar.length
    ? `<section class="section"><h2>Похожие объявления</h2><div class="cars">${car.similar
        .map((item) => carCard(item, context.query.currency, null))
        .join("")}</div></section>`
    : "";
  const botLink = context.botUsername
    ? `<a class="button button--bot" href="https://t.me/${escapeHtml(context.botUsername)}?start=car_${encodeURIComponent(listing.id)}">Открыть эту машину в боте</a>`
    : "";
  const body = [
    `<article class="car-page">`,
    `<nav class="crumbs"><a href="/cars">Каталог</a>${listing.catalog_attributes.make ? ` / <a href="${escapeHtml(brandHref(listing.catalog_attributes.make))}">${escapeHtml(listing.catalog_attributes.make)}</a>` : ""}</nav>`,
    `<h1>${escapeHtml(carTitle(listing))}</h1>`,
    photos
      ? `<div class="gallery">${photos}</div>`
      : `<p class="note">Фото источника недоступны по нашему разрешению на показ. Откройте объявление на площадке, чтобы увидеть фотографии.</p>`,
    `<div class="car-page__main">`,
    `<dl class="specs">${rows.map(([label, value]) => `<div class="spec"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`,
    `<p class="actions"><a class="button" href="${escapeHtml(listing.url)}" rel="noopener noreferrer nofollow">Открыть объявление на источнике</a>${botLink}</p>`,
    `</div>`,
    `</article>`,
    attributes
      ? `<section class="section"><h2>Характеристики по данным источника</h2><dl class="specs">${attributes}</dl></section>`
      : "",
    history,
    similar,
    `<section class="section"><p class="note">Цена объявления не равна цене сделки. Отсутствие пробега, ДТП или истории в объявлении не доказывает их отсутствие — проверьте VIN и документы до сделки.</p></section>`,
  ].join("");
  return page({
    title: `${carTitle(listing)} — Autodom`,
    description: `${carTitle(listing)}, ${formatMoney(carPrice(listing, context.query.currency), context.query.currency)}. Источник и дата проверки.`,
    canonical: carHref(listing),
    body,
    publicUrl: context.publicUrl,
    botUsername: context.botUsername,
  });
}

export function renderNotFound(context: SiteContext): string {
  return page({
    title: "Страница не найдена — Autodom",
    description: "Страница не найдена.",
    canonical: "/404",
    body: `<section class="empty"><h1>Страница не найдена</h1><p>Возможно, объявление сняли или ссылка устарела.</p><p><a href="/cars">Перейти в каталог</a></p></section>`,
    publicUrl: context.publicUrl,
    botUsername: context.botUsername,
  });
}
