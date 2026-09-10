import json
import unittest
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

from autodom import bidcars
from autodom.source_http import SourceError, SourceRateLimited

URL = "https://bid.cars/en/lot/1-66587646/1969-Alfa-Romeo-Duetto-AR1480400"


def detail(
    *, ended=False, status=None, timezone="(UTC+00:00) UTC", mileage="59 197 mi (95 268 km)"
):
    vehicle = {
        "@type": "Vehicle",
        "url": URL,
        "name": "1969 Alfa Romeo Duetto | AR1480400 | BidCars",
        "vehicleIdentificationNumber": "AR1480400",
        "vehicleModelDate": "1969",
        "vehicleTransmission": "Manual",
        "vehicleEngine": {"name": ""},
        "image": "https://images.bid.cars/example.jpg",
        "offers": {"price": "475", "availability": "https://schema.org/OnlineOnly"},
    }
    label, amount = ("Final bid", "13,350") if ended else ("Current Bid", "450")
    status = (
        status
        if status is not None
        else (
            "Final auction ended"
            if ended
            else '<label id="time-left">3 d 23 h 43 min 16 sec</label>'
        )
    )
    buy = (
        ""
        if ended
        else """<div class="buy-now-wr"><div><div class="field-name">Fast Buy Price:</div>
      <div class="price">$38,500 USD</div></div><a>Buy Now</a></div>"""
    )
    return f'''<html><head><meta property="og:url" content="{URL}">
      <meta name="description" content="VIN: AR1480400 Lot: 1-66587646, Sale date: 2026-09-14 Location: Portland North (OR), USA | Odometer: 59 197 mi">
      <script type="application/ld+json">{json.dumps(vehicle)}</script></head><body>
      <div id="main-info"><div class="option">Lot<span class="right-info">1-<h2>66587646</h2></span></div>
      <div class="option">VIN<span class="right-info">AR1480400</span></div>
      <div class="option">Sale Document<span class="right-info"><span>Certificate of title (WI)</span><img alt="Approved"></span></div></div>
      <ul class="lot-info"><li class="location"><span>Location:</span>Portland North (OR)</li>
      <li class="est_price"><span>Estimated cost:</span><b>$475</b> - <b>$9,000</b></li></ul>
      <div id="secondary-info"><div class="option">Odometer<span class="right-info">{mileage}</span></div>
      <div class="option">Primary damage<span class="right-info">Minor dent / scratches</span></div>
      <div class="option">Secondary damage<span class="right-info">Normal wear</span></div>
      <div class="option start_code">Start code<span class="right-info">Run and Drive</span></div></div>
      <div id="tertiary-info"></div>
      <div id="bidding-info"><div class="lot-price-info"><div><div class="field-name">{label}</div>
      <span class="price current_bid">${amount} USD</span></div></div>
      <div class="bid-status">{status}</div>{buy}</div>
      <div id="history"><span class="current_bid">$999999</span>Final auction ended</div>
      <ul class="links-footer"><li><button>{timezone}</button></li></ul>
      <script>
var lotNumber = '1-66587646';
var isArchived = 0;
var currentBid = {0 if ended else 450};
var finalBid = {13350 if ended else 0};
var estimatedAmount1 = 475;
var estimatedAmount2 = 9000;
var buyNowAmount = {0 if ended else 38500};
var auctionType = 'Copart';
var liveAuctionStartDateTime = '2026-09-14 21:00:00';
      </script></body></html>'''


def archived_detail():
    return (
        detail(ended=True)
        .replace(" | BidCars", " | Bid History | BidCars")
        .replace("https://images.bid.cars/", "https://mercury.bid.cars/")
        .replace(
            '<div class="bid-status">Final auction ended</div>',
            '<div id="archieved-message">You are watching archived offer. Auction ended.</div>',
        )
        .replace(
            '<li class="est_price"><span>Estimated cost:</span><b>$475</b> - <b>$9,000</b></li>', ""
        )
        .replace("var estimatedAmount1 = 475", "var estimatedAmount1 = 0")
        .replace("var estimatedAmount2 = 9000", "var estimatedAmount2 = 0")
        .replace("var isArchived = 0", "var isArchived = 1")
    )


class DetailTests(unittest.TestCase):
    def test_estimate_is_not_price_and_old_chassis_is_preserved(self):
        listing = bidcars.parse_detail(detail(), URL)
        self.assertEqual(listing.id, "bidcars:1-66587646")
        self.assertEqual(listing.vin, "AR1480400")
        self.assertEqual(listing.original_price_minor, 3_850_000)
        self.assertEqual(listing.current_bid_minor, 45_000)
        self.assertEqual(
            (listing.estimated_min_minor, listing.estimated_max_minor), (47_500, 900_000)
        )
        self.assertEqual(listing.mileage, "59197 miles")
        self.assertEqual(listing.auction_at, datetime(2026, 9, 14, 21, tzinfo=UTC).timestamp())
        self.assertEqual(listing.start_code, "Run and Drive")
        self.assertIn("аукциона", listing.condition)
        self.assertEqual(listing.sale_document, "Certificate of title (WI)")
        self.assertEqual(listing.auction_status, "active")

    def test_final_auction_keeps_history_without_a_purchase_price(self):
        listing = bidcars.parse_detail(detail(ended=True), URL)
        self.assertEqual(listing.final_bid_minor, 1_335_000)
        self.assertEqual(listing.auction_status, "ended")
        self.assertEqual(listing.availability, "Завершено")
        self.assertIsNone(listing.original_price_minor)
        self.assertIsNone(listing.price("USD"))

    def test_archived_result_without_live_status_or_estimate_is_not_an_offer(self):
        listing = bidcars.parse_detail(archived_detail(), URL)
        self.assertEqual(listing.title, "1969 Alfa Romeo Duetto")
        self.assertEqual(listing.final_bid_minor, 1_335_000)
        self.assertEqual(listing.auction_status, "ended")
        self.assertIsNone(listing.current_bid_minor)
        self.assertIsNone(listing.estimated_min_minor)
        self.assertIsNone(listing.price("USD"))
        with self.assertRaises(SourceError):
            bidcars.parse_detail(archived_detail().replace("archieved-message", "unrelated"), URL)

    def test_zero_current_bid_is_known_but_never_becomes_the_budget_price(self):
        source = (
            detail()
            .replace("$450 USD", "$0 USD")
            .replace("var currentBid = 450", "var currentBid = 0")
        )
        listing = bidcars.parse_detail(source, URL)
        self.assertEqual(listing.current_bid_minor, 0)
        self.assertEqual(listing.original_price_minor, 3_850_000)
        self.assertIsNone(listing.final_bid_minor)

    def test_source_body_style_drives_selected_body_filter(self):
        from autodom.matching import matches
        from autodom.models import Profile

        source = detail().replace(
            '<div id="tertiary-info">',
            '<div id="tertiary-info"><div class="option">Body Style<span class="right-info">Sport Utility</span></div>',
        )
        listing = bidcars.parse_detail(source, URL)
        with (
            patch.dict("os.environ", {"AUTODOM_APPROVED_SOURCES": "bid.cars"}),
            patch("autodom.models.time.time", return_value=listing.auction_at - 60),
        ):
            self.assertTrue(
                matches(Profile(1, 1, "USD", 0, 4_000_000, market="US", body_type="suv"), listing)
            )
            self.assertFalse(
                matches(Profile(1, 1, "USD", 0, 4_000_000, market="US", body_type="sedan"), listing)
            )

    def test_nonfinal_or_unknown_status_never_uses_onlineonly(self):
        listing = bidcars.parse_detail(detail(status="Preliminary auction ended"), URL)
        self.assertEqual(listing.auction_status, "unknown")
        self.assertIsNone(listing.original_price_minor)

    def test_ambiguous_timezone_is_not_a_budget_deadline(self):
        for zone in ("", "(UTC+02:00) Europe/Warsaw", "(UTC+00:00) UTC (UTC+02:00) GMT+2"):
            with self.subTest(zone=zone):
                listing = bidcars.parse_detail(detail(timezone=zone), URL)
                self.assertIsNone(listing.auction_at)
                self.assertIsNone(listing.price("USD"))

    def test_rounded_mileage_never_becomes_exact(self):
        listing = bidcars.parse_detail(detail(mileage="52k mi"), URL)
        self.assertEqual(listing.mileage, "")

    def test_identity_and_labeled_amount_conflicts_fail(self):
        for old, new in (
            ("var lotNumber = '1-66587646'", "var lotNumber = '1-12345678'"),
            ("var currentBid = 450", "var currentBid = 475"),
            ("var buyNowAmount = 38500", "var buyNowAmount = 38501"),
            ("var estimatedAmount1 = 475", "var estimatedAmount1 = 476"),
            ("var currentBid = 450", "var currentBid = calculate()"),
        ):
            with self.subTest(new=new), self.assertRaises(SourceError):
                bidcars.parse_detail(detail().replace(old, new), URL)

    def test_canadian_yard_is_not_us_inventory(self):
        source = (
            detail().replace("Portland North (OR)", "Toronto (ON)").replace(", USA |", ", Canada |")
        )
        self.assertIsNone(bidcars.parse_detail(source, URL))

    def test_missing_required_structure_is_not_an_empty_record(self):
        with self.assertRaises(SourceError):
            bidcars.parse_detail(detail().replace('id="secondary-info"', 'id="changed-info"'), URL)

    def test_known_unknown_values_do_not_invent_vehicle_claims(self):
        source = (
            detail(mileage="No information")
            .replace("Normal wear", "-")
            .replace("Run and Drive", "No information")
            .replace(
                "var liveAuctionStartDateTime = '2026-09-14 21:00:00'",
                "var liveAuctionStartDateTime = ''",
            )
        )
        listing = bidcars.parse_detail(source, URL)
        self.assertEqual(
            (listing.mileage, listing.secondary_damage, listing.start_code), ("", "", "")
        )
        self.assertIsNone(listing.auction_at)
        self.assertIsNone(listing.price("USD"))

    def test_truncated_document_is_not_a_successful_partial_detail(self):
        with self.assertRaises(SourceError):
            bidcars.parse_detail(detail().replace("</html>", ""), URL)


def row(url=URL, lot="1-66587646", title="1969 Alfa Romeo Duetto"):
    return f'''<div class="item-horizontal lots-search" id="{lot}">
      <a class="gallery" href="https://bid.cars/en/lot/0-111/Unrelated">Decorative</a>
      <div class="name"><a class="item-title" href="{url}">{title}</a></div>
      <h2 class="vin_title"><a href="{url}">AR1480400</a></h2>
      <span class="vin_title">{lot}</span><span>52k mi</span></div>'''


def catalog(rows=None, *, page=1, pages=1, base=bidcars.CATALOG_URL):
    rows = [row()] if rows is None else rows
    url = base.rsplit("/", 1)[0] + f"/{page}"
    links = "".join(
        f'<li class="active"><a href="#">{number}</a></li>'
        if number == page
        else f'<li><a href="{base.rsplit("/", 1)[0]}/{number}">{number}</a></li>'
        for number in range(1, pages + 1)
    )
    return f'''<html><head><meta property="og:url" content="{url}">
      <link rel="canonical" href="{url}"></head><body>
      <div id="search_area">{"".join(rows)}</div>
      <div class="breadcrumbs"><ul>{links}</ul></div>
      <div class="recommended">{row(lot="0-123", url="https://bid.cars/en/lot/0-123/Other")}</div>
      <span>385281 Live auctions</span></body></html>'''


class CatalogTests(unittest.TestCase):
    def test_only_identified_rows_are_discovered_and_duplicates_collapse(self):
        result = bidcars.parse_catalog(catalog([row(), row()], pages=3))
        self.assertEqual(result.urls, (URL,))
        self.assertEqual((result.page, result.pages, result.total), (1, 3, None))

    def test_scope_page_and_identity_conflicts_fail_whole_page(self):
        for source in (
            catalog(page=2, pages=3),
            catalog().replace(
                'rel="canonical" href="https://bid.cars/en/automobile/page/1"',
                'rel="canonical" href="https://bid.cars/en/automobile/toyota/page/1"',
            ),
            catalog([row(), row(title="Conflicting vehicle")]),
            catalog([row(lot="1-99999999")]),
            catalog([row(url="https://bid.cars/app/lot/1-66587646")]),
        ):
            with self.subTest(source=source), self.assertRaises(SourceError):
                bidcars.parse_catalog(source)

    def test_empty_final_page_is_not_a_schema_failure(self):
        result = bidcars.parse_catalog(catalog([]))
        self.assertEqual(result.urls, ())
        self.assertIsNone(result.total)
        with self.assertRaises(SourceError):
            bidcars.parse_catalog(catalog([], pages=2))

    def test_catalog_configuration_cannot_escape_public_scope(self):
        for url in (
            "http://bid.cars/en/automobile/page/1",
            "https://bid.cars:443/en/automobile/page/1",
            "https://user@bid.cars/en/automobile/page/1",
            "https://bid.cars/en/automobile/page/2",
            "https://bid.cars/en/automobile/page/1?",
            "https://bid.cars/en/automobile/%2e%2e/page/1",
            "https://bid.cars/en/search/results?query=Toyota",
        ):
            with (
                self.subTest(url=url),
                patch.dict("os.environ", {"AUTODOM_BIDCARS_CATALOG_URL": url}),
            ):
                with self.assertRaises(SourceError):
                    bidcars.catalog_url()


class FetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_permission_is_checked_before_network(self):
        with (
            patch.dict("os.environ", {"AUTODOM_APPROVED_SOURCES": "mashina.kg"}),
            patch("autodom.bidcars.fetch_document", new_callable=AsyncMock) as fetch,
        ):
            with self.assertRaises(SourceError):
                await bidcars.fetch_page(object(), proxies=())
        fetch.assert_not_awaited()

    async def test_detail_failure_does_not_return_a_partial_page(self):
        second = "https://bid.cars/en/lot/1-11111111/Other-AR1480400"
        calls = []

        async def transport(session, url, parse, **kwargs):
            calls.append(url)
            if url == bidcars.CATALOG_URL:
                return parse(catalog([row(), row(url=second, lot="1-11111111")]))
            if url == URL:
                return parse(detail())
            raise SourceRateLimited(300)

        with (
            patch("autodom.bidcars.require_source_access"),
            patch("autodom.bidcars.fetch_document", side_effect=transport),
            patch("autodom.bidcars.asyncio.sleep", new_callable=AsyncMock),
        ):
            with self.assertRaises(SourceRateLimited):
                await bidcars.fetch_page(object(), proxies=())
        self.assertEqual(calls, [bidcars.CATALOG_URL, URL, second])
