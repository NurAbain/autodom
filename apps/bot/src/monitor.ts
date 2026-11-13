import { setTimeout as delay } from "node:timers/promises";
import {
  isPriceDrop,
  type Listing,
  type ListingEvent,
  listingPrice,
  matches,
  money,
  type PriceEstimate,
  type Profile,
} from "@autodom/core";
import type { Metrics } from "@autodom/runtime/metrics";
import type { FavoriteState } from "@autodom/storage";
import { GrammyError, HttpError } from "grammy";
import { listingReplies, menu, packReplies, type Reply } from "./conversation.js";
import { escapeHtml } from "./html.js";

export interface MonitorStore {
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  monitoringProfiles(): Promise<Profile[]>;
  getProfile(userId: number): Promise<Profile | null>;
  eventsAfter(cursor: number, limit?: number): Promise<ListingEvent[]>;
  getListing(id: string, freshOnly?: boolean): Promise<Listing | null>;
  advanceCursor(userId: number, eventId: number, revision: string): Promise<boolean>;
  getMeta(key: string, defaultValue?: string | null): Promise<string | null>;
  estimatePrice(listing: Listing, currency: "USD" | "KGS"): Promise<PriceEstimate | null>;
  favoriteProfiles(): Promise<Profile[]>;
  favoriteState(userId: number): Promise<FavoriteState>;
  saveFavoriteState(userId: number, state: FavoriteState): Promise<void>;
  favoriteListings(userId: number): Promise<{ id: string; listing: Listing | null }[]>;
  setMonitoring(userId: number, enabled: boolean): Promise<Profile | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export type SendReplies = (chatId: number, replies: Reply[]) => Promise<void>;

export function quietNow(profile: Profile, now = new Date()): boolean {
  if (profile.quiet_start_minute === null || profile.quiet_end_minute === null) return false;
  const local = new Date(now.getTime() + 6 * 3_600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = profile.quiet_start_minute;
  const end = profile.quiet_end_minute;
  return start < end ? start <= minute && minute < end : minute >= start || minute < end;
}

export async function notifyOnce(
  store: MonitorStore,
  send: SendReplies,
  signal?: AbortSignal,
  metrics?: Pick<Metrics, "recordNotificationDelivery">,
  canNotify?: (userId: number) => Promise<boolean>,
): Promise<number> {
  let delivered = 0;
  const estimates = new Map<string, Promise<PriceEstimate | null>>();
  const deliveredListings = new Set<string>();
  for (const candidate of await store.monitoringProfiles()) {
    signal?.throwIfAborted();
    await store.withLock(`autodom:user:${candidate.user_id}`, async () => {
      if (canNotify && !(await canNotify(candidate.user_id))) return;
      const profile = await store.getProfile(candidate.user_id);
      if (!profile?.monitoring || quietNow(profile)) return;
      const buyout = (await store.getMeta(`autodom:buyout:${profile.user_id}`)) === "1";
      const events = await store.eventsAfter(profile.cursor, buyout ? 100 : 10_000);
      const lastEvent = events.at(-1);
      if (!lastEvent) return;
      const latest = new Map<string, ListingEvent>();
      for (let event of events) {
        const previous = latest.get(event.listing.id);
        if (
          previous &&
          event.kind !== "new" &&
          previous.listing.price_kind === event.listing.price_kind &&
          previous.listing.original_currency === event.listing.original_currency
        ) {
          event = {
            ...event,
            kind: previous.kind,
            previous_usd_minor: previous.previous_usd_minor,
            previous_kgs_minor: previous.previous_kgs_minor,
            previous_original_price_minor: previous.previous_original_price_minor,
            previous_original_currency: previous.previous_original_currency,
          };
        }
        latest.set(event.listing.id, event);
      }
      const cards: Reply[] = [];
      const batchIds: string[] = [];
      let shown = 0;
      let count = 0;
      for (const event of [...latest.values()].sort((a, b) => b.id - a.id)) {
        const current = await store.getListing(event.listing.id, true);
        if (!current || !matches(profile, current)) continue;
        if (
          current.price_kind !== event.listing.price_kind ||
          current.original_currency !== event.listing.original_currency
        )
          continue;
        if (
          current.original_currency
            ? current.original_price_minor !== event.listing.original_price_minor
            : listingPrice(current, profile.currency) !==
              listingPrice(event.listing, profile.currency)
        )
          continue;
        if (event.kind !== "new" && !isPriceDrop(event, profile.currency)) continue;
        let discount: number | undefined;
        let reference: PriceEstimate | null = null;
        if (buyout) {
          const currency = profile.currency === "USD" ? "USD" : "KGS";
          const key = `${currency}:${current.id}`;
          let pending = estimates.get(key);
          if (!pending) {
            pending = store.estimatePrice(current, currency);
            estimates.set(key, pending);
          }
          reference = await pending;
          const price = listingPrice(current, currency);
          if (!reference || price === null || price / reference.medianMinor > 0.85) continue;
          discount = Math.floor((1 - price / reference.medianMinor) * 100 + 1e-9);
        }
        count += 1;
        if (shown < 5) {
          const kind =
            discount === undefined
              ? event.kind === "new"
                ? "Новое совпадение в каталоге"
                : "Цена на сайте снизилась"
              : `Возможно ниже рынка: на ${discount}% ниже медианы ${money(reference!.medianMinor, reference!.currency)} (${reference!.sampleSize} аналогов). Состояние не проверено.`;
          cards.push(...listingReplies(current, profile.currency, [], kind));
          batchIds.push(current.id);
          shown += 1;
        }
      }
      try {
        if (cards.length) {
          let header =
            "<b>Бесплатный мониторинг Autodom</b>\nОбновления по вашему сохранённому поиску.";
          if (count > shown)
            header += ` Ещё подходящих обновлений: ${count - shown} — смотрите /search.`;
          cards[cards.length - 1]!.buttons = [
            ...cards[cards.length - 1]!.buttons,
            ...menu(profile),
          ];
          try {
            await send(profile.chat_id, [...packReplies(header, []), ...cards]);
          } catch (error) {
            metrics?.recordNotificationDelivery(
              error instanceof GrammyError && error.error_code === 403
                ? "blocked"
                : (error instanceof GrammyError && error.error_code === 429) ||
                    error instanceof HttpError
                  ? "retry"
                  : "error",
            );
            throw error;
          }
          metrics?.recordNotificationDelivery("sent");
          for (const id of batchIds) deliveredListings.add(`${profile.user_id}:${id}`);
          delivered += 1;
        }
        await store.advanceCursor(profile.user_id, lastEvent.id, profile.revision);
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 403) {
          await store.setMonitoring(profile.user_id, false);
        } else if (error instanceof GrammyError && error.error_code === 429) {
          await store.setMeta("telegram_error", "rate_limited");
          await delay(
            (error.parameters.retry_after ?? 60) * 1000,
            undefined,
            signal ? { signal } : {},
          );
        } else if (error instanceof HttpError) {
          await store.setMeta("telegram_error", "network_error");
        } else {
          throw error;
        }
      }
    });
  }
  for (const candidate of await store.favoriteProfiles()) {
    signal?.throwIfAborted();
    await store.withLock(`autodom:user:${candidate.user_id}`, async () => {
      if (canNotify && !(await canNotify(candidate.user_id))) return;
      const profile = await store.getProfile(candidate.user_id);
      if (!profile || profile.chat_id !== profile.user_id || quietNow(profile)) return;
      const state = await store.favoriteState(profile.user_id);
      if (!state.items.length) return;
      const favorites = await store.favoriteListings(profile.user_id);
      const byId = new Map(favorites.map((item) => [item.id, item.listing]));
      const events = await store.eventsAfter(state.cursor, 100);
      const changed = new Map<string, ListingEvent>();
      let cursor = state.cursor;
      for (const event of events) {
        const item = state.items.find((entry) => entry.id === event.listing.id);
        if (
          item &&
          event.id > item.addedEvent &&
          byId.get(item.id) &&
          !deliveredListings.has(`${profile.user_id}:${item.id}`)
        ) {
          if (!changed.has(item.id) && changed.size >= 20) break;
          changed.set(item.id, event);
        }
        cursor = event.id;
      }
      const replies: Reply[] = [];
      for (const [id, event] of changed) {
        const listing = byId.get(id);
        if (!listing) continue;
        const snapshotPrice = listingPrice(event.listing, profile.currency);
        const samePrice =
          snapshotPrice !== null &&
          listing.price_kind === event.listing.price_kind &&
          listing.original_currency === event.listing.original_currency &&
          (listing.original_currency
            ? listing.original_price_minor === event.listing.original_price_minor
            : listingPrice(listing, profile.currency) === snapshotPrice);
        const heading =
          samePrice && isPriceDrop(event, profile.currency)
            ? "Цена избранного автомобиля снизилась"
            : "Цена избранного автомобиля изменилась";
        replies.push(...listingReplies(listing, profile.currency, [], heading));
      }
      let staleChanged = false;
      const stale: string[] = [];
      for (const item of state.items) {
        const listing = byId.get(item.id);
        const notObserved =
          !listing ||
          listing.observed_at === null ||
          listing.observed_at < Date.now() / 1000 - 48 * 3600;
        if (notObserved && !item.staleNotified) {
          stale.push(listing ? escapeHtml(listing.title) : "Сохранённое объявление");
          item.staleNotified = true;
          staleChanged = true;
        } else if (!notObserved && item.staleNotified) {
          item.staleNotified = false;
          staleChanged = true;
        }
      }
      if (stale.length)
        replies.push(
          ...packReplies(
            "<b>Избранные объявления давно не наблюдались</b>\n" +
              stale.map((title) => `• ${title}`).join("\n") +
              "\nЭто не подтверждает продажу: источник может быть недоступен.",
            [],
          ),
        );
      try {
        if (replies.length) {
          await send(profile.chat_id, replies);
          metrics?.recordNotificationDelivery("sent");
          delivered += 1;
        }
        if (cursor !== state.cursor || staleChanged) {
          state.cursor = cursor;
          await store.saveFavoriteState(profile.user_id, state);
        }
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 403)
          metrics?.recordNotificationDelivery("blocked");
        else if (error instanceof GrammyError && error.error_code === 429) {
          metrics?.recordNotificationDelivery("retry");
          await delay(
            (error.parameters.retry_after ?? 60) * 1000,
            undefined,
            signal ? { signal } : {},
          );
        } else if (error instanceof HttpError) {
          metrics?.recordNotificationDelivery("retry");
          await store.setMeta("telegram_error", "network_error");
        } else throw error;
      }
    });
  }
  return delivered;
}

export async function monitor(
  store: MonitorStore,
  send: SendReplies,
  interval: number,
  signal: AbortSignal,
  metrics?: Pick<Metrics, "recordMonitorIteration" | "recordNotificationDelivery">,
  canNotify?: (userId: number) => Promise<boolean>,
): Promise<void> {
  while (!signal.aborted) {
    const started = performance.now();
    let outcome: "success" | "error" | "aborted" = "success";
    try {
      await store.setMeta("last_monitor_at", String(Date.now() / 1000));
      await store.setMeta("telegram_error", "");
      await notifyOnce(store, send, signal, metrics, canNotify);
    } catch (error) {
      outcome = signal.aborted ? "aborted" : "error";
      throw error;
    } finally {
      metrics?.recordMonitorIteration(outcome, (performance.now() - started) / 1000);
    }
    await delay(interval * 1000, undefined, { signal });
  }
}
