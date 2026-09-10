"""Bounded public-source requests with mandatory proxy transport."""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp

from .config import approved_sources
from .proxy import ProxyRoute

logger = logging.getLogger(__name__)
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class SourceError(Exception):
    """The source could not provide a trustworthy document."""


class SourceRateLimited(SourceError):
    def __init__(self, retry_after: int) -> None:
        self.retry_after = retry_after
        super().__init__(f"Source rate limit; collection paused for {retry_after} seconds")


def require_source_access(source: str) -> None:
    if source not in approved_sources():
        raise SourceError(f"{source}: automated access is disabled pending source permission")


def _retry_after(value: str) -> int:
    if value.isdecimal() and len(value) < 9:
        return max(60, int(value))
    try:
        instant = parsedate_to_datetime(value)
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=UTC)
        return max(60, int((instant - datetime.now(UTC)).total_seconds()))
    except (TypeError, ValueError, OverflowError):
        return 300


async def fetch_document[T](
    session: aiohttp.ClientSession,
    url: str,
    parse: Callable[[str], T],
    *,
    source: str,
    proxies: tuple[ProxyRoute, ...],
    page: int = 1,
    params: dict | None = None,
    headers: dict | None = None,
    method: str = "GET",
    payload: Any = None,
) -> T:
    if type(page) is not int or page < 1:
        raise SourceError("Catalog page must be a positive integer")
    if not proxies:
        raise SourceError("Scraping requires configured proxies; direct access is disabled")
    failures = []
    request_headers = {"User-Agent": "AutodomBot/0.2", "Accept": "application/json,text/html,*/*"}
    request_headers.update(headers or {})
    for route in proxies:
        try:
            async with session.request(
                method,
                url,
                params=params,
                headers=request_headers,
                json=payload,
                proxy=route.url_for(page),
                proxy_headers={"Proxy-Authorization": route.authorization},
                timeout=aiohttp.ClientTimeout(total=40),
                allow_redirects=False,
            ) as response:
                if response.status == 429:
                    raise SourceRateLimited(_retry_after(response.headers.get("Retry-After", "")))
                if response.status != 200:
                    raise SourceError(f"{source} returned HTTP {response.status}")
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise SourceError(f"{source} response exceeds size limit")
                result = parse(body.decode("utf-8"))
                logger.info("%s page %s collected via %s proxy", source, page, route.tier)
                return result
        except SourceRateLimited:
            # A server limit applies to this source, not merely one proxy IP.
            raise
        except (TimeoutError, SourceError, aiohttp.ClientError, UnicodeDecodeError) as error:
            reason = str(error) if isinstance(error, SourceError) else type(error).__name__
            if isinstance(error, aiohttp.ClientResponseError):
                reason += f" HTTP {error.status}"
            failures.append(f"{route.tier}: {reason}")
            logger.warning("%s proxy route unavailable: %s (%s)", source, route.tier, reason)
    raise SourceError(f"{source}: all proxy routes failed: " + "; ".join(failures))
