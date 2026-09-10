import argparse
import asyncio
import fcntl
import json
import logging
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from pathlib import Path

from autodom.config import Settings, load_token
from autodom.proxy import load_proxy_routes
from autodom.runtime import run_bot, sync_pages
from autodom.sources import source_status
from autodom.storage import Store


class SecretFormatter(logging.Formatter):
    def __init__(self, secrets: list[str]):
        super().__init__("%(asctime)s %(levelname)s %(name)s: %(message)s")
        self.secrets = [value for value in secrets if value]

    def format(self, record: logging.LogRecord) -> str:
        output = super().format(record)
        for secret in self.secrets:
            output = output.replace(secret, "[redacted]")
        return output


@contextmanager
def writer_lock(database: Path):
    """SQLite serializes transactions; this also prevents two Telegram pollers."""
    descriptor = os.open(database.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another Autodom writer is using this data directory") from None
        yield
    finally:
        os.close(descriptor)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="autodom",
        description="Car search and free Telegram monitoring. Configuration: .env.example.",
        epilog="Setup: uv sync --dev; export settings; uv run autodom sync --pages 3; uv run autodom run. "
        "Scraping requires both Domcom SMARTPROXY tiers. No direct scraping is allowed. "
        "Foreign sources require explicit permission and AUTODOM_APPROVED_SOURCES opt-in. "
        "Restore into a NEW directory with autodom restore SNAPSHOT --destination NEW_DIRECTORY/autodom.sqlite3; "
        "never replace a running database. Backups are local, retained seven days, not off-site protection.",
    )
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "run", help="Run the bot, proxy-only collector, monitor and local daily backup"
    )
    sync = commands.add_parser("sync", help="Collect real catalog pages through configured proxies")
    sync.add_argument("--pages", type=int, default=3)
    commands.add_parser("status", help="Show catalog counters and worker state, without user data")
    commands.add_parser(
        "health", help="Exit successfully only while runtime and monitor heartbeats are fresh"
    )
    backup = commands.add_parser(
        "backup", help="Create a new self-contained SQLite snapshot, including WAL"
    )
    backup.add_argument("destination", type=Path)
    restore = commands.add_parser(
        "restore", help="Restore a snapshot to a NEW file; never overwrite live data"
    )
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("--destination", required=True, type=Path)
    return result


def main() -> None:
    arguments = parser().parse_args()
    os.umask(0o077)
    secret_values = [
        value
        for key, value in os.environ.items()
        if key == "AUTODOM_BOT_TOKEN"
        or key.startswith("SMARTPROXY_")
        and key.endswith(("PASSWORD", "USERNAME"))
    ]
    formatter = SecretFormatter(secret_values)
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    store = None
    try:
        if arguments.command == "restore":
            if not arguments.snapshot.is_file():
                raise ValueError("Snapshot does not exist")
            source_uri = arguments.snapshot.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(source_uri, uri=True)) as snapshot:
                tables = {
                    row[0]
                    for row in snapshot.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                required = {"profiles", "drafts", "listings", "events", "metadata"}
                if (
                    not required <= tables
                    or snapshot.execute("PRAGMA quick_check").fetchone()[0] != "ok"
                ):
                    raise ValueError("Not a valid Autodom database snapshot")
            store = Store(arguments.snapshot)
            store.backup(arguments.destination)
            print(json.dumps({"restored": str(arguments.destination)}, ensure_ascii=False))
            return
        settings = Settings.from_env()
        if arguments.command in {"health", "status", "backup"} and not settings.database.is_file():
            raise ValueError("Database does not exist; run autodom sync or autodom run first")
        if arguments.command == "sync" and not 1 <= arguments.pages <= 10000:
            raise ValueError("--pages must be between 1 and 10000")
        routes = load_proxy_routes() if arguments.command in {"run", "sync"} else ()
        token = load_token() if arguments.command == "run" else ""
        if token:
            formatter.secrets.append(token)
        store = Store(settings.database)
        if arguments.command == "backup":
            store.backup(arguments.destination)
            print(json.dumps({"snapshot": str(arguments.destination)}, ensure_ascii=False))
        elif arguments.command in {"status", "health"}:
            now = time.time()
            heartbeat = float(store.get_meta("runtime_heartbeat", "0"))
            monitor = float(store.get_meta("last_monitor_at", "0"))
            healthy = 0 <= now - heartbeat <= 120 and 0 <= now - monitor <= max(
                120, settings.monitor_seconds * 2
            )
            print(
                json.dumps(
                    {
                        **store.stats(),
                        "healthy": healthy,
                        "sources": source_status(store),
                        "telegram_error": store.get_meta("telegram_error", ""),
                        "last_backup_at": store.get_meta("last_backup_at"),
                    },
                    ensure_ascii=False,
                )
            )
            if arguments.command == "health" and not healthy:
                raise SystemExit(1)
        else:
            with writer_lock(settings.database):
                if arguments.command == "sync":
                    print(
                        json.dumps(
                            asyncio.run(
                                sync_pages(store, arguments.pages, routes, settings.crawl_delay)
                            ),
                            ensure_ascii=False,
                        )
                    )
                else:
                    asyncio.run(run_bot(store, settings, routes, token))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        logging.getLogger(__name__).error("%s: %s", type(error).__name__, error)
        raise SystemExit(1) from None
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    main()
