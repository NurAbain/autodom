import json
import unittest

from autodom.mashina import SourceError, parse_page
from autodom.models import Profile
from autodom.storage import Store


def ad(**changes):
    item = {
        "id": 10112178,
        "slug": "volkswagen-tharu-xr-example",
        "title": "Volkswagen Tharu XR 1.5 AT",
        "status": "active",
        "availability": "В наличии",
        "created_at": "2026-08-14T07:06:47.273197+06:00",
        "prices": [
            {"currency": "USD", "amount": 11300},
            {"currency": "KGS", "amount": 988185},
        ],
        "attributes": [
            {"slug": "year", "value_number": 2026},
            {"slug": "mileage", "value_text": "165000 miles"},
            {"slug": "city", "value_json": {"name": "Бишкек"}},
        ],
        "location": {},
    }
    item.update(changes)
    return item


def catalog(items, **changes):
    result = {"items": items, "total": len(items), "page": 1, "size": 21, "pages": 1}
    result.update(changes)
    return result


def flight(value):
    return '0:I["component",[],"default"]\n1:' + json.dumps(value, ensure_ascii=False) + "\n"


class MashinaParserTests(unittest.TestCase):
    def test_finds_catalog_not_nested_translation_items(self):
        title = 'Lexus LX «Кыргызстан» [570] \\"особый"'
        source = flight(
            {
                "translations": {
                    "items": [{"items": ["один", {"text": "[скобки] и кавычки"}]}],
                    "total": "Всего",
                    "page": "Страница",
                    "size": "Размер",
                    "pages": "Страницы",
                },
                "children": [catalog([ad(title=title)])],
            }
        )
        result = parse_page(source)
        listing = result.listings[0]
        self.assertEqual(listing.title, title)
        self.assertEqual(listing.id, "mashina:10112178")
        self.assertEqual(listing.url, "https://mashina.kg/details/volkswagen-tharu-xr-example")
        self.assertEqual((listing.price_usd_minor, listing.price_kgs_minor), (1130000, 98818500))
        self.assertEqual(
            (listing.city, listing.mileage, listing.year), ("Бишкек", "165000 miles", 2026)
        )
        self.assertEqual(listing.availability, "В наличии")
        self.assertEqual(listing.published_at, "2026-08-14T07:06:47.273197+06:00")

    def test_decimal_json_prices_are_exact_and_invalid_prices_unknown(self):
        source = flight(catalog([ad(prices=[{"currency": "USD", "amount": "DECIMAL"}])]))
        result = parse_page(source.replace('"DECIMAL"', "11300.29"))
        self.assertEqual(result.listings[0].price_usd_minor, 1130029)
        self.assertIsNone(result.listings[0].price_kgs_minor)
        for invalid in (
            None,
            "NaN",
            "Infinity",
            "-Infinity",
            -1,
            0,
            True,
            "не указана",
            "1e99999999",
        ):
            with self.subTest(invalid=invalid):
                result = parse_page(
                    flight(catalog([ad(prices=[{"currency": "USD", "amount": invalid}])]))
                )
                self.assertIsNone(result.listings[0].price_usd_minor)

    def test_explicit_inactive_status_removes_saved_car_from_search(self):
        store = Store(":memory:")
        profile = Profile(1, 1, "USD", 0, 2_000_000)
        try:
            store.upsert_listings(parse_page(flight(catalog([ad()]))).listings)
            self.assertEqual([car.id for car in store.search(profile)], ["mashina:10112178"])
            store.upsert_listings(parse_page(flight(catalog([ad(status="inactive")]))).listings)
            self.assertEqual(store.search(profile), [])
        finally:
            store.close()

    def test_mileage_fallback_preserves_units_without_inventing_them(self):
        result = parse_page(
            flight(
                catalog(
                    [
                        ad(
                            attributes=[
                                {
                                    "slug": "mileage",
                                    "value_json": {"value": "64000", "suffix": "km"},
                                }
                            ]
                        ),
                        ad(id=10112179, attributes=[{"slug": "mileage", "value_number": 12000}]),
                    ]
                )
            )
        )
        self.assertEqual([listing.mileage for listing in result.listings], ["64000 km", ""])

    def test_explicit_empty_final_page_is_not_a_schema_failure(self):
        result = parse_page(flight(catalog([], page=3, pages=3, total=42)), page=3)
        self.assertEqual(result.listings, [])
        self.assertEqual((result.page, result.pages, result.total), (3, 3, 42))
        self.assertEqual(parse_page(flight(catalog([], pages=0))).listings, [])

    def test_missing_malformed_ambiguous_and_wrong_page_catalogs_fail(self):
        invalid_sources = [
            "<html>Service unavailable</html>",
            flight({"items": [], "total": 0}),
            flight(catalog([{"title": "not a listing"}])),
            flight(catalog([ad()]))[:-10],
            flight(catalog([ad()], page=2, pages=2)),
            flight(catalog([], page=1, pages=3, total=42)),
            flight(catalog([ad()], total=True)),
            flight([catalog([ad()]), catalog([ad(id=10112179)])]),
            flight(catalog([ad(prices={})])),
            flight(catalog([ad(attributes={})])),
        ]
        for source in invalid_sources:
            with self.subTest(source=source):
                with self.assertRaises(SourceError):
                    parse_page(source)
