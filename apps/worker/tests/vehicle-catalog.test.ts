import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("serves the stored catalogue after a restart and never asks the source again", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const directory = await mkdtemp(join(tmpdir(), "autodom-catalog-"));
  try {
    let requests = 0;
    const transport: DocumentTransport = {
      async fetchDocument(url, parse) {
        requests += 1;
        const parsed = new URL(url);
        if (parsed.searchParams.get("parent_option_id") === "1")
          return parse(
            JSON.stringify([
              { attribute_id: 17, id: 2, value: "Camry", label: "Camry", is_active: true },
            ]),
          );
        return parse(
          JSON.stringify([
            { attribute_id: 16, id: 1, value: "Toyota", label: "Toyota", is_active: true },
          ]),
        );
      },
      fetchDocuments: vi.fn(),
    };
    const first = new VehicleCatalog(transport, directory);
    expect((await first.getOptions("model", "1")).map((item) => item.value)).toEqual(["Camry"]);
    expect(requests).toBe(1);

    // A restart reads the stored copy instead of asking the source again.
    const second = new VehicleCatalog(transport, directory);
    expect((await second.getOptions("model", "1")).map((item) => item.value)).toEqual(["Camry"]);
    expect(requests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("replaces the stored catalogue only when the refresh is asked for", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const directory = await mkdtemp(join(tmpdir(), "autodom-catalog-"));
  try {
    let requests = 0;
    const transport: DocumentTransport = {
      async fetchDocument(url, parse) {
        requests += 1;
        const parsed = new URL(url);
        if (parsed.searchParams.get("parent_option_id") === "1")
          return parse(
            JSON.stringify([
              { attribute_id: 17, id: 2, value: "Camry", label: "Camry", is_active: true },
            ]),
          );
        return parse(
          JSON.stringify([
            { attribute_id: 16, id: 1, value: "Toyota", label: "Toyota", is_active: true },
          ]),
        );
      },
      fetchDocuments: vi.fn(),
    };
    const catalog = new VehicleCatalog(transport, directory);
    await catalog.getOptions("model", "1");
    const before = requests;

    const result = await catalog.refresh();
    expect(result).toEqual({ makes: 1, models: 1 });
    expect(requests).toBe(before + 2);

    // The refreshed copy is the one that is served afterwards.
    const restarted = new VehicleCatalog(transport, directory);
    expect((await restarted.getOptions("model", "1")).map((item) => item.value)).toEqual(["Camry"]);
    expect(requests).toBe(before + 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("warms the model list of every make and keeps the stored copy", async () => {
  vi.stubEnv("AUTODOM_APPROVED_SOURCES", "mashina.kg");
  const directory = await mkdtemp(join(tmpdir(), "autodom-catalog-"));
  try {
    let modelRequests = 0;
    const transport: DocumentTransport = {
      async fetchDocument(url, parse) {
        const parsed = new URL(url);
        if (parsed.searchParams.get("parent_option_id") === "1") {
          modelRequests += 1;
          return parse(
            JSON.stringify([
              { attribute_id: 17, id: 2, value: "Camry", label: "Camry", is_active: true },
            ]),
          );
        }
        return parse(
          JSON.stringify([
            { attribute_id: 16, id: 1, value: "Toyota", label: "Toyota", is_active: true },
          ]),
        );
      },
      fetchDocuments: vi.fn(),
    };
    const catalog = new VehicleCatalog(transport, directory);
    await catalog.warmMakes();
    expect(modelRequests).toBe(1);

    // The next start finds the stored copy and asks the source for nothing.
    const restarted = new VehicleCatalog(transport, directory);
    await restarted.warmMakes();
    expect(modelRequests).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
