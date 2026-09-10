from dataclasses import replace

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
