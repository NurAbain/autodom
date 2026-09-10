import base64
import copy
import json
import unittest
from unittest.mock import patch

from autodom.source_http import SourceError
from autodom.truecar import fetch_page, parse_page

VIN = "1ABCDEFGH23456789"
OTHER_VIN = "1ABCDEFGH23456780"


def cursor(number):
    return base64.b64encode(str(number).encode()).decode().rstrip("=")


def fixture(*, page=1, total=1, size=1, vin=VIN):
    args = {
        "filters": {
            "condition": "USED",
            "fallbackStrategy": "SIMPLE",
            "makeModelTrim": [{"makeSlug": "toyota", "modelSlug": "camry"}],
            "withinRadius": {"distance": 75, "postalCode": "10017"},
        },
        "first": size,
        "offset": (page - 1) * size,
        "sort": "BEST_MATCH",
    }
    row = {
        "__typename": "ConsumerSummaryListing",
        "pricing": {
            "listPrice": "12345.67",
            "exclusion": "NO_EXCLUSION",
            "discountLabel": "UPFRONT_PRICE",
            "totalMsrp": 99999,
        },
        "precalculatedLease": {"monthlyPayment": 99},
        "vehicle": {
            "vin": vin,
            "condition": "USED",
            "year": 2020,
            "mileage": 12001,
            "make": {"name": "Toyota", "slug": "toyota"},
            "model": {"name": "Camry", "slug": "camry"},
            "style": {"trimName": "LE"},
            "transmission": "Automatic",
            "bodyStyle": "SEDAN",
            "details": {
                "vin": vin,
                "mileage": 12001,
                "dealerCity": "Example City",
                "dealerState": "NY",
                "listedAt": "2026-08-01T12:00:00Z",
            },
        },
        "conditionHistory": {"accidentCount": 3, "ownerCount": 2, "isCleanTitle": True},
    }
    linked = {
        "@type": "Vehicle",
        "vehicleIdentificationNumber": vin,
        "itemCondition": "UsedCondition",
        "vehicleModelDate": "2020",
        "brand": {"name": "Toyota"},
        "model": "Camry",
        "vehicleConfiguration": "LE",
        "mileageFromOdometer": {"value": 12001},
        "image": "https://listings-prod.tcimg.net/synthetic.jpg",
        "offers": {
            "@type": "Offer",
            "price": "12345.67",
            "priceCurrency": "USD",
            "sku": vin,
            "url": f"https://www.truecar.com/used-cars-for-sale/listing/{vin}/",
        },
    }
    connection = {
        "__typename": "MarketplaceSearchConnection",
        "isFallback": False,
        "totalCount": total,
        "edges": [{"cursor": cursor(args["offset"] + 1), "node": {"__ref": "connected"}}],
        "pageInfo": {
            "endCursor": cursor(args["offset"] + 1),
            "hasNextPage": args["offset"] + 1 < total,
        },
    }
    return args, connection, row, linked


def document(parts, *, extra_root=None, extra_state=None, query=None):
    args, connection, row, linked = parts
    root = {**(extra_root or {}), "marketplaceListingSearch(" + json.dumps(args) + ")": connection}
    state = {"ROOT_QUERY": root, "connected": row}
    state.update(extra_state or {})
    data = {
        "isFallback": False,
        "query": query
        or {
            "condition": "used",
            "page": str(args["offset"] // args["first"] + 1),
            "splat": ["toyota", "camry"],
        },
        "props": {"pageProps": {"__APOLLO_STATE__": state}},
    }
    ld = {
        "@graph": [
            {
                "@type": "CollectionPage",
                "mainEntity": {
                    "itemListElement": [{"item": linked}] if connection["edges"] else [],
                },
            }
        ]
    }
    return (
        '<html><script type="application/json" id="__NEXT_DATA__">'
        + json.dumps(data)
        + '</script><script type="application/ld+json">'
        + json.dumps(ld)
        + "</script></html>"
    )


class TrueCarParserTests(unittest.TestCase):
    def test_sponsored_cache_does_not_replace_the_main_catalog(self):
        parts = fixture()
        sponsored_args = {**parts[0], "first": 3, "sponsored": True}
        sponsored_args.pop("sort")
        sponsored = copy.deepcopy(parts[1])
        sponsored["edges"][0]["node"]["__ref"] = "advertising-only"
        result = parse_page(
            document(
                parts,
                extra_root={
                    "marketplaceListingSearch(" + json.dumps(sponsored_args) + ")": sponsored
                },
            )
        )
        self.assertEqual([listing.id for listing in result.listings], [f"truecar:{VIN}"])
        self.assertEqual((result.total, result.pages), (1, 1))

    def test_model_artwork_is_not_presented_as_a_vehicle_photo(self):
        parts = fixture()
        parts[3]["image"] = "https://static.tcimg.net/vehicles/primary/model-example.png"
        result = parse_page(document(parts))
        self.assertEqual(result.listings[0].id, f"truecar:{VIN}")
        self.assertIsNone(result.listings[0].photo_url)

    def test_only_connected_inventory_and_asking_price_are_used(self):
        parts = fixture()
        unrelated = copy.deepcopy(parts[2])
        unrelated["vehicle"]["vin"] = OTHER_VIN
        result = parse_page(document(parts, extra_state={"unrelated": unrelated}))
        self.assertEqual([car.id for car in result.listings], [f"truecar:{VIN}"])
        car = result.listings[0]
        self.assertEqual((car.original_currency, car.original_price_minor), ("USD", 1234567))
        self.assertEqual(car.price_usd_minor, 1234567)
        self.assertIsNone(car.price_kgs_minor)
        self.assertEqual((car.title, car.trim, car.year), ("2020 Toyota Camry LE", "LE", 2020))
        self.assertEqual((car.mileage, car.city), ("12001 miles", "Example City, NY"))
        self.assertEqual(car.availability, "Опубликовано")
        self.assertEqual(car.photo_url, "https://listings-prod.tcimg.net/synthetic.jpg")
        self.assertEqual(car.url, f"https://www.truecar.com/used-cars-for-sale/listing/{VIN}/")
        self.assertIsNone(car.observed_at)
        self.assertEqual(car.published_at, "2026-08-01T12:00:00Z")

    def test_scope_and_identity_survive_ranked_page_overlap(self):
        first = parse_page(document(fixture(total=2)))
        second = parse_page(document(fixture(page=2, total=2)), page=2)
        self.assertEqual(first.listings[0].id, second.listings[0].id)
        self.assertEqual((second.page, second.total, second.pages), (2, 2, 2))
        self.assertEqual(first.scope, second.scope)
        scope = json.loads(first.scope.removeprefix("truecar.com:"))
        self.assertEqual(scope["filters"]["withinRadius"], {"distance": 75, "postalCode": "10017"})
        elsewhere = fixture()
        elsewhere[0]["filters"]["withinRadius"]["postalCode"] = "90210"
        self.assertNotEqual(first.scope, parse_page(document(elsewhere)).scope)

    def test_history_never_infers_accident_free_from_clean_title(self):
        car = parse_page(document(fixture())).listings[0]
        self.assertIn("TrueCar сообщает: зарегистрированных ДТП — 3", car.condition)
        self.assertIn("clean title — да", car.condition)
        self.assertNotIn("ДТП — 0", car.condition)
        for history in (None, {}, {"isCleanTitle": True, "accidentCount": None, "ownerCount": 0}):
            with self.subTest(history=history):
                parts = fixture()
                parts[2]["conditionHistory"] = history
                condition = parse_page(document(parts)).listings[0].condition
                self.assertIn("ДТП — неизвестно", condition)
                self.assertNotIn("ДТП — 0", condition)
                if history and history.get("ownerCount") == 0:
                    self.assertIn("история не подтверждена", condition)
                else:
                    self.assertIn("владельцев — неизвестно", condition)

    def test_missing_history_and_explicit_zero_are_distinct(self):
        parts = fixture()
        del parts[2]["conditionHistory"]
        unknown = parse_page(document(parts)).listings[0].condition
        parts[2]["conditionHistory"] = {"accidentCount": 0}
        reported = parse_page(document(parts)).listings[0].condition
        self.assertIn("ДТП — неизвестно", unknown)
        self.assertIn("TrueCar сообщает: зарегистрированных ДТП — 0", reported)
        self.assertIn("title — неизвестно", reported)

    def test_missing_or_invalid_list_price_never_falls_back_to_msrp_or_lease(self):
        for price in (None, True, 0, -1, "NaN", "Infinity", "123.456", "1e999999"):
            with self.subTest(price=price):
                parts = fixture()
                parts[2]["pricing"]["listPrice"] = price
                with self.assertRaises(SourceError):
                    parse_page(document(parts))

    def test_mismatched_currency_price_link_and_offer_types_fail_closed(self):
        mutations = [
            ("priceCurrency", "KRW"),
            ("price", "12345.68"),
            ("url", f"https://www.truecar.com.evil.example/used-cars-for-sale/listing/{VIN}/"),
            ("url", f"https://www.truecar.com/used-cars-for-sale/listing/{OTHER_VIN}/"),
            ("url", f"http://www.truecar.com/used-cars-for-sale/listing/{VIN}/"),
            ("@type", "AggregateOffer"),
            ("priceSpecification", {"unitText": "MONTH"}),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                parts = fixture()
                parts[3]["offers"][key] = value
                with self.assertRaises(SourceError):
                    parse_page(document(parts))
        parts = fixture()
        parts[2]["pricing"]["exclusion"] = "CONDITIONAL_DISCOUNT"
        with self.assertRaises(SourceError):
            parse_page(document(parts))

    def test_fallback_incomplete_count_cursor_and_page_mismatches_fail(self):
        cases = []
        parts = fixture()
        parts[1]["isFallback"] = True
        cases.append(parts)
        parts = fixture(total=2, size=2)
        cases.append(parts)
        parts = fixture()
        parts[1]["pageInfo"]["hasNextPage"] = True
        cases.append(parts)
        parts = fixture()
        parts[1]["pageInfo"]["endCursor"] = cursor(2)
        cases.append(parts)
        parts = fixture()
        parts[1]["edges"][0]["cursor"] = cursor(2)
        cases.append(parts)
        parts = fixture()
        parts[1]["totalCount"] = True
        cases.append(parts)
        parts = fixture()
        parts[1]["edges"][0]["node"]["__ref"] = "absent"
        cases.append(parts)
        for parts in cases:
            with self.subTest(parts=parts):
                with self.assertRaises(SourceError):
                    parse_page(document(parts))
        with self.assertRaises(SourceError):
            parse_page(document(fixture(total=2)), page=2)

    def test_wrong_connection_is_ignored_but_ambiguous_matches_fail(self):
        parts = fixture()
        other_args = copy.deepcopy(parts[0])
        other_args["offset"] = 1
        key = "marketplaceListingSearch(" + json.dumps(other_args) + ")"
        result = parse_page(document(parts, extra_root={key: {"invalid": "unconnected"}}))
        self.assertEqual(result.listings[0].id, f"truecar:{VIN}")
        other_args["offset"] = 0
        other_args["filters"]["withinRadius"]["postalCode"] = "90210"
        key = "marketplaceListingSearch(" + json.dumps(other_args) + ")"
        with self.assertRaises(SourceError):
            parse_page(document(parts, extra_root={key: parts[1]}))

    def test_challenge_truncated_schema_and_wrong_mileage_units_fail(self):
        for html in (
            "<html>Access denied</html>",
            '<script src="/_Incapsula_Resource"></script>',
            document(fixture())[:-40],
            '<script id="__NEXT_DATA__">{}</script>',
        ):
            with self.subTest(html=html[:80]):
                with self.assertRaises(SourceError):
                    parse_page(html)
        parts = fixture()
        parts[3]["mileageFromOdometer"]["unitCode"] = "KMT"
        with self.assertRaises(SourceError):
            parse_page(document(parts))

    def test_empty_search_is_valid_only_with_consistent_count(self):
        parts = fixture(total=0)
        parts[1]["edges"] = []
        parts[1]["pageInfo"] = {"endCursor": None, "hasNextPage": False}
        result = parse_page(document(parts))
        self.assertEqual((result.listings, result.total, result.pages), ([], 0, 0))


class TrueCarAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_permission_is_required_before_transport(self):
        with (
            patch.dict(
                "os.environ",
                {
                    "AUTODOM_APPROVED_SOURCES": "mashina.kg",
                    "AUTODOM_TRUECAR_SEARCH_URL": "https://www.truecar.com/used-cars-for-sale/listings/toyota/camry/",
                },
            ),
            patch(
                "autodom.truecar.fetch_document",
                side_effect=AssertionError("Unauthorized network access"),
            ),
        ):
            with self.assertRaises(SourceError):
                await fetch_page(None, proxies=())

    async def test_configured_urls_cannot_target_other_hosts_or_nonsearch_routes(self):
        urls = [
            "http://www.truecar.com/used-cars-for-sale/listings/toyota/camry/",
            "https://www.truecar.com.evil.example/used-cars-for-sale/listings/toyota/camry/",
            "https://www.truecar.com/abp/api/vehicles/",
            "https://www.truecar.com/used-cars-for-sale/listings/toyota/camry/?zip=10017&zip=90210",
        ]
        with (
            patch.dict("os.environ", {"AUTODOM_APPROVED_SOURCES": "truecar.com"}),
            patch(
                "autodom.truecar.fetch_document",
                side_effect=AssertionError("Unsafe URL reached transport"),
            ),
        ):
            for url in urls:
                with (
                    self.subTest(url=url),
                    patch.dict("os.environ", {"AUTODOM_TRUECAR_SEARCH_URL": url}),
                ):
                    with self.assertRaises(SourceError):
                        await fetch_page(None, proxies=())

    async def test_transport_response_must_match_configured_scope(self):
        async def captured_response(session, url, parse, **kwargs):
            return parse(document(fixture()))

        with (
            patch.dict(
                "os.environ",
                {
                    "AUTODOM_APPROVED_SOURCES": "truecar.com",
                    "AUTODOM_TRUECAR_SEARCH_URL": "https://www.truecar.com/used-cars-for-sale/listings/honda/civic/",
                },
            ),
            patch("autodom.truecar.fetch_document", side_effect=captured_response),
        ):
            with self.assertRaises(SourceError):
                await fetch_page(None, proxies=())

        parts = fixture()
        query = {"condition": "used", "page": "1", "splat": ["toyota", "camry"], "zip": "90210"}

        async def wrong_location(session, url, parse, **kwargs):
            return parse(document(parts, query=query))

        with (
            patch.dict(
                "os.environ",
                {
                    "AUTODOM_APPROVED_SOURCES": "truecar.com",
                    "AUTODOM_TRUECAR_SEARCH_URL": "https://www.truecar.com/used-cars-for-sale/listings/toyota/camry/?zip=90210",
                },
            ),
            patch("autodom.truecar.fetch_document", side_effect=wrong_location),
        ):
            with self.assertRaises(SourceError):
                await fetch_page(None, proxies=())
