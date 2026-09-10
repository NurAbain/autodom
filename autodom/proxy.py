"""Domcom's Decodo datacenter route, with its residential route as fallback."""

import os
from base64 import b64encode
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class ProxyRoute:
    tier: str
    url: str
    authorization: str = field(repr=False)
    port_start: int = 0
    port_count: int = 0

    def url_for(self, page: int) -> str:
        if not self.port_count:
            return self.url
        port = self.port_start + (page - 1) % self.port_count
        return self.url.rsplit(":", 1)[0] + f":{port}"


def _route(tier: str, endpoint: str, username: str, password: str) -> ProxyRoute:
    if not username or not password:
        raise ValueError(f"Configure the {tier} SMARTPROXY username and password")
    try:
        parsed = urlsplit(endpoint if "://" in endpoint else "http://" + endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.port is None
            or parsed.username is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        if ":" in username:
            raise ValueError
        authorization = "Basic " + b64encode(f"{username}:{password}".encode("latin1")).decode(
            "ascii"
        )
        port_start = int(os.environ.get(f"SMARTPROXY_{tier.upper()}_PORT_START", "0"))
        port_count = int(os.environ.get(f"SMARTPROXY_{tier.upper()}_PORT_COUNT", "0"))
        if port_count < 0 or (
            port_count and not 1 <= port_start <= port_start + port_count - 1 <= 65535
        ):
            raise ValueError
    except (ValueError, UnicodeError):
        raise ValueError(f"Invalid {tier} SMARTPROXY endpoint or authentication format") from None
    return ProxyRoute(
        tier, parsed._replace(path="").geturl(), authorization, port_start, port_count
    )


def load_proxy_routes() -> tuple[ProxyRoute, ProxyRoute]:
    """Require both configured tiers. Never fall back to direct internet access."""
    username = os.environ.get("SMARTPROXY_USERNAME", "").strip()
    password = os.environ.get("SMARTPROXY_PASSWORD", "").strip()
    datacenter = _route(
        "datacenter",
        os.environ.get("SMARTPROXY_DATACENTER_ENDPOINT")
        or os.environ.get("SMARTPROXY_ENDPOINT")
        or "dc.decodo.com:10000",
        username,
        password,
    )
    residential = _route(
        "residential",
        os.environ.get("SMARTPROXY_RESIDENTIAL_ENDPOINT") or "gate.decodo.com:7000",
        os.environ.get("SMARTPROXY_RESIDENTIAL_USERNAME", "").strip(),
        os.environ.get("SMARTPROXY_RESIDENTIAL_PASSWORD", "").strip(),
    )
    return datacenter, residential
