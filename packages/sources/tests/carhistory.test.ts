import { SourceError } from "@autodom/core";
import { describe, expect, it } from "vitest";
import { checkCarHistory, parseCarHistoryAvailability } from "../src/carhistory.js";
import type { VinSession } from "../src/vin-session.js";

const VIN = "KMFXKN7BPXU258800";
const OTHER_VIN = "KMFXKN7BPXU000000";
const HELP = '<section class="sec2"><h2>차량번호를 찾을 수 없으신가요?</h2></section>';

// Sanitized result markup from the observed free availability responses.
function section(available = true, vin = VIN): string {
  return `<section class="section sec1${available ? "" : " error"}">
    <div class="container">
      <h2 class="title">${available ? "조회 가능한 차량입니다" : "차량번호 오류"}</h2>
      <div class="number-box">\n ${vin}\n </div>
      <div class="deco"><img src="/img/character/${available ? "initSearch.png" : "initSearch-noResult.png"}" alt=""></div>
    </div>
  </section>`;
}
function page(result = section()): string {
  return `<div class="sec-search-initSearch">${result}${HELP}</div>`;
}

const ENTRY = `<section class="sec-search-history">
  <form method="post" name="searchForm" action="initSearch.car">
    <select name="carnumSel"><option value="1">차대번호</option></select>
    <input name="carbodynum"><input name="carnum2">
    <input type="hidden" name="realm"><input type="hidden" name="carnum">
  </form>
</section>`;

function sessionWith(...responses: string[]): {
  session: VinSession;
  requests: Array<{ path: string; options: Parameters<VinSession["request"]>[1] }>;
} {
  const requests: Array<{ path: string; options: Parameters<VinSession["request"]>[1] }> = [];
  return {
    requests,
    session: {
      async request(path, options) {
        requests.push({ path, options });
        const body = responses.shift();
        if (body === undefined) throw new Error("Unexpected extra provider request");
        return { body, status: 200 };
      },
    },
  };
}

describe("CarHistory free report availability", () => {
  it("recognizes availability despite shared missing-number help without exposing paid fields", () => {
    const html = `${page()}<form action="/payment"><input name="session" value="private-token"></form>`;
    expect(parseCarHistoryAvailability(html, VIN)).toBe("available");
  });

  it("recognizes an explicit same-VIN lookup rejection, not an accident history", () => {
    expect(parseCarHistoryAvailability(page(section(false)), VIN)).toBe("not_found");
  });

  it("rejects a different echoed VIN on both known outcomes", () => {
    for (const available of [true, false]) {
      expect(() => parseCarHistoryAvailability(page(section(available, OTHER_VIN)), VIN)).toThrow(
        SourceError,
      );
    }
  });

  it("requires one exact VIN echo rather than a substring, missing identity or duplicated identity", () => {
    for (const result of [
      section(true, `${VIN} ${OTHER_VIN}`),
      section(true, ""),
      section().replace(
        '</div>\n      <div class="deco">',
        `</div><div class="number-box">${VIN}</div><div class="deco">`,
      ),
    ]) {
      expect(() => parseCarHistoryAvailability(page(result), VIN)).toThrow(SourceError);
    }
  });

  it("does not mistake help, challenge or maintenance pages for a lookup rejection", () => {
    for (const html of [
      HELP,
      "<html><h1>Verify you are human</h1><form id='challenge-form'></form></html>",
      "<html><h1>서비스 점검 중입니다</h1></html>",
      page(section(false).replace("차량번호 오류", "서비스 오류")),
    ]) {
      expect(() => parseCarHistoryAvailability(html, VIN)).toThrow(SourceError);
    }
  });

  it("fails closed on duplicate or contradictory result sections and status signals", () => {
    for (const html of [
      page(section() + section()),
      page(section() + section(false)),
      page() + page(),
      page(section().replace('class="section sec1"', 'class="section sec1 error"')),
      page(section(false).replace("initSearch-noResult.png", "initSearch.png")),
      page(section().replace("initSearch.png", "initSearch-noResult.png")),
      page(section().replace("<h2", '<h2 class="title">차량번호 오류</h2><h2')),
      page(section(false).replace(/<div class="deco">.*?<\/div>/u, "")),
      page(
        section()
          .replace('<section class="section sec1">', '<div class="section sec1">')
          .replace("</section>", "</div>"),
      ),
    ]) {
      expect(() => parseCarHistoryAvailability(html, VIN)).toThrow(SourceError);
    }
  });

  it("submits only the observed free VIN lookup and never follows payment forms", async () => {
    const { session, requests } = sessionWith(ENTRY, `${page()}<form action="/payment"></form>`);
    await expect(checkCarHistory(VIN, session)).resolves.toBe("available");
    expect(requests).toEqual([
      { path: "/search/carhistory/search.car", options: undefined },
      {
        path: "/search/carhistory/initSearch.car",
        options: {
          method: "POST",
          form: { carnumSel: "1", carbodynum: VIN, carnum: VIN, carnum2: "", realm: "" },
          headers: { Referer: "https://www.carhistory.or.kr/search/carhistory/search.car" },
        },
      },
    ]);
  });

  it("does not submit a VIN after a challenge replaces the entry form", async () => {
    const { session, requests } = sessionWith("<h1>Verify you are human</h1>", page());
    await expect(checkCarHistory(VIN, session)).rejects.toThrow(SourceError);
    expect(requests.map(({ path }) => path)).toEqual(["/search/carhistory/search.car"]);
  });
});
