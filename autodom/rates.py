"""Dated NBKR quotes; refresh is explicit and uses only proxied public XML."""

import json
import logging
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from xml.etree import ElementTree

import aiohttp

from .models import Listing
from .proxy import ProxyRoute
from .source_http import SourceError, SourceRateLimited, fetch_document
from .storage import Store

logger = logging.getLogger(__name__)
_BISHKEK = timezone(timedelta(hours=6))
_FEEDS = {
    "USD": ("https://www.nbkr.kg/XML/daily.xml", 4),
    "KRW": ("https://www.nbkr.kg/XML/weekly.xml", 7),
}
_LAST_REFRESH = "nbkr:last_refresh"


@dataclass(frozen=True, slots=True)
class Quote:
    currency: str
    date: str
    nominal: Decimal
    value: Decimal
    valid_days: int

    starts_at: float = field(init=False)
    expires_at: float = field(init=False)

    def __post_init__(self) -> None:
        start = datetime.strptime(self.date, "%Y-%m-%d").replace(tzinfo=_BISHKEK).timestamp()
        object.__setattr__(self, "starts_at", start)
        object.__setattr__(self, "expires_at", start + self.valid_days * 86400)

    def valid_at(self, now: float) -> bool:
        return self.starts_at <= now < self.expires_at


def _decimal(value: object) -> Decimal:
    if not isinstance(value, str) or len(value) > 100:
        raise ValueError("Invalid NBKR amount")
    number = Decimal(value.strip().replace(",", "."))
    if not number.is_finite() or number <= 0 or abs(number.adjusted()) > 20:
        raise ValueError("Invalid NBKR amount")
    return number


def _quote(
    currency: str, date: str, nominal: object, value: object, days: int, now: float
) -> Quote:
    if currency not in _FEEDS or type(days) is not int or days != _FEEDS[currency][1]:
        raise ValueError("Invalid NBKR quote validity")
    unit = _decimal(nominal)
    if unit != unit.to_integral_value():
        raise ValueError("Invalid NBKR nominal")
    quote = Quote(currency, date, unit, _decimal(value), days)
    if not quote.valid_at(now):
        raise ValueError("Future or expired NBKR quote")
    return quote


def parse_quote(text: str, currency: str, *, now: float | None = None) -> Quote:
    """Parse one required quote; dates take effect at midnight in Kyrgyzstan."""
    try:
        if currency not in _FEEDS or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            raise ValueError("Unsupported NBKR document")
        root = ElementTree.fromstring(text)
        if root.tag != "CurrencyRates":
            raise ValueError("Invalid NBKR root")
        day = datetime.strptime(root.attrib["Date"], "%d.%m.%Y").date().isoformat()
        entries = [entry for entry in root.findall("Currency") if entry.get("ISOCode") == currency]
        if len(entries) != 1:
            raise ValueError("Required NBKR currency missing or duplicated")
        entry = entries[0]
        days = _FEEDS[currency][1]
        if currency == "KRW" and entry.findtext("ValidFor") != "7":
            raise ValueError("Unverified NBKR weekly validity")
        return _quote(
            currency,
            day,
            entry.findtext("Nominal"),
            entry.findtext("Value"),
            days,
            time.time() if now is None else now,
        )
    except (
        ElementTree.ParseError,
        KeyError,
        TypeError,
        ValueError,
        InvalidOperation,
        OverflowError,
    ) as error:
        raise SourceError(f"Invalid or unavailable NBKR {currency} quote") from error


def _minor(amount: Decimal) -> int | None:
    rounded = amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if 0 < rounded <= 2**63 - 1:
        return int(rounded)
    return None


class RateBook:
    def __init__(self, store: Store, proxies: tuple[ProxyRoute, ...]) -> None:
        self.store = store
        self.proxies = proxies
        self.quotes: dict[str, Quote] = {}
        now = time.time()
        for currency in _FEEDS:
            saved = store.get_meta(f"nbkr:{currency}")
            if not saved:
                continue
            try:
                data = json.loads(saved)
                quote = _quote(
                    currency, data["date"], data["nominal"], data["value"], data["valid_days"], now
                )
            except (KeyError, TypeError, ValueError, InvalidOperation, OverflowError):
                continue
            self.quotes[currency] = quote
        try:
            attempted = float(store.get_meta(_LAST_REFRESH, "0"))
        except (TypeError, ValueError, OverflowError):
            attempted = 0.0
        self._last_refresh = attempted if 0 <= attempted <= now else 0.0

    async def refresh(self, session: aiohttp.ClientSession) -> None:
        """Attempt each feed independently, at most once per hour, retaining valid cache."""
        now = time.time()
        if 0 <= now - self._last_refresh < 3600:
            return
        self._last_refresh = now
        self.store.set_meta(_LAST_REFRESH, str(now))
        for currency, (url, _) in _FEEDS.items():
            try:
                quote = await fetch_document(
                    session,
                    url,
                    lambda text, currency=currency: parse_quote(text, currency),
                    source="nbkr.kg",
                    proxies=self.proxies,
                    headers={"Accept": "application/xml,text/xml"},
                )
            except SourceRateLimited:
                # Both XML feeds share one origin; a 429 stops this refresh.
                logger.warning("NBKR refresh rate limited")
                break
            except SourceError as error:
                logger.warning("NBKR %s refresh unavailable: %s", currency, error)
                continue
            cached = self.quotes.get(currency)
            if cached is not None and quote.date < cached.date:
                continue
            self.store.set_meta(
                f"nbkr:{currency}",
                json.dumps(
                    {
                        "date": quote.date,
                        "nominal": str(quote.nominal),
                        "value": str(quote.value),
                        "valid_days": quote.valid_days,
                    }
                ),
            )
            self.quotes[currency] = quote

    def convert(self, listing: Listing) -> Listing:
        """Recompute from original amounts, never from previous normalized prices."""
        currency, original = listing.original_currency, listing.original_price_minor
        if not currency:
            return listing
        valid_price = (
            listing.price_kind in ("asking", "buy_now")
            and type(original) is int
            and 0 < original <= 2**63 - 1
        )
        dollars = original if valid_price and currency == "USD" else None
        som = original if valid_price and currency == "KGS" else None
        used: list[Quote] = []
        if valid_price and currency in ("USD", "KRW"):
            now = time.time()
            usd, krw = self.quotes.get("USD"), self.quotes.get("KRW")
            usd = usd if usd is not None and usd.valid_at(now) else None
            krw = krw if krw is not None and krw.valid_at(now) else None
            try:
                with localcontext() as context:
                    context.prec = 50
                    if currency == "USD" and usd is not None:
                        som = _minor(Decimal(original) * usd.value / usd.nominal)
                        if som is not None:
                            used.append(usd)
                    elif currency == "KRW" and krw is not None:
                        # Round only the final target currency, not the intermediate KGS.
                        som_amount = Decimal(original) * 100 * krw.value / krw.nominal
                        som = _minor(som_amount)
                        if som is not None:
                            used.append(krw)
                        if usd is not None:
                            dollars = _minor(som_amount * usd.nominal / usd.value)
                            if dollars is not None:
                                used = [usd, krw]
            except (InvalidOperation, OverflowError):
                dollars = original if currency == "USD" else None
                som = None
                used = []
        return replace(
            listing,
            price_usd_minor=dollars,
            price_kgs_minor=som,
            fx_date=";".join(f"{quote.currency}:{quote.date}" for quote in used),
            fx_expires_at=min((quote.expires_at for quote in used), default=None),
        )
