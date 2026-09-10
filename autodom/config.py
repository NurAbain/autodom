import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

SOURCE_IDS = ("mashina.kg", "encar.com", "truecar.com", "bid.cars")


def approved_sources() -> tuple[str, ...]:
    """An explicit operator allowlist, not a grant of source usage rights."""
    configured = os.environ.get("AUTODOM_APPROVED_SOURCES", "mashina.kg")
    selected = tuple(part.strip() for part in configured.split(",") if part.strip())
    if not selected or len(set(selected)) != len(selected) or set(selected) - set(SOURCE_IDS):
        raise ValueError("AUTODOM_APPROVED_SOURCES must contain unique known source IDs")
    return selected


@dataclass(frozen=True, slots=True)
class Settings:
    database: Path
    refresh_seconds: int = 300
    refresh_pages: int = 3
    crawl_delay: float = 2.0
    full_refresh_seconds: int = 86400
    monitor_seconds: int = 30
    backup_directory: Path | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        approved_sources()
        data_dir = Path(os.environ.get("AUTODOM_DATA_DIR", ".local")).expanduser()
        refresh = int(os.environ.get("AUTODOM_REFRESH_SECONDS", "300"))
        pages = int(os.environ.get("AUTODOM_REFRESH_PAGES", "3"))
        delay = float(os.environ.get("AUTODOM_CRAWL_DELAY", "2"))
        if refresh < 60 or not 1 <= pages <= 20 or not 1 <= delay <= 60:
            raise ValueError("Invalid crawl settings: refresh >=60s, pages 1..20, delay 1..60s")
        monitor = int(os.environ.get("AUTODOM_MONITOR_SECONDS", "30"))
        full_refresh = int(os.environ.get("AUTODOM_FULL_REFRESH_SECONDS", "86400"))
        if not 10 <= monitor <= 3600 or not refresh <= full_refresh <= 86400:
            raise ValueError(
                "Invalid monitoring/full refresh interval: monitor 10..3600s, refresh..86400s"
            )
        return cls(
            database=data_dir / "autodom.sqlite3",
            refresh_seconds=refresh,
            refresh_pages=pages,
            crawl_delay=delay,
            monitor_seconds=monitor,
            full_refresh_seconds=full_refresh,
            backup_directory=Path(
                os.environ.get("AUTODOM_BACKUP_DIR", str(data_dir / "backups"))
            ).expanduser(),
        )


def load_token() -> str:
    token = os.environ.get("AUTODOM_BOT_TOKEN", "").strip()
    if not token:
        try:
            result = subprocess.run(
                ["pass", "show", "autodom/telegram/bot-token"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError(
                "Set AUTODOM_BOT_TOKEN or save autodom/telegram/bot-token in pass"
            ) from None
        if result.returncode == 0:
            token = result.stdout.strip()
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]{30,}", token):
        raise RuntimeError("A valid Telegram bot token is required; token value is not logged")
    return token
