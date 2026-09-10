from dataclasses import replace

import pytest

from autodom.matching import matches, normalize, query_groups
from autodom.models import Listing, Profile


def test_aliases_are_whole_words_and_alternatives_require_all_words():
    profile = Profile(1, 1, "USD", 100, 200, "тойота камри, хёндай")
    car = Listing(
        "1", "Toyota Camry", "https://www.mashina.kg/1", 100, 9000, availability="В наличии"
    )
    assert matches(profile, car)
    assert matches(profile, replace(car, title="Hyundai Sonata"))
    assert not matches(profile, replace(car, title="Toyota Corolla"))
    assert not matches(profile, replace(car, title="NotHyundai Sonata"))
    assert normalize("ХЁНДАЙ") == normalize("Hyundai")
    assert query_groups("тойота камри, хонда") == [["toyota", "camry"], ["honda"]]


def test_empty_alternative_does_not_turn_query_into_match_all():
    car = Listing("1", "Honda Fit", "https://www.mashina.kg/1", 100, 9000, availability="В наличии")
    assert not matches(Profile(1, 1, "USD", 100, 200, "тойота,,"), car)
    assert not matches(Profile(1, 1, "USD", 100, 200, " , "), car)
    assert not matches(Profile(1, 1, "USD", 100, 200, "!!!"), car)
    assert matches(Profile(1, 1, "USD", 100, 200, " \t "), car)


@pytest.mark.parametrize(
    "mileage,maximum,expected",
    [
        ("", 0, False),
        ("0", 0, False),
        ("0 km", 0, True),
        ("0.000001 km", 0, False),
        ("1,000 miles", 1609, False),
        ("1,000 miles", 1610, True),
        ("15,625 miles", 25146, True),
        ("15625.000000000000001 miles", 25146, False),
        ("100 km / 62 miles", 100, False),
    ],
)
def test_mileage_requires_units_and_never_rounds_down(mileage, maximum, expected):
    profile = Profile(1, 1, "USD", 100, 200, mileage_max_km=maximum)
    listing = Listing(
        "1",
        "Toyota Camry",
        "https://www.mashina.kg/1",
        100,
        9000,
        mileage=mileage,
        availability="В наличии",
    )
    assert matches(profile, listing) is expected


def test_hard_fields_require_known_exact_values_and_advisory_fields_do_not_filter():
    profile = Profile(
        1,
        1,
        "USD",
        100,
        200,
        city=" Бишкек ",
        body_type="sedan",
        transmission="automatic",
        year_min=2020,
        use_case="work",
        purchase_by="2000-01-01",
    )
    listing = Listing(
        "1",
        "Toyota Camry",
        "https://www.mashina.kg/1",
        100,
        9000,
        year=2020,
        city="БИШКЕК",
        body_type="Седан",
        transmission="8-Speed Automatic",
        availability="В наличии",
    )
    assert matches(profile, listing)
    assert not matches(profile, replace(listing, city="Бишкек район"))
    assert not matches(profile, replace(listing, body_type="중형차"))
    assert not matches(profile, replace(listing, transmission="Automatic / Manual"))
    assert not matches(profile, replace(listing, year=None))
    assert not matches(profile, replace(listing, year=2019))
