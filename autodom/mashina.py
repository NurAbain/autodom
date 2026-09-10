"""Mashina's public catalog, transported as a React Flight stream."""

import json
from decimal import ROUND_HALF_UP, Decimal, DecimalException, InvalidOperation
from typing import Any
from urllib.parse import quote, urlsplit

import aiohttp

from .models import Listing, SourcePage
from .proxy import ProxyRoute
from .source_http import SourceError, fetch_document, require_source_access

CATALOG_URL = "https://mashina.kg/catalog/passenger"
_CATALOG_KEYS = {"items", "total", "page", "size", "pages"}
_ATTRIBUTE_SLUGS = {"year", "mileage", "gearbox", "body_type", "city"}


def _listing_shape(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and type(item.get("id")) is int
        and item["id"] > 0
        and all(
            isinstance(item.get(key), str) and item[key].strip()
            for key in ("slug", "title", "status")
        )
    )


def _catalogs(text: str) -> list[dict]:
    # Decode complete objects, then walk their children. Unlike bracket slicing,
    # JSON decoding preserves nested arrays and escaped seller-supplied strings.
    decoder = json.JSONDecoder(parse_float=Decimal, parse_constant=Decimal)
    catalogs = []
    position = 0
    while (start := text.find("{", position)) >= 0:
        try:
            value, position = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            position = start + 1
            continue
        pending = [value]
        while pending:
            node = pending.pop()
            if isinstance(node, dict):
                if (
                    _CATALOG_KEYS <= node.keys()
                    and isinstance(node["items"], list)
                    and all(_listing_shape(item) for item in node["items"])
                ):
                    catalogs.append(node)
                else:
                    pending.extend(node.values())
            elif isinstance(node, list):
                pending.extend(node)
    return catalogs


def _minor_units(amount: Any) -> int | None:
    if isinstance(amount, bool) or not isinstance(amount, (str, int, Decimal)):
        return None
    try:
        value = Decimal(amount)
        if not value.is_finite() or value <= 0:
            return None
        minor = (value * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        # Persistent prices use SQLite's signed 64-bit INTEGER representation.
        return int(minor) if 0 < minor <= 2**63 - 1 else None
    except (DecimalException, ValueError, OverflowError):
        return None


def _attribute_text(attribute: dict) -> str:
    text = attribute.get("value_text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    value = attribute.get("value_json")
    if isinstance(value, dict):
        name = value.get("name")
        if isinstance(name, str):
            return name.strip()
        # Preserve explicitly supplied mileage units; never assume km.
        number, suffix = value.get("value"), value.get("suffix")
        if isinstance(number, (str, int, Decimal)) and isinstance(suffix, str):
            return f"{number} {suffix}".strip()
    elif isinstance(value, str):
        return value.strip()
    return ""


def _photo_url(images: Any) -> str | None:
    if not isinstance(images, list) or not images or not isinstance(images[0], dict):
        return None
    for key in ("medium", "thumb"):
        value = images[0].get(key)
        if isinstance(value, str):
            try:
                url = urlsplit(value)
            except ValueError:
                continue
            if url.scheme == "https" and url.hostname and not url.username:
                return value
    return None


def _listing(item: dict) -> Listing:
    prices = item.get("prices")
    attributes = item.get("attributes")
    if prices is None:
        prices = []
    if attributes is None:
        attributes = []
    if not isinstance(prices, list) or not all(isinstance(p, dict) for p in prices):
        raise SourceError("Mashina catalog price schema changed")
    if not isinstance(attributes, list) or not all(isinstance(a, dict) for a in attributes):
        raise SourceError("Mashina catalog attribute schema changed")
    amounts = {"USD": None, "KGS": None}
    for price in prices:
        currency = price.get("currency")
        if isinstance(currency, str) and currency in amounts:
            amounts[currency] = _minor_units(price.get("amount"))
    attrs = {
        attr["slug"]: attr
        for attr in attributes
        if isinstance(attr.get("slug"), str) and attr["slug"] in _ATTRIBUTE_SLUGS
    }
    year_attr = attrs.get("year", {})
    year_value = year_attr.get("value_number")
    if year_value is None:
        year_value = _attribute_text(year_attr)
    year = None
    if not isinstance(year_value, bool):
        try:
            numeric_year = Decimal(str(year_value))
            if (
                numeric_year.is_finite()
                and numeric_year == numeric_year.to_integral_value()
                and 1800 <= numeric_year <= 2200
            ):
                year = int(numeric_year)
        except InvalidOperation:
            pass
    availability = item.get("availability")
    if availability is not None and not isinstance(availability, str):
        raise SourceError("Mashina catalog availability schema changed")
    if item["status"] != "active":
        availability = "Неактивно"
    published_at = item.get("created_at")
    if published_at is not None and not isinstance(published_at, str):
        raise SourceError("Mashina catalog publication date schema changed")
    return Listing(
        id=f"mashina:{item['id']}",
        title=item["title"].strip(),
        url=f"https://mashina.kg/details/{quote(item['slug'], safe='-._~')}",
        price_usd_minor=amounts["USD"],
        price_kgs_minor=amounts["KGS"],
        year=year,
        mileage=_attribute_text(attrs.get("mileage", {})),
        transmission=_attribute_text(attrs.get("gearbox", {})),
        body_type=_attribute_text(attrs.get("body_type", {})),
        city=_attribute_text(attrs.get("city", {})),
        availability=availability.strip() if availability else "",
        published_at=published_at or "",
        photo_url=_photo_url(item.get("images")),
    )


def parse_page(text: str, page: int = 1) -> SourcePage:
    if type(page) is not int or page < 1:
        raise SourceError("Catalog page must be a positive integer")
    try:
        catalogs = _catalogs(text)
    except (RecursionError, ValueError) as exc:
        raise SourceError("Malformed Mashina catalog response") from exc
    if len(catalogs) != 1:
        raise SourceError("Expected exactly one Mashina catalog with listing-shaped items")
    catalog = catalogs[0]
    if any(type(catalog[key]) is not int for key in ("page", "pages", "size", "total")):
        raise SourceError("Mashina catalog pagination schema changed")
    if catalog["page"] != page:
        raise SourceError(f"Mashina returned page {catalog['page']} instead of {page}")
    total, pages, size = catalog["total"], catalog["pages"], catalog["size"]
    if total < 0 or pages < 0 or size <= 0 or (total > 0 and pages == 0):
        raise SourceError("Invalid Mashina catalog pagination")
    items = catalog["items"]
    if len(items) > size or len(items) > total:
        raise SourceError("Mashina catalog item count contradicts pagination")
    # A final/out-of-range page may legitimately be empty after concurrent
    # removals. An empty interior page would hide an upstream schema problem.
    if not items and total > 0 and page < pages:
        raise SourceError("Unexpected empty Mashina catalog interior page")
    if items and page > pages:
        raise SourceError("Mashina returned listings beyond the final page")
    listings = [_listing(item) for item in items]
    if len({listing.id for listing in listings}) != len(listings):
        raise SourceError("Mashina catalog contains duplicate listing IDs")
    return SourcePage(listings=listings, page=page, total=total, pages=pages)


async def fetch_page(
    session: aiohttp.ClientSession, page: int = 1, *, proxies: tuple[ProxyRoute, ...]
) -> SourcePage:
    require_source_access("mashina.kg")
    return await fetch_document(
        session,
        CATALOG_URL,
        lambda text: parse_page(text, page),
        source="mashina.kg",
        proxies=proxies,
        page=page,
        params={"page": page},
        headers={"RSC": "1", "Accept": "text/x-component"},
    )
