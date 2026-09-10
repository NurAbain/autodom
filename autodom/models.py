import time
from dataclasses import dataclass

MARKETS = {"KG": "Кыргызстан", "KR": "Корея", "US": "США", "ALL": "Все рынки"}
BUDGET_SCOPES = {"car": "Только автомобиль", "total": "Весь бюджет, включая доставку и оформление"}
BODY_TYPES = {
    "sedan": "Седан",
    "suv": "Внедорожник / кроссовер",
    "hatchback": "Хэтчбек",
    "wagon": "Универсал",
    "minivan": "Минивэн",
    "pickup": "Пикап",
    "coupe": "Купе",
    "convertible": "Кабриолет",
    "van": "Фургон",
}
TRANSMISSIONS = {
    "manual": "Механика",
    "automatic": "Автомат",
    "cvt": "Вариатор",
    "robot": "Робот",
}
USE_CASES = {"city": "Город", "family": "Семья", "work": "Работа", "travel": "Поездки"}


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
    vin: str = ""
    auction_house: str = ""
    auction_lot: str = ""
    auction_status: str = ""
    auction_at: float | None = None
    current_bid_minor: int | None = None
    buy_now_minor: int | None = None
    final_bid_minor: int | None = None
    estimated_min_minor: int | None = None
    estimated_max_minor: int | None = None
    sale_document: str = ""
    primary_damage: str = ""
    secondary_damage: str = ""
    start_code: str = ""

    @property
    def is_auction(self) -> bool:
        return bool(
            self.auction_status
            or self.auction_house
            or self.auction_lot
            or self.auction_at is not None
            or self.price_kind == "auction"
            or self.current_bid_minor is not None
            or self.buy_now_minor is not None
            or self.final_bid_minor is not None
            or self.estimated_min_minor is not None
            or self.estimated_max_minor is not None
        )

    @property
    def purchase_eligible(self) -> bool:
        return self.price_kind in ("asking", "buy_now") and (
            not self.is_auction
            or (
                self.price_kind == "buy_now"
                and self.auction_status == "active"
                and self.auction_at is not None
                and self.auction_at > time.time()
            )
        )

    def price(self, currency: str) -> int | None:
        if currency not in ("USD", "KGS"):
            raise ValueError("Unsupported currency")
        if not self.purchase_eligible:
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
    city: str = ""
    budget_scope: str = "car"
    body_type: str = ""
    year_min: int | None = None
    mileage_max_km: int | None = None
    transmission: str = ""
    use_case: str = ""
    allow_import: bool | None = None
    purchase_by: str = ""


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
        if not self.listing.purchase_eligible:
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
    total: int | None
    pages: int
    scope: str = ""
