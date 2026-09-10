import re
from decimal import Decimal

_NUMBER = re.compile(r"\d+(?:[.,]\d{1,2})?[кk]?", re.IGNORECASE)
_ERROR = (
    "Введите сумму 15000 или диапазон 10000–15000. Пробелы и «15к» допустимы; валюта уже выбрана."
)


def _amount(text: str) -> int:
    if not _NUMBER.fullmatch(text):
        raise ValueError(_ERROR)
    multiplier = 1000 if text[-1].lower() in {"к", "k"} else 1
    number = text[:-1] if multiplier == 1000 else text
    amount = Decimal(number.replace(",", ".")) * multiplier * 100
    if amount > 10**13:
        raise ValueError("Сумма слишком большая. Проверьте количество цифр.")
    return int(amount)


def parse_budget(text: str) -> tuple[int, int]:
    if len(text) > 80:
        raise ValueError(_ERROR)
    normalized = "".join(text.split()).replace("–", "-").replace("—", "-")
    parts = normalized.split("-")
    if len(parts) == 1:
        minimum, maximum = 0, _amount(parts[0])
    elif len(parts) == 2:
        minimum, maximum = (_amount(part) for part in parts)
    else:
        raise ValueError(_ERROR)
    if maximum <= 0 or minimum > maximum:
        raise ValueError("Верхняя граница должна быть больше нуля и не меньше нижней.")
    return minimum, maximum


def money(minor: int, currency: str) -> str:
    whole, fractional = divmod(minor, 100)
    amount = f"{whole:,}".replace(",", " ")
    if fractional:
        amount += f",{fractional:02d}"
    return f"{amount} {'$' if currency == 'USD' else 'сом'}"
