import { makeListing } from "@autodom/core";
import { parseCatalogQuery } from "@autodom/core/catalog-query";
import { describe, expect, it } from "vitest";
import {
  brandHref,
  carHref,
  escapeHtml,
  formatMoney,
  originalPriceLabel,
  renderCar,
  renderCatalog,
  renderHome,
  type SiteContext,
} from "../src/site-views.js";

const listing = makeListing({
  id: "mashina-42",
  title: "<b>Toyota Camry</b> 2.0",
  url: "https://www.mashina.kg/car/42",
  price_usd_minor: 1_500_000,
  price_kgs_minor: 135_000_000,
  year: 2021,
  mileage: "45 000 km",
  body_type: "Sedan",
  transmission: "Automatic",
  city: "Bishkek",
  source: "mashina.kg",
  observed_at: 1_757_000_000,
  catalog_attributes: { make: "Toyota", model: "Camry" },
});

const context = (overrides: Partial<SiteContext> = {}): SiteContext => ({
  query: parseCatalogQuery(""),
  listings: [],
  total: 0,
  pages: 1,
  brands: [],
  publicUrl: "https://cars.example.org",
  botUsername: "autodomkgbot",
  ...overrides,
});

describe("site escaping", () => {
  it("escapes markup in titles", () => {
    expect(escapeHtml("<script>\"x\"&'y'</script>")).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });

  it("never renders a listing title as markup", () => {
    const html = renderCatalog(context({ listings: [listing], total: 1 }), new Map());
    expect(html).not.toContain("<b>Toyota Camry</b>");
    expect(html).toContain("Toyota Camry 2.0");
  });
});

describe("site money and dates", () => {
  it("shows minor units as whole money", () => {
    expect(formatMoney(1_500_000, "USD")).toBe("15\u00a0000 $");
    expect(formatMoney(null, "USD")).toBe("цена не указана");
  });

  it("keeps the source price with its conversion date", () => {
    const foreign = makeListing({
      ...listing,
      original_currency: "USD",
      original_price_minor: 1_500_000,
      fx_date: "2026-09-20",
    });
    expect(originalPriceLabel(foreign)).toBe("15\u00a0000 $ (курс на 2026-09-20)");
  });
});

describe("catalogue page", () => {
  it("shows the source and the observation date of every car", () => {
    const html = renderCatalog(context({ listings: [listing], total: 1 }), new Map());
    expect(html).toContain("Источник: mashina.kg");
    expect(html).toContain("обновлено");
  });

  it("keeps the filter state in the URL", () => {
    const query = parseCatalogQuery("?make=Toyota&budget_max=15000");
    const html = renderCatalog(context({ query, total: 1 }), new Map());
    expect(html).toContain('name="make"');
    expect(html).toContain('value="Toyota"');
    expect(html).toContain('name="budget_max"');
    expect(html).toContain('value="15000"');
  });

  it("leads with the budget and offers no market control", () => {
    const html = renderCatalog(context({ total: 1 }), new Map());
    expect(html).not.toContain('name="market"');
    expect(html).not.toContain("Направление");
    expect(html.indexOf('name="budget_min"')).toBeLessThan(html.indexOf('name="q"'));
    expect(html.indexOf('name="q"')).toBeLessThan(html.indexOf('name="year_min"'));
  });

  it("explains an empty result and offers concrete relaxations", () => {
    const query = parseCatalogQuery("?year_min=2022&budget_max=15000");
    const html = renderCatalog(context({ query, total: 0 }), new Map());
    expect(html).toContain("Под текущие условия ничего не нашлось");
    expect(html).toContain("Не ограничивать год");
    expect(html).toContain("Поднять бюджет");
  });

  it("paginates with the current page marked", () => {
    const query = parseCatalogQuery("?page=2");
    const html = renderCatalog(context({ query, total: 90, pages: 4 }), new Map());
    expect(html).toContain('aria-current="page">2');
    expect(html).toContain("page=3");
  });

  it("uses the shared brand link", () => {
    expect(brandHref("Toyota")).toBe("/brands/Toyota?make=Toyota");
    expect(brandHref("Toyota", parseCatalogQuery("?make=Toyota&model=Camry&page=3"))).toBe(
      "/brands/Toyota?make=Toyota",
    );
  });
});

describe("car page", () => {
  const car = {
    listing,
    photos: ["https://im.mashina.kg/photo.jpg"],
    history: [
      {
        observed_at: 1_750_000_000,
        price_usd_minor: 1_600_000,
        price_kgs_minor: null,
        original_price_minor: null,
        original_currency: "",
      },
    ],
    similar: [makeListing({ ...listing, id: "mashina-43", title: "Toyota Camry 2019" })],
  };

  it("shows the known characteristics and the original announcement", () => {
    const html = renderCar(car, context());
    expect(html).toContain("2021 г.");
    expect(html).toContain("45 000 km");
    expect(html).toContain("mashina.kg");
    expect(html).toContain("https://www.mashina.kg/car/42");
  });

  it("omits characteristics that are unknown instead of showing zeroes", () => {
    const bare = makeListing({ id: "x", title: "Без данных", url: "https://example.org/x" });
    const html = renderCar({ listing: bare, photos: [], history: [], similar: [] }, context());
    expect(html).not.toContain("<dt>VIN</dt>");
    expect(html).not.toContain("<dt>Пробег</dt>");
    expect(html).toContain("Фото источника недоступны");
  });

  it("shows the source attributes with their reference labels", () => {
    const html = renderCar(car, context());
    expect(html).toContain("<dt>Марка</dt>");
    expect(html).toContain("<dt>Модель</dt>");
    expect(html).not.toContain("<dt>make</dt>");
  });

  it("shows the price history and states when nothing was observed", () => {
    expect(renderCar(car, context())).toContain("История цены");
    expect(renderCar(car, context())).toContain("15 июня 2025");
    const without = renderCar({ ...car, history: [] }, context());
    expect(without).toContain("не нашли зафиксированных изменений цены");
  });

  it("hands the chosen car over to the bot", () => {
    const html = renderCar(car, context());
    expect(html).toContain("https://t.me/autodomkgbot?start=car_mashina-42");
    expect(html).toContain("Открыть эту машину в боте");
  });

  it("omits the bot hand-off when the username is unknown", () => {
    const html = renderCar(car, context({ botUsername: undefined }));
    expect(html).not.toContain("t.me/");
    expect(html).toContain("Открыть объявление на источнике");
  });

  it("links to the car page from a card", () => {
    expect(carHref(listing)).toBe("/cars/mashina-42");
  });
});

describe("home page", () => {
  it("shows fresh cars and the brands with their counts", () => {
    const html = renderHome(
      context({
        listings: [listing],
        total: 42,
        brands: [{ value: "Toyota", count: 7 }],
      }),
      new Map([[listing.id, "https://im.mashina.kg/photo.jpg"]]),
    );
    expect(html).toContain("Toyota (7)");
    expect(html).toContain("https://im.mashina.kg/photo.jpg");
    expect(html).toContain("Открыть бота подбора");
  });
});
