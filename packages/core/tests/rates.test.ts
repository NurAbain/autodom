import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeListing } from "../src/models.js";
import { type MetadataStore, parseQuote, RateBook } from "../src/rates.js";
import { type DocumentTransport, SourceError, SourceRateLimited } from "../src/transport.js";

const instant = (day: string) =>
  Date.parse(`${day.includes("T") ? day : `${day}T00:00:00`}+06:00`) / 1000;
const entry = (currency: string, value: string, nominal = "1", valid = "7") =>
  `<Currency ISOCode="${currency}"><Nominal>${nominal}</Nominal>${currency === "KRW" || currency === "AED" ? `<ValidFor>${valid}</ValidFor>` : ""}<Value>${value}</Value></Currency>`;
const xml = (currency: string, value: string, date = "10.09.2026", nominal = "1", valid = "7") =>
  `<CurrencyRates Date="${date}">${entry(currency, value, nominal, valid)}</CurrencyRates>`;
const car = (currency = "KRW", amount = 1) =>
  makeListing({
    id: "encar:synthetic",
    title: "Synthetic",
    url: "https://example.invalid/vehicle",
    source: "encar.com",
    market: "KR",
    original_currency: currency,
    original_price_minor: amount,
  });
function metadata(): MetadataStore {
  const data = new Map<string, string>();
  return {
    async getMeta(key, fallback = null) {
      return data.get(key) ?? fallback;
    },
    async setMeta(key, value) {
      data.set(key, value);
    },
  };
}
function transport(fetch: (url: string) => string | Promise<string>): DocumentTransport {
  return {
    async fetchDocument(url, parse) {
      return parse(await fetch(url));
    },
    async fetchDocuments(requests) {
      return Promise.all(requests.map(async (request) => request.parse(await fetch(request.url))));
    },
  };
}
const unavailable = transport(() => {
  throw new SourceError("offline");
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(instant("2026-09-10T12:00:00") * 1000);
});
afterEach(() => vi.useRealTimers());

it("uses nominal, comma decimals and half-up without double-rounding", () => {
  const book = new RateBook(metadata(), unavailable);
  book.quotes.USD = parseQuote(xml("USD", "2,0000"), "USD");
  book.quotes.KRW = parseQuote(xml("KRW", "0,2500", "10.09.2026", "10"), "KRW");
  const converted = book.convert(car());
  expect(converted).toMatchObject({
    original_price_minor: 1,
    price_kgs_minor: 3,
    price_usd_minor: 1,
    fx_date: "USD:2026-09-10;KRW:2026-09-10",
    fx_expires_at: instant("2026-09-14"),
  });
  expect(book.convert(car("USD", 1)).price_kgs_minor).toBe(2);
});

it("converts fils with nominal and rounds each target only once", () => {
  const book = new RateBook(metadata(), unavailable);
  book.quotes.USD = parseQuote(xml("USD", "2,0000"), "USD");
  book.quotes.AED = parseQuote(xml("AED", "25,0000", "10.09.2026", "10"), "AED");
  expect(book.convert(car("AED", 1))).toMatchObject({
    original_currency: "AED",
    original_price_minor: 1,
    price_kgs_minor: 3,
    price_usd_minor: 1,
    fx_date: "USD:2026-09-10;AED:2026-09-10",
    fx_expires_at: instant("2026-09-14"),
  });
});

it("clears expired conversions but preserves native USD", () => {
  const book = new RateBook(metadata(), unavailable);
  const usd = { ...car("USD", 123), price_kgs_minor: 999, fx_date: "old", fx_expires_at: 1 };
  expect(book.convert(usd)).toMatchObject({ price_usd_minor: 123, price_kgs_minor: null });
  book.quotes.USD = parseQuote(xml("USD", "87,4500"), "USD");
  book.quotes.KRW = parseQuote(xml("KRW", "0,0647", "05.09.2026"), "KRW");
  const converted = book.convert(car("KRW", 18500000));
  expect(converted).toMatchObject({
    price_kgs_minor: 119695000,
    price_usd_minor: 1368725,
    fx_expires_at: instant("2026-09-12"),
  });
  vi.setSystemTime(instant("2026-09-12") * 1000);
  expect(book.convert(converted)).toMatchObject({
    price_usd_minor: null,
    price_kgs_minor: null,
    original_price_minor: 18500000,
    fx_date: "",
    fx_expires_at: null,
  });
  expect(book.convert(usd).price_kgs_minor).toBe(10756);
  vi.setSystemTime(instant("2026-09-14") * 1000);
  expect(book.convert(usd)).toMatchObject({ price_usd_minor: 123, price_kgs_minor: null });
});

it("can convert weekly KRW to som independently but cannot normalize lease prices", () => {
  const book = new RateBook(metadata(), unavailable);
  book.quotes.KRW = parseQuote(xml("KRW", "0,0647"), "KRW");
  const converted = book.convert(car("KRW", 1000));
  expect(converted).toMatchObject({
    price_kgs_minor: 6470,
    price_usd_minor: null,
    fx_date: "KRW:2026-09-10",
    fx_expires_at: instant("2026-09-17"),
  });
  expect(book.convert({ ...converted, price_kind: "lease" })).toMatchObject({
    price_kgs_minor: null,
    price_usd_minor: null,
  });
});

it("keeps AED native value as daily and weekly conversions expire independently", () => {
  const book = new RateBook(metadata(), unavailable);
  book.quotes.AED = parseQuote(xml("AED", "23,8108"), "AED");
  const original = car("AED", 100000);
  expect(book.convert(original)).toMatchObject({
    price_kgs_minor: 2381080,
    price_usd_minor: null,
    fx_date: "AED:2026-09-10",
    fx_expires_at: instant("2026-09-17"),
  });
  book.quotes.USD = parseQuote(xml("USD", "87,4500"), "USD");
  const converted = book.convert(original);
  expect(converted.fx_expires_at).toBe(instant("2026-09-14"));
  vi.setSystemTime(instant("2026-09-14") * 1000);
  expect(book.convert(converted)).toMatchObject({
    price_kgs_minor: 2381080,
    price_usd_minor: null,
    fx_date: "AED:2026-09-10",
    fx_expires_at: instant("2026-09-17"),
  });
  vi.setSystemTime(instant("2026-09-17") * 1000);
  expect(book.convert(converted)).toMatchObject({
    original_currency: "AED",
    original_price_minor: 100000,
    price_kgs_minor: null,
    price_usd_minor: null,
    fx_date: "",
    fx_expires_at: null,
  });
});

it.each([
  xml("KRW", "NaN"),
  xml("KRW", "0,0647", "10.09.2026", "0"),
  xml("KRW", "0,0647", "10.09.2026", "1", "30"),
  xml("KRW", "0,0647").replace("<ValidFor>7</ValidFor>", ""),
  xml("KRW", "0,0647", "11.09.2026"),
  xml("KRW", "0,0647", "03.09.2026"),
  xml("KRW", "0,0647", "31.02.2026"),
  xml("KRW", "0,0647", "10.09.2026", "1.1"),
  xml("KRW", "1e100"),
  '<!DOCTYPE CurrencyRates [<!ENTITY amount "1">]>' + xml("KRW", "&amount;"),
  xml("KRW", "1").replace(
    "</CurrencyRates>",
    '<Currency ISOCode="KRW"><Nominal>1</Nominal><ValidFor>7</ValidFor><Value>1</Value></Currency></CurrencyRates>',
  ),
  xml("KRW", "1").replace("</Value>", "</Wrong>"),
])("rejects untrustworthy NBKR XML %#", (payload) => {
  expect(() => parseQuote(payload, "KRW")).toThrow(SourceError);
  expect(() => parseQuote(payload.replaceAll("KRW", "AED"), "AED")).toThrow(SourceError);
});

it("accepts weekend daily quotes and expires at the exact Bishkek four-day boundary", () => {
  const payload = xml("USD", "87,4500");
  expect(parseQuote(payload, "USD", instant("2026-09-13T23:59:59")).value.isFinite()).toBe(true);
  expect(() => parseQuote(payload, "USD", instant("2026-09-14"))).toThrow(SourceError);
  expect(() => parseQuote(payload, "USD", instant("2026-09-09T23:59:59"))).toThrow(SourceError);
});

it("hydrates exact persisted quotes before honoring the hourly throttle on reopen", async () => {
  const store = metadata();
  const book = new RateBook(
    store,
    transport((url) =>
      url.includes("daily")
        ? xml("USD", "87,45005", "10.09.2026", "10")
        : xml("KRW", "0,0647", "05.09.2026").replace(
            "</CurrencyRates>",
            `${entry("AED", "23,8108")}</CurrencyRates>`,
          ),
    ),
  );
  await book.refresh();
  const original = book.convert(car("USD", 10000000));
  expect(original.price_kgs_minor).toBe(87450050);
  expect(book.convert(car("AED", 100000)).price_kgs_minor).toBe(2381080);
  const reloaded = new RateBook(
    store,
    transport(() => {
      throw new Error("must not fetch within one hour");
    }),
  );
  await reloaded.refresh();
  expect(reloaded.convert(car("USD", 10000000))).toEqual(original);
  expect(reloaded.convert(car("KRW", 18500000))).toEqual(book.convert(car("KRW", 18500000)));
  expect(reloaded.convert(car("AED", 100000))).toEqual(book.convert(car("AED", 100000)));
});

it("retains weekly cache on feed failure while committing a new daily quote", async () => {
  const store = metadata();
  const book = new RateBook(
    store,
    transport((url) => {
      if (url.includes("weekly")) throw new SourceError("weekly unavailable");
      return xml("USD", "87,4500");
    }),
  );
  book.quotes.KRW = parseQuote(xml("KRW", "0,0647", "05.09.2026"), "KRW");
  await book.refresh();
  expect(book.convert(car("USD", 100)).price_kgs_minor).toBe(8745);
  expect(book.convert(car("KRW", 18500000)).price_usd_minor).toBe(1368725);
  const reopened = new RateBook(store, unavailable);
  await reopened.refresh();
  expect(reopened.convert(car("USD", 100)).price_kgs_minor).toBe(8745);
});

it("stops both feeds on origin rate limit, while ordinary daily failure allows weekly progress", async () => {
  const requested: string[] = [];
  const book = new RateBook(
    metadata(),
    transport((url) => {
      requested.push(url);
      throw new SourceRateLimited(7200);
    }),
  );
  await book.refresh();
  expect(requested).toEqual(["https://www.nbkr.kg/XML/daily.xml"]);
  const independent = new RateBook(
    metadata(),
    transport((url) => {
      if (url.includes("daily")) throw new SourceError("daily unavailable");
      return xml("KRW", "0,0647");
    }),
  );
  await independent.refresh();
  expect(independent.convert(car("KRW", 1000))).toMatchObject({
    price_kgs_minor: 6470,
    price_usd_minor: null,
  });
});

it("does not let a future throttle timestamp block refresh", async () => {
  const store = metadata();
  await store.setMeta("nbkr:last_refresh", String(instant("2026-09-11")));
  const book = new RateBook(
    store,
    transport((url) => (url.includes("daily") ? xml("USD", "87,4500") : xml("KRW", "0,0647"))),
  );
  await book.refresh();
  expect(book.convert(car("KRW", 18500000)).price_usd_minor).toBe(1368725);
});

it.each([
  { date: "2026-09-10", nominal: "1", value: "NaN", valid_days: 4 },
  { date: "2026-09-10", nominal: "0", value: "87.45", valid_days: 4 },
  { date: "2026-09-10", nominal: "1", value: "87.45", valid_days: 30 },
  { date: "2026-09-11", nominal: "1", value: "87.45", valid_days: 4 },
  { date: "2026-09-01", nominal: "1", value: "87.45", valid_days: 4 },
])("cannot consume untrusted persisted quotes during an outage %#", async (data) => {
  const store = metadata();
  await store.setMeta("nbkr:USD", JSON.stringify(data));
  const book = new RateBook(store, unavailable);
  await book.refresh();
  expect(book.convert(car("USD", 100))).toMatchObject({
    price_usd_minor: 100,
    price_kgs_minor: null,
    fx_date: "",
    fx_expires_at: null,
  });
});

it("excludes unsafe converted amounts rather than returning rounded integer money", () => {
  const book = new RateBook(metadata(), unavailable);
  book.quotes.USD = parseQuote(xml("USD", "87.45"), "USD");
  expect(book.convert(car("USD", Number.MAX_SAFE_INTEGER))).toMatchObject({
    price_usd_minor: Number.MAX_SAFE_INTEGER,
    price_kgs_minor: null,
    fx_expires_at: null,
  });
});

it("never replaces a newer valid quote with an older feed", async () => {
  const book = new RateBook(
    metadata(),
    transport((url) =>
      url.includes("daily") ? xml("USD", "80", "09.09.2026") : xml("KRW", "0,0647"),
    ),
  );
  book.quotes.USD = parseQuote(xml("USD", "87,4500"), "USD");
  await book.refresh();
  expect(book.convert(car("USD", 100)).price_kgs_minor).toBe(8745);
});

it.each([false, true])(
  "refreshes at Bishkek midnight even within the last hour (reopened: %s)",
  async (reopen) => {
    const boundary = instant("2026-09-12");
    vi.setSystemTime((boundary - 1800) * 1000);
    const store = metadata();
    let book = new RateBook(
      store,
      transport((url) => {
        if (url.includes("daily")) return xml("USD", "87,4500", "12.09.2026");
        if (url.includes("weekly"))
          return xml("KRW", "0,0651", "12.09.2026").replace(
            "</CurrencyRates>",
            `${entry("AED", "23,8108")}</CurrencyRates>`,
          );
        const params = new URL(url).searchParams;
        const id = params.get("valuta_id");
        const usd = id === "15";
        const aed = id === "103";
        const name = usd
          ? "1 Доллар США"
          : aed
            ? "1 Дирхам ОАЭ"
            : "1 Вона Республики Корея/южно-корейский вон";
        return `<center>
        <form><select name="valuta_id"><option selected value="${id}">${name}</option></select></form>
        <span align="center">${name}</span><br>
        <table><tr><td>Дата<br>(курсы действуют с указанных дат)</td><td>Курс<br>(к кыргызскому сому)</td></tr>
        <tr><td class="stat-center"><!--date-->${usd ? "11.09.2026" : "05.09.2026"}<!--date--></td>
        <td class="stat-right"><!--value-->${usd ? "87,4500" : aed ? "23,8000" : "0,0647"}<!--value-->&nbsp;&nbsp;</td></tr></table>
      </center>`;
      }),
    );
    await book.refresh();
    expect(book.convert(car("KRW", 18500000))).toMatchObject({
      price_kgs_minor: 119695000,
      price_usd_minor: 1368725,
      fx_date: "USD:2026-09-11;KRW:2026-09-05",
      fx_expires_at: boundary,
    });
    expect(book.convert(car("AED", 10000))).toMatchObject({
      price_kgs_minor: 238000,
      price_usd_minor: 2722,
      fx_date: "USD:2026-09-11;AED:2026-09-05",
      fx_expires_at: boundary,
    });
    vi.setSystemTime((boundary - 1) * 1000);
    await book.refresh();
    expect(book.convert(car("KRW", 18500000)).price_kgs_minor).toBe(119695000);
    vi.setSystemTime(boundary * 1000);
    if (reopen) book = new RateBook(store, book.transport);
    expect(book.convert(car("KRW", 18500000)).price_kgs_minor).toBeNull();
    expect(book.convert(car("AED", 10000)).price_kgs_minor).toBeNull();
    await book.refresh();
    expect(book.convert(car("KRW", 18500000))).toMatchObject({
      price_kgs_minor: 120435000,
      fx_date: "USD:2026-09-12;KRW:2026-09-12",
    });
    expect(book.convert(car("AED", 10000))).toMatchObject({
      price_kgs_minor: 238108,
      price_usd_minor: 2723,
      fx_date: "USD:2026-09-12;AED:2026-09-12",
    });
  },
);

it("uses the effective AED archive quote even when NBKR includes the preceding expired row", async () => {
  vi.setSystemTime(instant("2026-09-13T23:00:00") * 1000);
  const book = new RateBook(
    metadata(),
    transport((url) => {
      if (url.includes("daily")) return xml("USD", "87,4500", "13.09.2026");
      if (url.includes("weekly")) return xml("AED", "23,8108", "14.09.2026");
      return `<center>
        <form><select name="valuta_id"><option selected value="103">1 Дирхам ОАЭ</option></select></form>
        <span align="center">1 Дирхам ОАЭ</span>
        <table><tr><td>Дата<br>(курсы действуют с указанных дат)</td><td>Курс<br>(к кыргызскому сому)</td></tr>
        <tr><td>12.09.2026</td><td>23,8108</td></tr>
        <tr><td>05.09.2026</td><td>23,8112</td></tr></table>
      </center>`;
    }),
  );
  await book.refresh();
  expect(book.convert(car("AED", 10000))).toMatchObject({
    original_currency: "AED",
    original_price_minor: 10000,
    price_kgs_minor: 238108,
    price_usd_minor: 2723,
    fx_date: "USD:2026-09-13;AED:2026-09-12",
    fx_expires_at: instant("2026-09-17"),
  });
});

it.each([
  { id: "25", date: "12.09.2026", duplicate: false },
  { id: "25", date: "04.09.2026", duplicate: false },
  { id: "15", date: "05.09.2026", duplicate: false },
  { id: "25", date: "05.09.2026", duplicate: true },
])("rejects an untrustworthy archive during prepublication %#", async ({ id, date, duplicate }) => {
  vi.setSystemTime(instant("2026-09-11T23:00:00") * 1000);
  const row = `<tr><td>${date}</td><td>0,0647</td></tr>`;
  const book = new RateBook(
    metadata(),
    transport((url) => {
      if (url.includes("daily")) return xml("USD", "87,4500", "11.09.2026");
      if (url.includes("weekly")) return xml("KRW", "0,0651", "12.09.2026");
      return `<center>
        <form><select name="valuta_id"><option selected value="${id}">1 Вона Республики Корея/южно-корейский вон</option></select></form>
        <span align="center">1 Вона Республики Корея/южно-корейский вон</span>
        <table><tr><td>Дата<br>(курсы действуют с указанных дат)</td><td>Курс<br>(к кыргызскому сому)</td></tr>
        ${row}${duplicate ? row : ""}</table>
      </center>`;
    }),
  );
  await book.refresh();
  expect(book.convert(car("KRW", 18500000))).toMatchObject({
    price_kgs_minor: null,
    price_usd_minor: null,
    fx_date: "",
    fx_expires_at: null,
  });
});

it("honors the origin pause when the effective archive is rate limited", async () => {
  vi.setSystemTime(instant("2026-09-11T23:00:00") * 1000);
  const requested: string[] = [];
  const book = new RateBook(
    metadata(),
    transport((url) => {
      requested.push(url);
      if (url.includes("daily")) return xml("USD", "87,4500", "12.09.2026");
      throw new SourceRateLimited(7200);
    }),
  );
  await book.refresh();
  await book.refresh();
  expect(requested).toHaveLength(2);
  expect(requested.some((url) => url.includes("weekly"))).toBe(false);
  expect(book.convert(car("USD", 100)).price_kgs_minor).toBeNull();
});

it("does not shorten an origin pause when cached quotes expire", async () => {
  const boundary = instant("2026-09-12");
  vi.setSystemTime((boundary - 1800) * 1000);
  const store = metadata();
  await store.setMeta(
    "nbkr:USD",
    JSON.stringify({
      date: "2026-09-08",
      nominal: "1",
      value: "87.45",
      valid_days: 4,
    }),
  );
  const requested: string[] = [];
  const book = new RateBook(
    store,
    transport((url) => {
      requested.push(url);
      if (url.includes("daily")) return xml("USD", "87.45", "12.09.2026");
      throw new SourceRateLimited(3600);
    }),
  );
  await book.refresh();
  expect(book.convert(car("USD", 100)).price_kgs_minor).toBe(8745);
  vi.setSystemTime(boundary * 1000);
  const reopened = new RateBook(store, book.transport);
  await reopened.refresh();
  expect(reopened.convert(car("USD", 100)).price_kgs_minor).toBeNull();
  expect(requested).toEqual([
    "https://www.nbkr.kg/XML/daily.xml",
    "https://www.nbkr.kg/XML/weekly.xml",
  ]);
});
