import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone

import aiohttp
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatType, ParseMode
from aiogram.exceptions import TelegramForbiddenError, TelegramNetworkError, TelegramRetryAfter
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LinkPreviewOptions,
    Message,
)

from autodom.config import Settings
from autodom.conversation import Conversation, Reply, listing_text, menu, pack_replies
from autodom.matching import matches
from autodom.models import ListingEvent, Profile, SourcePage
from autodom.proxy import ProxyRoute
from autodom.rates import RateBook
from autodom.source_http import SourceError, SourceRateLimited
from autodom.sources import Source, enabled_sources, source_status
from autodom.storage import Store

logger = logging.getLogger(__name__)
Send = Callable[[int, list[Reply]], Awaitable[None]]


class UserLocks:
    def __init__(self) -> None:
        self._locks: dict[int, asyncio.Lock] = {}

    def get(self, user_id: int) -> asyncio.Lock:
        if user_id not in self._locks:
            self._locks[user_id] = asyncio.Lock()
        return self._locks[user_id]


def record_page(
    store: Store, source: Source, page: SourcePage, observed_at: float | None = None
) -> int:
    if any(item.source != source.id or item.market != source.market for item in page.listings):
        raise SourceError("A catalog page contains another source or market")
    prefix = f"source:{source.id}:"
    prior_scope = store.get_meta(prefix + "scope", "")
    if page.page > 1 and prior_scope and page.scope != prior_scope:
        store.set_meta(prefix + "crawl_next_page", "1")
        store.set_meta(prefix + "full_scan_completed_at", "0")
        raise SourceError("Source search scope changed; restart from the first page")
    count = store.upsert_listings(page.listings, observed_at=observed_at)
    store.set_meta(prefix + "catalog_total", str(page.total))
    store.set_meta(prefix + "catalog_pages", str(page.pages))
    store.set_meta(prefix + "scope", page.scope)
    store.set_meta(prefix + "last_sync_at", datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"))
    store.set_meta(prefix + "source_error", "")
    return count


async def _collect_page(
    store: Store,
    source: Source,
    page_number: int,
    session: aiohttp.ClientSession,
    proxies: tuple[ProxyRoute, ...],
    rates: RateBook,
) -> SourcePage:
    page = await source.fetch_page(session, page_number, proxies=proxies)
    observed_at = time.time()
    if source.market != "KG":
        await rates.refresh(session)
        page = replace(page, listings=[rates.convert(listing) for listing in page.listings])
    record_page(store, source, page, observed_at)
    return page


def _source_failed(store: Store, source: Source, error: Exception) -> None:
    store.set_meta(f"source:{source.id}:source_error", type(error).__name__)
    reason = str(error) if isinstance(error, SourceError) else type(error).__name__
    logger.warning("%s collection paused: %s", source.id, reason)


async def sync_pages(
    store: Store, pages: int, proxies: tuple[ProxyRoute, ...], delay: float = 2.0
) -> dict:
    if type(pages) is not int or pages < 1:
        raise ValueError("Page count must be positive")
    async with aiohttp.ClientSession() as session:
        rates = RateBook(store, proxies)

        async def collect(source: Source) -> bool:
            prefix = f"source:{source.id}:"
            try:
                for page_number in range(1, pages + 1):
                    if page_number > 1:
                        await asyncio.sleep(delay)
                    page = await _collect_page(store, source, page_number, session, proxies, rates)
                    store.set_meta(
                        prefix + "crawl_next_page",
                        str(
                            max(
                                page_number + 1,
                                int(store.get_meta(prefix + "crawl_next_page", "1")),
                            )
                        ),
                    )
                    if page_number >= page.pages:
                        store.set_meta(prefix + "full_scan_completed_at", str(time.time()))
                        break
                return True
            except Exception as error:
                _source_failed(store, source, error)
                return False

        outcomes = await asyncio.gather(*(collect(source) for source in enabled_sources()))
        if not any(outcomes):
            raise SourceError("No enabled source could be updated; inspect per-source status")
    return {**store.stats(), "sources": source_status(store)}


async def _crawl_source(
    store: Store,
    settings: Settings,
    source: Source,
    session: aiohttp.ClientSession,
    proxies: tuple[ProxyRoute, ...],
    rates: RateBook,
) -> None:
    prefix = f"source:{source.id}:"
    next_refresh = 0.0
    while True:
        try:
            if time.monotonic() >= next_refresh:
                for page_number in range(1, settings.refresh_pages + 1):
                    page = await _collect_page(store, source, page_number, session, proxies, rates)
                    await asyncio.sleep(settings.crawl_delay)
                    if page_number >= page.pages:
                        break
                next_refresh = time.monotonic() + settings.refresh_seconds
            next_page = int(store.get_meta(prefix + "crawl_next_page", "1"))
            pages = int(store.get_meta(prefix + "catalog_pages", "1"))
            completed = float(store.get_meta(prefix + "full_scan_completed_at", "0"))
            if next_page > pages:
                if not completed:
                    completed = time.time()
                    store.set_meta(prefix + "full_scan_completed_at", str(completed))
                if time.time() - completed >= settings.full_refresh_seconds:
                    next_page = 1
                    store.set_meta(prefix + "crawl_next_page", "1")
                    store.set_meta(prefix + "full_scan_completed_at", "0")
                else:
                    await asyncio.sleep(min(30, settings.refresh_seconds))
                    continue
            page = await _collect_page(store, source, next_page, session, proxies, rates)
            store.set_meta(prefix + "crawl_next_page", str(next_page + 1))
            if next_page >= page.pages:
                store.set_meta(prefix + "full_scan_completed_at", str(time.time()))
                logger.info("%s catalog scan complete", source.id)
            if next_page % 50 == 0:
                logger.info("%s progress: page %s/%s", source.id, next_page, page.pages)
            await asyncio.sleep(settings.crawl_delay)
        except SourceRateLimited as error:
            _source_failed(store, source, error)
            await asyncio.sleep(max(settings.refresh_seconds, error.retry_after))
        except Exception as error:
            _source_failed(store, source, error)
            await asyncio.sleep(settings.refresh_seconds)


async def crawl(store: Store, settings: Settings, proxies: tuple[ProxyRoute, ...]) -> None:
    async with aiohttp.ClientSession() as session:
        rates = RateBook(store, proxies)
        async with asyncio.TaskGroup() as tasks:
            for source in enabled_sources():
                tasks.create_task(_crawl_source(store, settings, source, session, proxies, rates))


async def send_replies(bot: Bot, chat_id: int, replies: list[Reply]) -> None:
    for reply in replies:
        keyboard = None
        if reply.buttons:
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(text=label, callback_data=action)
                        for label, action in row
                    ]
                    for row in reply.buttons
                ]
            )
        await bot.send_message(
            chat_id,
            reply.text,
            reply_markup=keyboard,
            link_preview_options=LinkPreviewOptions(is_disabled=True),
        )


def quiet_now(profile: Profile, now: datetime | None = None) -> bool:
    if profile.quiet_start_minute is None or profile.quiet_end_minute is None:
        return False
    local = (now or datetime.now(UTC)).astimezone(timezone(timedelta(hours=6)))
    minute = local.hour * 60 + local.minute
    start, end = profile.quiet_start_minute, profile.quiet_end_minute
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


async def notify_once(store: Store, locks: UserLocks, send: Send) -> int:
    delivered = 0
    for candidate_profile in store.monitoring_profiles():
        async with locks.get(candidate_profile.user_id):
            profile = store.get_profile(candidate_profile.user_id)
            if profile is None or not profile.monitoring:
                continue
            if quiet_now(profile):
                continue
            events = store.events_after(profile.cursor, limit=10_000)
            if not events:
                continue
            latest: dict[str, ListingEvent] = {}
            for event in events:
                previous = latest.get(event.listing.id)
                if previous is not None:
                    event = ListingEvent(
                        event.id,
                        event.listing,
                        previous.kind,
                        previous.previous_usd_minor,
                        previous.previous_kgs_minor,
                        previous.previous_original_price_minor,
                        previous.previous_original_currency,
                    )
                latest[event.listing.id] = event
            sections = []
            count = 0
            section_characters = 0
            for event in sorted(latest.values(), key=lambda value: value.id, reverse=True):
                current = store.get_listing(event.listing.id, fresh_only=True)
                if current is None or not matches(profile, current):
                    continue
                if current.original_currency:
                    if (
                        current.original_currency != event.listing.original_currency
                        or current.original_price_minor != event.listing.original_price_minor
                    ):
                        continue
                elif current.price(profile.currency) != event.listing.price(profile.currency):
                    continue
                if event.kind != "new" and not event.is_price_drop(profile.currency):
                    continue
                count += 1
                if len(sections) < 5:
                    kind = (
                        "Новое совпадение в каталоге"
                        if event.kind == "new"
                        else "Цена на сайте снизилась"
                    )
                    section = f"<b>{kind}</b>\n" + listing_text(current, profile.currency)
                    if section_characters + len(section) + 2 <= 3000:
                        sections.append(section)
                        section_characters += len(section) + 2
            try:
                if sections:
                    header = "<b>Бесплатный мониторинг Autodom</b>\nОбновления по вашему сохранённому поиску."
                    if count > len(sections):
                        header += f" Ещё подходящих обновлений: {count - len(sections)} — смотрите /search."
                    await send(profile.chat_id, pack_replies(header, sections, menu(profile)))
                    delivered += 1
                store.advance_cursor(profile.user_id, events[-1].id, profile.revision)
            except TelegramForbiddenError:
                store.set_monitoring(profile.user_id, False)
            except TelegramRetryAfter as error:
                logger.warning("Telegram rate limit; monitoring delivery postponed")
                store.set_meta("telegram_error", "rate_limited")
                await asyncio.sleep(error.retry_after)
            except TelegramNetworkError:
                store.set_meta("telegram_error", "network_error")
                logger.warning("Telegram unavailable; monitoring cursor retained for next attempt")
    return delivered


async def monitor(store: Store, locks: UserLocks, send: Send, interval: int) -> None:
    while True:
        store.set_meta("last_monitor_at", str(time.time()))
        store.set_meta("telegram_error", "")
        await notify_once(store, locks, send)
        await asyncio.sleep(interval)


async def maintain(store: Store, settings: Settings) -> None:
    backup_directory = settings.backup_directory
    while True:
        now = time.time()
        store.set_meta("runtime_heartbeat", str(now))
        # Snapshots are local protection against application/data mistakes, not off-site backup.
        if backup_directory is not None:
            last_backup = float(store.get_meta("last_backup_at", "0"))
            if now - last_backup >= 86400:
                destination = (
                    backup_directory / f"autodom-{datetime.now(UTC):%Y%m%dT%H%M%S%f}.sqlite3"
                )
                store.backup(destination)
                store.set_meta("last_backup_at", str(now))
                logger.info("Local database snapshot saved")
            for snapshot in backup_directory.glob("autodom-*.sqlite3"):
                if snapshot.is_file() and snapshot.stat().st_mtime < now - 7 * 86400:
                    snapshot.unlink()
        await asyncio.sleep(30)


async def run_bot(
    store: Store, settings: Settings, proxies: tuple[ProxyRoute, ...], token: str
) -> None:
    bot = Bot(token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    try:
        identity = await bot.get_me()
        webhook = await bot.get_webhook_info()
        if webhook.url:
            raise RuntimeError(
                "This bot already has a webhook; refusing to replace an existing integration"
            )
        await bot.set_my_commands(
            [
                BotCommand(command="start", description="Начать подбор автомобиля"),
                BotCommand(command="search", description="Найти варианты по моему бюджету"),
                BotCommand(command="profile", description="Мой бюджет и пожелания"),
                BotCommand(command="edit", description="Изменить поиск"),
                BotCommand(command="resume", description="Включить бесплатный мониторинг"),
                BotCommand(command="pause", description="Приостановить уведомления"),
                BotCommand(command="tips", description="Советы перед покупкой"),
                BotCommand(command="quiet", description="Тихие часы: /quiet 23:00-08:00 или off"),
                BotCommand(command="privacy", description="Хранение и удаление моих данных"),
                BotCommand(command="status", description="Состояние каталога"),
                BotCommand(command="delete", description="Удалить мои данные"),
                BotCommand(command="help", description="Все команды и примеры"),
            ]
        )
        conversation = Conversation(store)
        locks = UserLocks()
        router = Router()

        async def send(chat_id: int, replies: list[Reply]) -> None:
            await send_replies(bot, chat_id, replies)

        @router.message(F.chat.type == ChatType.PRIVATE)
        async def on_message(message: Message) -> None:
            if not message.from_user or message.from_user.is_bot:
                return
            async with locks.get(message.from_user.id):
                replies = conversation.handle(
                    message.from_user.id, message.chat.id, message.text or ""
                )
                await send(message.chat.id, replies)

        @router.callback_query()
        async def on_callback(callback: CallbackQuery) -> None:
            if (
                not isinstance(callback.message, Message)
                or callback.message.chat.type != ChatType.PRIVATE
            ):
                await callback.answer("Откройте бота в личном чате.")
                return
            if callback.message.chat.id != callback.from_user.id:
                await callback.answer("Этот поиск принадлежит другому пользователю.")
                return
            await callback.answer()
            async with locks.get(callback.from_user.id):
                replies = conversation.handle(
                    callback.from_user.id, callback.message.chat.id, callback.data or ""
                )
                await send(callback.message.chat.id, replies)

        dispatcher = Dispatcher()
        dispatcher.include_router(router)
        async with asyncio.TaskGroup() as tasks:
            collector = tasks.create_task(crawl(store, settings, proxies))
            notifier = tasks.create_task(monitor(store, locks, send, settings.monitor_seconds))
            maintenance = tasks.create_task(maintain(store, settings))
            logger.info(
                "Bot @%s ready; catalog=%s, polling enabled",
                identity.username,
                store.stats()["listings"],
            )
            try:
                await dispatcher.start_polling(
                    bot,
                    allowed_updates=["message", "callback_query"],
                    close_bot_session=False,
                    tasks_concurrency_limit=50,
                )
            finally:
                collector.cancel()
                notifier.cancel()
                maintenance.cancel()
    finally:
        await bot.session.close()
