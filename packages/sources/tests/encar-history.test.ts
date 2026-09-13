import { ENCAR_HISTORY_MAX_PHOTOS, SourceError } from "@autodom/core";
import { describe, expect, it } from "vitest";
import { checkEncarHistory } from "../src/encar-history.js";
import type { VinSession } from "../src/vin-session.js";

const VIN = "WBA51AG03NCK98884";
const OTHER_VIN = "KMHEC41MAAA015218";
const DISCOVERY = `https://carcheck.by/auto/${VIN}`;
const FIRST = "39720103";
const SECOND = "39711062";

type Reply = { body: string; status: number } | Error;

function sessionWith(
  discovery: string | Reply,
  cards: Record<string, string | Reply> = {},
): {
  session: VinSession;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    session: {
      async request(url) {
        requested.push(url);
        const id = url.match(/^https:\/\/fem\.encar\.com\/cars\/detail\/([1-9]\d*)$/u)?.[1];
        const response = url === DISCOVERY ? discovery : id ? cards[id] : undefined;
        if (response === undefined) throw new SourceError("Unexpected request");
        if (response instanceof Error) throw response;
        return typeof response === "string" ? { body: response, status: 200 } : response;
      },
    },
  };
}

// Only the observed identity and sales-history sections; unrelated page data is not evidence.
function row(
  id: string,
  source = "Encar",
  vin = VIN,
  href = `https://carcheck.by/auto/${vin}/${id}`,
): string {
  return `<tr><td><span class="history-auction">${source}</span></td>
    <td>11 июн 2025</td><td><a href="${href}">${id}</a></td></tr>`;
}

function discovery(rows = "", primary = FIRST, auction = "12"): string {
  return `<h1 class="auto-vin-title"><span>${VIN}</span>
    <button class="auto-save-button" data-save-vin="${VIN}"
      data-save-lot="${primary}" data-save-auction="${auction}"></button></h1>
    <details class="vehicle-sales-history"><table class="vehicle-sales-table">
      <tbody>${rows}</tbody></table></details>`;
}

// Sanitized cars.base fields from the retained SOLD HTML, not the unavailable JSON API.
function base(id = FIRST, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vehicleId: Number(id),
    queryCarId: Number(id),
    vin: VIN,
    manage: {
      dummy: false,
      dummyVehicleId: null,
      reRegistered: false,
      registDateTime: "2025-05-26T09:23:30",
      firstAdvertisedDateTime: "2025-05-27T09:20:12",
      modifyDateTime: "2025-05-31T19:21:55",
    },
    category: { manufacturerEnglishName: "BMW", modelGroupEnglishName: "5-Series" },
    advertisement: { status: "SOLD" },
    spec: { mileage: 21986 },
    photos: [{ path: `/carpicture02/pic3972/${id}_001.jpg` }],
    ...overrides,
  };
}

function html(value: unknown): string {
  return `<div>이 차량은 판매되었거나 삭제된 차량입니다.</div>
    <script>__PRELOADED_STATE__ = ${JSON.stringify({ cars: { base: value } })};</script>`;
}

describe("VIN-confirmed Encar advertisement history", () => {
  it("keeps retained SOLD evidence while hidden or wrong VIN cards remain unverified", async () => {
    const { session } = sessionWith(discovery(row(SECOND) + row("40122438")), {
      [FIRST]: html(base()),
      [SECOND]: html(base(SECOND, { vin: null })),
      "40122438": html(base("40122438", { vin: OTHER_VIN })),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings).toEqual([
      {
        id: FIRST,
        vin: VIN,
        source_url: `https://fem.encar.com/cars/detail/${FIRST}`,
        model: "BMW 5-Series",
        mileage_km: 21986,
        advertisement_status: "SOLD",
        created_at: "2025-05-26T09:23:30",
        first_advertised_at: "2025-05-27T09:20:12",
        modified_at: "2025-05-31T19:21:55",
        re_registered: false,
        photo_urls: [`https://ci.encar.com/carpicture/carpicture02/pic3972/${FIRST}_001.jpg`],
      },
    ]);
    expect(result?.partial).toBe(true);
  });

  it("does not publish photos when none of the candidate VINs can be verified", async () => {
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(base(FIRST, { vin: null })),
      [SECOND]: html(base(SECOND, { vin: OTHER_VIN })),
    });
    await expect(checkEncarHistory(VIN, session)).rejects.toBeInstanceOf(SourceError);
  });

  it.each([true, false])(
    "deduplicates the explicit dummy relationship with dummy-first=%s",
    async (dummyFirst) => {
      const canonical = "42455240";
      const alias = "42458676";
      const primary = dummyFirst ? alias : canonical;
      const other = dummyFirst ? canonical : alias;
      const { session, requested } = sessionWith(discovery(row(other), primary), {
        [primary]: html(
          base(canonical, {
            queryCarId: Number(primary),
            manage: { dummy: dummyFirst, dummyVehicleId: Number(alias) },
          }),
        ),
      });
      const result = await checkEncarHistory(VIN, session);
      expect(result?.listings.map((listing) => listing.id)).toEqual([canonical]);
      expect(result?.listings[0]?.source_url).toBe(
        `https://fem.encar.com/cars/detail/${canonical}`,
      );
      expect(result?.partial).toBe(false);
      expect(requested).toEqual([DISCOVERY, `https://fem.encar.com/cars/detail/${primary}`]);
    },
  );

  it("does not treat a different canonical id as an alias without the explicit relationship", async () => {
    const { session } = sessionWith(discovery(), {
      [FIRST]: html(base(SECOND, { queryCarId: Number(FIRST) })),
    });
    await expect(checkEncarHistory(VIN, session)).rejects.toBeInstanceOf(SourceError);
  });

  it("preserves separate advertisements even when their VIN and gallery paths coincide", async () => {
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(base()),
      [SECOND]: html(base(SECOND, { photos: base().photos })),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings.map((listing) => listing.id)).toEqual([FIRST, SECOND]);
    expect(result?.listings[1]?.photo_urls).toEqual([]);
    expect(result?.partial).toBe(false);
  });

  it("uses same-VIN Encar history under a foreign primary and ignores foreign or unrelated links", async () => {
    const rows =
      row(FIRST) +
      row("12345678", "Copart") +
      row("40122438", "Encar", OTHER_VIN) +
      row("11111111", "Encar", VIN, `https://untrusted.invalid/auto/${VIN}/11111111`) +
      row("00001234") +
      row("22222222", "Encar", VIN, `/auto/${VIN}/22222222?redirect=1`);
    const { session, requested } = sessionWith(
      discovery(rows, "99999999", "1") +
        `<footer><a href="https://carcheck.by/auto/${VIN}/${SECOND}">${SECOND}</a></footer>`,
      { [FIRST]: html(base()) },
    );
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings.map((listing) => listing.id)).toEqual([FIRST]);
    expect(result?.partial).toBe(false);
    expect(requested).toEqual([DISCOVERY, `https://fem.encar.com/cars/detail/${FIRST}`]);
  });

  it("distinguishes recognized no-Encar discovery from a challenge or mismatched identity", async () => {
    const empty = sessionWith(discovery(row("12345678", "Copart"), "99999999", "1"));
    await expect(checkEncarHistory(VIN, empty.session)).resolves.toBeNull();
    for (const page of [
      "<html><h1>Just a moment...</h1></html>",
      discovery().replace(`<span>${VIN}</span>`, `<span>${OTHER_VIN}</span>`),
      discovery().replace(`data-save-vin="${VIN}"`, `data-save-vin="${OTHER_VIN}"`),
      discovery().replace('data-save-auction="12"', 'data-save-auction=""'),
    ]) {
      await expect(checkEncarHistory(VIN, sessionWith(page).session)).rejects.toBeInstanceOf(
        SourceError,
      );
    }
  });

  it("accepts only the transport-confirmed no-candidate redirect without following it", async () => {
    const { session, requested } = sessionWith({ body: "", status: 301 });
    await expect(checkEncarHistory(VIN, session)).resolves.toBeNull();
    expect(requested).toEqual([DISCOVERY]);
    await expect(
      checkEncarHistory(VIN, sessionWith({ body: "", status: 404 }).session),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it("keeps source failures and malformed SSR distinct from an empty discovery", async () => {
    for (const response of [
      { body: "", status: 404 },
      "<div>이 차량은 판매되었거나 삭제된 차량입니다.</div>",
      "<script>__PRELOADED_STATE__ = {cars: {base: {}}};</script>",
      "<script>__PRELOADED_STATE__ = (() => ({cars: {base: {}}}))();</script>",
      html(null),
      html(base()) + html(base()),
    ]) {
      await expect(
        checkEncarHistory(VIN, sessionWith(discovery(), { [FIRST]: response }).session),
      ).rejects.toBeInstanceOf(SourceError);
    }
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(base()),
      [SECOND]: new SourceError("Provider unavailable"),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings.map((listing) => listing.id)).toEqual([FIRST]);
    expect(result?.partial).toBe(true);
  });

  it("propagates cancellation rather than returning an apparently partial history", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(base()),
      [SECOND]: abort,
    });
    await expect(checkEncarHistory(VIN, session)).rejects.toBe(abort);
  });

  it("bounds candidate requests without losing the distinction between truncation and coverage", async () => {
    const ids = [FIRST, SECOND, "40122438", "42455240", "42458676", "42459999"];
    const { session, requested } = sessionWith(
      discovery(ids.map((id) => row(id)).join("")),
      Object.fromEntries(ids.map((id) => [id, html(base(id))])),
    );
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings.map((listing) => listing.id)).toEqual(ids.slice(0, 5));
    expect(result?.partial).toBe(true);
    expect(requested).not.toContain(`https://fem.encar.com/cars/detail/${ids[5]}`);
  });

  it("publishes only unique safe gallery paths for the canonical ad, bounded to 32", async () => {
    const path = `/carpicture02/pic3972/${FIRST}_001.jpg`;
    const invalid = [
      `https://evil.invalid${path}`,
      `//evil.invalid${path}`,
      `${path}?token=private`,
      `${path}#fragment`,
      `/../${path}`,
      `/carpicture02/pic3972/${SECOND}_001.jpg`,
      `/carpicture02/pic3972/${FIRST}_001.svg`,
      `${path}\n`,
      null,
    ];
    const paths = [
      path,
      ...invalid,
      path,
      ...Array.from(
        { length: 40 },
        (_, index) => `/carpicture02/pic3972/${FIRST}_${String(index + 2).padStart(3, "0")}.jpg`,
      ),
    ];
    const { session } = sessionWith(discovery(), {
      [FIRST]: html(base(FIRST, { photos: paths.map((photoPath) => ({ path: photoPath })) })),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings[0]?.photo_urls).toEqual(
      Array.from(
        { length: ENCAR_HISTORY_MAX_PHOTOS },
        (_, index) =>
          `https://ci.encar.com/carpicture/carpicture02/pic3972/${FIRST}_${String(index + 1).padStart(3, "0")}.jpg`,
      ),
    );
    expect(result?.partial).toBe(false);
  });

  it("keeps the model boundary but drops oversized assembled metadata without losing the ad", async () => {
    const boundaryModel = "X".repeat(512);
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(
        base(FIRST, {
          category: {
            manufacturerEnglishName: "X".repeat(256),
            modelGroupEnglishName: "Y".repeat(256),
          },
        }),
      ),
      [SECOND]: html(base(SECOND, { category: { manufacturerEnglishName: boundaryModel } })),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(
      result?.listings.map(({ id, model, mileage_km }) => ({ id, model, mileage_km })),
    ).toEqual([
      { id: FIRST, model: null, mileage_km: 21986 },
      { id: SECOND, model: boundaryModel, mileage_km: 21986 },
    ]);
  });

  it("preserves zero mileage and valid local leap-day time while nulling malformed metadata", async () => {
    const { session } = sessionWith(discovery(row(SECOND)), {
      [FIRST]: html(
        base(FIRST, {
          spec: { mileage: 0 },
          manage: {
            registDateTime: "2024-02-29T00:00:00",
            firstAdvertisedDateTime: "2025-02-29T12:00:00",
            modifyDateTime: "2025-05-31T24:00:00",
            reRegistered: "false",
          },
        }),
      ),
      [SECOND]: html(
        base(SECOND, {
          spec: { mileage: Number.MAX_SAFE_INTEGER + 1 },
          category: { manufacturerEnglishName: {}, modelGroupEnglishName: 5 },
          advertisement: { status: "DELETED" },
          manage: { registDateTime: "2024-02-29T00:00:00Z" },
        }),
      ),
    });
    const result = await checkEncarHistory(VIN, session);
    expect(result?.listings[0]).toMatchObject({
      mileage_km: 0,
      created_at: "2024-02-29T00:00:00",
      first_advertised_at: null,
      modified_at: null,
      re_registered: null,
    });
    expect(result?.listings[1]).toMatchObject({
      mileage_km: null,
      model: null,
      advertisement_status: null,
      created_at: null,
    });
    expect(result?.partial).toBe(false);
  });
});
