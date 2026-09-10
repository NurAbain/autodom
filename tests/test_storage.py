import json
import sqlite3
import stat
from dataclasses import asdict, replace
from datetime import UTC, datetime

import pytest

from autodom.matching import matches
from autodom.models import Listing, Profile
from autodom.storage import Store


@pytest.fixture
def store(tmp_path):
    db = Store(tmp_path / "private" / "catalog.sqlite3")
    yield db
    db.close()


def car(id="1", **changes):
    return replace(
        Listing(
            id, "Toyota Camry", f"https://www.mashina.kg/{id}", 100, 9000, availability="В наличии"
        ),
        **changes,
    )


def test_price_events_survive_reopen_without_duplicate_ingestion(tmp_path):
    path = tmp_path / "catalog.sqlite3"
    db = Store(path)
    original = car(observed_at=100.0)
    lowered = replace(original, price_usd_minor=90, price_kgs_minor=8100, observed_at=102.0)
    try:
        assert db.upsert_listings([original]) == 1
        assert db.upsert_listings([original]) == 0
        assert db.upsert_listings([replace(original, city="Бишкек", observed_at=101.0)]) == 0
        assert db.upsert_listings([lowered]) == 1
    finally:
        db.close()
    db = Store(path)
    try:
        events = db.events_after(0)
        assert [event.kind for event in events] == ["new", "price_change"]
        assert events[0].listing == original
        assert events[1].listing == lowered
        assert events[1].previous_usd_minor == 100
        assert events[1].previous_kgs_minor == 9000
        assert events[1].is_price_drop("USD")
        assert events[1].is_price_drop("KGS")
        assert db.upsert_listings([lowered]) == 0
    finally:
        db.close()


def test_profile_revisions_baseline_and_protect_cursor(store):
    store.upsert_listings([car()])
    profile = store.save_profile(Profile(1, 10, "USD", 100, 200, monitoring=True))
    assert store.events_after(profile.cursor) == []
    store.upsert_listings([car("2")])
    pending = store.events_after(profile.cursor)[0]
    disabled = store.set_monitoring(1, False)
    assert disabled is not None and not disabled.monitoring
    assert not store.advance_cursor(1, pending.id, profile.revision)
    enabled = store.set_monitoring(1, True)
    assert enabled is not None and enabled.revision > disabled.revision
    assert store.events_after(enabled.cursor) == []
    store.upsert_listings([car("3")])
    event = store.events_after(enabled.cursor)[0]
    assert store.advance_cursor(1, event.id, enabled.revision)
    assert not store.advance_cursor(1, enabled.cursor, enabled.revision)
    changed = store.save_profile(replace(enabled, query="киа"))
    assert changed.revision > enabled.revision
    assert not store.advance_cursor(1, event.id, enabled.revision)


def test_search_and_match_agree_at_budget_currency_stock_boundaries(store):
    listings = [
        car("low"),
        car("high", price_usd_minor=200),
        car("below", price_usd_minor=99),
        car("above", price_usd_minor=201),
        car("unknown", price_usd_minor=None),
        car("free", price_usd_minor=0),
        car("negative", price_usd_minor=-1),
        car("import", availability="На заказ"),
        car("unknown-stock", availability=""),
        car("not-stock", availability="Не в наличии"),
        car("other", title="Honda Fit"),
        car("alias", title="Тойота Камри"),
        car("substring", title="Toyota Camrywide"),
    ]
    store.upsert_listings(listings)
    for currency, minimum, maximum in [("USD", 100, 200), ("KGS", 9000, 9000)]:
        profile = Profile(1, 10, currency, minimum, maximum, "тойота камри")
        expected = {item.id for item in listings if matches(profile, item)}
        assert {item.id for item in store.search(profile, limit=100)} == expected
        assert store.count_matches(profile) == len(expected)
    assert {item.id for item in store.search(Profile(1, 10, "USD", 100, 200), limit=100)} == {
        "low",
        "high",
        "other",
        "alias",
        "substring",
    }
    assert store.get_listing("import") is not None


def test_observation_expiry_and_pagination(store, monkeypatch):
    now = 2_000_000_000.0
    monkeypatch.setattr("autodom.storage.time.time", lambda: now)
    profile = Profile(1, 10, "USD", 100, 200)
    store.upsert_listings([car("expired")], observed_at=now - 49 * 3600)
    store.upsert_listings([car("older")], observed_at=now - 100)
    store.upsert_listings([car("newer")], observed_at=now - 10)
    assert [item.id for item in store.search(profile, limit=1)] == ["newer"]
    assert [item.id for item in store.search(profile, limit=1, offset=1)] == ["older"]
    assert store.count_matches(profile) == 2
    assert store.get_listing("expired") is not None
    assert store.get_listing("expired", fresh_only=True) is None
    assert store.get_listing("newer", fresh_only=True).observed_at == now - 10
    store.upsert_listings([car("boundary")], observed_at=now - 48 * 3600)
    assert store.get_listing("boundary", fresh_only=True).observed_at == now - 48 * 3600
    assert store.count_matches(profile) == 3
    assert store.upsert_listings([car("expired")], observed_at=now) == 0
    assert store.count_matches(profile) == 4
    assert store.get_listing("expired", fresh_only=True).observed_at == now


@pytest.mark.parametrize(
    "changes",
    [
        {"currency": "EUR"},
        {"budget_min_minor": -1},
        {"budget_min_minor": 201},
        {"budget_min_minor": 0, "budget_max_minor": 0},
        {"budget_min_minor": 1.5},
        {"city": "!"},
        {"city": " "},
        {"city": "А" * 81},
        {"city": "draft:nonce:save"},
        {"city": "Бишкек\nОш"},
        {"city": None},
        {"budget_scope": "landed"},
        {"body_type": "средний"},
        {"transmission": "any"},
        {"use_case": "racing"},
        {"allow_import": 0},
        {"allow_import": 1},
        {"year_min": 1899},
        {"year_min": datetime.now(UTC).year + 2},
        {"year_min": True},
        {"mileage_max_km": -1},
        {"mileage_max_km": 10_000_001},
        {"mileage_max_km": 0.5},
        {"mileage_max_km": False},
        {"purchase_by": "2026-02-30"},
        {"purchase_by": "20260910"},
    ],
)
def test_invalid_profile_never_replaces_existing_profile(store, changes):
    profile = store.save_profile(Profile(1, 10, "USD", 100, 200))
    with pytest.raises(ValueError):
        store.save_profile(replace(profile, **changes))
    assert store.get_profile(1) == profile


def test_private_state_persists_and_deletion_preserves_catalog(tmp_path):
    path = tmp_path / "state.sqlite3"
    db = Store(path)
    try:
        db.upsert_listings([car()], observed_at=123.0)
        profile = db.save_profile(Profile(1, 10, "USD", 100, 200, monitoring=True))
        db.set_draft(1, "budget", {"query": "тойота", "minimum": 100})
        db.set_meta("monitor_cursor", "1")
    finally:
        db.close()
    db = Store(path)
    try:
        assert db.monitoring_profiles() == [profile]
        assert db.get_draft(1) == ("budget", {"query": "тойота", "minimum": 100})
        assert db.get_meta("monitor_cursor") == "1"
        db.delete_user(1)
        assert db.get_profile(1) is None
        assert db.get_draft(1) is None
        assert db.monitoring_profiles() == []
        assert db.get_listing("1") == car(observed_at=123.0)
        assert len(db.events_after(0)) == 1
    finally:
        db.close()


def test_older_observations_never_replace_newer_state_or_emit_events(store, monkeypatch):
    now = 2_000_000_000.0
    monkeypatch.setattr("autodom.storage.time.time", lambda: now)
    current = car(observed_at=now - 10)
    assert store.upsert_listings([current]) == 1
    events = store.events_after(0)
    stale = replace(current, price_usd_minor=50, title="Honda Fit", observed_at=now - 49 * 3600)
    assert store.upsert_listings([stale]) == 0
    assert store.upsert_listings([replace(stale, observed_at=current.observed_at)]) == 0
    assert store.get_listing("1", fresh_only=True) == current
    assert store.events_after(0) == events
    assert store.search(Profile(1, 10, "USD", 100, 200, "toyota")) == [current]
    assert store.search(Profile(1, 10, "USD", 1, 200, "honda")) == []
    assert store.upsert_listings([replace(stale, id="expired")]) == 1
    assert store.get_listing("expired", fresh_only=True) is None
    assert store.get_listing("expired").observed_at == stale.observed_at


def test_nonempty_punctuation_queries_do_not_broaden_sql_matches(store):
    store.upsert_listings([car()])
    for query in (" , ", "!!!", "___"):
        profile = Profile(1, 10, "USD", 100, 200, query)
        assert store.search(profile) == []
        assert store.count_matches(profile) == 0
        assert not matches(profile, car())
    assert [item.id for item in store.search(Profile(1, 10, "USD", 100, 200, " \t "))] == ["1"]


def test_quiet_hours_preserve_pending_cursor_and_survive_profile_edits(store):
    original = store.save_profile(Profile(1, 10, "USD", 100, 200, monitoring=True))
    store.upsert_listings([car()])
    pending = store.events_after(original.cursor)[0]
    quiet = store.set_quiet_hours(1, 22 * 60, 8 * 60)
    assert quiet.cursor == original.cursor
    assert not store.advance_cursor(1, pending.id, original.revision)
    assert store.advance_cursor(1, pending.id, quiet.revision)
    edited = store.save_profile(Profile(1, 10, "KGS", 9000, 18000, "honda", monitoring=True))
    assert (edited.quiet_start_minute, edited.quiet_end_minute) == (22 * 60, 8 * 60)
    disabled = store.set_quiet_hours(1, None, None)
    assert (disabled.quiet_start_minute, disabled.quiet_end_minute) == (None, None)
    assert disabled.cursor == edited.cursor
    assert not store.advance_cursor(1, pending.id, edited.revision)


@pytest.mark.parametrize(
    "start,end", [(None, 60), (60, None), (60, 60), (-1, 60), (60, 1440), (1.5, 60), (False, 60)]
)
def test_invalid_quiet_hours_leave_profile_unchanged(store, start, end):
    original = store.save_profile(Profile(1, 10, "USD", 100, 200))
    with pytest.raises(ValueError):
        store.set_quiet_hours(1, start, end)
    assert store.get_profile(1) == original


@pytest.mark.parametrize("legacy_version", [1, 2, 3])
def test_legacy_migration_preserves_state_and_backfills_filters(
    tmp_path, monkeypatch, legacy_version
):
    now = 2_000_000_000.0
    monkeypatch.setattr("autodom.storage.time.time", lambda: now)
    path = tmp_path / "legacy.sqlite3"
    legacy = sqlite3.connect(path)
    try:
        legacy.executescript("""
            CREATE TABLE listings (
                id TEXT PRIMARY KEY, data TEXT NOT NULL, price_usd_minor INTEGER,
                price_kgs_minor INTEGER, availability TEXT NOT NULL, normalized_text TEXT NOT NULL,
                first_seen REAL NOT NULL, last_seen REAL NOT NULL
            );
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL REFERENCES listings(id),
                kind TEXT NOT NULL, data TEXT NOT NULL, previous_usd_minor INTEGER,
                previous_kgs_minor INTEGER, observed_at REAL NOT NULL
            );
            CREATE TABLE profiles (
                user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, currency TEXT NOT NULL,
                budget_min_minor INTEGER NOT NULL, budget_max_minor INTEGER NOT NULL,
                query TEXT NOT NULL, monitoring INTEGER NOT NULL, revision INTEGER NOT NULL,
                cursor INTEGER NOT NULL
            );
            CREATE TABLE drafts (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 1;
        """)
        vehicle = car(
            city="Бишкек",
            body_type="Седан",
            transmission="Автомат",
            year=2020,
            mileage="15,625 miles",
        )
        data = asdict(vehicle)
        data.pop("observed_at")
        payload = json.dumps(data)
        legacy.execute(
            "INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "1",
                payload,
                100,
                9000,
                "в наличии",
                " toyota camry в наличии ",
                now - 72 * 3600,
                now - 49 * 3600,
            ),
        )
        legacy.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
            (7, "1", "new", payload, None, None, now - 72 * 3600),
        )
        legacy.execute("INSERT INTO profiles VALUES (1, 10, 'USD', 100, 200, 'toyota', 1, 4, 6)")
        legacy.execute("INSERT INTO drafts VALUES (1, 'budget', ?)", ('{"minimum":100}',))
        legacy.execute("INSERT INTO metadata VALUES ('monitor_cursor', '8')")
        if legacy_version >= 2:
            legacy.execute("ALTER TABLE profiles ADD COLUMN quiet_start_minute INTEGER")
            legacy.execute("ALTER TABLE profiles ADD COLUMN quiet_end_minute INTEGER")
            legacy.execute("UPDATE profiles SET quiet_start_minute = 60, quiet_end_minute = 120")
        if legacy_version >= 3:
            for definition in (
                "source TEXT NOT NULL DEFAULT 'mashina.kg'",
                "market TEXT NOT NULL DEFAULT 'KG'",
                "original_currency TEXT NOT NULL DEFAULT ''",
                "original_price_minor INTEGER",
                "fx_expires_at REAL",
            ):
                legacy.execute(f"ALTER TABLE listings ADD COLUMN {definition}")
            legacy.execute("ALTER TABLE events ADD COLUMN previous_original_price_minor INTEGER")
            legacy.execute(
                "ALTER TABLE events ADD COLUMN previous_original_currency TEXT NOT NULL DEFAULT ''"
            )
            legacy.execute("ALTER TABLE profiles ADD COLUMN market TEXT NOT NULL DEFAULT 'KG'")
        legacy.execute(f"PRAGMA user_version = {legacy_version}")
        legacy.commit()
    finally:
        legacy.close()
    db = Store(path)
    try:
        profile = db.get_profile(1)
        assert profile == Profile(
            1,
            10,
            "USD",
            100,
            200,
            "toyota",
            True,
            4,
            6,
            60 if legacy_version >= 2 else None,
            120 if legacy_version >= 2 else None,
        )
        assert db.get_draft(1) == ("budget", {"minimum": 100})
        assert db.get_meta("monitor_cursor") == "8"
        assert db.get_listing("1").observed_at == now - 49 * 3600
        assert db.get_listing("1", fresh_only=True) is None
        assert db.search(profile) == []
        event = db.events_after(profile.cursor)[0]
        assert event.id == 7
        assert event.listing.observed_at == now - 72 * 3600
        constrained = replace(
            profile,
            city="БИШКЕК",
            body_type="sedan",
            transmission="automatic",
            year_min=2020,
            mileage_max_km=25146,
        )
        # Freshness must remain intact; backfilled filters are exercised without re-ingestion.
        monkeypatch.setattr("autodom.storage.time.time", lambda: now - 2 * 3600)
        assert [item.id for item in db.search(constrained)] == ["1"]
        assert db.count_matches(replace(constrained, mileage_max_km=25145)) == 0
        assert matches(constrained, db.get_listing("1"))
        monkeypatch.setattr("autodom.storage.time.time", lambda: now)
        quiet = db.set_quiet_hours(1, 0, 60)
        assert quiet.cursor == 6
    finally:
        db.close()
    db = Store(path)
    try:
        assert db.get_profile(1) == quiet
        assert db.events_after(6) == [event]
        assert db.upsert_listings([car()], observed_at=now) == 0
        assert db.get_listing("1", fresh_only=True) == car(observed_at=now)
    finally:
        db.close()


def test_online_backup_reopens_committed_wal_state_and_refuses_overwrite(tmp_path):
    source = tmp_path / "source.sqlite3"
    destination = tmp_path / "private" / "snapshot.sqlite3"
    db = Store(source)
    try:
        db.upsert_listings([car()], observed_at=100.0)
        db.save_profile(
            Profile(
                1,
                10,
                "USD",
                50,
                200,
                monitoring=True,
                city="Бишкек",
                budget_scope="total",
                body_type="sedan",
                year_min=2020,
                mileage_max_km=0,
                transmission="automatic",
                use_case="family",
                allow_import=False,
                purchase_by="2000-01-01",
            )
        )
        profile = db.set_quiet_hours(1, 1320, 480)
        db.set_draft(1, "budget", {"minimum": 50, "query": "toyota"})
        db.upsert_listings([car(price_usd_minor=90)], observed_at=101.0)
        db.set_meta("monitor_cursor", "3")
        events = db.events_after(0)
        assert source.with_name(source.name + "-wal").stat().st_size > 0
        db.backup(destination)
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
        assert stat.S_IMODE(destination.parent.stat().st_mode) == 0o700
        restored = Store(destination)
        try:
            assert restored.get_profile(1) == profile
            assert restored.get_draft(1) == ("budget", {"minimum": 50, "query": "toyota"})
            assert restored.get_listing("1") == car(price_usd_minor=90, observed_at=101.0)
            assert restored.events_after(0) == events
            assert restored.get_meta("monitor_cursor") == "3"
            assert restored.advance_cursor(1, events[-1].id, profile.revision)
        finally:
            restored.close()
        snapshot = destination.read_bytes()
        with pytest.raises(FileExistsError):
            db.backup(destination)
        assert destination.read_bytes() == snapshot
        with pytest.raises(FileExistsError):
            db.backup(source)
        assert db.get_profile(1) == profile
    finally:
        db.close()


def test_preferences_filter_before_pagination_and_agree_with_notification_matching(
    store, monkeypatch
):
    monkeypatch.setattr("autodom.matching.approved_sources", lambda: ("mashina.kg", "truecar.com"))
    monkeypatch.setattr("autodom.storage.approved_sources", lambda: ("mashina.kg", "truecar.com"))
    good = car(city="Бишкек", body_type="седан", transmission="АКПП", year=2020, mileage="0 km")
    listings = [
        replace(good, id="01-unknown", mileage="0"),
        replace(good, id="02-over", mileage="0.001 km"),
        replace(good, id="03-city", city="Бишкек область"),
        replace(good, id="04-body", body_type="중형차"),
        replace(good, id="05-transmission", transmission=""),
        replace(good, id="06-year", year=None),
        replace(good, id="07-old", year=2019),
        replace(
            good,
            id="08-foreign",
            market="US",
            source="truecar.com",
            original_currency="USD",
            availability="Опубликовано",
        ),
        replace(
            good,
            id="09-unapproved",
            market="US",
            source="unapproved",
            original_currency="USD",
            availability="Опубликовано",
        ),
        replace(good, id="10-good"),
        replace(good, id="11-good"),
    ]
    store.upsert_listings(listings)
    profile = Profile(
        1,
        10,
        "USD",
        100,
        200,
        market="ALL",
        city="бишкек",
        body_type="sedan",
        year_min=2020,
        mileage_max_km=0,
        transmission="automatic",
        use_case="travel",
        purchase_by="2000-01-01",
    )
    for allow_import, budget_scope, expected in (
        (None, "car", ["08-foreign", "10-good", "11-good"]),
        (True, "car", ["08-foreign", "10-good", "11-good"]),
        (False, "car", ["10-good", "11-good"]),
        (True, "total", ["10-good", "11-good"]),
    ):
        selected = replace(profile, allow_import=allow_import, budget_scope=budget_scope)
        assert [item.id for item in listings if matches(selected, item)] == expected
        assert store.count_matches(selected) == len(expected)
        assert [
            item.id
            for offset in range(len(expected) + 1)
            for item in store.search(selected, limit=1, offset=offset)
        ] == expected


@pytest.mark.parametrize("allow_import", [None, False, True])
def test_preferences_survive_pause_resume_quiet_hours_and_reopen(tmp_path, allow_import):
    path = tmp_path / "preferences.sqlite3"
    db = Store(path)
    try:
        original = db.save_profile(
            Profile(
                1,
                10,
                "USD",
                100,
                200,
                monitoring=True,
                city="Бишкек",
                budget_scope="total",
                body_type="sedan",
                year_min=2020,
                mileage_max_km=0,
                transmission="automatic",
                use_case="family",
                allow_import=allow_import,
                purchase_by="2000-01-01",
            )
        )
        paused = db.set_monitoring(1, False)
        assert paused == replace(original, monitoring=False, revision=original.revision + 1)
        quiet = db.set_quiet_hours(1, 1320, 480)
        assert quiet == replace(
            paused, quiet_start_minute=1320, quiet_end_minute=480, revision=paused.revision + 1
        )
        resumed = db.set_monitoring(1, True)
        assert resumed == replace(quiet, monitoring=True, revision=quiet.revision + 1)
    finally:
        db.close()
    db = Store(path)
    try:
        assert db.get_profile(1) == resumed
        assert db.get_profile(1).allow_import is allow_import
    finally:
        db.close()
