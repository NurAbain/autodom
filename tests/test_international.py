import asyncio
from dataclasses import replace
from pathlib import Path

import pytest

from autodom import runtime
from autodom.config import Settings
from autodom.conversation import Conversation, listing_text
from autodom.matching import matches
from autodom.models import Listing, Profile, SourcePage
from autodom.runtime import UserLocks, notify_once, record_page, sync_pages
from autodom.source_http import SourceError, SourceRateLimited
from autodom.sources import Source, source_status
from autodom.storage import Store

NOW = 2_000_000_000.0


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setenv("AUTODOM_APPROVED_SOURCES", "mashina.kg,encar.com,truecar.com")
    monkeypatch.setattr("autodom.storage.time.time", lambda: NOW)
    store = Store(":memory:")
    yield store
    store.close()


def car(market, **changes):
    source, identity, url = {
        "KG": ("mashina.kg", "mashina:1", "https://mashina.kg/details/hyundai"),
        "KR": ("encar.com", "encar:1", "https://fem.encar.com/cars/detail/1"),
        "US": (
            "truecar.com",
            "truecar:1",
            "https://www.truecar.com/used-cars-for-sale/listing/example/",
        ),
    }[market]
    return replace(
        Listing(
            identity,
            "Hyundai example",
            url,
            100_000,
            8_745_000,
            availability="В наличии" if market == "KG" else "Опубликовано",
            source=source,
            market=market,
            original_currency="KRW" if market == "KR" else "USD" if market == "US" else "",
            original_price_minor=1_000_000
            if market == "KR"
            else 100_000
            if market == "US"
            else None,
            fx_expires_at=NOW + 3600,
        ),
        **changes,
    )


def test_unapproved_sources_are_hidden_even_from_saved_all_market_search(catalog, monkeypatch):
    profile = catalog.save_profile(Profile(1, 1, "USD", 0, 200_000, monitoring=True, market="ALL"))
    catalog.upsert_listings([car("KG"), car("KR"), car("US")])
    monkeypatch.delenv("AUTODOM_APPROVED_SOURCES")
    assert [item.id for item in catalog.search(profile)] == ["mashina:1"]
    assert catalog.count_matches(profile) == 1
    assert not matches(profile, car("KR")) and not matches(profile, car("US"))
    sent = []

    async def send(chat, replies):
        sent.extend(reply.text for reply in replies)

    assert asyncio.run(notify_once(catalog, UserLocks(), send)) == 1
    rendered = "\n".join(sent)
    assert car("KG").url in rendered
    assert car("KR").url not in rendered and car("US").url not in rendered


def test_market_choice_scopes_search_and_edit_invalidates_old_choice(catalog):
    catalog.upsert_listings([car("KG"), car("KR"), car("US")])
    conversation = Conversation(catalog)
    replies = conversation.handle(1, 1, "/start")
    consent = replies[0].buttons[0][0][1]
    markets = conversation.handle(1, 1, consent)
    market_button = next(
        data for reply in markets for row in reply.buttons for label, data in row if "Коре" in label
    )
    currencies = conversation.handle(1, 1, market_button)
    currency_button = next(
        data
        for reply in currencies
        for row in reply.buttons
        for label, data in row
        if "USD" in label
    )
    conversation.handle(1, 1, currency_button)
    conversation.handle(1, 1, "2000")
    review = conversation.handle(1, 1, "Hyundai")
    save_button = next(
        data
        for reply in review
        for row in reply.buttons
        for label, data in row
        if "Сохранить" in label
    )
    replies = conversation.handle(1, 1, save_button)
    profile = catalog.get_profile(1)
    assert profile.market == "KR"
    assert [item.id for item in catalog.search(profile)] == ["encar:1"]
    assert car("KR").url in "\n".join(reply.text for reply in replies)
    conversation.handle(1, 1, market_button)
    assert catalog.get_profile(1) == profile
    conversation.handle(1, 1, "/resume")
    conversation.handle(1, 1, "/edit")
    assert not catalog.get_profile(1).monitoring
    conversation.handle(1, 1, currency_button)
    assert catalog.get_draft(1)[0] == "market"
    conversation.handle(1, 1, "/cancel")
    assert catalog.get_profile(1).market == "KR"


def test_fx_moves_do_not_create_price_drops_or_lose_pending_new_cars(catalog):
    catalog.save_profile(Profile(1, 1, "USD", 0, 200_000, monitoring=True, market="KR"))
    korean = car("KR")
    catalog.upsert_listings([korean], observed_at=NOW - 10)
    assert (
        catalog.upsert_listings([replace(korean, price_usd_minor=110_000)], observed_at=NOW - 9)
        == 0
    )
    sent = []

    async def send(chat, replies):
        sent.extend(reply.text for reply in replies)

    locks = UserLocks()
    assert asyncio.run(notify_once(catalog, locks, send)) == 1
    assert "1 100 $" in "\n".join(sent)
    assert (
        catalog.upsert_listings([replace(korean, price_usd_minor=90_000)], observed_at=NOW - 8) == 0
    )
    assert asyncio.run(notify_once(catalog, locks, send)) == 0
    cheaper_native = replace(korean, original_price_minor=900_000, price_usd_minor=130_000)
    assert catalog.upsert_listings([cheaper_native], observed_at=NOW - 7) == 1
    assert asyncio.run(notify_once(catalog, locks, send)) == 1
    assert "900 000 KRW" in "\n".join(sent)
    assert asyncio.run(notify_once(catalog, locks, send)) == 0


def test_expired_fx_excludes_conversions_but_preserves_native_usd(catalog, monkeypatch):
    korean, american = car("KR", fx_expires_at=NOW + 1), car("US", fx_expires_at=NOW + 1)
    catalog.upsert_listings([korean, american])
    profile = Profile(1, 1, "USD", 0, 200_000, market="ALL")
    assert {item.id for item in catalog.search(profile)} == {korean.id, american.id}
    monkeypatch.setattr("autodom.storage.time.time", lambda: NOW + 1)
    assert [item.id for item in catalog.search(profile)] == [american.id]
    assert not matches(profile, korean) and matches(profile, american)
    assert catalog.search(replace(profile, currency="KGS", budget_max_minor=9_000_000)) == []
    assert "1 000 000 KRW" in listing_text(korean, "USD")
    assert "1 000 $" not in listing_text(korean, "USD")


def test_one_source_failure_keeps_other_source_progress_and_status(catalog, monkeypatch):
    catalog.set_meta("source:encar.com:crawl_next_page", "37")

    async def limited(session, page=1, *, proxies):
        raise SourceRateLimited(3600)

    async def available(session, page=1, *, proxies):
        return SourcePage([car("KG")], page, 1, 1)

    sources = (
        Source("encar.com", "Encar", "KR", (), limited),
        Source("mashina.kg", "Mashina.kg", "KG", (), available),
    )
    monkeypatch.setattr(runtime, "enabled_sources", lambda: sources)
    result = asyncio.run(sync_pages(catalog, 1, (), delay=0))
    assert result["listings"] == 1
    assert catalog.get_listing("mashina:1") is not None
    assert catalog.get_meta("source:mashina.kg:crawl_next_page") == "2"
    assert catalog.get_meta("source:encar.com:crawl_next_page") == "37"
    status = {item["source"]: item for item in source_status(catalog)}
    assert status["mashina.kg"]["last_sync"] and not status["mashina.kg"]["error"]
    assert status["encar.com"]["error"] == "SourceRateLimited"


def test_rate_limited_crawler_does_not_suspend_another_market(catalog, monkeypatch):
    async def exercise():
        observed = asyncio.Event()

        async def limited(session, page=1, *, proxies):
            raise SourceRateLimited(3600)

        async def available(session, page=1, *, proxies):
            observed.set()
            return SourcePage([car("KG")], page, 1, 1)

        sources = (
            Source("encar.com", "Encar", "KR", (), limited),
            Source("mashina.kg", "Mashina.kg", "KG", (), available),
        )
        monkeypatch.setattr(runtime, "enabled_sources", lambda: sources)
        task = asyncio.create_task(
            runtime.crawl(catalog, Settings(Path("unused"), crawl_delay=10), ())
        )
        try:
            await asyncio.wait_for(observed.wait(), timeout=1)
            assert catalog.get_listing("mashina:1") is not None
            assert catalog.get_meta("source:encar.com:source_error") == "SourceRateLimited"
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(exercise())


def test_changed_source_scope_cannot_commit_a_later_page(catalog):
    source = Source("truecar.com", "TrueCar", "US", (), None)
    record_page(catalog, source, SourcePage([car("US")], 1, 60, 2, "first-area"), NOW - 2)
    catalog.set_meta("source:truecar.com:crawl_next_page", "2")
    different_area = replace(car("US"), id="truecar:other")
    with pytest.raises(SourceError):
        record_page(catalog, source, SourcePage([different_area], 2, 60, 2, "other-area"), NOW - 1)
    assert catalog.get_listing(different_area.id) is None
    assert catalog.get_meta("source:truecar.com:crawl_next_page") == "1"
    assert catalog.get_meta("source:truecar.com:scope") == "first-area"
