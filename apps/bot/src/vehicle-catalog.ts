import { type CatalogLookup, catalogChoicesSchema } from "@autodom/core/catalog-filter";

const UNAVAILABLE =
  "Справочник временно недоступен. Выбранные параметры сохранены; повторите позже.";

export class CatalogPendingError extends Error {
  constructor() {
    super(
      "Готовим полный справочник. Первый запрос модификаций может занять несколько минут. Нажмите «Повторить» позже — выбранные параметры сохранены.",
    );
  }
}

/** Only the parser has source/proxy access. No in-process or direct-source fallback. */
export const vehicleCatalog: CatalogLookup = {
  async getOptions(key, parentId, scope) {
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
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
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
      await reader.cancel();
      reader.releaseLock();
    }
  },
};
