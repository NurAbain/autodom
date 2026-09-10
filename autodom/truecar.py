"""Permission-gated TrueCar retail search; parse captured HTML without network access."""

import base64
import json
import os
import re
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlsplit, urlunsplit

import aiohttp

from .models import Listing, SourcePage
from .proxy import ProxyRoute
from .source_http import SourceError, fetch_document, require_source_access

SEARCH_URL = "https://www.truecar.com/used-cars-for-sale/listings/toyota/camry/"
_SOURCE = "truecar.com"
_SEARCH_PREFIX = "marketplaceListingSearch("
_VIN = re.compile(r"[A-HJ-NPR-Z0-9]{17}")


class _Scripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.next_data: list[str] = []
        self.linked_data: list[str] = []
        self.target: list[str] | None = None
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "script":
            return
        attributes = dict(attrs)
        if attributes.get("id") == "__NEXT_DATA__":
            self.target = self.next_data
        elif attributes.get("type") == "application/ld+json":
            self.target = self.linked_data
        else:
            self.target = None
        self.parts = []

    def handle_data(self, data: str) -> None:
        if self.target is not None:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.target is not None:
            self.target.append("".join(self.parts))
            self.target = None
            self.parts = []


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SourceError(f"TrueCar: {message}")


def _integer(value: object, minimum: int = 0) -> int:
    _require(type(value) is int and value >= minimum, "invalid integer field")
    return value


def _text(value: object) -> str:
    _require(isinstance(value, str) and bool(value.strip()), "missing text field")
    return value.strip()


def _money(value: object) -> int:
    _require(
        isinstance(value, (str, int, Decimal)) and not isinstance(value, bool),
        "missing asking price",
    )
    amount = Decimal(value)
    _require(amount.is_finite() and 0 < amount < 10**12, "invalid asking price")
    cents = amount * 100
    _require(cents == cents.to_integral_value(), "fractional price cents")
    return int(cents)


def _https_url(value: object, host: str) -> str:
    url = _text(value)
    parsed = urlsplit(url)
    _require(
        parsed.scheme == "https"
        and parsed.netloc == host
        and not parsed.fragment
        and not re.search(r"[\s\\]", url),
        "invalid source URL",
    )
    return url


def _cursor(value: object) -> int:
    value = _text(value)
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), validate=True).decode("ascii")
    _require(decoded.isdecimal(), "invalid pagination cursor")
    return int(decoded)


def _history(row: dict, vehicle: dict) -> str:
    facts = ["TrueCar: USED (подержанный автомобиль)"]
    certified = vehicle.get("certifiedPreOwned")
    if certified is not None:
        _require(type(certified) is bool, "invalid certification flag")
        if certified:
            facts.append("TrueCar сообщает: certified pre-owned")
    history = row.get("conditionHistory")
    _require(history is None or isinstance(history, dict), "invalid condition history")
    history = history or {}
    for key, label in (
        ("accidentCount", "зарегистрированных ДТП"),
        ("ownerCount", "зарегистрированных владельцев"),
    ):
        value = history.get(key)
        if value is None:
            facts.append(f"TrueCar: {label} — неизвестно")
        else:
            count = _integer(value)
            suffix = (
                " (исходное значение, история не подтверждена)"
                if key == "ownerCount" and count == 0
                else ""
            )
            facts.append(f"TrueCar сообщает: {label} — {count}{suffix}")
    title = history.get("isCleanTitle")
    _require(title is None or type(title) is bool, "invalid title history")
    facts.append(
        "TrueCar: статус title — неизвестно"
        if title is None
        else f"TrueCar сообщает: clean title — {'да' if title else 'нет'}"
    )
    facts.append("TrueCar: advertised asking price; NO_EXCLUSION; не итоговая стоимость")
    return "; ".join(facts)


def _listing(row: dict, linked: dict, filters: dict) -> Listing:
    _require(row["__typename"] == "ConsumerSummaryListing", "unexpected listing entity")
    vehicle = row["vehicle"]
    vin = _text(vehicle["vin"])
    _require(_VIN.fullmatch(vin) is not None, "invalid VIN")
    _require(
        vehicle["condition"] == "USED"
        and linked["itemCondition"] in ("UsedCondition", "https://schema.org/UsedCondition"),
        "not a used retail listing",
    )
    pricing = row["pricing"]
    _require(
        pricing["exclusion"] == "NO_EXCLUSION"
        and pricing.get("discountLabel") in (None, "UPFRONT_PRICE"),
        "unsupported price qualification",
    )
    price = _money(pricing["listPrice"])
    offer = linked["offers"]
    _require(
        offer["@type"] == "Offer"
        and offer["priceCurrency"] == "USD"
        and offer.get("sku") == vin
        and _money(offer["price"]) == price,
        "inconsistent USD asking price",
    )
    _require(
        not any(key in offer for key in ("leaseLength", "priceSpecification")),
        "unsupported offer price type",
    )
    _require(
        offer.get("businessFunction") in (None, "Sell", "http://purl.org/goodrelations/v1#Sell"),
        "offer is not a retail purchase",
    )
    url = _https_url(offer["url"], "www.truecar.com")
    _require(
        url == f"https://www.truecar.com/used-cars-for-sale/listing/{vin}/",
        "noncanonical vehicle URL",
    )
    make, model = vehicle["make"], vehicle["model"]
    selected = filters.get("makeModelTrim", [])
    _require(
        not selected
        or any(
            all(
                choice.get(key) is None or choice[key] == actual
                for key, actual in (("makeSlug", make["slug"]), ("modelSlug", model["slug"]))
            )
            for choice in selected
        ),
        "listing outside requested make/model",
    )
    year = _integer(vehicle["year"], 1886)
    _require(year < 2200 and str(year) == linked["vehicleModelDate"], "inconsistent model year")
    trim = _text(vehicle["style"]["trimName"])
    _require(
        linked["brand"]["name"] == make["name"]
        and linked["model"] == model["name"]
        and linked["vehicleConfiguration"] == trim,
        "inconsistent vehicle identity",
    )
    miles = _integer(vehicle["mileage"])
    details = vehicle["details"]
    _require(
        details["vin"] == vin
        and details["mileage"] == miles
        and linked["mileageFromOdometer"]["value"] == miles,
        "inconsistent mileage or VIN",
    )
    unit = linked["mileageFromOdometer"].get("unitCode")
    _require(
        unit in (None, "SMI")
        and linked["mileageFromOdometer"].get("unitText") in (None, "mi", "miles"),
        "unsupported odometer units",
    )
    photo = linked.get("image")
    if photo:
        if urlsplit(_text(photo)).hostname == "static.tcimg.net":
            illustration = _https_url(photo, "static.tcimg.net")
            _require(
                urlsplit(illustration).path.startswith("/vehicles/primary/"),
                "unsupported model illustration URL",
            )
            # A generic model illustration is not a photograph of this advertisement.
            photo = None
        else:
            photo = _https_url(photo, "listings-prod.tcimg.net")
    else:
        photo = None
    return Listing(
        id=f"truecar:{vin}",
        title=f"{year} {_text(make['name'])} {_text(model['name'])} {trim}",
        url=url,
        price_usd_minor=price,
        price_kgs_minor=None,
        year=year,
        mileage=f"{miles} miles",
        transmission=_text(vehicle["transmission"]),
        body_type=_text(vehicle["bodyStyle"]),
        city=f"{_text(details['dealerCity'])}, {_text(details['dealerState'])}",
        availability="Опубликовано",
        published_at=details.get("listedAt") or "",
        photo_url=photo,
        source=_SOURCE,
        market="US",
        original_currency="USD",
        original_price_minor=price,
        trim=trim,
        condition=_history(row, vehicle),
        search_aliases=f"{make['name']} {model['name']} {trim}",
        price_kind="asking",
    )


def _parse_page(
    text: str,
    page: int,
    *,
    expected_path: list[str] | None = None,
    expected_query: dict[str, str] | None = None,
) -> SourcePage:
    try:
        _integer(page, 1)
        scripts = _Scripts()
        scripts.feed(text)
        scripts.close()
        _require(
            len(scripts.next_data) == 1, "missing or ambiguous Next.js data; possible challenge"
        )
        data = json.loads(scripts.next_data[0], parse_float=Decimal)
        _require(data.get("isFallback") is False, "Next.js fallback document")
        query = data["query"]
        _require(
            query.get("condition") == "used" and str(query.get("page", "1")) == str(page),
            "returned search page does not match request",
        )
        path = query.get("splat", [])
        _require(
            isinstance(path, list) and all(isinstance(part, str) for part in path),
            "invalid search route",
        )
        if expected_path is not None:
            _require(path == expected_path, "returned search route does not match request")
        for key, value in (expected_query or {}).items():
            _require(str(query.get(key)) == value, "returned query does not match request")
        state = data["props"]["pageProps"]["__APOLLO_STATE__"]
        matches = []
        for key, connection in state["ROOT_QUERY"].items():
            if not key.startswith(_SEARCH_PREFIX) or not key.endswith(")"):
                continue
            args = json.loads(key[len(_SEARCH_PREFIX) : -1])
            if args.get("sponsored") is True:
                continue
            size = _integer(args["first"], 1)
            offset = _integer(args["offset"])
            filters = args["filters"]
            if offset != (page - 1) * size or filters.get("condition") != "USED":
                continue
            selected = filters.get("makeModelTrim", [])
            if path and (
                len(selected) != 1
                or selected[0].get("makeSlug") != path[0]
                or len(path) > 1
                and selected[0].get("modelSlug") != path[1]
            ):
                continue
            matches.append((args, connection))
        _require(len(matches) == 1, "missing or ambiguous requested search connection")
        args, connection = matches[0]
        _require(
            connection["__typename"] == "MarketplaceSearchConnection"
            and connection["isFallback"] is False,
            "fallback search results",
        )
        total = _integer(connection["totalCount"])
        size, offset = args["first"], args["offset"]
        pages = (total + size - 1) // size
        _require(page <= max(1, pages), "page outside result count")
        edges, info = connection["edges"], connection["pageInfo"]
        _require(
            isinstance(edges, list) and len(edges) == min(size, max(0, total - offset)),
            "incomplete search page",
        )
        _require(
            type(info["hasNextPage"]) is bool
            and info["hasNextPage"] == (offset + len(edges) < total),
            "inconsistent next page",
        )
        if edges:
            _require(_cursor(info["endCursor"]) == offset + len(edges), "inconsistent end cursor")
        else:
            _require(info.get("endCursor") in (None, ""), "unexpected empty-page cursor")
        filters = args["filters"]
        radius = filters["withinRadius"]
        _integer(radius["distance"], 1)
        _require(
            re.fullmatch(r"\d{5}", radius["postalCode"]) is not None, "missing search postal code"
        )
        _require(isinstance(args["sort"], str), "missing search sort")
        for parameter, actual in (
            ("zip", radius["postalCode"]),
            ("searchRadius", radius["distance"]),
        ):
            if parameter in (expected_query or {}):
                _require(
                    expected_query[parameter] == str(actual), "returned location scope differs"
                )
        linked = {}
        for raw in scripts.linked_data:
            document = json.loads(raw, parse_float=Decimal)
            graph = document.get("@graph", [document])
            for item in graph:
                if item.get("@type") != "CollectionPage":
                    continue
                for element in item["mainEntity"]["itemListElement"]:
                    vehicle = element["item"]
                    _require(vehicle["@type"] == "Vehicle", "invalid JSON-LD inventory")
                    vin = vehicle["vehicleIdentificationNumber"]
                    _require(vin not in linked, "duplicate JSON-LD vehicle")
                    linked[vin] = vehicle
        listings = []
        seen = set()
        for position, edge in enumerate(edges, start=offset + 1):
            _require(_cursor(edge["cursor"]) == position, "inconsistent edge cursor")
            row = state[edge["node"]["__ref"]]
            vin = row["vehicle"]["vin"]
            _require(vin not in seen, "duplicate vehicle within search page")
            seen.add(vin)
            listings.append(_listing(row, linked[vin], filters))
        scope = (
            _SOURCE
            + ":"
            + json.dumps(
                {"filters": filters, "sort": args["sort"]}, sort_keys=True, separators=(",", ":")
            )
        )
        return SourcePage(listings=listings, page=page, total=total, pages=pages, scope=scope)
    except SourceError:
        raise
    except (
        KeyError,
        TypeError,
        ValueError,
        AttributeError,
        InvalidOperation,
        OverflowError,
        RecursionError,
    ) as error:
        raise SourceError("TrueCar: invalid structured retail search document") from error


def parse_page(text: str, page: int = 1) -> SourcePage:
    """Parse only connected inventory; retain the executed geographic search scope."""
    return _parse_page(text, page)


async def fetch_page(
    session: aiohttp.ClientSession, page: int = 1, *, proxies: tuple[ProxyRoute, ...]
) -> SourcePage:
    require_source_access(_SOURCE)
    _integer(page, 1)
    try:
        url = _https_url(
            os.environ.get("AUTODOM_TRUECAR_SEARCH_URL", SEARCH_URL), "www.truecar.com"
        )
        parsed = urlsplit(url)
        _require(
            re.fullmatch(
                r"/used-cars-for-sale/listings/(?:[a-z0-9]+(?:-[a-z0-9]+)*/)*", parsed.path
            )
            is not None,
            "invalid canonical search path",
        )
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        params = dict(pairs)
        _require(len(params) == len(pairs), "duplicate search parameters")
        _require(
            all(key in {"page", "zip", "searchRadius"} for key in params),
            "unsupported search parameters",
        )
        if "zip" in params:
            _require(re.fullmatch(r"\d{5}", params["zip"]) is not None, "invalid postal code")
        if "searchRadius" in params:
            _require(
                params["searchRadius"].isdecimal() and int(params["searchRadius"]) > 0,
                "invalid search radius",
            )
        params["page"] = str(page)
        expected_path = parsed.path.removeprefix("/used-cars-for-sale/listings/").strip("/")
        path = expected_path.split("/") if expected_path else []
        request_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except (ValueError, TypeError) as error:
        raise SourceError("TrueCar: invalid configured search URL") from error
    return await fetch_document(
        session,
        request_url,
        lambda text: _parse_page(text, page, expected_path=path, expected_query=params),
        source=_SOURCE,
        proxies=proxies,
        page=page,
        params=params,
    )
