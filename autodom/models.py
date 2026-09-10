from dataclasses import dataclass


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

    def price(self, currency: str) -> int | None:
        if currency == "USD":
            return self.price_usd_minor
        if currency == "KGS":
            return self.price_kgs_minor
        raise ValueError("Unsupported currency")


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


@dataclass(frozen=True, slots=True)
class ListingEvent:
    id: int
    listing: Listing
    kind: str
    previous_usd_minor: int | None = None
    previous_kgs_minor: int | None = None

    def is_price_drop(self, currency: str) -> bool:
        current = self.listing.price(currency)
        previous = self.previous_usd_minor if currency == "USD" else self.previous_kgs_minor
        return previous is not None and current is not None and current < previous


@dataclass(frozen=True, slots=True)
class SourcePage:
    listings: list[Listing]
    page: int
    total: int
    pages: int
