import { type Car365Record, normalizeVin, SourceError } from "@autodom/core";
import { load } from "cheerio";
import type { VinSession } from "./vin-session.js";

const ORIGIN = "https://www.car365.go.kr";
const ENTRY_PATH = "/ccpt/carlife/scrcar/schdcarXportView.do";
const LOOKUP_PATH = "/ccpt/carlife/scrcar/selectSchdcarXportList.do";
const RECORD_FIELDS = ["atmbNm", "drvngDstnc", "xportFlflYnDclrYmd", "frstRegYmd", "tolosYn"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new SourceError("Car365 text schema changed");
  return value.trim() || null;
}

function mileage(value: unknown): number | null {
  const literal = text(value);
  if (literal === null) return null;
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/u.test(literal)) {
    throw new SourceError("Car365 mileage is not an integer kilometre reading");
  }
  const result = Number(literal.replaceAll(",", ""));
  if (!Number.isSafeInteger(result)) throw new SourceError("Car365 mileage exceeds exact range");
  return result;
}

function date(value: unknown): string | null {
  const literal = text(value);
  if (literal === null) return null;
  if (!/^[0-9]{8}$/u.test(literal)) throw new SourceError("Car365 date schema changed");
  const year = Number(literal.slice(0, 4));
  const month = Number(literal.slice(4, 6));
  const day = Number(literal.slice(6, 8));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leapYear ? 29 : (MONTH_DAYS[month - 1] ?? 0);
  if (year < 1 || day < 1 || day > days) throw new SourceError("Car365 date is impossible");
  return `${literal.slice(0, 4)}-${literal.slice(4, 6)}-${literal.slice(6, 8)}`;
}

export function parseCar365Record(body: string, vin: string): Car365Record | null {
  const expectedVin = normalizeVin(vin);
  if (!expectedVin) throw new SourceError("Car365 requires a valid VIN");
  // Observed successful absence is exactly zero bytes, not an arbitrary blank/error document.
  if (body === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("Malformed Car365 response", { cause });
  }
  if (data === null || (Array.isArray(data) && data.length === 0)) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new SourceError("Car365 record schema changed");
  }
  const record = data as Record<string, unknown>;
  if (
    record.vin !== expectedVin ||
    !RECORD_FIELDS.some((key) => Object.hasOwn(record, key)) ||
    record.error != null ||
    record.errors != null
  ) {
    throw new SourceError("Car365 record identity or schema mismatch");
  }
  const totalLoss = text(record.tolosYn);
  return {
    vin: expectedVin,
    model: text(record.atmbNm),
    last_mileage_km: mileage(record.drvngDstnc),
    export_date: date(record.xportFlflYnDclrYmd),
    first_registration_date: date(record.frstRegYmd),
    total_loss: totalLoss === "Y" ? true : totalLoss === "N" ? false : null,
  };
}

function csrfToken(html: string): string {
  const $ = load(html);
  let token: string | undefined;
  $("script").each((_index, element) => {
    const node = $(element);
    if (node.attr("src")) return;
    const script = node.text();
    if (!/\b_CSRF_TOKEN\s*=/u.test(script)) return;
    // The observed page declares this token in its own inline script. Never execute page JS.
    const literal =
      /^\s*(?:const|let|var)\s+_CSRF_TOKEN\s*=\s*(["'])([A-Za-z0-9._-]+)\1\s*;\s*$/u.exec(script);
    if (!literal || token !== undefined) {
      throw new SourceError("Car365 CSRF declaration is ambiguous or not literal");
    }
    token = literal[2]!;
  });
  if (token === undefined) throw new SourceError("Car365 CSRF token is missing");
  return token;
}

export async function checkCar365(vin: string, session: VinSession): Promise<Car365Record | null> {
  const normalizedVin = normalizeVin(vin);
  if (!normalizedVin) throw new SourceError("Car365 requires a valid VIN");
  const entry = await session.request(ENTRY_PATH);
  const token = csrfToken(entry.body);
  const response = await session.request(LOOKUP_PATH, {
    method: "POST",
    form: { vin: normalizedVin },
    headers: {
      "X-CSRF-TOKEN": token,
      "X-AJAX-REQ": "CCPT",
      "X-Requested-With": "XMLHttpRequest",
      Origin: ORIGIN,
      Referer: `${ORIGIN}${ENTRY_PATH}`,
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
  });
  return parseCar365Record(response.body, normalizedVin);
}
