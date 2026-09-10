"""Public English auction pages; price estimates are never purchase prices."""

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from html.parser import HTMLParser
from urllib.parse import urlsplit

import aiohttp

from .models import Listing, SourcePage
from .proxy import ProxyRoute
from .source_http import SourceError, fetch_document, require_source_access

CATALOG_URL = "https://bid.cars/en/automobile/page/1"
DETAIL_DELAY_SECONDS = 2.0
_MAX_BYTES = 4 * 1024 * 1024
_MAX_LOTS = 100
_CATALOG_PATH = re.compile(
    r"/en/automobile(?:/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}/page/([1-9][0-9]{0,6})"
)
_LOT_PATH = re.compile(r"/en/lot/([01]-[0-9]{1,12})/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)")
_UNKNOWN = {"", "-", "--", "---", "n/a", "unknown", "no information", "not available", "hidden"}
_VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}
_US_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split()
)


@dataclass(slots=True)
class _Node:
    tag: str
    attrs: dict[str, str]
    children: list = field(default_factory=list)

    def has(self, name: str) -> bool:
        return name in self.attrs.get("class", "").split()

    def nodes(self):
        stack = [self]
        while stack:
            node = stack.pop()
            yield node
            stack.extend(child for child in reversed(node.children) if isinstance(child, _Node))

    def text(self) -> str:
        parts = []
        stack = list(reversed(self.children))
        while stack:
            child = stack.pop()
            if isinstance(child, str):
                parts.append(child)
            elif child.tag not in {"script", "style"}:
                stack.extend(reversed(child.children))
        return " ".join("".join(parts).split())


class _Document(HTMLParser):
    def __init__(self, text: str):
        super().__init__(convert_charrefs=True)
        if len(text) > _MAX_BYTES or len(text.encode("utf-8")) > _MAX_BYTES:
            raise SourceError("Bid.Cars document exceeds transport limit")
        self.root = _Node("document", {})
        self.stack = [self.root]
        self.count = 0
        self.feed(text)
        self.close()
        if not any(node.tag == "html" for node in self.root.nodes()) or not re.search(
            r"</html\s*>", text, re.I
        ):
            raise SourceError("Incomplete Bid.Cars HTML document")

    def handle_starttag(self, tag, attrs):
        self.count += 1
        if self.count > 100_000 or len(self.stack) > 256:
            raise SourceError("Bid.Cars HTML complexity exceeds limit")
        node = _Node(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def _one(nodes, label: str) -> _Node:
    found = list(nodes)
    if len(found) != 1:
        raise SourceError(f"Bid.Cars expected one {label}")
    return found[0]


def _block(root: _Node, identity: str) -> _Node:
    return _one((node for node in root.nodes() if node.attrs.get("id") == identity), identity)


def _class(root: _Node, name: str) -> _Node:
    return _one((node for node in root.nodes() if node.has(name)), name)


def _url(value: str, pattern: re.Pattern) -> re.Match:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f]", value):
        raise SourceError("Invalid Bid.Cars URL")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise SourceError("Invalid Bid.Cars URL") from exc
    match = pattern.fullmatch(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "bid.cars"
        or parsed.query
        or parsed.fragment
        or not match
        or "?" in value
        or "#" in value
    ):
        raise SourceError("Bid.Cars URL is outside the permitted public English scope")
    return match


def catalog_url() -> str:
    value = os.environ.get("AUTODOM_BIDCARS_CATALOG_URL", CATALOG_URL)
    if _url(value, _CATALOG_PATH).group(1) != "1":
        raise SourceError("Bid.Cars catalog configuration must start at page/1")
    return value


def _options(root: _Node) -> dict[str, str]:
    options = {}
    for node in root.nodes():
        if not node.has("option"):
            continue
        label = " ".join("".join(c for c in node.children if isinstance(c, str)).split()).lower()
        if label not in {
            "lot",
            "vin",
            "sale document",
            "primary damage",
            "secondary damage",
            "odometer",
            "start code",
            "body style",
        }:
            continue
        value = _class(node, "right-info").text()
        if label in options and options[label] != value:
            raise SourceError("Conflicting Bid.Cars labeled attributes")
        options[label] = value
    return options


def _optional(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SourceError("Bid.Cars text schema changed")
    value = " ".join(value.split())
    return "" if value.lower() in _UNKNOWN else value


def _amount(value: str, *, dom: bool = False) -> int | None:
    if not isinstance(value, str):
        raise SourceError("Bid.Cars amount schema changed")
    value = value.strip()
    if value.lower() in _UNKNOWN or value == "null":
        return None
    if len(value) > 32:
        raise SourceError("Bid.Cars amount exceeds supported range")
    pattern = (
        r"\$([0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(\.[0-9]{1,2})?(?:\s+USD)?"
        if dom
        else r"([0-9]{1,12})(\.[0-9]{1,2})?"
    )
    match = re.fullmatch(pattern, value)
    if not match:
        raise SourceError("Malformed Bid.Cars USD amount")
    cents = int(Decimal((match.group(1) + (match.group(2) or "")).replace(",", "")) * 100)
    if cents > 10**14:
        raise SourceError("Bid.Cars amount exceeds supported range")
    return cents


def _variables(root: _Node) -> dict[str, str]:
    names = {
        "lotNumber",
        "isArchived",
        "currentBid",
        "finalBid",
        "estimatedAmount1",
        "estimatedAmount2",
        "buyNowAmount",
        "auctionType",
        "liveAuctionStartDateTime",
    }
    values = {}
    for node in root.nodes():
        if (
            node.tag != "script"
            or node.attrs.get("src")
            or node.attrs.get("type") == "application/ld+json"
        ):
            continue
        script = "".join(child for child in node.children if isinstance(child, str))
        for match in re.finditer(r"^\s*(?:var|let|const)\s+(\w+)\s*=\s*([^;\r\n]*);", script, re.M):
            name, literal = match.groups()
            if name not in names:
                continue
            literal = literal.strip()
            if name in {"lotNumber", "auctionType", "liveAuctionStartDateTime"}:
                string = re.fullmatch(r"(['\"])([A-Za-z0-9 :+._/-]*)\1", literal)
                if not string and literal != "null":
                    raise SourceError(f"Bid.Cars {name} is not a supported literal")
                value = string.group(2) if string else ""
            else:
                _amount(literal)
                value = literal
            if name in values and values[name] != value:
                raise SourceError(f"Conflicting Bid.Cars {name}")
            values[name] = value
    if not names <= values.keys():
        raise SourceError("Bid.Cars auction declaration schema changed")
    return values


def _vehicle(root: _Node) -> dict:
    vehicles = []
    for node in root.nodes():
        if node.tag != "script" or node.attrs.get("type") != "application/ld+json":
            continue
        try:
            data = json.loads("".join(child for child in node.children if isinstance(child, str)))
        except (ValueError, RecursionError) as exc:
            raise SourceError("Malformed Bid.Cars structured identity") from exc
        if isinstance(data, dict) and data.get("@type") == "Vehicle":
            vehicles.append(data)
    if len(vehicles) != 1:
        raise SourceError("Bid.Cars expected one structured vehicle identity")
    return vehicles[0]


def _deadline(root: _Node, value: str) -> float | None:
    # The observed detail footer declares UTC; category GMT+2 text is unrelated.
    footers = [node for node in root.nodes() if node.has("links-footer")]
    if len(footers) != 1:
        return None
    zones = [
        node.text() for node in footers[0].nodes() if node.tag == "button" and "(UTC" in node.text()
    ]
    if zones != ["(UTC+00:00) UTC"]:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC).timestamp()
    except ValueError:
        return None


def _mileage(value: str) -> str:
    value = _optional(value)
    if not value:
        return ""
    exact = re.fullmatch(
        r"([0-9]+(?:[ ,][0-9]{3})*)\s*(mi|miles|km)(?:\s*\([0-9 ,]+\s*km\))?", value, re.I
    )
    if exact:
        number = exact.group(1).replace(" ", "").replace(",", "")
        return f"{int(number)} {'km' if exact.group(2).lower() == 'km' else 'miles'}"
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?[kK]\s*(?:mi|miles|km)", value):
        return ""
    raise SourceError("Bid.Cars odometer schema changed")


def _location(root: _Node, lot: str, vin: str) -> str | None:
    descriptions = [
        node.attrs.get("content", "")
        for node in root.nodes()
        if node.tag == "meta" and node.attrs.get("name") == "description"
    ]
    if len(descriptions) != 1:
        raise SourceError("Bid.Cars location evidence missing")
    description = descriptions[0]
    if not re.search(rf"\bLot:\s*{re.escape(lot)}(?:[,\s]|$)", description) or not re.search(
        rf"\bVIN:\s*{re.escape(vin)}(?:[,\s]|$)", description
    ):
        raise SourceError("Bid.Cars location identity mismatch")
    match = re.search(r"Location:\s*([^|]+),\s*(USA|Canada)\s*\|", description)
    if not match:
        raise SourceError("Bid.Cars yard country is not evidenced")
    location, country = match.groups()
    locations = [node for node in root.nodes() if node.tag == "li" and node.has("location")]
    if not locations or any(
        node.text().removeprefix("Location:").strip() != location.strip() for node in locations
    ):
        raise SourceError("Conflicting Bid.Cars yard location")
    if country == "Canada":
        return None
    state = re.search(r"\(([A-Z]{2})\)$", location.strip())
    if not state or state.group(1) not in _US_STATES:
        raise SourceError("Bid.Cars USA label contradicts yard state")
    return location.strip()


def parse_detail(text: str, url: str) -> Listing | None:
    """Parse one identified lot; proven Canadian inventory is deliberately excluded."""
    lot = _url(url, _LOT_PATH).group(1)
    root = _Document(text).root
    vehicle = _vehicle(root)
    if vehicle.get("url") != url:
        raise SourceError("Bid.Cars returned a different vehicle URL")
    main, secondary, tertiary = (
        _options(_block(root, identity))
        for identity in ("main-info", "secondary-info", "tertiary-info")
    )
    if (
        not {"lot", "vin", "sale document"} <= main.keys()
        or not {"odometer", "primary damage", "secondary damage", "start code"} <= secondary.keys()
    ):
        raise SourceError("Bid.Cars detail attribute schema changed")
    vin = _optional(vehicle.get("vehicleIdentificationNumber"))
    if (
        not re.fullmatch(r"[A-Z0-9]{5,25}", vin)
        or main["vin"] != vin
        or main["lot"].replace(" ", "") != lot
    ):
        raise SourceError("Conflicting Bid.Cars lot or vehicle identity")
    variables = _variables(root)
    if (
        variables["lotNumber"] != lot
        or variables["auctionType"] != {"0": "IAAI", "1": "Copart"}[lot[0]]
    ):
        raise SourceError("Conflicting Bid.Cars auction identity")
    if variables["isArchived"] not in {"0", "1"}:
        raise SourceError("Bid.Cars archive declaration schema changed")
    archived = variables["isArchived"] == "1"
    city = _location(root, lot, vin)
    bidding = _block(root, "bidding-info")
    prices = _class(bidding, "lot-price-info")
    bid_node = _class(prices, "current_bid")
    labeled = [
        node
        for node in prices.nodes()
        if node.has("field-name") and node.text().lower() in {"current bid", "final bid"}
    ]
    label = _one(labeled, "labeled auction bid").text().lower()
    current = _amount(variables["currentBid"]) if label == "current bid" else None
    final = _amount(variables["finalBid"]) if label == "final bid" else None
    if _amount(bid_node.text(), dom=True) != (current if label == "current bid" else final):
        raise SourceError("Bid.Cars labeled bid conflicts with auction declaration")
    statuses = [node.text() for node in bidding.nodes() if node.has("bid-status")]
    status = "unknown"
    if archived:
        archive_notice = _block(root, "archieved-message").text()
        if (
            label != "final bid"
            or statuses
            or not archive_notice.startswith("You are watching archived offer.")
        ):
            raise SourceError("Bid.Cars archived result evidence conflicts")
        status = "ended"
    else:
        if len(statuses) != 1:
            raise SourceError("Bid.Cars auction status schema changed")
        if statuses[0].lower() == "final auction ended":
            status = "ended"
        elif label == "current bid" and re.fullmatch(
            r"(?:[0-9]+\s*(?:d|h|min|sec)\s*)+", statuses[0]
        ):
            status = "active"
    buy = _amount(variables["buyNowAmount"]) or None
    buy_blocks = [node for node in bidding.nodes() if node.has("buy-now-wr")]
    if buy_blocks:
        buy_block = _one(buy_blocks, "buy now block")
        if (
            _class(buy_block, "field-name").text().lower().rstrip(":") != "fast buy price"
            or (_amount(_class(buy_block, "price").text(), dom=True) or None) != buy
        ):
            raise SourceError("Bid.Cars labeled Buy Now price conflicts with declaration")
        buy_active = any(
            node.tag in {"a", "button"}
            and node.text() == "Buy Now"
            and "disabled" not in node.attrs
            and not node.has("disabled")
            for node in buy_block.nodes()
        )
    else:
        buy_active = False
    estimate_min, estimate_max = (
        _amount(variables["estimatedAmount1"]) or None,
        _amount(variables["estimatedAmount2"]) or None,
    )
    estimates = [node for node in root.nodes() if node.tag == "li" and node.has("est_price")]
    if not estimates and (not archived or estimate_min is not None or estimate_max is not None):
        raise SourceError("Bid.Cars labeled estimate schema changed")
    for estimate in estimates:
        amounts = [
            _amount(node.text(), dom=True) or None for node in estimate.nodes() if node.tag == "b"
        ]
        if amounts != [estimate_min, estimate_max]:
            raise SourceError("Bid.Cars labeled estimate conflicts with declaration")
    if estimate_min is not None and estimate_max is not None and estimate_min > estimate_max:
        raise SourceError("Bid.Cars estimate interval is reversed")
    year_text = vehicle.get("vehicleModelDate")
    if not isinstance(year_text, str) or not re.fullmatch(r"[12][0-9]{3}", year_text):
        raise SourceError("Bid.Cars vehicle year schema changed")
    name = _optional(vehicle.get("name"))
    suffix = f" | {vin} | {'Bid History | ' if archived else ''}BidCars"
    if not name.endswith(suffix) or not name.startswith(year_text + " "):
        raise SourceError("Bid.Cars vehicle title identity mismatch")
    title = name.removesuffix(suffix)
    photo = _optional(vehicle.get("image"))
    if photo:
        parsed_photo = urlsplit(photo)
        if (
            parsed_photo.scheme != "https"
            or parsed_photo.netloc not in {"images.bid.cars", "mercury.bid.cars", "pluto.bid.car"}
            or parsed_photo.query
            or parsed_photo.fragment
        ):
            raise SourceError("Bid.Cars photo URL schema changed")
    sale_document = _optional(main["sale document"])
    primary, secondary_damage, start = (
        _optional(secondary[key]) for key in ("primary damage", "secondary damage", "start code")
    )
    condition = "; ".join(
        f"{label}: {value}"
        for label, value in (
            ("Документ", sale_document),
            ("Основное повреждение", primary),
            ("Вторичное повреждение", secondary_damage),
            ("Код запуска", start),
        )
        if value
    )
    price = buy if status == "active" and buy_active else None
    listing = Listing(
        id=f"bidcars:{lot}",
        title=title,
        url=url,
        price_usd_minor=price,
        price_kgs_minor=None,
        year=int(year_text),
        mileage=_mileage(secondary["odometer"]),
        transmission=_optional(vehicle.get("vehicleTransmission")),
        city=city or "",
        availability={"active": "Опубликовано", "ended": "Завершено", "unknown": "Неизвестно"}[
            status
        ],
        photo_url=photo or None,
        source="bid.cars",
        market="US",
        original_currency="USD",
        original_price_minor=price,
        trim=title.partition(", ")[2],
        body_type=_optional(tertiary.get("body style")),
        condition=f"По данным аукциона: {condition}" if condition else "",
        price_kind="buy_now" if price is not None else "auction",
        vin=vin,
        auction_house=variables["auctionType"],
        auction_lot=lot,
        auction_status=status,
        auction_at=_deadline(root, variables["liveAuctionStartDateTime"]),
        current_bid_minor=current,
        final_bid_minor=final,
        buy_now_minor=buy,
        estimated_min_minor=estimate_min,
        estimated_max_minor=estimate_max,
        sale_document=sale_document,
        primary_damage=primary,
        secondary_damage=secondary_damage,
        start_code=start,
    )
    return listing if city is not None else None


@dataclass(frozen=True, slots=True)
class CatalogLot:
    lot: str
    url: str
    title: str
    vin: str


@dataclass(frozen=True, slots=True)
class CatalogPage:
    lots: tuple[CatalogLot, ...]
    page: int
    pages: int
    total: int | None = None

    @property
    def urls(self) -> tuple[str, ...]:
        return tuple(lot.url for lot in self.lots)


def parse_catalog(text: str, page: int = 1, *, catalog_url: str = CATALOG_URL) -> CatalogPage:
    """Discover only identified catalog rows, never gallery/history/recommendation links."""
    if type(page) is not int or page < 1 or page > 9_999_999:
        raise SourceError("Bid.Cars catalog page must be a positive bounded integer")
    if _url(catalog_url, _CATALOG_PATH).group(1) != "1":
        raise SourceError("Bid.Cars catalog scope must start at page/1")
    prefix = catalog_url.rsplit("/", 1)[0] + "/"
    requested = prefix + str(page)
    root = _Document(text).root
    identities = [
        node.attrs.get("href") if node.tag == "link" else node.attrs.get("content")
        for node in root.nodes()
        if (node.tag == "link" and node.attrs.get("rel") == "canonical")
        or (node.tag == "meta" and node.attrs.get("property") == "og:url")
    ]
    if not identities or any(identity != requested for identity in identities):
        raise SourceError("Bid.Cars returned a different catalog scope or page")
    area = _block(root, "search_area")
    rows = [
        node
        for node in area.nodes()
        if node.tag == "div" and node.has("item-horizontal") and node.has("lots-search")
    ]
    if any(node.has("item-horizontal") != node.has("lots-search") for node in area.nodes()):
        raise SourceError("Bid.Cars catalog row schema changed")
    if not rows and any(isinstance(child, _Node) or str(child).strip() for child in area.children):
        raise SourceError("Unrecognized Bid.Cars catalog content")
    if len(rows) > _MAX_LOTS:
        raise SourceError("Bid.Cars catalog exceeds bounded detail count")
    lots = {}
    for row in rows:
        name = _class(row, "name")
        anchor = _one(
            (node for node in name.nodes() if node.tag == "a" and node.has("item-title")),
            "catalog title link",
        )
        url = anchor.attrs.get("href", "")
        lot = _url(url, _LOT_PATH).group(1)
        if row.attrs.get("id") != lot:
            raise SourceError("Bid.Cars catalog row and link identity conflict")
        vin_node = _one(
            (node for node in row.nodes() if node.tag == "h2" and node.has("vin_title")),
            "catalog VIN",
        )
        vin = vin_node.text()
        vin_links = [node.attrs.get("href") for node in vin_node.nodes() if node.tag == "a"]
        lot_labels = [
            node.text() for node in row.nodes() if node.tag == "span" and node.has("vin_title")
        ]
        if not re.fullmatch(r"[A-Z0-9]{5,25}", vin) or vin_links != [url] or lot_labels != [lot]:
            raise SourceError("Bid.Cars catalog identity labels conflict")
        title = anchor.text()
        if not re.match(r"[12][0-9]{3}\s+\S", title):
            raise SourceError("Bid.Cars catalog title schema changed")
        found = CatalogLot(lot=lot, url=url, title=title, vin=vin)
        if lot in lots and lots[lot] != found:
            raise SourceError("Bid.Cars duplicate lot has conflicting identity")
        lots[lot] = found
    breadcrumbs = _class(root, "breadcrumbs")
    active = _one(
        (node for node in breadcrumbs.nodes() if node.tag == "li" and node.has("active")),
        "current catalog page",
    )
    active_anchor = _one((node for node in active.nodes() if node.tag == "a"), "current page link")
    if active_anchor.text() != str(page) or active_anchor.attrs.get("href") not in {"#", requested}:
        raise SourceError("Bid.Cars returned a different pagination position")
    numbers = {page}
    for anchor in breadcrumbs.nodes():
        if anchor.tag != "a" or anchor is active_anchor:
            continue
        target = anchor.attrs.get("href", "")
        if target == "#" and anchor.text() in {"...", "…"}:
            continue
        number = int(_url(target, _CATALOG_PATH).group(1))
        if target != prefix + str(number):
            raise SourceError("Bid.Cars pagination escapes requested scope")
        if anchor.text().isdecimal() and int(anchor.text()) != number:
            raise SourceError("Bid.Cars pagination link and label conflict")
        numbers.add(number)
    pages = max(numbers)
    if not lots and page < pages:
        raise SourceError("Unexpected empty Bid.Cars interior catalog page")
    # Public catalogs expose pagination but no trustworthy scope-wide lot total.
    return CatalogPage(lots=tuple(lots.values()), page=page, pages=pages)


async def fetch_page(
    session: aiohttp.ClientSession, page: int = 1, *, proxies: tuple[ProxyRoute, ...]
) -> SourcePage:
    require_source_access("bid.cars")
    base = catalog_url()
    if type(page) is not int or page < 1 or page > 9_999_999:
        raise SourceError("Bid.Cars catalog page must be a positive bounded integer")
    url = base.rsplit("/", 1)[0] + f"/{page}"
    catalog = await fetch_document(
        session,
        url,
        lambda text: parse_catalog(text, page, catalog_url=base),
        source="bid.cars",
        proxies=proxies,
        page=page,
        headers={"Accept": "text/html"},
    )
    listings = []
    for lot in catalog.lots:
        await asyncio.sleep(DETAIL_DELAY_SECONDS)
        listing = await fetch_document(
            session,
            lot.url,
            lambda text, url=lot.url: parse_detail(text, url),
            source="bid.cars",
            proxies=proxies,
            headers={"Accept": "text/html"},
        )
        if listing is not None:
            if listing.vin != lot.vin or listing.title != lot.title:
                raise SourceError("Bid.Cars catalog and detail identity conflict")
            listings.append(listing)
    return SourcePage(
        listings=listings,
        page=page,
        pages=catalog.pages,
        total=catalog.total,
        scope=f"США: аукционы Copart/IAAI; каталог {base}; экспорт не подтверждён",
    )
