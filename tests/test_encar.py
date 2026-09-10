import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from autodom.encar import fetch_page, parse_page
from autodom.source_http import SourceError


def ad(**changes):
    value = {
        "Id": "100",
        "Manufacturer": "현대",
        "Model": "그랜저 IG",
        "Badge": "2.4 프리미엄",
        "BadgeDetail": "(세부등급 없음)",
        "FormYear": "2018",
        "Year": 201704,
        "Mileage": 12345,
        "Price": "1850.125",
        "SellType": "일반",
        "OfficeCityState": "서울",
    }
    value.update(changes)
    return value


def document(items, total=None):
    return json.dumps({"Count": len(items) if total is None else total, "SearchResults": items})


def test_native_won_model_year_and_registration_are_not_conflated():
    listing = parse_page(document([ad()])).listings[0]
    assert listing.original_currency == "KRW"
    assert listing.original_price_minor == 18501250
    assert listing.price_usd_minor is None and listing.price_kgs_minor is None
    assert listing.year == 2018
    assert listing.registration_month == "201704"
    assert listing.title == "현대 그랜저 IG 2.4 프리미엄"
    assert listing.trim == "2.4 프리미엄"
    assert "Grandeur IG" in listing.search_aliases
    assert listing.mileage == "12345 km"


def test_report_presence_does_not_claim_clean_history_or_physical_identity():
    first = ad(
        Condition=["Inspection", "Record", "Resume"],
        ServiceCopyCar="DUPLICATION",
        Photos=[{"location": "/carpicture00/pic0000/900_001.jpg"}],
    )
    page = parse_page(document([first, {**first, "Id": "101"}, first]))
    assert [listing.id for listing in page.listings] == ["encar:100", "encar:101"]
    assert all(listing.condition == "" for listing in page.listings)
    assert all(listing.availability == "Опубликовано" for listing in page.listings)
    assert page.listings[0].url.endswith("/100")
    assert (
        page.listings[0].photo_url
        == "https://ci.encar.com/carpicture/carpicture00/pic0000/900_001.jpg"
    )
    assert parse_page(document([ad()])).listings[0].condition == ""


def test_sports_variant_survives_lookup_aliases_and_unknown_trim():
    listing = parse_page(
        document(
            [
                ad(
                    Manufacturer="KG모빌리티(쌍용)",
                    Model="더 뉴 렉스턴 스포츠",
                    Badge="디젤 2.2 4WD",
                    BadgeDetail="와일드",
                )
            ]
        )
    ).listings[0]
    assert listing.title.endswith("더 뉴 렉스턴 스포츠 디젤 2.2 4WD 와일드")
    assert "Rexton Sports" in listing.search_aliases
    assert "Wild" in listing.search_aliases


@pytest.mark.parametrize("sale_type", ["리스", "렌트", "", None, "unverified"])
def test_nonordinary_sale_cannot_supply_a_purchase_price(sale_type):
    listing = parse_page(document([ad(SellType=sale_type)])).listings[0]
    assert listing.price_kind != "asking"
    assert listing.original_price_minor is None
    assert listing.price_usd_minor is None and listing.price_kgs_minor is None


@pytest.mark.parametrize("price", [0, -1, True, "NaN", "Infinity", "0.00001", None])
def test_invalid_or_fractional_won_amount_remains_unknown(price):
    assert parse_page(document([ad(Price=price)])).listings[0].original_price_minor is None


def test_pagination_distinguishes_tail_removals_from_lost_interior_pages():
    assert parse_page(document([ad()], total=41), page=3).pages == 3
    assert parse_page(document([], total=40), page=3).listings == []
    with pytest.raises(SourceError):
        parse_page(document([], total=41), page=1)
    with pytest.raises(SourceError):
        parse_page(document([ad()], total=0))
    with pytest.raises(SourceError):
        parse_page('{"Count": 20, "SearchResults": {}}')


def test_disabled_source_makes_no_inventory_request(monkeypatch):
    monkeypatch.delenv("AUTODOM_APPROVED_SOURCES", raising=False)
    session = AsyncMock()
    with pytest.raises(SourceError):
        asyncio.run(fetch_page(session, proxies=()))
    session.request.assert_not_called()
