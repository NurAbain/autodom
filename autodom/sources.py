"""Source identity and access status shared by collection and presentation."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from . import bidcars, encar, mashina, truecar
from .config import approved_sources
from .models import SourcePage
from .storage import Store


@dataclass(frozen=True, slots=True)
class Source:
    id: str
    name: str
    market: str
    hosts: tuple[str, ...]
    fetch_page: Callable[..., Awaitable[SourcePage]]


SOURCES = (
    Source("mashina.kg", "Mashina.kg", "KG", ("mashina.kg",), mashina.fetch_page),
    Source("encar.com", "Encar", "KR", ("fem.encar.com",), encar.fetch_page),
    Source("truecar.com", "TrueCar", "US", ("www.truecar.com",), truecar.fetch_page),
    Source("bid.cars", "Bid.Cars · Copart / IAAI", "US", ("bid.cars",), bidcars.fetch_page),
)


def enabled_sources() -> tuple[Source, ...]:
    approved = approved_sources()
    return tuple(source for source in SOURCES if source.id in approved)


def enabled_markets() -> tuple[str, ...]:
    return tuple(dict.fromkeys(source.market for source in enabled_sources()))


def listing_url_allowed(source_id: str, url: str) -> bool:
    if len(url) > 600:
        return False
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme == "https"
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 443)
            and any(
                source.id == source_id and parsed.hostname in source.hosts for source in SOURCES
            )
        )
    except ValueError:
        return False


def source_status(store: Store) -> list[dict]:
    counts = store.source_stats()
    approved = approved_sources()
    result = []
    for source in SOURCES:
        prefix = f"source:{source.id}:"
        observed = counts.get(source.id, {})
        result.append(
            {
                "source": source.id,
                "name": source.name,
                "market": source.market,
                "enabled": source.id in approved,
                "listings": observed.get("listings", 0),
                "last_seen": observed.get("last_seen"),
                "last_sync": store.get_meta(prefix + "last_sync_at"),
                "total": store.get_meta(prefix + "catalog_total") or None,
                "scope": store.get_meta(prefix + "scope", ""),
                "error": store.get_meta(prefix + "source_error", ""),
            }
        )
    return result
