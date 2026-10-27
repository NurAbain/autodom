import {
  type CatalogChoice,
  type CatalogFieldKey,
  type CatalogLookup,
  catalogChoicesSchema,
  type ModificationScope,
} from "@autodom/core/catalog-filter";

const UNAVAILABLE =
  "Справочник временно недоступен. Выбранные параметры сохранены; повторите позже.";

export class CatalogPendingError extends Error {
  constructor() {
    super(
      "Готовим полный справочник. Первый запрос модификаций может занять несколько минут. Нажмите «Повторить» позже — выбранные параметры сохранены.",
    );
  }
}

/** The taxonomy changes once a day, the editor asks for it on every make. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 512;
const cache = new Map<string, { expires: number; result: Promise<readonly CatalogChoice[]> }>();

function memoCatalogue(
  key: string,
  load: () => Promise<readonly CatalogChoice[]>,
): Promise<readonly CatalogChoice[]> {
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + CACHE_TTL_MS, result: load() };
  entry.result.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  cache.set(key, entry);
  return entry.result;
}

/** Only the parser has source/proxy access. No in-process or direct-source fallback. */
export const vehicleCatalog: CatalogLookup = {
  getOptions(key, parentId, scope) {
    return memoCatalogue(
      `${key}:${parentId ?? ""}:${scope ? `${scope.modelId}/${scope.generation}` : ""}`,
      () => loadCatalogueOptions(key, parentId, scope),
    );
  },
};

async function loadCatalogueOptions(
  key: CatalogFieldKey,
  parentId?: string,
  scope?: ModificationScope,
): Promise<readonly CatalogChoice[]> {
  const raw = process.env.AUTODOM_CATALOG_API_URL?.trim();
  const token = process.env.AUTODOM_CATALOG_API_TOKEN?.trim();
  if (!raw || !token || token.length < 32)
    throw new Error("Справочник ещё не подключён. Можно задать марку и модель текстом.");
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error(UNAVAILABLE);
  const url = new URL("/v1/catalog/options", base);
  url.searchParams.set("key", key);
  if (parentId) url.searchParams.set("parent", parentId);
  if (scope) {
    url.searchParams.set("model", scope.modelId);
    url.searchParams.set("generation", scope.generation);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A slow taxonomy is still being prepared; the caller retries instead of
    // telling the user that the catalogue is unavailable.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new CatalogPendingError();
    throw new Error(UNAVAILABLE);
  }
  if (response.status === 202) {
    await response.body?.cancel();
    throw new CatalogPendingError();
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(UNAVAILABLE);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error(UNAVAILABLE);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    return catalogChoicesSchema.parse(value);
  } catch {
    throw new Error(UNAVAILABLE);
  } finally {
    reader.cancel();
    reader.releaseLock();
  }
}
