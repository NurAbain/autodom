import pytest

from autodom.budget import money, parse_budget


@pytest.mark.parametrize(
    "text, expected",
    [
        ("15\u00a0000", (0, 1500000)),
        ("10к–15,25к", (1000000, 1525000)),
        ("0 — 0.01", (0, 1)),
        ("1.25-1.25", (125, 125)),
        ("1 000 000", (0, 100000000)),
    ],
)
def test_budget_preserves_minor_units_and_inclusive_range(text, expected):
    assert parse_budget(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "0",
        "-100",
        "200-100",
        "100-200-300",
        "NaN",
        "1e6",
        "15000 USD",
        "1.001",
        "1,000,000",
        "100000000001",
        "9" * 81,
    ],
)
def test_invalid_budget_is_rejected_without_guessing(text):
    with pytest.raises(ValueError):
        parse_budget(text)


def test_displayed_budget_keeps_fractional_money():
    assert money(123456, "USD") == "1 234,56 $"
    assert money(123456, "KGS") == "1 234,56 сом"
