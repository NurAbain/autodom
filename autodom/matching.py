import re
from decimal import Decimal

from .config import approved_sources
from .models import MARKETS, Listing, Profile

_ALIASES = {
    "тойота": "toyota",
    "камри": "camry",
    "хонда": "honda",
    "хендай": "hyundai",
    "хундай": "hyundai",
    "хёндай": "hyundai",
    "киа": "kia",
    "бмв": "bmw",
    "мерседес": "mercedes",
    "лексус": "lexus",
}
_WORDS = re.compile(r"[^\W_]+", re.UNICODE)
_BODY_LABELS = {
    "sedan": ("sedan", "седан", "세단"),
    "suv": (
        "suv",
        "sport utility",
        "crossover",
        "внедорожник",
        "кроссовер",
        "внедорожник кроссовер",
    ),
    "hatchback": ("hatchback", "хэтчбек", "хетчбэк", "хэтчбэк", "해치백"),
    "wagon": ("wagon", "station wagon", "универсал", "왜건"),
    "minivan": ("minivan", "минивэн", "минивен", "미니밴"),
    "pickup": ("pickup", "pickup truck", "пикап", "픽업"),
    "coupe": ("coupe", "купе", "쿠페"),
    "convertible": ("convertible", "cabriolet", "кабриолет", "컨버터블"),
    "van": ("van", "cargo van", "фургон"),
}
_TRANSMISSION_LABELS = {
    "manual": ("manual", "механика", "механическая", "мкпп", "수동"),
    "automatic": ("automatic", "автомат", "автоматическая", "акпп", "오토", "자동"),
    "cvt": ("cvt", "вариатор", "무단변속기"),
    "robot": ("robot", "automated manual", "dct", "dsg", "робот", "роботизированная"),
}
_MILEAGE = re.compile(
    r"([0-9]+(?:\.[0-9]+)?|[0-9]{1,3}(?:[ ,\u00a0\u202f][0-9]{3})+)"
    r"\s*(km|км|kilometers?|kilometres?|mi|miles?|миль|мили|миля)",
    re.IGNORECASE,
)


def normalize_city(text: str) -> str:
    """Exact place words, without vehicle aliases or geographic guesses."""
    return " ".join(_WORDS.findall(text.casefold().replace("ё", "е")))


def normalize_body_type(text: str) -> str:
    value = normalize_city(text)
    return next((key for key, labels in _BODY_LABELS.items() if value in labels), "")


def normalize_transmission(text: str) -> str:
    value = normalize_city(text)
    value = re.sub(r"^[0-9]+ speed ", "", value)
    return next((key for key, labels in _TRANSMISSION_LABELS.items() if value in labels), "")


def normalize_mileage_km(text: str) -> int | None:
    """Ceiling km preserves exact comparisons with whole-km profile limits."""
    found = _MILEAGE.fullmatch(text.strip())
    if found is None or len(found[1]) > 24:
        return None
    number = re.sub(r"[ ,\u00a0\u202f]", "", found[1])
    numerator, denominator = Decimal(number).as_integer_ratio()
    if found[2].casefold() not in (
        "km",
        "км",
        "kilometer",
        "kilometers",
        "kilometre",
        "kilometres",
    ):
        numerator *= 1_609_344
        denominator *= 1_000_000
    result = (numerator + denominator - 1) // denominator
    return result if result < 2**63 else None


def normalize(text: str) -> str:
    """Canonicalize whole words, without fuzzy or substring aliases."""
    words = _WORDS.findall(text.casefold().replace("ё", "е"))
    return " ".join(_ALIASES.get(word, word) for word in words)


def query_groups(query: str) -> list[list[str]]:
    """Comma-separated OR groups containing AND words; empty groups are ignored."""
    return [words for alternative in query.split(",") if (words := normalize(alternative).split())]


def searchable_text(listing: Listing) -> str:
    """Space-delimited words shared by in-memory matching and persisted search."""
    return (
        " "
        + normalize(
            " ".join(
                (
                    listing.title,
                    listing.body_type,
                    listing.transmission,
                    listing.city,
                    listing.mileage,
                    listing.trim,
                    listing.search_aliases,
                    str(listing.year) if listing.year is not None else "",
                )
            )
        )
        + " "
    )


def matches(profile: Profile, listing: Listing) -> bool:
    if (
        profile.currency not in ("USD", "KGS")
        or profile.market not in MARKETS
        or listing.source not in approved_sources()
        or (profile.market != "ALL" and listing.market != profile.market)
        or (
            listing.market != "KG"
            and (profile.allow_import is False or profile.budget_scope == "total")
        )
        or (profile.city and normalize_city(listing.city) != normalize_city(profile.city))
        or (profile.body_type and normalize_body_type(listing.body_type) != profile.body_type)
        or (
            profile.transmission
            and normalize_transmission(listing.transmission) != profile.transmission
        )
        or (
            profile.year_min is not None
            and (type(listing.year) is not int or listing.year < profile.year_min)
        )
        or (
            profile.mileage_max_km is not None
            and (
                (mileage := normalize_mileage_km(listing.mileage)) is None
                or mileage > profile.mileage_max_km
            )
        )
    ):
        return False
    price = listing.price(profile.currency)
    if (
        price is None
        or price <= 0
        or not profile.budget_min_minor <= price <= profile.budget_max_minor
        or (
            normalize(listing.availability) != "в наличии"
            and not (listing.market != "KG" and normalize(listing.availability) == "опубликовано")
        )
    ):
        return False
    groups = query_groups(profile.query)
    if not groups:
        return not profile.query.strip()
    text = searchable_text(listing)
    return any(all(f" {word} " in text for word in group) for group in groups)
