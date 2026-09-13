import type { DocumentTransport } from "@autodom/core";
import { afterEach, expect, it, vi } from "vitest";
import { VehicleCatalog } from "../src/vehicle-catalog.js";

afterEach(() => vi.unstubAllEnvs());

it("unions modifications across physical years and bodies without including another generation", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const option = (attribute_id: number, id: number, value: string) => ({
    attribute_id,
    id,
    value,
    label: value,
    is_active: true,
  });
  const tree: Record<string, unknown[]> = {
    "1:1:": [option(1, 10, "2023"), option(1, 11, "2024")],
    "18:10:": [option(18, 20, "Седан")],
    "18:11:": [option(18, 21, "Седан"), option(18, 22, "Универсал")],
    "13:20:": [option(13, 30, "X")],
    "13:21:": [option(13, 31, "X"), option(13, 32, "XI")],
    "13:22:": [option(13, 33, "X")],
    "14:30:3": [option(14, 40, "2.0 AT")],
    "14:31:3": [option(14, 41, "2.0 AT"), option(14, 42, "2.5 AT")],
    "14:33:3": [option(14, 43, "3.0 AT")],
    "14:32:3": [option(14, 44, "4.0 AT")],
  };
  const transport: DocumentTransport = {
    async fetchDocument(url, parse) {
      const parsed = new URL(url);
      const key = `${parsed.pathname.split("/").at(-2)}:${parsed.searchParams.get("parent_option_id")}:${parsed.searchParams.get("skip_levels") ?? ""}`;
      if (!Object.hasOwn(tree, key)) throw new Error(`Unexpected hierarchy ${key}`);
      return parse(JSON.stringify(tree[key]));
    },
    fetchDocuments: vi.fn(),
  };
  const catalog = new VehicleCatalog(transport);
  const variants = await catalog.getOptions("modification", "30", {
    modelId: "1",
    generation: "X",
  });
  expect(variants.map((item) => item.value).sort()).toEqual(["2.0 AT", "2.5 AT", "3.0 AT"]);
  await expect(
    catalog.getOptions("modification", "32", { modelId: "1", generation: "X" }),
  ).rejects.toThrow();
});
