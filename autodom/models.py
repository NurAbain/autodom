import time
from dataclasses import dataclass

MARKETS = {"KG": "Кыргызстан", "KR": "Корея", "US": "США", "ALL": "Все рынки"}


@dataclass(frozen=True, slots=True)
class Listing:
    id: str
    title: str
    url: str
    price_usd_minor: int | None
    price_kgs_minor: int | None
    year: int | None = None
    mileage: str = ""
    transmission: str = ""
    body_type: str = ""
    city: str = ""
    availability: str = ""
    published_at: str = ""
    photo_url: str | None = None
    source: str = "mashina.kg"
    observed_at: float | None = None
    market: str = "KG"
    original_currency: str = ""
    original_price_minor: int | None = None
    trim: str = ""
    condition: str = ""
    search_aliases: str = ""
    registration_month: str = ""
    price_kind: str = "asking"
    fx_date: str = ""
    fx_expires_at: float | None = None

    def price(self, currency: str) -> int | None:
        if currency not in ("USD", "KGS"):
            raise ValueError("Unsupported currency")
        if self.price_kind not in ("asking", "buy_now"):
            return None
        if self.market != "KG" and currency != self.original_currency:
            if self.fx_expires_at is None or self.fx_expires_at <= time.time():
                return None
        return self.price_usd_minor if currency == "USD" else self.price_kgs_minor


@dataclass(frozen=True, slots=True)
class Profile:
    user_id: int
    chat_id: int
    currency: str
    budget_min_minor: int
    budget_max_minor: int
    query: str = ""
    monitoring: bool = False
    revision: int = 0
    cursor: int = 0
    quiet_start_minute: int | None = None
    quiet_end_minute: int | None = None
    market: str = "KG"


@dataclass(frozen=True, slots=True)
class ListingEvent:
    id: int
    listing: Listing
    kind: str
    previous_usd_minor: int | None = None
    previous_kgs_minor: int | None = None
    previous_original_price_minor: int | None = None
    previous_original_currency: str = ""

    def is_price_drop(self, currency: str) -> bool:
        if self.listing.price_kind not in ("asking", "buy_now"):
            return False
        if self.listing.original_currency:
            return (
                self.previous_original_currency == self.listing.original_currency
                and self.previous_original_price_minor is not None
                and self.listing.original_price_minor is not None
                and self.listing.original_price_minor < self.previous_original_price_minor
            )
        current = self.listing.price(currency)
        previous = self.previous_usd_minor if currency == "USD" else self.previous_kgs_minor
        return previous is not None and current is not None and current < previous


@dataclass(frozen=True, slots=True)
class SourcePage:
    listings: list[Listing]
    page: int
    total: int
    pages: int
    scope: str = ""
