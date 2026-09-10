import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from autodom.models import Listing
from autodom.rates import RateBook, parse_quote
from autodom.source_http import SourceError
from autodom.storage import Store


def instant(day):
    return datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=6))).timestamp()


def xml(currency, value, *, date="10.09.2026", nominal="1", valid="7"):
    validity = f"<ValidFor>{valid}</ValidFor>" if currency == "KRW" else ""
    return (
        f'<CurrencyRates Date="{date}"><Currency ISOCode="{currency}">'
        f"<Nominal>{nominal}</Nominal>{validity}<Value>{value}</Value>"
        "</Currency></CurrencyRates>"
    )


def car(currency="KRW", amount=1):
    return Listing(
        "encar:synthetic",
        "Synthetic",
        "https://example.invalid/vehicle",
        None,
        None,
        source="encar.com",
        market="KR",
        original_currency=currency,
        original_price_minor=amount,
    )


@pytest.fixture
def book(tmp_path, monkeypatch):
    monkeypatch.setattr("autodom.rates.time.time", lambda: instant("2026-09-10T12:00:00"))
    store = Store(tmp_path / "rates.sqlite3")
    yield RateBook(store, ())
    store.close()


def test_nominal_comma_decimals_and_half_up_without_double_rounding(book):
    book.quotes["USD"] = parse_quote(xml("USD", "2,0000"), "USD")
    book.quotes["KRW"] = parse_quote(xml("KRW", "0,2500", nominal="10"), "KRW")
    converted = book.convert(car())
    assert converted.original_price_minor == 1
    assert converted.price_kgs_minor == 3  # 2.5 cents, half-up
    assert converted.price_usd_minor == 1  # 1.25 cents, not 3 / 2
    assert converted.fx_date == "USD:2026-09-10;KRW:2026-09-10"
    assert converted.fx_expires_at == instant("2026-09-14")
    assert book.convert(car("USD", 1)).price_kgs_minor == 2


def test_missing_or_expired_quotes_clear_old_conversions_without_losing_native_usd(
    book, monkeypatch
):
    usd = replace(car("USD", 123), price_kgs_minor=999, fx_date="old", fx_expires_at=1)
    assert book.convert(usd).price_usd_minor == 123
    assert book.convert(usd).price_kgs_minor is None
    book.quotes["USD"] = parse_quote(xml("USD", "87,4500"), "USD")
    book.quotes["KRW"] = parse_quote(xml("KRW", "0,0647", date="05.09.2026"), "KRW")
    converted = book.convert(car(amount=18500000))
    assert converted.price_kgs_minor == 119695000
    assert converted.price_usd_minor == 1368725
    assert converted.fx_expires_at == instant("2026-09-12")
    monkeypatch.setattr("autodom.rates.time.time", lambda: instant("2026-09-12"))
    expired = book.convert(converted)
    assert expired.price_usd_minor is None and expired.price_kgs_minor is None
    assert expired.original_price_minor == 18500000
    assert expired.fx_date == "" and expired.fx_expires_at is None
    assert book.convert(usd).price_kgs_minor == 10756
    monkeypatch.setattr("autodom.rates.time.time", lambda: instant("2026-09-14"))
    assert book.convert(usd).price_kgs_minor is None
    assert book.convert(usd).price_usd_minor == 123


def test_valid_weekly_quote_does_not_require_daily_quote_for_som_conversion(book):
    book.quotes["KRW"] = parse_quote(xml("KRW", "0,0647"), "KRW")
    converted = book.convert(car(amount=1000))
    assert converted.price_kgs_minor == 6470
    assert converted.price_usd_minor is None
    assert converted.fx_date == "KRW:2026-09-10"
    assert converted.fx_expires_at == instant("2026-09-17")
    unverified = book.convert(replace(converted, price_kind="lease"))
    assert unverified.price_kgs_minor is None and unverified.price_usd_minor is None


@pytest.mark.parametrize(
    "payload",
    [
        xml("KRW", "NaN"),
        xml("KRW", "0,0647", nominal="0"),
        xml("KRW", "0,0647", valid="30"),
        xml("KRW", "0,0647", date="11.09.2026"),
        xml("KRW", "0,0647", date="03.09.2026"),
    ],
)
def test_invalid_future_and_expired_weekly_quotes_are_rejected(book, payload):
    with pytest.raises(SourceError):
        parse_quote(payload, "KRW")


def test_daily_window_accepts_weekend_but_expires_at_four_day_boundary(book):
    payload = xml("USD", "87,4500")
    assert parse_quote(payload, "USD", now=instant("2026-09-13T23:59:59")).value.is_finite()
    with pytest.raises(SourceError):
        parse_quote(payload, "USD", now=instant("2026-09-14"))
    with pytest.raises(SourceError):
        parse_quote(payload, "USD", now=instant("2026-09-09T23:59:59"))


def test_refresh_persists_exact_quotes_and_throttles_across_reopen(book, monkeypatch):
    async def fetch(session, url, parse, **kwargs):
        return parse(
            xml("USD", "87,45005", nominal="10")
            if "daily" in url
            else xml("KRW", "0,0647", date="05.09.2026")
        )

    monkeypatch.setattr("autodom.rates.fetch_document", fetch)
    asyncio.run(book.refresh(None))
    original = book.convert(car("USD", 10000000))
    assert original.price_kgs_minor == 87450050
    reloaded = RateBook(book.store, ())
    assert reloaded.convert(car("USD", 10000000)) == original

    async def forbidden(*args, **kwargs):
        raise AssertionError("Hourly throttle must survive RateBook reconstruction")

    monkeypatch.setattr("autodom.rates.fetch_document", forbidden)
    asyncio.run(reloaded.refresh(None))
    assert reloaded.convert(car(amount=18500000)) == book.convert(car(amount=18500000))


def test_weekly_failure_retains_cache_and_cannot_discard_new_daily_quote(book, monkeypatch):
    book.quotes["KRW"] = parse_quote(xml("KRW", "0,0647", date="05.09.2026"), "KRW")

    async def fetch(session, url, parse, **kwargs):
        if "weekly" in url:
            raise SourceError("Unavailable weekly feed")
        return parse(xml("USD", "87,4500"))

    monkeypatch.setattr("autodom.rates.fetch_document", fetch)
    asyncio.run(book.refresh(None))
    assert book.convert(car("USD", 100)).price_kgs_minor == 8745
    assert book.convert(car(amount=18500000)).price_usd_minor == 1368725
    assert RateBook(book.store, ()).convert(car("USD", 100)).price_kgs_minor == 8745
