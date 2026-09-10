import re

from .models import Listing, Profile

_ALIASES = {
    "тойота": "toyota",
    "камри": "camry",
    "хонда": "honda",
    "хендай": "hyundai",
    "хундай": "hyundai",
    "киа": "kia",
    "бмв": "bmw",
    "мерседес": "mercedes",
    "лексус": "lexus",
}
_WORDS = re.compile(r"[^\W_]+", re.UNICODE)


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
                    str(listing.year) if listing.year is not None else "",
                )
            )
        )
        + " "
    )


def matches(profile: Profile, listing: Listing) -> bool:
    if profile.currency not in ("USD", "KGS"):
        return False
    price = listing.price(profile.currency)
    if (
        price is None
        or price <= 0
        or not profile.budget_min_minor <= price <= profile.budget_max_minor
        or normalize(listing.availability) != "в наличии"
    ):
        return False
    groups = query_groups(profile.query)
    if not groups:
        return not profile.query.strip()
    text = searchable_text(listing)
    return any(all(f" {word} " in text for word in group) for group in groups)
