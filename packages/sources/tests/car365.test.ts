import { SourceError } from "@autodom/core";
import { describe, expect, it } from "vitest";
import * as sources from "../src/index.js";
import type { VinSession } from "../src/vin-session.js";

const VIN = "KMFXKN7BPXU258800";
const ENTRY_PATH = "/ccpt/carlife/scrcar/schdcarXportView.do";
const LOOKUP_PATH = "/ccpt/carlife/scrcar/selectSchdcarXportList.do";

function record(changes: Record<string, unknown> = {}) {
  return {
    vin: VIN,
    atmbNm: "포터125",
    drvngDstnc: "    79,434",
    xportFlflYnDclrYmd: "20141117",
    frstRegYmd: "19990129",
    tolosYn: null,
    ...changes,
  };
}

describe("Car365 exported-vehicle evidence", () => {
  it("rejects a record belonging to a different VIN instead of attributing its mileage", () => {
    const response = JSON.stringify(record({ vin: "KMFXKN7BPXU258801" }));
    expect(() => sources.parseCar365Record(response, VIN)).toThrow(SourceError);
  });

  it("returns only public vehicle evidence, excluding internal identifiers", () => {
    const response = JSON.stringify(record({ ledgerGroupNo: 12, kbrdrId: "SYSTEM" }));
    expect(sources.parseCar365Record(response, VIN)).toEqual({
      vin: VIN,
      model: "포터125",
      last_mileage_km: 79434,
      export_date: "2014-11-17",
      first_registration_date: "1999-01-29",
      total_loss: null,
    });
  });

  it("keeps missing evidence unknown while retaining a genuine zero odometer", () => {
    expect(
      sources.parseCar365Record(
        JSON.stringify(record({ drvngDstnc: undefined, tolosYn: "U", frstRegYmd: "" })),
        VIN,
      ),
    ).toMatchObject({
      last_mileage_km: null,
      first_registration_date: null,
      total_loss: null,
    });
    expect(
      sources.parseCar365Record(JSON.stringify(record({ drvngDstnc: " 0 ", tolosYn: "N" })), VIN),
    ).toMatchObject({ last_mileage_km: 0, total_loss: false });
    expect(
      sources.parseCar365Record(JSON.stringify(record({ tolosYn: "Y" })), VIN)?.total_loss,
    ).toBe(true);
  });

  it.each(["", "null", "[]"])("recognizes documented absence %j", (body) => {
    expect(sources.parseCar365Record(body, VIN)).toBeNull();
  });

  it.each([
    " ",
    "{}",
    '{"error":"upstream failure"}',
    JSON.stringify({ vin: VIN }),
    JSON.stringify({ ...record(), error: "denied" }),
    JSON.stringify([record()]),
    "false",
    '""',
    "<html>Access denied</html>",
    '{"vin":',
  ])("does not report an unknown or failed response as absence: %s", (body) => {
    expect(() => sources.parseCar365Record(body, VIN)).toThrow(SourceError);
  });

  it.each(["79,43", "-1", "1.5", "1e3", "123 km", "9007199254740992"])(
    "rejects a malformed or inexact mileage %s",
    (drvngDstnc) => {
      expect(() => sources.parseCar365Record(JSON.stringify(record({ drvngDstnc })), VIN)).toThrow(
        SourceError,
      );
    },
  );

  it.each(["20230229", "20240431", "20241301", "20240100", "00000101", "2024-01-01"])(
    "rejects an impossible or unsupported calendar date %s",
    (date) => {
      for (const key of ["xportFlflYnDclrYmd", "frstRegYmd"]) {
        expect(() =>
          sources.parseCar365Record(JSON.stringify(record({ [key]: date })), VIN),
        ).toThrow(SourceError);
      }
    },
  );

  it("accepts a real leap day without normalizing the source calendar", () => {
    expect(
      sources.parseCar365Record(JSON.stringify(record({ xportFlflYnDclrYmd: "20000229" })), VIN)
        ?.export_date,
    ).toBe("2000-02-29");
  });
});

describe("Car365 anonymous HTTP workflow", () => {
  it("uses the session CSRF and complete AJAX protocol before interpreting an empty response", async () => {
    let entered = false;
    const session: VinSession = {
      async request(path, options) {
        if (path === ENTRY_PATH && !options?.method) {
          entered = true;
          return {
            body: '<script nonce="">const _CSRF_TOKEN = "session-token";</script>',
            status: 200,
          };
        }
        const headers = new Headers(options?.headers);
        if (
          !entered ||
          path !== LOOKUP_PATH ||
          options?.method !== "POST" ||
          JSON.stringify(options.form) !== JSON.stringify({ vin: VIN }) ||
          headers.get("X-CSRF-TOKEN") !== "session-token" ||
          headers.get("X-AJAX-REQ") !== "CCPT" ||
          headers.get("X-Requested-With") !== "XMLHttpRequest" ||
          headers.get("Origin") !== "https://www.car365.go.kr" ||
          headers.get("Referer") !== `https://www.car365.go.kr${ENTRY_PATH}` ||
          headers.get("Accept") !== "application/json, text/javascript, */*; q=0.01"
        ) {
          throw new SourceError("Anonymous lookup protocol rejected");
        }
        return { body: "", status: 200 };
      },
    };
    await expect(sources.checkCar365(VIN, session)).resolves.toBeNull();
  });

  it.each([
    "<html>Service unavailable</html>",
    '<div>const _CSRF_TOKEN = "not-a-script";</div>',
    '<script>const _CSRF_TOKEN = "one" + "two";</script>',
    "<script>const _CSRF_TOKEN = getToken();</script>",
    '<script>// const _CSRF_TOKEN = "comment";</script>',
    '<script>const _CSRF_TOKEN = "one";</script><script>const _CSRF_TOKEN = "two";</script>',
    '<script src="/external.js">const _CSRF_TOKEN = "ignored";</script>',
  ])("rejects missing, ambiguous or executable CSRF evidence: %s", async (body) => {
    let submitted = false;
    const session: VinSession = {
      async request(path) {
        if (path === LOOKUP_PATH) submitted = true;
        return { body, status: 200 };
      },
    };
    await expect(sources.checkCar365(VIN, session)).rejects.toThrow(SourceError);
    expect(submitted).toBe(false);
  });
});
