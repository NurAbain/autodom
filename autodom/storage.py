import json
import os
import sqlite3
import time
from dataclasses import asdict, replace
from pathlib import Path

from .config import approved_sources
from .matching import normalize, query_groups, searchable_text
from .models import MARKETS, Listing, ListingEvent, Profile

_SCHEMA_VERSION = 3
_FRESH_SECONDS = 48 * 60 * 60
_SCHEMA = """
BEGIN;
CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    price_usd_minor INTEGER,
    price_kgs_minor INTEGER,
    availability TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    first_seen REAL NOT NULL,
    last_seen REAL NOT NULL
    ,source TEXT NOT NULL DEFAULT 'mashina.kg'
    ,market TEXT NOT NULL DEFAULT 'KG'
    ,original_currency TEXT NOT NULL DEFAULT ''
    ,original_price_minor INTEGER
    ,fx_expires_at REAL
);
CREATE INDEX IF NOT EXISTS listings_recent ON listings(last_seen DESC, first_seen DESC, id);
CREATE INDEX IF NOT EXISTS listings_source ON listings(source, market, last_seen);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    kind TEXT NOT NULL CHECK(kind IN ('new', 'price_change')),
    data TEXT NOT NULL,
    previous_usd_minor INTEGER,
    previous_kgs_minor INTEGER,
    observed_at REAL NOT NULL
    ,previous_original_price_minor INTEGER
    ,previous_original_currency TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK(currency IN ('USD', 'KGS')),
    budget_min_minor INTEGER NOT NULL CHECK(budget_min_minor >= 0),
    budget_max_minor INTEGER NOT NULL CHECK(budget_max_minor >= budget_min_minor AND budget_max_minor > 0),
    query TEXT NOT NULL,
    monitoring INTEGER NOT NULL CHECK(monitoring IN (0, 1)),
    revision INTEGER NOT NULL,
    cursor INTEGER NOT NULL,
    quiet_start_minute INTEGER,
    quiet_end_minute INTEGER,
    market TEXT NOT NULL DEFAULT 'KG' CHECK(market IN ('KG', 'KR', 'US', 'ALL')),
    CHECK((quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR
          (quiet_start_minute IS NOT NULL AND quiet_end_minute IS NOT NULL AND
           quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND
           quiet_start_minute != quiet_end_minute))
);
CREATE TABLE IF NOT EXISTS drafts (
    user_id INTEGER PRIMARY KEY,
    state TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
PRAGMA user_version = 3;
COMMIT;
"""
_MIGRATE_V1 = """
BEGIN;
ALTER TABLE profiles ADD COLUMN quiet_start_minute INTEGER;
ALTER TABLE profiles ADD COLUMN quiet_end_minute INTEGER
    CHECK((quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR
          (quiet_start_minute IS NOT NULL AND quiet_end_minute IS NOT NULL AND
           quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND
           quiet_start_minute != quiet_end_minute));
PRAGMA user_version = 2;
COMMIT;
"""
_MIGRATE_V2 = """
BEGIN;
ALTER TABLE listings ADD COLUMN source TEXT NOT NULL DEFAULT 'mashina.kg';
ALTER TABLE listings ADD COLUMN market TEXT NOT NULL DEFAULT 'KG';
ALTER TABLE listings ADD COLUMN original_currency TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN original_price_minor INTEGER;
ALTER TABLE listings ADD COLUMN fx_expires_at REAL;
CREATE INDEX listings_source ON listings(source, market, last_seen);
ALTER TABLE events ADD COLUMN previous_original_price_minor INTEGER;
ALTER TABLE events ADD COLUMN previous_original_currency TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN market TEXT NOT NULL DEFAULT 'KG'
    CHECK(market IN ('KG', 'KR', 'US', 'ALL'));
INSERT OR IGNORE INTO metadata(key, value)
    SELECT 'source:mashina.kg:' || key, value FROM metadata
    WHERE key IN ('catalog_total', 'catalog_pages', 'last_sync_at', 'source_error',
                  'crawl_next_page', 'full_scan_completed_at');
DELETE FROM metadata WHERE key IN ('catalog_total', 'catalog_pages', 'last_sync_at',
    'source_error', 'crawl_next_page', 'full_scan_completed_at');
PRAGMA user_version = 3;
COMMIT;
"""


def _private_parent(path: Path) -> None:
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700, exist_ok=True)


def _json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _listing(data: str, observed_at: float) -> Listing:
    values = json.loads(data)
    values["observed_at"] = observed_at
    return Listing(**values)


def _profile(row: sqlite3.Row | None) -> Profile | None:
    if row is None:
        return None
    values = dict(row)
    values["monitoring"] = bool(values["monitoring"])
    return Profile(**values)


def _validate_quiet_hours(start: int | None, end: int | None) -> None:
    if start is None and end is None:
        return
    if (
        type(start) is not int
        or type(end) is not int
        or not 0 <= start < 1440
        or not 0 <= end < 1440
        or start == end
    ):
        raise ValueError(
            "Quiet hours require distinct integer minutes from 0 through 1439, or both None"
        )


class Store:
    """Synchronous SQLite state for one event-loop process."""

    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            path = Path(path).expanduser()
            _private_parent(path)
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
        self._db = sqlite3.connect(str(path), timeout=10)
        self._db.row_factory = sqlite3.Row
        try:
            self._db.execute("PRAGMA foreign_keys = ON")
            self._db.execute("PRAGMA journal_mode = WAL")
            version = self._db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                self._db.executescript(_SCHEMA)
            else:
                if version == 1:
                    self._db.executescript(_MIGRATE_V1)
                    version = 2
                if version == 2:
                    self._db.executescript(_MIGRATE_V2)
                elif version != _SCHEMA_VERSION:
                    raise ValueError(f"Unsupported database schema version: {version}")
        except BaseException:
            self._db.close()
            raise

    def close(self) -> None:
        self._db.close()

    def backup(self, destination: str | Path) -> None:
        """Snapshot committed state, including WAL, into a new private SQLite file."""
        path = Path(destination).expanduser().absolute()
        _private_parent(path)
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        try:
            target = sqlite3.connect(str(path), timeout=10)
            try:
                self._db.backup(target)
                target.execute("PRAGMA journal_mode = DELETE")
            finally:
                target.close()
        except BaseException:
            path.unlink()
            raise

    def upsert_listings(self, listings: list[Listing], observed_at: float | None = None) -> int:
        ingestion_time = time.time() if observed_at is None else observed_at
        events = 0
        with self._db:
            for listing in listings:
                if listing.market not in ("KG", "KR", "US"):
                    raise ValueError("A listing must identify its actual market")
                observation = (
                    observed_at
                    if observed_at is not None
                    else listing.observed_at
                    if listing.observed_at is not None
                    else ingestion_time
                )
                previous = self._db.execute(
                    """SELECT price_usd_minor, price_kgs_minor, last_seen,
                              original_price_minor, original_currency
                       FROM listings WHERE id = ?""",
                    (listing.id,),
                ).fetchone()
                if previous is not None and observation <= previous["last_seen"]:
                    continue
                listing = replace(listing, observed_at=observation)
                data = _json(asdict(listing))
                prices = (listing.price("USD"), listing.price("KGS"))
                self._db.execute(
                    """INSERT INTO listings
                       (id, data, price_usd_minor, price_kgs_minor, availability,
                        normalized_text, first_seen, last_seen, source, market,
                        original_currency, original_price_minor, fx_expires_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         data = excluded.data,
                         price_usd_minor = excluded.price_usd_minor,
                         price_kgs_minor = excluded.price_kgs_minor,
                         availability = excluded.availability,
                         normalized_text = excluded.normalized_text,
                         last_seen = excluded.last_seen,
                         source = excluded.source, market = excluded.market,
                         original_currency = excluded.original_currency,
                         original_price_minor = excluded.original_price_minor,
                         fx_expires_at = excluded.fx_expires_at""",
                    (
                        listing.id,
                        data,
                        *prices,
                        normalize(listing.availability),
                        searchable_text(listing),
                        observation,
                        observation,
                        listing.source,
                        listing.market,
                        listing.original_currency,
                        listing.original_price_minor,
                        listing.fx_expires_at,
                    ),
                )
                changed = previous is None
                if previous is not None:
                    if listing.original_currency or previous["original_currency"]:
                        changed = (
                            listing.original_currency != previous["original_currency"]
                            or listing.original_price_minor != previous["original_price_minor"]
                        )
                    else:
                        changed = (previous[0], previous[1]) != prices
                if changed:
                    self._db.execute(
                        """INSERT INTO events
                           (listing_id, kind, data, previous_usd_minor, previous_kgs_minor,
                            observed_at, previous_original_price_minor, previous_original_currency)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            listing.id,
                            "new" if previous is None else "price_change",
                            data,
                            previous[0] if previous is not None else None,
                            previous[1] if previous is not None else None,
                            observation,
                            previous["original_price_minor"] if previous is not None else None,
                            previous["original_currency"] if previous is not None else "",
                        ),
                    )
                    events += 1
        return events

    def get_listing(self, id: str, *, fresh_only: bool = False) -> Listing | None:
        where = "id = ?"
        parameters = [id]
        if fresh_only:
            where += " AND last_seen >= ?"
            parameters.append(time.time() - _FRESH_SECONDS)
        row = self._db.execute(
            f"SELECT data, last_seen FROM listings WHERE {where}",
            parameters,
        ).fetchone()
        return _listing(row["data"], row["last_seen"]) if row else None

    def _max_event(self) -> int:
        return self._db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]

    def save_profile(self, profile: Profile) -> Profile:
        if profile.currency not in ("USD", "KGS"):
            raise ValueError("Currency must be USD or KGS")
        if profile.market not in MARKETS:
            raise ValueError("Unknown search market")
        if (
            type(profile.budget_min_minor) is not int
            or type(profile.budget_max_minor) is not int
            or profile.budget_min_minor < 0
            or profile.budget_max_minor <= 0
            or profile.budget_max_minor < profile.budget_min_minor
        ):
            raise ValueError("Budget must use integer minor units with 0 <= minimum <= maximum > 0")
        with self._db:
            previous = self.get_profile(profile.user_id)
            quiet_start = previous.quiet_start_minute if previous else profile.quiet_start_minute
            quiet_end = previous.quiet_end_minute if previous else profile.quiet_end_minute
            _validate_quiet_hours(quiet_start, quiet_end)
            self._db.execute(
                """INSERT INTO profiles
                   (user_id, chat_id, currency, budget_min_minor, budget_max_minor,
                    query, monitoring, revision, cursor, quiet_start_minute, quiet_end_minute, market)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET
                     chat_id = excluded.chat_id, currency = excluded.currency,
                     budget_min_minor = excluded.budget_min_minor, market = excluded.market,
                     budget_max_minor = excluded.budget_max_minor,
                     query = excluded.query, monitoring = excluded.monitoring,
                     revision = excluded.revision, cursor = excluded.cursor""",
                (
                    profile.user_id,
                    profile.chat_id,
                    profile.currency,
                    profile.budget_min_minor,
                    profile.budget_max_minor,
                    profile.query,
                    int(profile.monitoring),
                    previous.revision + 1 if previous else time.time_ns(),
                    self._max_event(),
                    quiet_start,
                    quiet_end,
                    profile.market,
                ),
            )
        saved = self.get_profile(profile.user_id)
        assert saved is not None
        return saved

    def get_profile(self, user_id: int) -> Profile | None:
        return _profile(
            self._db.execute(
                "SELECT * FROM profiles WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        )

    def monitoring_profiles(self) -> list[Profile]:
        rows = self._db.execute("SELECT * FROM profiles WHERE monitoring = 1 ORDER BY user_id")
        return [profile for row in rows if (profile := _profile(row)) is not None]

    def set_monitoring(self, user_id: int, enabled: bool) -> Profile | None:
        with self._db:
            self._db.execute(
                """UPDATE profiles SET monitoring = ?, revision = revision + 1,
                   cursor = CASE WHEN ? THEN ? ELSE cursor END WHERE user_id = ?""",
                (int(enabled), int(enabled), self._max_event(), user_id),
            )
        return self.get_profile(user_id)

    def set_quiet_hours(self, user_id: int, start: int | None, end: int | None) -> Profile | None:
        """Save Bishkek UTC+6 minutes, start inclusive and end exclusive; both None disables."""
        _validate_quiet_hours(start, end)
        with self._db:
            self._db.execute(
                """UPDATE profiles SET quiet_start_minute = ?, quiet_end_minute = ?,
                   revision = revision + 1 WHERE user_id = ?""",
                (start, end, user_id),
            )
        return self.get_profile(user_id)

    def events_after(self, cursor: int, limit: int = 200) -> list[ListingEvent]:
        if limit <= 0:
            return []
        rows = self._db.execute(
            "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (cursor, limit),
        )
        return [
            ListingEvent(
                row["id"],
                _listing(row["data"], row["observed_at"]),
                row["kind"],
                row["previous_usd_minor"],
                row["previous_kgs_minor"],
                row["previous_original_price_minor"],
                row["previous_original_currency"],
            )
            for row in rows
        ]

    def advance_cursor(self, user_id: int, event_id: int, revision: int) -> bool:
        with self._db:
            result = self._db.execute(
                """UPDATE profiles SET cursor = ?
                   WHERE user_id = ? AND revision = ? AND cursor <= ?""",
                (event_id, user_id, revision, event_id),
            )
        return result.rowcount == 1

    @staticmethod
    def _search_where(profile: Profile) -> tuple[str, list]:
        if profile.currency not in ("USD", "KGS") or profile.market not in MARKETS:
            return "0", []
        price = "price_usd_minor" if profile.currency == "USD" else "price_kgs_minor"
        sources = approved_sources()
        clauses = [
            f"{price} > 0",
            f"{price} BETWEEN ? AND ?",
            "(availability = 'в наличии' OR (market != 'KG' AND availability = 'опубликовано'))",
            "last_seen >= ?",
            f"source IN ({','.join('?' for _ in sources)})",
            "(market = 'KG' OR original_currency = ? OR fx_expires_at > ?)",
        ]
        now = time.time()
        parameters = [
            profile.budget_min_minor,
            profile.budget_max_minor,
            now - _FRESH_SECONDS,
            *sources,
            profile.currency,
            now,
        ]
        if profile.market != "ALL":
            clauses.append("market = ?")
            parameters.append(profile.market)
        groups = query_groups(profile.query)
        if profile.query.strip() and not groups:
            return "0", []
        if groups:
            alternatives = []
            for group in groups:
                alternatives.append(
                    "(" + " AND ".join("instr(normalized_text, ?) > 0" for _ in group) + ")"
                )
                parameters.extend(f" {word} " for word in group)
            clauses.append("(" + " OR ".join(alternatives) + ")")
        return " AND ".join(clauses), parameters

    def search(self, profile: Profile, limit: int = 5, offset: int = 0) -> list[Listing]:
        if limit <= 0:
            return []
        if offset < 0:
            raise ValueError("Offset must be nonnegative")
        where, parameters = self._search_where(profile)
        rows = self._db.execute(
            f"SELECT data, last_seen FROM listings WHERE {where} ORDER BY last_seen DESC, first_seen DESC, id ASC LIMIT ? OFFSET ?",
            [*parameters, limit, offset],
        )
        return [_listing(row["data"], row["last_seen"]) for row in rows]

    def count_matches(self, profile: Profile) -> int:
        where, parameters = self._search_where(profile)
        return self._db.execute(
            f"SELECT COUNT(*) FROM listings WHERE {where}", parameters
        ).fetchone()[0]

    def get_draft(self, user_id: int) -> tuple[str, dict] | None:
        row = self._db.execute(
            "SELECT state, data FROM drafts WHERE user_id = ?", (user_id,)
        ).fetchone()
        return (row["state"], json.loads(row["data"])) if row else None

    def set_draft(self, user_id: int, state: str, data: dict) -> None:
        with self._db:
            self._db.execute(
                """INSERT INTO drafts (user_id, state, data) VALUES (?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data""",
                (user_id, state, _json(data)),
            )

    def clear_draft(self, user_id: int) -> None:
        with self._db:
            self._db.execute("DELETE FROM drafts WHERE user_id = ?", (user_id,))

    def delete_user(self, user_id: int) -> None:
        with self._db:
            self._db.execute("DELETE FROM drafts WHERE user_id = ?", (user_id,))
            self._db.execute("DELETE FROM profiles WHERE user_id = ?", (user_id,))

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self._db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        with self._db:
            self._db.execute(
                """INSERT INTO metadata (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (key, value),
            )

    def stats(self) -> dict:
        return dict(
            self._db.execute(
                """SELECT (SELECT COUNT(*) FROM listings) AS listings,
                      (SELECT COUNT(*) FROM events) AS events,
                      (SELECT COUNT(*) FROM profiles) AS profiles,
                      (SELECT COUNT(*) FROM profiles WHERE monitoring = 1) AS active_profiles,
                      (SELECT MAX(last_seen) FROM listings) AS last_seen""",
            ).fetchone()
        )

    def source_stats(self) -> dict[str, dict]:
        rows = self._db.execute(
            """SELECT source, market, COUNT(*) AS listings, MAX(last_seen) AS last_seen
               FROM listings GROUP BY source, market"""
        )
        return {row["source"]: dict(row) for row in rows}
