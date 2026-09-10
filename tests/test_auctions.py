import asyncio
import json
import sqlite3
from dataclasses import asdict, replace

import pytest

from autodom.matching import matches
from autodom.models import Listing, ListingEvent, Profile
from autodom.runtime import UserLocks, notify_once
from autodom.storage import Store

NOW = 2_000_000_000.0


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setenv("AUTODOM_APPROVED_SOURCES", "mashina.kg,bid.cars,truecar.com")
    monkeypatch.setattr("autodom.storage.time.time", lambda: NOW)
    store = Store(":memory:")
    yield store
    store.close()


def lot(**changes):
    return replace(
        Listing(
            "bidcars:1-66587646",
            "2025 Alfa Romeo Stelvio",
            "https://bid.cars/en/lot/1-66587646/",
            3_850_000,
            None,
            source="bid.cars",
            market="US",
            availability="Опубликовано",
            original_currency="USD",
            original_price_minor=3_850_000,
            price_kind="buy_now",
            auction_house="Copart",
            auction_lot="1-66587646",
            auction_status="active",
            auction_at=NOW + 3600,
            current_bid_minor=45_000,
            buy_now_minor=3_850_000,
            vin="ZASPAKAN1S7D12345",
            sale_document="Salvage",
            primary_damage="Front End",
            secondary_damage="Side",
            start_code="Run and Drive",
        ),
        **changes,
    )


def bid_only(**changes):
    return replace(
        lot(
            price_kind="auction",
            original_price_minor=None,
            price_usd_minor=None,
            buy_now_minor=None,
        ),
        **changes,
    )


def profile(**changes):
    return replace(Profile(1, 1, "USD", 0, 4_000_000, market="US", monitoring=True), **changes)


def notifications(store):
    sent = []

    async def send(chat_id, replies):
        sent.extend(reply.text for reply in replies)

    delivered = asyncio.run(notify_once(store, UserLocks(), send))
    return delivered, "\n".join(sent)


def test_current_bid_is_never_a_budget_purchase_price(catalog):
    cheap = profile(budget_max_minor=100_000)
    for listing in (lot(), bid_only()):
        catalog.upsert_listings([listing], observed_at=NOW + (listing.price_kind == "auction"))
        assert not matches(cheap, listing)
        assert catalog.search(cheap) == []
        assert catalog.count_matches(cheap) == 0
    assert catalog.get_listing(lot().id).current_bid_minor == 45_000


@pytest.mark.parametrize(
    "changes",
    [
        {"auction_status": "ended"},
        {"auction_status": "unknown"},
        {"auction_status": ""},
        {"auction_at": None},
        {"auction_at": NOW},
    ],
)
def test_unavailable_auction_cannot_supply_price_even_with_cached_buy_now(catalog, changes):
    listing = lot(**changes)
    catalog.upsert_listings([listing])
    assert listing.price("USD") is None
    assert not matches(profile(), listing)
    assert catalog.search(profile()) == []
    assert catalog.count_matches(profile()) == 0


def test_cached_buy_now_expires_in_search_matches_and_pending_notifications(catalog, monkeypatch):
    catalog.save_profile(profile())
    listing = lot(auction_at=NOW + 1)
    catalog.upsert_listings([listing])
    assert catalog.count_matches(profile()) == 1
    assert matches(profile(), listing)
    monkeypatch.setattr("autodom.storage.time.time", lambda: NOW + 1)
    assert listing.price("USD") is None
    assert catalog.search(profile()) == []
    assert catalog.count_matches(profile()) == 0
    assert not matches(profile(), listing)
    assert notifications(catalog)[0] == 0
    event = ListingEvent(
        1,
        listing,
        "price_change",
        previous_original_price_minor=4_000_000,
        previous_original_currency="USD",
    )
    assert not event.is_price_drop("USD")


def test_ended_update_cancels_queued_new_notification_and_preserves_result(catalog):
    catalog.save_profile(profile())
    catalog.upsert_listings([lot()])
    ended = lot(auction_status="ended", availability="Завершено", final_bid_minor=2_800_000)
    catalog.upsert_listings([ended], observed_at=NOW + 1)
    assert notifications(catalog)[0] == 0
    saved = catalog.get_listing(ended.id)
    assert saved.final_bid_minor == 2_800_000
    assert saved.buy_now_minor == 3_850_000
    assert catalog.count_matches(profile()) == 0


def test_bid_and_estimate_changes_do_not_notify(catalog):
    catalog.upsert_listings([bid_only()])
    catalog.save_profile(profile())
    assert (
        catalog.upsert_listings(
            [
                bid_only(
                    current_bid_minor=50_000,
                    estimated_min_minor=2_000_000,
                    estimated_max_minor=3_000_000,
                )
            ],
            observed_at=NOW + 1,
        )
        == 0
    )
    assert notifications(catalog)[0] == 0


def test_first_buy_now_is_new_match_then_real_reduction_is_price_drop(catalog):
    catalog.upsert_listings([bid_only()])
    catalog.save_profile(profile())
    assert catalog.upsert_listings([lot()], observed_at=NOW + 1) == 1
    delivered, text = notifications(catalog)
    assert delivered == 1
    assert "Новое совпадение" in text and "Цена на сайте снизилась" not in text
    assert (
        catalog.upsert_listings(
            [lot(current_bid_minor=90_000, estimated_max_minor=5_000_000)], observed_at=NOW + 2
        )
        == 0
    )
    assert notifications(catalog)[0] == 0
    lowered = lot(
        buy_now_minor=3_500_000, original_price_minor=3_500_000, price_usd_minor=3_500_000
    )
    assert catalog.upsert_listings([lowered], observed_at=NOW + 3) == 1
    delivered, text = notifications(catalog)
    assert delivered == 1
    assert "Цена на сайте снизилась" in text


@pytest.mark.parametrize(
    "changes",
    [
        {"price_kind": "asking"},
        {"original_currency": "KRW", "fx_expires_at": NOW + 3600},
    ],
)
def test_monitor_never_compares_purchase_prices_across_kinds_or_currencies(catalog, changes):
    catalog.upsert_listings([lot()])
    catalog.save_profile(profile())
    changed = lot(original_price_minor=3_000_000, price_usd_minor=3_000_000, **changes)
    catalog.upsert_listings([changed], observed_at=NOW + 1)
    assert notifications(catalog)[0] == 0


def test_new_offer_resets_pending_old_price_drop_comparison(catalog):
    catalog.upsert_listings([lot()])
    catalog.save_profile(profile())
    catalog.upsert_listings(
        [lot(original_price_minor=3_500_000, price_usd_minor=3_500_000, buy_now_minor=3_500_000)],
        observed_at=NOW + 1,
    )
    catalog.upsert_listings([bid_only()], observed_at=NOW + 2)
    catalog.upsert_listings([lot()], observed_at=NOW + 3)
    delivered, text = notifications(catalog)
    assert delivered == 1
    assert "Новое совпадение" in text and "Цена на сайте снизилась" not in text


def test_schema4_migration_preserves_saved_preferences_cursor_events_and_old_json(
    tmp_path, monkeypatch
):
    monkeypatch.setattr("autodom.storage.time.time", lambda: NOW)
    path = tmp_path / "schema4.sqlite3"
    store = Store(path)
    retail = Listing(
        "mashina:old",
        "Toyota",
        "https://mashina.kg/details/old",
        100_000,
        8_700_000,
        availability="В наличии",
    )
    store.upsert_listings([retail])
    saved = store.save_profile(
        Profile(
            1,
            10,
            "USD",
            0,
            200_000,
            monitoring=True,
            city="Бишкек",
            body_type="sedan",
            year_min=2010,
            mileage_max_km=100_000,
            transmission="automatic",
            use_case="family",
            allow_import=False,
            quiet_start_minute=1380,
            quiet_end_minute=420,
        )
    )
    store.set_meta("source:mashina.kg:crawl_next_page", "37")
    store.close()
    old_fields = {
        key: value
        for key, value in asdict(retail).items()
        if key
        not in {
            "vin",
            "auction_house",
            "auction_lot",
            "auction_status",
            "auction_at",
            "current_bid_minor",
            "buy_now_minor",
            "final_bid_minor",
            "estimated_min_minor",
            "estimated_max_minor",
            "sale_document",
            "primary_damage",
            "secondary_damage",
            "start_code",
        }
    }
    with sqlite3.connect(path) as legacy:
        legacy.execute("DROP INDEX listings_auction")
        legacy.execute("ALTER TABLE listings DROP COLUMN auction_status")
        legacy.execute("ALTER TABLE listings DROP COLUMN auction_at")
        legacy.execute("UPDATE listings SET data = ?", (json.dumps(old_fields),))
        legacy.execute("UPDATE events SET data = ?", (json.dumps(old_fields),))
        legacy.execute("PRAGMA user_version = 4")
    migrated = Store(path)
    try:
        assert migrated.get_profile(1) == saved
        assert migrated.get_meta("source:mashina.kg:crawl_next_page") == "37"
        restored = migrated.get_listing(retail.id)
        assert restored.price("USD") == 100_000
        assert restored.auction_status == "" and restored.auction_at is None
        assert migrated.events_after(0)[0].listing.id == retail.id
        assert migrated.search(Profile(2, 2, "USD", 0, 200_000))[0].id == retail.id
        assert (
            migrated.upsert_listings([replace(retail, price_usd_minor=90_000)], observed_at=NOW + 1)
            == 1
        )
    finally:
        migrated.close()
