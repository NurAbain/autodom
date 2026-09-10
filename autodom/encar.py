"""Permission-gated Korean domestic-brand advertisements, not an export feed."""

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import aiohttp

from .models import Listing, SourcePage
from .proxy import ProxyRoute
from .source_http import SourceError, fetch_document, require_source_access

CATALOG_URL = "https://api.encar.com/search/car/list/general"
PAGE_SIZE = 20
SCOPE = "Корея: корейские марки; возможность экспорта не подтверждена"
_MAKES = {
    "현대": "Hyundai",
    "기아": "Kia",
    "제네시스": "Genesis",
    "KG모빌리티(쌍용)": "KG Mobility KGM SsangYong",
    "쉐보레(GM대우)": "Chevrolet GM Daewoo",
    "르노코리아(삼성)": "Renault Korea Renault Samsung",
}
# Exact observed variants: aliases supplement, never replace, Korean labels.
_MODELS = {
    "그랜저 IG": "Grandeur IG",
    "아반떼 AD": "Avante AD Elantra AD",
    "LF 쏘나타": "Sonata LF",
    "싼타페 DM": "Santa Fe DM",
    "싼타페 CM": "Santa Fe CM",
    "뉴 쏘렌토 R": "New Sorento R",
    "더 뉴 카니발": "The New Carnival",
    "올 뉴 카니발": "All New Carnival",
    "더 뉴 모하비": "The New Mohave",
    "더 뉴 레이": "The New Ray",
    "스파크": "Spark",
    "그랑 콜레오스": "Grand Koleos",
    "더 뉴 렉스턴 스포츠": "The New Rexton Sports",
    "그랜드 스타렉스": "Grand Starex",
    "K5 2세대": "K5 second generation",
}


def _integer(value: Any, *, scale: int = 1) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        return None
    try:
        number = Decimal(value) * scale
        if number.is_finite() and 0 <= number <= 2**63 - 1 and number == number.to_integral_value():
            return int(number)
    except InvalidOperation:
        pass
    return None


def _text(item: dict, key: str) -> str:
    value = item.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SourceError(f"Encar {key} schema changed")
    return value.strip()


def _photo_url(item: dict) -> str | None:
    photos = item.get("Photos")
    if not isinstance(photos, list):
        return None
    for photo in photos:
        path = photo.get("location") if isinstance(photo, dict) else None
        if isinstance(path, str) and re.fullmatch(r"/carpicture[\w/.-]+\.(?:jpg|jpeg|png)", path):
            if ".." not in path:
                return "https://ci.encar.com/carpicture" + path
    return None


def _listing(item: Any) -> Listing:
    if not isinstance(item, dict):
        raise SourceError("Encar listing schema changed")
    ad_id = item.get("Id")
    if not isinstance(ad_id, str) or not re.fullmatch(r"[0-9]+", ad_id):
        raise SourceError("Encar advertisement identity missing")
    make, model = _text(item, "Manufacturer"), _text(item, "Model")
    if not make or not model:
        raise SourceError("Encar vehicle title missing")
    badge, detail = _text(item, "Badge"), _text(item, "BadgeDetail")
    if detail == "(세부등급 없음)":
        detail = ""
    trim = " ".join(part for part in (badge, detail) if part)
    year = _integer(item.get("FormYear"))
    if year is not None and not 1800 <= year <= 2200:
        year = None
    month = _integer(item.get("Year"))
    registration = ""
    if month is not None and 1800 <= month // 100 <= 2200 and 1 <= month % 100 <= 12:
        registration = str(month)
    mileage = _integer(item.get("Mileage"))
    asking = _text(item, "SellType") == "일반"
    amount = _integer(item.get("Price"), scale=10000) if asking else None
    if amount == 0:
        amount = None
    aliases = [_MAKES.get(make, ""), _MODELS.get(model, "")]
    if make == "KG모빌리티(쌍용)" and model == "더 뉴 렉스턴 스포츠" and detail == "와일드":
        aliases.append("Wild")
    return Listing(
        id=f"encar:{ad_id}",
        title=" ".join(part for part in (make, model, trim) if part),
        url=f"https://fem.encar.com/cars/detail/{ad_id}",
        price_usd_minor=None,
        price_kgs_minor=None,
        year=year,
        registration_month=registration,
        mileage=f"{mileage} km" if mileage is not None else "",
        city=_text(item, "OfficeCityState"),
        availability="Опубликовано",
        photo_url=_photo_url(item),
        source="encar.com",
        market="KR",
        original_currency="KRW",
        original_price_minor=amount,
        trim=trim,
        price_kind="asking" if asking else "unknown",
        search_aliases=" ".join(alias for alias in aliases if alias),
        # Condition flags describe report availability, not accident outcomes.
        condition="",
    )


def parse_page(text: str, page: int = 1) -> SourcePage:
    if type(page) is not int or page < 1:
        raise SourceError("Catalog page must be a positive integer")
    try:
        data = json.loads(text, parse_float=Decimal, parse_constant=Decimal)
    except (ValueError, RecursionError) as error:
        raise SourceError("Malformed Encar catalog response") from error
    if not isinstance(data, dict) or type(data.get("Count")) is not int:
        raise SourceError("Encar count schema changed")
    total, items = data["Count"], data.get("SearchResults")
    if total < 0 or not isinstance(items, list) or len(items) > PAGE_SIZE:
        raise SourceError("Encar catalog pagination schema changed")
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    # Count and offset order are mutable. A removal at the tail can yield an
    # empty final page; an interior empty response cannot establish coverage.
    if not items and total and page < pages:
        raise SourceError("Unexpected empty Encar catalog interior page")
    if len(items) > total or (items and page > pages):
        raise SourceError("Encar catalog item count contradicts pagination")
    listings = [_listing(item) for item in items]
    # Service copies have separate advertisement IDs. Photo filenames are not
    # vehicle identity; only duplicate advertisement IDs can be merged here.
    listings = list({listing.id: listing for listing in listings}.values())
    return SourcePage(listings=listings, page=page, total=total, pages=pages, scope=SCOPE)


async def fetch_page(
    session: aiohttp.ClientSession, page: int = 1, *, proxies: tuple[ProxyRoute, ...]
) -> SourcePage:
    require_source_access("encar.com")
    if type(page) is not int or page < 1:
        raise SourceError("Catalog page must be a positive integer")
    return await fetch_document(
        session,
        CATALOG_URL,
        lambda text: parse_page(text, page),
        source="encar.com",
        proxies=proxies,
        page=page,
        params={
            "count": "true",
            "q": "(And.Hidden.N._.CarType.Y.)",
            "sr": f"|ModifiedDate|{(page - 1) * PAGE_SIZE}|{PAGE_SIZE}",
        },
    )
