import { load } from "cheerio";
import { Decimal } from "decimal.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Listing } from "./models.js";
import { type DocumentTransport, SourceError, SourceRateLimited } from "./transport.js";

export interface MetadataStore {
  getMeta(key: string, defaultValue?: string | null): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

const FEEDS: Readonly<Record<string, readonly [string, number]>> = {
  USD: ["https://www.nbkr.kg/XML/daily.xml", 4],
  KRW: ["https://www.nbkr.kg/XML/weekly.xml", 7],
  AED: ["https://www.nbkr.kg/XML/weekly.xml", 7],
};
const ARCHIVES: Readonly<Record<string, readonly [string, string]>> = {
  USD: ["15", "Доллар США"],
  KRW: ["25", "Вона Республики Корея/южно-корейский вон"],
  AED: ["103", "Дирхам ОАЭ"],
};
const LAST_REFRESH = "nbkr:last_refresh";
const NEXT_REFRESH = "nbkr:next_refresh";
const REFRESH_CURRENCIES = "nbkr:refresh_currencies";
const CURRENCY_SIGNATURE = Object.keys(FEEDS).join(",");
const ExactDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
});

function calendarDate(year: number, month: number, day: number): string {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
    throw new Error("Invalid NBKR date");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error("Invalid NBKR date");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export class Quote {
  readonly starts_at: number;
  readonly expires_at: number;
  constructor(
    readonly currency: string,
    readonly date: string,
    readonly nominal: Decimal,
    readonly value: Decimal,
    readonly valid_days: number,
  ) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    if (!match || calendarDate(Number(match[1]), Number(match[2]), Number(match[3])) !== date)
      throw new Error("Invalid NBKR date");
    this.starts_at = Date.parse(`${date}T00:00:00+06:00`) / 1000;
    this.expires_at = this.starts_at + valid_days * 86400;
  }
  validAt(now: number): boolean {
    return this.starts_at <= now && now < this.expires_at;
  }
}

class PrepublishedQuote extends Error {}

function decimal(value: unknown): Decimal {
  if (typeof value !== "string" || value.length > 100) throw new Error("Invalid NBKR amount");
  const text = value.trim().replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text))
    throw new Error("Invalid NBKR amount");
  const number = new ExactDecimal(text);
  if (!number.isFinite() || number.lte(0) || Math.abs(number.e) > 20)
    throw new Error("Invalid NBKR amount");
  return number;
}

function quote(
  currency: string,
  date: unknown,
  nominal: unknown,
  value: unknown,
  days: unknown,
  now: number,
): Quote {
  const feed = Object.hasOwn(FEEDS, currency) ? FEEDS[currency] : undefined;
  if (
    !feed ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days !== feed[1] ||
    typeof date !== "string"
  )
    throw new Error("Invalid NBKR quote validity");
  const unit = decimal(nominal);
  if (!unit.isInteger()) throw new Error("Invalid NBKR nominal");
  const result = new Quote(currency, date, unit, decimal(value), days);
  if (result.starts_at > now) throw new PrepublishedQuote("NBKR quote is not effective yet");
  if (!result.validAt(now)) throw new Error("Future or expired NBKR quote");
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQuote(text: string, currency: string, now = Date.now() / 1000): Quote {
  try {
    const feed = Object.hasOwn(FEEDS, currency) ? FEEDS[currency] : undefined;
    if (!feed || /<!DOCTYPE|<!ENTITY/iu.test(text) || XMLValidator.validate(text) !== true)
      throw new Error("Unsupported NBKR document");
    const document: unknown = parser.parse(text);
    if (
      !record(document) ||
      Object.keys(document)
        .filter((key) => !key.startsWith("?"))
        .join(",") !== "CurrencyRates"
    )
      throw new Error("Invalid NBKR root");
    const root = document.CurrencyRates;
    if (!record(root) || typeof root["@_Date"] !== "string") throw new Error("Invalid NBKR root");
    const date = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(root["@_Date"]);
    if (!date) throw new Error("Invalid NBKR date");
    const day = calendarDate(Number(date[3]), Number(date[2]), Number(date[1]));
    const entries: unknown[] = Array.isArray(root.Currency) ? root.Currency : [root.Currency];
    const required = entries.filter(
      (entry): entry is Record<string, unknown> => record(entry) && entry["@_ISOCode"] === currency,
    );
    if (required.length !== 1) throw new Error("Required NBKR currency missing or duplicated");
    const entry = required[0]!;
    if (feed[1] === 7 && entry.ValidFor !== "7") throw new Error("Unverified NBKR weekly validity");
    return quote(currency, day, entry.Nominal, entry.Value, feed[1], now);
  } catch (cause) {
    throw new SourceError(`Invalid or unavailable NBKR ${currency} quote`, { cause });
  }
}

function archiveUrl(currency: string, now: number): string {
  const url = new URL("https://www.nbkr.kg/index1.jsp");
  url.searchParams.set("item", "1562");
  url.searchParams.set("lang", "RUS");
  url.searchParams.set("valuta_id", ARCHIVES[currency]![0]);
  // The official archive dates are effective dates in Bishkek, not publication dates.
  // Request only dates that can still pass the existing freshness limit.
  for (const [prefix, age] of [
    ["beg", FEEDS[currency]![1] - 1],
    ["end", 0],
  ] as const) {
    const date = new Date((now + 6 * 3600 - age * 86400) * 1000);
    url.searchParams.set(`${prefix}_day`, String(date.getUTCDate()).padStart(2, "0"));
    url.searchParams.set(`${prefix}_month`, String(date.getUTCMonth() + 1).padStart(2, "0"));
    url.searchParams.set(`${prefix}_year`, String(date.getUTCFullYear()));
  }
  return url.href;
}

function parseArchive(text: string, currency: string, now: number): Quote {
  try {
    const [id, name] = ARCHIVES[currency]!;
    const $ = load(text);
    const selected = $('select[name="valuta_id"] > option[selected]');
    const heading = $("center > span[align='center']");
    const nominal = new RegExp(`^(\\d+) ${name}$`, "u").exec(selected.text().trim())?.[1];
    if (
      selected.length !== 1 ||
      selected.attr("value") !== id ||
      !nominal ||
      heading.length !== 1 ||
      heading.text().trim() !== selected.text().trim()
    )
      throw new Error("Unverified NBKR archive currency");
    const rows = heading.nextAll("table").first().find("tr");
    const headers = rows.first().children("td");
    if (
      headers.length !== 2 ||
      headers.eq(0).text().replace(/\s+/gu, "") !== "Дата(курсыдействуютсуказанныхдат)" ||
      headers.eq(1).text().replace(/\s+/gu, "") !== "Курс(ккыргызскомусому)"
    )
      throw new Error("Unverified NBKR archive dates");
    const unit = decimal(nominal);
    if (!unit.isInteger()) throw new Error("Invalid NBKR nominal");
    let newest: Quote | undefined;
    const dates = new Set<string>();
    for (const row of rows.slice(1)) {
      const cells = $(row).children("td");
      const date = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(cells.eq(0).text().trim());
      if (cells.length !== 2 || !date) throw new Error("Invalid NBKR archive row");
      const day = calendarDate(Number(date[3]), Number(date[2]), Number(date[1]));
      if (dates.has(day)) throw new Error("Duplicated NBKR archive date");
      dates.add(day);
      const candidate = new Quote(
        currency,
        day,
        unit,
        decimal(cells.eq(1).text()),
        FEEDS[currency]![1],
      );
      if (candidate.starts_at > now) throw new PrepublishedQuote("NBKR quote is not effective yet");
      if (candidate.validAt(now) && (!newest || candidate.date > newest.date)) newest = candidate;
    }
    if (!newest) throw new Error("No effective NBKR archive quote");
    return newest;
  } catch (cause) {
    throw new SourceError(`Invalid or unavailable NBKR ${currency} archive`, { cause });
  }
}

function minor(amount: Decimal): number | null {
  const rounded = amount.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return rounded.isFinite() && rounded.gt(0) && rounded.lte(Number.MAX_SAFE_INTEGER)
    ? rounded.toNumber()
    : null;
}

export class RateBook {
  readonly quotes: Record<string, Quote> = {};
  private loaded: Promise<void> | undefined;
  private lastRefresh = 0;
  private nextRefresh = 0;

  constructor(
    readonly store: MetadataStore,
    readonly transport: DocumentTransport,
  ) {}

  private async loadCache(): Promise<void> {
    const now = Date.now() / 1000;
    for (const currency of Object.keys(FEEDS)) {
      const saved = await this.store.getMeta(`nbkr:${currency}`);
      if (!saved) continue;
      try {
        const data: unknown = JSON.parse(saved);
        if (!record(data)) continue;
        const cached = quote(currency, data.date, data.nominal, data.value, data.valid_days, now);
        const current = this.quotes[currency];
        if (!current || current.date <= cached.date) this.quotes[currency] = cached;
      } catch {
        /* Invalid persisted quotes are unavailable, never conversion inputs. */
      }
    }
    const saved = await this.store.getMeta(LAST_REFRESH, "0");
    const attempted = saved === null || saved.trim() === "" ? NaN : Number(saved);
    this.lastRefresh =
      Number.isFinite(attempted) && attempted >= 0 && attempted <= now ? attempted : 0;
    const scheduled = Number(
      await this.store.getMeta(NEXT_REFRESH, String(this.lastRefresh + 3600)),
    );
    this.nextRefresh =
      Number.isFinite(scheduled) &&
      scheduled >= this.lastRefresh &&
      scheduled <= this.lastRefresh + 3600
        ? scheduled
        : this.lastRefresh + 3600;
    // An older currency set's cooldown does not cover newly supported currencies.
    if ((await this.store.getMeta(REFRESH_CURRENCIES)) !== CURRENCY_SIGNATURE) this.nextRefresh = 0;
  }

  async refresh(): Promise<void> {
    // Async stores cannot hydrate in a synchronous constructor. Always await the first
    // refresh before consuming persisted quotes; hydration precedes the hourly throttle.
    this.loaded ??= this.loadCache();
    await this.loaded;
    const now = Date.now() / 1000;
    if (now >= this.lastRefresh && now < this.nextRefresh) return;
    this.lastRefresh = now;
    await this.store.setMeta(LAST_REFRESH, String(now));
    this.nextRefresh = now + 3600;
    await this.store.setMeta(NEXT_REFRESH, String(this.nextRefresh));
    // Persist the attempted set before I/O, including failures/rate limits, so
    // reopening cannot turn a missing quote into a request on every page.
    await this.store.setMeta(REFRESH_CURRENCIES, CURRENCY_SIGNATURE);
    let nextRefresh = this.nextRefresh;
    const documents = new Map<string, string>();
    for (const [currency, feed] of Object.entries(FEEDS)) {
      let fetched: Quote | null;
      try {
        const parse = (text: string): Quote | null => {
          let result: Quote | null;
          try {
            result = parseQuote(text, currency);
          } catch (error) {
            if (error instanceof SourceError && error.cause instanceof PrepublishedQuote)
              result = null;
            else throw error;
          }
          documents.set(feed[0], text);
          return result;
        };
        const document = documents.get(feed[0]);
        fetched =
          document === undefined
            ? await this.transport.fetchDocument(feed[0], parse, {
                source: "nbkr.kg",
                headers: { Accept: "application/xml,text/xml" },
              })
            : parse(document);
        if (fetched === null) {
          const cached = this.quotes[currency];
          if (cached?.validAt(now)) {
            nextRefresh = Math.min(nextRefresh, cached.expires_at);
            continue;
          }
          // NBKR rules §§6,8: published today, effective next calendar day.
          // https://www.nbkr.kg/contout.jsp?lang=RUS&material=132534
          fetched = await this.transport.fetchDocument(
            archiveUrl(currency, now),
            (text) => parseArchive(text, currency, Date.now() / 1000),
            { source: "nbkr.kg", headers: { Accept: "text/html" } },
          );
        }
      } catch (error) {
        if (error instanceof SourceRateLimited) return;
        if (error instanceof SourceError) continue;
        throw error;
      }
      const cached = this.quotes[currency];
      if (cached && fetched.date < cached.date) continue;
      await this.store.setMeta(
        `nbkr:${currency}`,
        JSON.stringify({
          date: fetched.date,
          nominal: fetched.nominal.toString(),
          value: fetched.value.toString(),
          valid_days: fetched.valid_days,
        }),
      );
      this.quotes[currency] = fetched;
      nextRefresh = Math.min(nextRefresh, fetched.expires_at);
    }
    // Successful quotes may expire before the hourly poll, notably at Bishkek
    // midnight. Persist that deadline so restarting cannot postpone fresh prices.
    if (nextRefresh < this.nextRefresh) {
      this.nextRefresh = nextRefresh;
      await this.store.setMeta(NEXT_REFRESH, String(nextRefresh));
    }
  }

  convert(listing: Listing, now = Date.now() / 1000): Listing {
    const currency = listing.original_currency;
    const original = listing.original_price_minor;
    // Domestic sources may supply both prices themselves; these are not NBKR quotes.
    if (
      !currency ||
      (listing.market === "KG" &&
        listing.price_usd_minor !== null &&
        listing.price_kgs_minor !== null &&
        listing.fx_expires_at === null &&
        listing.fx_date === "")
    )
      return listing;
    const validPrice =
      (listing.price_kind === "asking" || listing.price_kind === "buy_now") &&
      original !== null &&
      Number.isSafeInteger(original) &&
      original > 0;
    let dollars = validPrice && currency === "USD" ? original : null;
    let som = validPrice && currency === "KGS" ? original : null;
    let used: Quote[] = [];
    if (
      validPrice &&
      original !== null &&
      (currency === "USD" || currency === "KGS" || currency === "KRW" || currency === "AED")
    ) {
      const usd = this.quotes.USD?.validAt(now) ? this.quotes.USD : undefined;
      const native = this.quotes[currency]?.validAt(now) ? this.quotes[currency] : undefined;
      if (currency === "USD" && usd) {
        som = minor(new ExactDecimal(original).mul(usd.value).div(usd.nominal));
        if (som !== null) used.push(usd);
      } else if (currency === "KGS" && usd) {
        dollars = minor(new ExactDecimal(original).mul(usd.nominal).div(usd.value));
        if (dollars !== null) used.push(usd);
      } else if ((currency === "KRW" || currency === "AED") && native) {
        // Won is whole units; AED is fils. Keep KGS minor units exact until each output rounds.
        const somAmount = new ExactDecimal(original)
          .mul(currency === "KRW" ? 100 : 1)
          .mul(native.value)
          .div(native.nominal);
        som = minor(somAmount);
        if (som !== null) used.push(native);
        if (usd) {
          dollars = minor(somAmount.mul(usd.nominal).div(usd.value));
          if (dollars !== null) used = [usd, native];
        }
      }
    }
    return {
      ...listing,
      price_usd_minor: dollars,
      price_kgs_minor: som,
      fx_date: used.map((item) => `${item.currency}:${item.date}`).join(";"),
      fx_expires_at: used.length ? Math.min(...used.map((item) => item.expires_at)) : null,
    };
  }
}
