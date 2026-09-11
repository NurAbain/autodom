import { normalizeVin, SourceError } from "@autodom/core";
import { load } from "cheerio";
import type { VinSession } from "./vin-session.js";

const SEARCH_PATH = "/search/carhistory/search.car";
const RESULT_PATH = "/search/carhistory/initSearch.car";
const SEARCH_URL = `https://www.carhistory.or.kr${SEARCH_PATH}`;

/** Checks paid-report availability only; a rejected VIN says nothing about accidents. */
export function parseCarHistoryAvailability(html: string, vin: string): "available" | "not_found" {
  const expectedVin = normalizeVin(vin);
  if (!expectedVin) throw new SourceError("CarHistory requires a valid VIN");
  const $ = load(html);
  const root = $(".sec-search-initSearch");
  const result = root.children("section.sec1");
  if (root.length !== 1 || result.length !== 1 || root.find(".sec1").length !== 1) {
    throw new SourceError("CarHistory availability result missing or ambiguous");
  }

  const title = result.find("h2.title");
  const number = result.find(".number-box");
  const image = result.find(".deco img");
  if (title.length !== 1 || number.length !== 1 || image.length !== 1) {
    throw new SourceError("CarHistory availability structure changed");
  }
  if (number.text().trim() !== expectedVin) {
    throw new SourceError("CarHistory availability VIN mismatch");
  }

  const heading = title.text().trim();
  const icon = image.attr("src");
  if (
    heading === "조회 가능한 차량입니다" &&
    !result.hasClass("error") &&
    icon === "/img/character/initSearch.png"
  ) {
    return "available";
  }
  if (
    heading === "차량번호 오류" &&
    result.hasClass("error") &&
    icon === "/img/character/initSearch-noResult.png"
  ) {
    // The VIN may need an old Korean plate to resolve; this is not a clean report.
    return "not_found";
  }
  throw new SourceError("CarHistory availability status unknown or contradictory");
}

export async function checkCarHistory(
  vin: string,
  session: VinSession,
): Promise<"available" | "not_found"> {
  const normalizedVin = normalizeVin(vin);
  if (!normalizedVin) throw new SourceError("CarHistory requires a valid VIN");
  const entry = await session.request(SEARCH_PATH);
  const $ = load(entry.body);
  const form = $('form[name="searchForm"]');
  if (
    form.length !== 1 ||
    form.attr("method")?.toLowerCase() !== "post" ||
    form.attr("action") !== "initSearch.car" ||
    form.find('select[name="carnumSel"] option[value="1"]').length !== 1 ||
    ["carbodynum", "carnum", "carnum2", "realm"].some(
      (name) => form.find(`input[name="${name}"]`).length !== 1,
    )
  ) {
    throw new SourceError("CarHistory VIN search form missing or changed");
  }

  // Only this free lookup is submitted. Ignore all authentication/payment forms and tokens.
  const response = await session.request(RESULT_PATH, {
    method: "POST",
    form: {
      carnumSel: "1",
      carbodynum: normalizedVin,
      carnum: normalizedVin,
      carnum2: "",
      realm: "",
    },
    headers: { Referer: SEARCH_URL },
  });
  return parseCarHistoryAvailability(response.body, normalizedVin);
}
