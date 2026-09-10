import asyncio
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import SendMessage

from autodom.models import Listing, Profile
from autodom.runtime import UserLocks, notify_once, quiet_now
from autodom.storage import Store


def test_fresh_notifications_and_cursor_survive_reopen(tmp_path):
    path = tmp_path / "catalog.sqlite3"
    store = Store(path)
    store.save_profile(Profile(1, 1, "USD", 0, 2_000_000, "toyota", True))
    listing = Listing(
        "mashina:1",
        "Toyota Camry",
        "https://mashina.kg/details/toyota",
        1_500_000,
        None,
        availability="В наличии",
    )
    store.upsert_listings([listing])
    sent = []

    async def send(chat_id, replies):
        sent.extend(replies)

    assert asyncio.run(notify_once(store, UserLocks(), send)) == 1
    assert any(listing.title in reply.text for reply in sent)
    store.close()
    store = Store(path)
    assert asyncio.run(notify_once(store, UserLocks(), send)) == 0
    store.upsert_listings([replace(listing, price_usd_minor=1_400_000)])
    assert asyncio.run(notify_once(store, UserLocks(), send)) == 1
    store.close()


def test_new_matching_car_is_not_lost_when_repriced_before_poll():
    store = Store(":memory:")
    store.save_profile(Profile(1, 1, "USD", 0, 2_000_000, "", True))
    listing = Listing(
        "mashina:1",
        "Kia K5",
        "https://mashina.kg/details/kia",
        1_000_000,
        None,
        availability="В наличии",
    )
    store.upsert_listings([listing])
    store.upsert_listings([replace(listing, price_usd_minor=1_100_000)])
    sent = []

    async def send(chat_id, replies):
        sent.extend(replies)

    assert asyncio.run(notify_once(store, UserLocks(), send)) == 1
    assert any("Kia K5" in reply.text for reply in sent)
    assert asyncio.run(notify_once(store, UserLocks(), send)) == 0
    store.close()


def test_failed_delivery_keeps_event_available_and_pause_stops_it():
    store = Store(":memory:")
    profile = store.save_profile(Profile(1, 1, "USD", 0, 2_000_000, "", True))
    store.upsert_listings(
        [
            Listing(
                "mashina:1",
                "Honda Fit",
                "https://mashina.kg/details/honda",
                800_000,
                None,
                availability="В наличии",
            )
        ]
    )

    async def unavailable(chat_id, replies):
        raise TelegramNetworkError(
            method=SendMessage(chat_id=chat_id, text="test"), message="connection unavailable"
        )

    assert asyncio.run(notify_once(store, UserLocks(), unavailable)) == 0
    assert store.get_profile(1).cursor == profile.cursor
    store.set_monitoring(1, False)

    async def send(chat_id, replies):
        pytest.fail("A paused profile must not receive notifications")

    assert asyncio.run(notify_once(store, UserLocks(), send)) == 0
    store.close()


@pytest.mark.parametrize(
    ("hour", "minute", "expected"), [(16, 59, False), (17, 0, True), (1, 59, True), (2, 0, False)]
)
def test_quiet_hours_cross_midnight_with_exact_bishkek_boundaries(hour, minute, expected):
    profile = Profile(1, 1, "USD", 0, 100, quiet_start_minute=23 * 60, quiet_end_minute=8 * 60)
    assert quiet_now(profile, datetime(2026, 9, 9, hour, minute, tzinfo=UTC)) is expected
