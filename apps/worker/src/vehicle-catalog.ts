import { approvedSources, type DocumentTransport } from "@autodom/core";
import type {
  CatalogChoice,
  CatalogFieldKey,
  CatalogLookup,
  ModificationScope,
} from "@autodom/core/catalog-filter";
import pLimit from "p-limit";

const ORIGIN = "https://api.mashina.kg/api/mbank-proxy/v1";
const LOOKUPS: Record<CatalogFieldKey, { id: number; parent?: boolean; skip?: number }> = {
  make: { id: 16 },
  model: { id: 17, parent: true },
  generation: { id: 13, parent: true, skip: 2 },
  modification: { id: 14, parent: true, skip: 3 },
  body_type: { id: 18 },
  fuel_type: { id: 19 },
  drive_type: { id: 23 },
  gearbox: { id: 21 },
  steering_wheel: { id: 22 },
  color: { id: 24 },
  condition: { id: 20 },
  exchange_option: { id: 12 },
  region: { id: 51 },
  city: { id: 50, parent: true },
  availibility: { id: 96 },
};
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 256;
const MAX_OPTIONS = 10_000;
const INVALID = "Справочник временно недоступен. Выбранные параметры сохранены; повторите позже.";

type CacheEntry<T> = { expires: number; result: Promise<T> };

async function eachChoice(
  items: readonly CatalogChoice[],
  action: (choice: CatalogChoice) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) await action(items[next++]!);
    }),
  );
}

/** Public taxonomy only: never requests ads, user searches, budgets or contacts. */
export class VehicleCatalog implements CatalogLookup {
  private readonly cache = new Map<string, CacheEntry<readonly CatalogChoice[]>>();
  private readonly paths = new Map<string, CacheEntry<ReadonlyMap<string, readonly string[]>>>();
  private readonly requests = pLimit(4);

  constructor(private readonly transport: DocumentTransport) {}

  async getOptions(
    key: CatalogFieldKey,
    parentId?: string,
    scope?: ModificationScope,
  ): Promise<readonly CatalogChoice[]> {
    if (!approvedSources().includes("mashina.kg"))
      throw new Error("Справочник этого рынка сейчас отключён.");
    if (!Object.hasOwn(LOOKUPS, key)) throw new Error("Неизвестный параметр автомобиля.");
    const lookup = LOOKUPS[key];
    if (lookup.parent && (!parentId || !/^[1-9]\d{0,17}$/u.test(parentId)))
      throw new Error("Сначала выберите предыдущий параметр автомобиля или регион.");
    if (!lookup.parent && parentId !== undefined)
      throw new Error("Этот параметр не зависит от другого выбора.");
    if (
      key === "modification" &&
      (!scope ||
        !/^[1-9]\d{0,17}$/u.test(scope.modelId) ||
        !scope.generation ||
        scope.generation.length > 300)
    )
      throw new Error("Сначала выберите модель и поколение автомобиля.");
    const cacheKey = `${key}:${parentId ?? ""}:${key === "modification" ? JSON.stringify(scope) : ""}`;
    return this.memo(this.cache, cacheKey, MAX_ENTRIES, () =>
      key === "modification"
        ? this.modifications(parentId!, scope!)
        : this.options(lookup.id, parentId, lookup.skip),
    );
  }

  private memo<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    maximum: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) {
      cache.delete(key);
      cache.set(key, previous);
      return previous.result;
    }
    cache.delete(key);
    if (cache.size >= maximum) {
      for (const [oldestKey, value] of cache) {
        if (value.expires === Number.POSITIVE_INFINITY) continue;
        cache.delete(oldestKey);
        break;
      }
      if (cache.size >= maximum) return Promise.reject(new Error(INVALID));
    }
    const entry: CacheEntry<T> = { expires: Number.POSITIVE_INFINITY, result: load() };
    entry.result = entry.result
      .then((value) => {
        entry.expires = Date.now() + TTL_MS;
        return value;
      })
      .catch((error: unknown) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      });
    cache.set(key, entry);
    return entry.result;
  }

  private generationPaths(modelId: string): Promise<ReadonlyMap<string, readonly string[]>> {
    return this.memo(this.paths, modelId, 32, async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
      try {
        const generations = new Map<string, string[]>();
        const years = await this.options(1, modelId, undefined, signal);
        // Physical hierarchy: model -> year -> body -> generation. Flattened options
        // retain only one representative per label and can hide later-year engines.
        await eachChoice(years, async (year) => {
          const bodies = await this.options(18, year.id, undefined, signal);
          for (const body of bodies) {
            for (const generation of await this.options(13, body.id, undefined, signal)) {
              const ids = generations.get(generation.value);
              if (ids) {
                if (!ids.includes(generation.id)) ids.push(generation.id);
              } else generations.set(generation.value, [generation.id]);
            }
          }
        });
        return generations;
      } finally {
        controller.abort();
      }
    });
  }

  private async modifications(
    parentId: string,
    scope: ModificationScope,
  ): Promise<readonly CatalogChoice[]> {
    const paths = await this.generationPaths(scope.modelId);
    const ids = paths.get(scope.generation);
    if (!ids?.includes(parentId)) throw new Error(INVALID);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    try {
      const variants = new Map<string, CatalogChoice>();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (next < ids.length) {
            const id = ids[next++]!;
            for (const option of await this.options(14, id, 3, signal))
              if (!variants.has(option.value)) variants.set(option.value, option);
          }
        }),
      );
      return Object.freeze(
        [...variants.values()].sort((a, b) => a.label.localeCompare(b.label, "ru")),
      );
    } finally {
      controller.abort();
    }
  }

  private options(
    attributeId: number,
    parentId?: string,
    skip?: number,
    signal?: AbortSignal,
  ): Promise<readonly CatalogChoice[]> {
    return this.requests(() => this.requestOptions(attributeId, parentId, skip, signal));
  }

  private async requestOptions(
    attributeId: number,
    parentId?: string,
    skip?: number,
    signal?: AbortSignal,
  ): Promise<readonly CatalogChoice[]> {
    const url = new URL(`${ORIGIN}/ads/${attributeId}/options`);
    url.searchParams.set("category_id", "1");
    if (parentId) url.searchParams.set("parent_option_id", parentId);
    // An omitted/wrong skip may return category-wide options instead of an error.
    if (skip !== undefined) url.searchParams.set("skip_levels", String(skip));
    try {
      return await this.transport.fetchDocument(
        url.toString(),
        (text) => {
          const raw: unknown = JSON.parse(text);
          if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) throw new Error(INVALID);
          const choices: CatalogChoice[] = [];
          const ids = new Set<string>();
          for (const option of raw) {
            if (option === null || typeof option !== "object" || Array.isArray(option))
              throw new Error(INVALID);
            const item = option as Record<string, unknown>;
            if (item.attribute_id !== attributeId || typeof item.is_active !== "boolean")
              throw new Error(INVALID);
            if (!item.is_active) continue;
            const id =
              typeof item.id === "number" && Number.isSafeInteger(item.id)
                ? String(item.id)
                : item.id;
            const value = item.value ?? item.id;
            if (
              typeof id !== "string" ||
              !/^[1-9]\d{0,17}$/u.test(id) ||
              !["string", "number", "boolean"].includes(typeof value) ||
              (typeof value === "number" && !Number.isFinite(value)) ||
              typeof item.label !== "string" ||
              !item.label.trim() ||
              item.label.length > 256 ||
              String(value).length > 256 ||
              /[\p{Cc}]/u.test(item.label + String(value)) ||
              ids.has(id)
            )
              throw new Error(INVALID);
            ids.add(id);
            choices.push(Object.freeze({ id, value: String(value), label: item.label.trim() }));
          }
          return Object.freeze(choices);
        },
        {
          source: "mashina.kg",
          headers: { Accept: "application/json", "Accept-Language": "ru" },
          ...(signal ? { signal } : {}),
        },
      );
    } catch {
      throw new Error(INVALID);
    }
  }
}
