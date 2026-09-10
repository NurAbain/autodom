import asyncio
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import aiohttp
import pytest

from autodom import mashina
from autodom.mashina import SourceError, SourceRateLimited, fetch_page
from autodom.proxy import ProxyRoute, load_proxy_routes


@contextmanager
def endpoint(status, requests, body=b"", retry_after=None):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(status)
            if retry_after:
                self.send_header("Retry-After", retry_after)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def fetch(proxies):
    async def run():
        async with aiohttp.ClientSession() as session:
            return await fetch_page(session, proxies=proxies)

    return asyncio.run(run())


def test_failed_datacenter_uses_residential_without_contacting_origin(monkeypatch):
    body = json.dumps(
        {
            "items": [
                {
                    "id": 1,
                    "title": "Toyota Camry",
                    "slug": "toyota",
                    "status": "active",
                    "availability": "В наличии",
                    "prices": [{"currency": "USD", "amount": "12000"}],
                }
            ],
            "total": 1,
            "pages": 1,
            "page": 1,
            "size": 21,
        }
    ).encode()
    direct, datacenter, residential = [], [], []
    with (
        endpoint(200, direct, body) as origin,
        endpoint(503, datacenter) as dc,
        endpoint(200, residential, body) as resident,
    ):
        monkeypatch.setattr(mashina, "CATALOG_URL", origin)
        page = fetch(
            (
                ProxyRoute("datacenter", dc, "Basic dGVzdDp0ZXN0"),
                ProxyRoute("residential", resident, "Basic dGVzdDp0ZXN0"),
            )
        )
    assert [listing.title for listing in page.listings] == ["Toyota Camry"]
    assert not direct
    assert datacenter and residential


def test_all_failed_proxies_do_not_leak_a_direct_request(monkeypatch):
    direct, proxied = [], []
    with endpoint(200, direct) as origin, endpoint(407, proxied) as proxy:
        monkeypatch.setattr(mashina, "CATALOG_URL", origin)
        with pytest.raises(SourceError):
            fetch(
                (
                    ProxyRoute("datacenter", proxy, "Basic dGVzdDp0ZXN0"),
                    ProxyRoute("residential", proxy, "Basic dGVzdDp0ZXN0"),
                )
            )
        with pytest.raises(SourceError):
            fetch(())
    assert not direct


def test_rate_limit_pauses_crawler_instead_of_rotating_around_it(monkeypatch):
    throttled, fallback = [], []
    with (
        endpoint(429, throttled, retry_after="7200") as primary,
        endpoint(200, fallback) as secondary,
    ):
        monkeypatch.setattr(mashina, "CATALOG_URL", "http://127.0.0.1:1/catalog")
        with pytest.raises(SourceRateLimited) as captured:
            fetch(
                (
                    ProxyRoute("datacenter", primary, "Basic dGVzdDp0ZXN0"),
                    ProxyRoute("residential", secondary, "Basic dGVzdDp0ZXN0"),
                )
            )
    assert captured.value.retry_after >= 7200
    assert not fallback


def test_missing_second_tier_credentials_fail_before_scraping(monkeypatch):
    monkeypatch.setenv("SMARTPROXY_USERNAME", "fixture-user")
    monkeypatch.setenv("SMARTPROXY_PASSWORD", "fixture-password")
    monkeypatch.delenv("SMARTPROXY_RESIDENTIAL_USERNAME", raising=False)
    monkeypatch.delenv("SMARTPROXY_RESIDENTIAL_PASSWORD", raising=False)
    with pytest.raises(ValueError):
        load_proxy_routes()
