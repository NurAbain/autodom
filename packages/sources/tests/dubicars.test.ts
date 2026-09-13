import { readFileSync } from "node:fs";
import { makeProfile, matches, SourceError } from "@autodom/core";
import { type CheerioAPI, load } from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG_URL, parsePage } from "../src/dubicars.js";

const fixture = readFileSync(new URL("./fixtures/dubicars.html", import.meta.url), "utf8");
afterEach(() => vi.unstubAllEnvs());
type RecordValue = Record<string, unknown>;
type StructuredList = {
  "@graph": { numberOfItems: number; itemListElement: { position: number; item: RecordValue }[] }[];
};

function document(change: ($: CheerioAPI) => void): string {
  const $ = load(fixture);
  change($);
  return $.html();
}

function vehicle($: CheerioAPI, index = 0) {
  const card = $("#serp-list li.serp-list-item").eq(index);
  const row = JSON.parse(card.attr("data-sp-item")!) as RecordValue;
  const structured = JSON.parse($('script[type="application/ld+json"]').text()) as StructuredList;
  const car = structured["@graph"][0]!.itemListElement[index]!.item;
  return {
    card,
    row,
    car,
    save() {
      card.attr("data-sp-item", JSON.stringify(row));
      $('script[type="application/ld+json"]').text(JSON.stringify(structured));
    },
  };
}

function pagination($: CheerioAPI, page: number, pages: number): void {
  const href = (number: number) => (number === 1 ? CATALOG_URL : `${CATALOG_URL}?page=${number}`);
  $('head link[rel="canonical"]').attr("href", href(page));
  $('head link[rel="next"], head link[rel="prev"]').remove();
  for (const [rel, target] of [
    ["prev", page > 1 ? page - 1 : null],
    ["next", page < pages ? page + 1 : null],
  ] as const) {
    const link = $(`#pagination [rel="${rel}"]`);
    link.attr("href", target === null ? "" : href(target)).toggleClass("disabled", target === null);
    if (target !== null) $("head").append(`<link rel="${rel}" href="${href(target)}">`);
  }
  $("#pagination .active strong").text(String(page));
  $("#pagination a:not([rel])").attr("href", href(pages)).text(String(pages));
  $("#serp-list li.serp-list-item").each((index) => {
    const item = vehicle($, index);
    item.row.pno = page;
    item.save();
  });
}

describe("DubiCars Dubai native asking prices", () => {
  it("uses the current AED asking amount, not analytics prices, USD conversion or finance payment", () => {
    const result = parsePage(
      document(($) => {
        $("#serp-list li.serp-list-item")
          .first()
          .find(".price")
          .append(
            '<div class="emi-action-container desktop-only"><strong><i aria-label="AED"></i> 456 / month</strong></div>',
          );
        const item = vehicle($, 1);
        item.row.pr = 199000;
        item.row.rl = false;
        item.save();
      }),
    );
    expect(result).toMatchObject({ page: 1, pages: 332, total: 22457 });
    expect(result.listings.map((item) => [item.id, item.original_price_minor])).toEqual([
      ["dubicars:1016947", 2999900],
      ["dubicars:997942", 20819900],
    ]);
    expect(result.listings[0]).toMatchObject({
      original_currency: "AED",
      market: "AE",
      year: 2020,
      mileage: "106785 km",
      city: "Dubai",
      price_usd_minor: null,
      price_kgs_minor: null,
    });
    expect(result.listings[0]!.condition).toContain("2026-09-13 18:18:00");
  });

  it("admits published UAE asking offers into the free car-only buyer search", () => {
    vi.stubEnv("AUTODOM_APPROVED_SOURCES", "dubicars.com");
    const buyer = makeProfile({
      user_id: 1,
      chat_id: 1,
      currency: "USD",
      budget_min_minor: 0,
      budget_max_minor: 2_000_000,
      market: "AE",
    });
    const listing = {
      ...parsePage(fixture).listings[0]!,
      price_usd_minor: 1_000_000,
      fx_expires_at: Date.now() / 1000 + 60,
    };
    expect(matches(buyer, listing)).toBe(true);
    expect(matches({ ...buyer, budget_scope: "total" }, listing)).toBe(false);
  });

  it("retains exact fils and refuses fractional-fils prices before JSON rounding", () => {
    const priced = document(($) => {
      const item = vehicle($);
      item.row.pr = item.row.rpr = item.row.spr = "29999.01";
      (item.car.offers as RecordValue).price = "29999.01";
      item.card.find(".price strong").html('<i aria-label="AED"></i>29,999.01');
      item.save();
    });
    expect(parsePage(priced).listings[0]!.original_price_minor).toBe(2999901);
    const fractional = priced.replace('"price":"29999.01"', '"price":29999.010000000000000001');
    expect(() => parsePage(fractional)).toThrow(SourceError);
  });

  it("rejects ignored AED selection and a converted USD offer", () => {
    const foreign = document(($) => {
      const item = vehicle($);
      (item.car.offers as RecordValue).priceCurrency = "USD";
      (item.car.offers as RecordValue).price = "8174";
      item.save();
    });
    expect(() => parsePage(foreign)).toThrow(SourceError);
    expect(() => parsePage(fixture.replace('"cr":{"id":"AED"}', '"cr":{"id":"USD"}'))).toThrow(
      SourceError,
    );
  });

  it("keeps explicitly unavailable asking price and mileage unknown without borrowing a monthly amount", () => {
    const raw = document(($) => {
      const item = vehicle($);
      item.row.pnr = true;
      item.row.pr = item.row.rpr = item.row.spr = 0;
      item.row.km = null;
      delete item.car.offers;
      delete item.car.mileageFromOdometer;
      item.card.find(".price").text("Price on request");
      item.card.find("img.icon-speed").parent().text("Unknown");
      item.save();
    });
    expect(parsePage(raw).listings[0]).toMatchObject({
      original_price_minor: null,
      price_kind: "unknown",
      mileage: "",
    });
    expect(() => parsePage(raw.replace("Price on request", "From AED 456/month"))).toThrow(
      SourceError,
    );
  });

  it("does not classify explicit overseas stock as Dubai inventory and retains visible sale restrictions", () => {
    const raw = document(($) => {
      const item = vehicle($);
      item.row.pid = 7;
      item.card.find("img.icon-location").parent().html('<img class="icon-location">Japan');
      item.save();
      vehicle($, 1).card.find(".detail").append('<span badge-popup="2">Export Only</span>');
    });
    const result = parsePage(raw);
    expect(result.listings.map((item) => item.id)).toEqual(["dubicars:997942"]);
    expect(result.listings[0]!.condition).toContain("Export Only");
    const contradiction = document(($) =>
      vehicle($).card.find("img.icon-location").parent().html('<img class="icon-location">Japan'),
    );
    expect(() => parsePage(contradiction)).toThrow(SourceError);
  });

  it("deduplicates promoted copies only when the advertisement facts agree", () => {
    const duplicated = document(($) => {
      const structured = JSON.parse(
        $('script[type="application/ld+json"]').text(),
      ) as StructuredList;
      const list = structured["@graph"][0]!;
      list.itemListElement[1] = { ...list.itemListElement[0]!, position: 2 };
      $('script[type="application/ld+json"]').text(JSON.stringify(structured));
      $("#serp-list li.serp-list-item")
        .eq(1)
        .replaceWith($("#serp-list li.serp-list-item").first().clone());
    });
    expect(parsePage(duplicated).listings.map((item) => item.id)).toEqual(["dubicars:1016947"]);
    const $ = load(duplicated);
    const changed = vehicle($, 1);
    changed.row.pr = changed.row.rpr = changed.row.spr = 30000;
    (changed.car.offers as RecordValue).price = "30000";
    changed.card.find(".price strong").html('<i aria-label="AED"></i>30,000');
    changed.save();
    expect(() => parsePage($.html())).toThrow(SourceError);
  });

  it("rejects crossed advertisement identities and non-kilometre odometers", () => {
    const crossed = document(($) => {
      const item = vehicle($);
      item.row.id = 997942;
      item.save();
    });
    expect(() => parsePage(crossed)).toThrow(SourceError);
    const miles = document(($) => {
      const item = vehicle($);
      (item.car.mileageFromOdometer as RecordValue).unitCode = "SMI";
      item.save();
    });
    expect(() => parsePage(miles)).toThrow(SourceError);
  });

  it("follows explicit capped navigation and stops only at a corroborated terminal page", () => {
    expect(
      parsePage(
        document(($) => pagination($, 2, 332)),
        2,
      ),
    ).toMatchObject({ page: 2, pages: 332 });
    expect(
      parsePage(
        document(($) => pagination($, 332, 332)),
        332,
      ),
    ).toMatchObject({ page: 332, pages: 332 });
    expect(() => parsePage(fixture, 2)).toThrow(SourceError);
    const missingNext = document(($) => $('head link[rel="next"]').remove());
    expect(() => parsePage(missingNext)).toThrow(SourceError);
    const changedScope = document(($) =>
      $('#pagination a[rel="next"]').attr("href", "https://www.dubicars.com/uae/used?page=2"),
    );
    expect(() => parsePage(changedScope)).toThrow(SourceError);
  });

  it("does not turn truncated, challenged or missing inventory markup into an empty success", () => {
    expect(() => parsePage(fixture.slice(0, -30))).toThrow(SourceError);
    expect(() => parsePage("<html><body>Verify you are human</body></html>")).toThrow(SourceError);
    const missing = document(($) => $("#serp-list li.serp-list-item").first().remove());
    expect(() => parsePage(missing)).toThrow(SourceError);
  });
});
