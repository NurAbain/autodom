import time
from datetime import datetime, timedelta, timezone

import pytest

from autodom.conversation import Conversation, listing_text
from autodom.models import Listing
from autodom.storage import Store


@pytest.fixture
def buyer(tmp_path):
    store = Store(tmp_path / "state.sqlite3")
    yield store, Conversation(store)
    store.close()


def button(replies, label):
    return next(
        data for reply in replies for row in reply.buttons for text, data in row if label in text
    )


def begin(conversation, user=1, currency="USD"):
    replies = conversation.handle(user, user, "/start")
    replies = conversation.handle(user, user, button(replies, "Согласен"))
    return conversation.handle(user, user, button(replies, currency))


def save(conversation, query="Toyota Camry", user=1, currency="USD", budget="15000"):
    begin(conversation, user, currency)
    replies = conversation.handle(user, user, budget)
    review = conversation.handle(user, user, query if query else button(replies, "Пока не знаю"))
    return conversation.handle(user, user, button(review, "Сохранить"))


def test_disclosure_requires_explicit_current_consent_before_persistence(buyer):
    store, conversation = buyer
    stale_consent = button(conversation.handle(1, 1, "/start"), "Согласен")
    for command in ("/privacy", "/begin", "/edit", "consent:accept"):
        conversation.handle(1, 1, command)
        assert store.get_draft(1) is None
        assert store.get_profile(1) is None
    conversation.handle(1, 1, stale_consent)
    assert store.get_draft(1) is None
    replies = conversation.handle(1, 1, "/privacy")
    conversation.handle(1, 1, button(replies, "Согласен"))
    assert store.get_draft(1)[0] == "currency"


@pytest.mark.parametrize(
    "invalid", ["currency:KGS", "query:unexpected", "!!!", "___", ", ,", "Toyota, !!!"]
)
def test_invalid_preferences_do_not_replace_saved_search(buyer, invalid):
    store, conversation = buyer
    save(conversation)
    replies = conversation.handle(1, 1, "/edit")
    original = store.get_profile(1)
    conversation.handle(1, 1, button(replies, "KGS"))
    conversation.handle(1, 1, "1000000")
    conversation.handle(1, 1, invalid)
    assert store.get_profile(1) == original
    assert store.get_draft(1)[0] == "query"


def test_stale_currency_and_unknown_buttons_cannot_cross_input_steps(buyer):
    store, conversation = buyer
    replies = conversation.handle(1, 1, "/start")
    currencies = conversation.handle(1, 1, button(replies, "Согласен"))
    stale_currency = button(currencies, "KGS")
    conversation.handle(1, 1, button(currencies, "USD"))
    queries = conversation.handle(1, 1, "15000")
    unknown = button(queries, "Пока не знаю")
    conversation.handle(1, 1, stale_currency)
    assert store.get_profile(1) is None
    assert store.get_draft(1)[1]["currency"] == "USD"
    review = conversation.handle(1, 1, "Toyota Camry")
    conversation.handle(1, 1, button(review, "Сохранить"))
    replies = conversation.handle(1, 1, "/edit")
    profile = store.get_profile(1)
    current_currency_draft = store.get_draft(1)
    conversation.handle(1, 1, stale_currency)
    assert store.get_draft(1) == current_currency_draft
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, unknown)
    assert store.get_profile(1) == profile
    assert store.get_draft(1)[0] == "budget"
    conversation.handle(1, 1, "10000")
    review = conversation.handle(1, 1, "Honda Accord")
    conversation.handle(1, 1, button(review, "Сохранить"))
    assert store.get_profile(1).query == "Honda Accord"


def test_edit_cancel_and_stale_resume_do_not_restore_monitoring(buyer):
    store, conversation = buyer
    replies = save(conversation)
    assert not store.get_profile(1).monitoring
    stale_resume = button(replies, "Включить мониторинг")
    conversation.handle(1, 1, "/resume")
    replies = conversation.handle(1, 1, "/edit")
    assert not store.get_profile(1).monitoring
    conversation.handle(1, 1, "/resume")
    assert not store.get_profile(1).monitoring
    conversation.handle(1, 1, "/cancel")
    original = store.get_profile(1)
    conversation.handle(1, 1, stale_resume)
    assert store.get_profile(1) == original
    assert not original.monitoring
    conversation.handle(1, 1, "/resume")
    assert store.get_profile(1).monitoring
    conversation.handle(1, 1, "/pause")
    assert not store.get_profile(1).monitoring


def test_deletion_confirmation_is_user_bound_cancellable_and_one_use(buyer):
    store, conversation = buyer
    save(conversation)
    old = button(conversation.handle(1, 1, "/delete"), "Удалить мои данные")
    conversation.handle(2, 2, old)
    assert store.get_profile(1) is not None
    conversation.handle(1, 1, "/cancel")
    conversation.handle(1, 1, old)
    assert store.get_profile(1) is not None
    replies = conversation.handle(1, 1, "/delete")
    deletion = button(replies, "Удалить мои данные")
    conversation.handle(1, 1, deletion)
    assert store.get_profile(1) is None
    assert store.get_draft(1) is None
    save(conversation, "Honda Accord")
    restored = store.get_profile(1)
    conversation.handle(1, 1, deletion)
    assert store.get_profile(1) == restored


def test_group_chat_cannot_read_or_mutate_private_profile(buyer):
    store, conversation = buyer
    save(conversation)
    original = store.get_profile(1)
    for command in ("/profile", "/search", "/edit", "/resume", "/delete", "/quiet off"):
        replies = conversation.handle(1, -100, command)
        assert all(
            "Toyota Camry" not in reply.text and "15 000" not in reply.text for reply in replies
        )
        assert store.get_profile(1) == original
        assert store.get_draft(1) is None


def test_quiet_hours_preserve_cursor_and_survive_edit(buyer):
    store, conversation = buyer
    save(conversation)
    conversation.handle(1, 1, "/resume")
    before = store.get_profile(1)
    conversation.handle(1, 1, "/quiet 22:30-07:15")
    quiet = store.get_profile(1)
    assert (quiet.quiet_start_minute, quiet.quiet_end_minute) == (1350, 435)
    assert quiet.cursor == before.cursor
    assert quiet.revision > before.revision
    for invalid in ("24:00-07:00", "23:00-23:00", "23:60-07:00", "7:00-09:00"):
        conversation.handle(1, 1, "/quiet " + invalid)
        assert store.get_profile(1) == quiet
    replies = conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, "12000")
    review = conversation.handle(1, 1, "Honda Accord")
    conversation.handle(1, 1, button(review, "Сохранить"))
    changed = store.get_profile(1)
    assert (changed.quiet_start_minute, changed.quiet_end_minute) == (1350, 435)
    conversation.handle(1, 1, "/quiet off")
    disabled = store.get_profile(1)
    assert (disabled.quiet_start_minute, disabled.quiet_end_minute) == (None, None)
    assert disabled.cursor == changed.cursor


def test_alternatives_currency_and_pagination_show_matching_records(buyer):
    store, conversation = buyer
    now = time.time()
    cars = [
        Listing(
            str(i),
            "Toyota Camry" if i < 3 else "Honda Accord",
            f"https://mashina.kg/details/{i}",
            1200000,
            100000000,
            availability="В наличии",
        )
        for i in range(7)
    ]
    store.upsert_listings(cars, observed_at=now)
    store.upsert_listings(
        [
            Listing(
                "other",
                "Kia Rio",
                "https://mashina.kg/details/other",
                1200000,
                100000000,
                availability="В наличии",
            )
        ],
        observed_at=now,
    )
    replies = save(conversation, "Toyota Camry, Honda Accord", currency="KGS", budget="1000000")
    first = "\n".join(reply.text for reply in replies)
    next_page = button(replies, "Ещё варианты")
    second = "\n".join(reply.text for reply in conversation.handle(1, 1, next_page))
    for car in cars:
        assert (car.url in first) != (car.url in second)
    assert "details/other" not in first + second
    replies = conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "Kia Rio")
    conversation.handle(1, 1, button(review, "Сохранить"))
    stale = conversation.handle(1, 1, next_page)
    assert all("details/" not in reply.text for reply in stale)
    assert store.get_profile(1).query == "Kia Rio"


def test_listing_discloses_actual_observation_not_publication_time():
    observed = 1789000000.0
    car = Listing(
        "1",
        "Toyota Camry",
        "https://mashina.kg/details/1",
        100,
        9000,
        published_at="yesterday",
        observed_at=observed,
    )
    rendered = listing_text(car, "USD")
    assert (
        datetime.fromtimestamp(observed, timezone(timedelta(hours=6))).strftime("%d.%m.%Y %H:%M")
        in rendered
    )
    assert "UTC+6" in rendered


def test_unknown_model_is_explicit_and_keeps_budget_filter(buyer):
    store, conversation = buyer
    store.upsert_listings(
        [
            Listing(
                "affordable",
                "Honda Fit",
                "https://mashina.kg/details/affordable",
                1000000,
                87000000,
                availability="В наличии",
            ),
            Listing(
                "expensive",
                "Toyota Camry",
                "https://mashina.kg/details/expensive",
                2000000,
                174000000,
                availability="В наличии",
            ),
        ]
    )
    replies = save(conversation, query="")
    assert store.get_profile(1).query == ""
    text = "\n".join(reply.text for reply in replies)
    assert "details/affordable" in text
    assert "details/expensive" not in text
    assert not store.get_profile(1).monitoring


def test_cancelling_deletion_preserves_consented_draft(buyer):
    store, conversation = buyer
    begin(conversation)
    original = store.get_draft(1)
    deletion = button(conversation.handle(1, 1, "/delete"), "Удалить мои данные")
    conversation.handle(1, 1, "/cancel")
    assert store.get_draft(1) == original
    conversation.handle(1, 1, deletion)
    assert store.get_draft(1) == original
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "Toyota Camry")
    conversation.handle(1, 1, button(review, "Сохранить"))
    assert store.get_profile(1).query == "Toyota Camry"


def test_existing_menu_remains_usable_after_conversation_restart(buyer):
    store, conversation = buyer
    resume = button(save(conversation), "Включить мониторинг")
    restarted = Conversation(store)
    restarted.handle(1, 1, resume)
    assert store.get_profile(1).monitoring


def test_stale_consent_cannot_recreate_deleted_user(buyer):
    store, conversation = buyer
    consent = button(conversation.handle(1, 1, "/start"), "Согласен")
    conversation.handle(1, 1, consent)
    deletion = button(conversation.handle(1, 1, "/delete"), "Удалить мои данные")
    conversation.handle(1, 1, deletion)
    conversation.handle(1, 1, consent)
    assert store.get_draft(1) is None
    assert store.get_profile(1) is None


def test_old_monitor_button_cannot_enable_recreated_profile(buyer):
    store, conversation = buyer
    old_resume = button(save(conversation), "Включить мониторинг")
    deletion = button(conversation.handle(1, 1, "/delete"), "Удалить мои данные")
    conversation.handle(1, 1, deletion)
    save(conversation, "Honda Accord")
    recreated = store.get_profile(1)
    conversation.handle(1, 1, old_resume)
    assert store.get_profile(1) == recreated
    assert not recreated.monitoring


def test_editing_paused_profile_invalidates_prior_monitor_choice(buyer):
    store, conversation = buyer
    old_resume = button(save(conversation), "Включить мониторинг")
    conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, "/cancel")
    conversation.handle(1, 1, old_resume)
    assert not store.get_profile(1).monitoring


def test_review_correction_applies_only_after_explicit_save(buyer):
    store, conversation = buyer
    store.upsert_listings(
        [
            Listing(
                identity,
                title,
                f"https://mashina.kg/details/{identity}",
                900000,
                78000000,
                city=city,
                availability="В наличии",
            )
            for identity, title, city in (
                ("toyota", "Toyota Camry", "Бишкек"),
                ("honda-local", "Honda Accord", "Бишкек"),
                ("honda-other", "Honda Accord", "Ош"),
            )
        ]
    )
    save(conversation)
    replies = conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, "10000")
    review = conversation.handle(1, 1, "Honda Accord")
    assert [car.id for car in store.search(store.get_profile(1))] == ["toyota"]
    conversation.handle(1, 1, button(review, "Город"))
    review = conversation.handle(1, 1, "Бишкек")
    assert [car.id for car in store.search(store.get_profile(1))] == ["toyota"]
    conversation.handle(1, 1, button(review, "Сохранить"))
    assert [car.id for car in store.search(store.get_profile(1))] == ["honda-local"]


def test_review_callbacks_are_prompt_bound_user_bound_and_survive_restart(buyer):
    store, conversation = buyer
    begin(conversation)
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "Toyota")
    old_save = button(review, "Сохранить")
    old_city = button(review, "Город")
    city_prompt = conversation.handle(1, 1, old_city)
    city_draft = store.get_draft(1)
    for stale in (old_save, old_city, old_city.replace(":review:", ":city:")):
        conversation.handle(1, 1, stale)
        assert store.get_draft(1) == city_draft
        assert store.get_profile(1) is None
    begin(conversation, user=2)
    conversation.handle(2, 2, "9000")
    conversation.handle(2, 2, "Honda")
    other_draft = store.get_draft(2)
    conversation.handle(2, 2, button(city_prompt, "пропустить"))
    assert store.get_draft(2) == other_draft
    assert store.get_profile(2) is None
    restarted = Conversation(store)
    review = restarted.handle(1, 1, button(city_prompt, "Назад"))
    current_save = button(review, "Сохранить")
    restarted.handle(1, 1, old_save)
    assert store.get_profile(1) is None
    restarted.handle(1, 1, current_save)
    saved = store.get_profile(1)
    assert saved.query == "Toyota"
    restarted.handle(1, 1, current_save)
    assert store.get_profile(1) == saved


def test_unknown_callback_payloads_cannot_become_city_or_model_preferences(buyer):
    store, conversation = buyer
    save(conversation)
    currencies = conversation.handle(1, 1, "/edit")
    stale_currency = button(currencies, "KGS")
    conversation.handle(1, 1, button(currencies, "USD"))
    conversation.handle(1, 1, "10000")
    query_draft = store.get_draft(1)
    for payload in ("unexpected:Toyota", "query:any", stale_currency):
        conversation.handle(1, 1, payload)
        assert store.get_draft(1) == query_draft
    review = conversation.handle(1, 1, "Honda")
    conversation.handle(1, 1, button(review, "Город"))
    city_draft = store.get_draft(1)
    for payload in ("unexpected:Бишкек", "city:Ош", stale_currency):
        conversation.handle(1, 1, payload)
        assert store.get_draft(1) == city_draft
    conversation.handle(1, 1, "/cancel")
    assert store.get_profile(1).query == "Toyota Camry"
    assert store.get_profile(1).city == ""


def test_advanced_preferences_survive_basic_edit_and_back_until_intentionally_cleared(buyer):
    store, conversation = buyer
    begin(conversation)
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "не знаю")
    values = {
        "Что входит": "total",
        "Город": "Бишкек",
        "Кузов": "suv",
        "Год от": "2015",
        "Пробег до": "90 000",
        "Коробка": "automatic",
        "Для чего": "family",
        "Готовность": "no",
        "Планируемая": "29.02.2024",
    }
    for label, value in values.items():
        conversation.handle(1, 1, button(review, label))
        review = conversation.handle(1, 1, value)
    conversation.handle(1, 1, button(review, "Сохранить"))
    conversation.handle(1, 1, "/quiet 22:00-07:00")
    conversation.handle(1, 1, "/resume")
    before = store.get_profile(1)
    fields = (
        "budget_scope",
        "city",
        "body_type",
        "year_min",
        "mileage_max_km",
        "transmission",
        "use_case",
        "allow_import",
        "purchase_by",
        "quiet_start_minute",
        "quiet_end_minute",
    )
    replies = conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, "12000")
    review = conversation.handle(1, 1, "Honda")
    for label, invalid in (
        ("Год от", "1899"),
        ("Пробег до", "-1"),
        ("Планируемая", "2025-02-29"),
        ("Город", "123 !!!"),
    ):
        conversation.handle(1, 1, button(review, label))
        prompt = conversation.handle(1, 1, invalid)
        review = conversation.handle(1, 1, button(prompt, "Назад"))
    conversation.handle(1, 1, button(review, "Сохранить"))
    changed = store.get_profile(1)
    assert changed.query == "Honda"
    assert changed.budget_max_minor == 1_200_000
    assert tuple(getattr(changed, field) for field in fields) == tuple(
        getattr(before, field) for field in fields
    )
    assert not changed.monitoring
    replies = conversation.handle(1, 1, "/edit")
    conversation.handle(1, 1, button(replies, "USD"))
    conversation.handle(1, 1, "12000")
    review = conversation.handle(1, 1, "Honda")
    prompt = conversation.handle(1, 1, button(review, "Город"))
    review = conversation.handle(1, 1, button(prompt, "пропустить"))
    conversation.handle(1, 1, button(review, "Сохранить"))
    assert store.get_profile(1).city == ""
    assert store.get_profile(1).body_type == before.body_type


def test_free_text_is_escaped_in_review_and_saved_profile(buyer):
    store, conversation = buyer
    begin(conversation)
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "<b>Toyota</b>")
    conversation.handle(1, 1, button(review, "Город"))
    review = conversation.handle(1, 1, "<i>Бишкек</i>")
    for raw, escaped in (
        ("<b>Toyota</b>", "&lt;b&gt;Toyota&lt;/b&gt;"),
        ("<i>Бишкек</i>", "&lt;i&gt;Бишкек&lt;/i&gt;"),
    ):
        rendered = "\n".join(reply.text for reply in review)
        assert raw not in rendered
        assert escaped in rendered
    conversation.handle(1, 1, button(review, "Сохранить"))
    rendered = "\n".join(reply.text for reply in conversation.handle(1, 1, "/profile"))
    assert "<b>Toyota</b>" not in rendered
    assert "<i>Бишкек</i>" not in rendered
    assert "&lt;b&gt;Toyota&lt;/b&gt;" in rendered
    assert "&lt;i&gt;Бишкек&lt;/i&gt;" in rendered


def test_currency_correction_requires_a_new_amount_instead_of_relabeling_money(buyer):
    store, conversation = buyer
    store.upsert_listings(
        [
            Listing(
                "affordable",
                "Toyota Camry",
                "https://mashina.kg/details/affordable",
                1200000,
                104400000,
                availability="В наличии",
            )
        ]
    )
    begin(conversation)
    conversation.handle(1, 1, "15000")
    review = conversation.handle(1, 1, "Toyota")
    currencies = conversation.handle(1, 1, button(review, "Валюта"))
    conversation.handle(1, 1, button(currencies, "KGS"))
    review = conversation.handle(1, 1, "1400000")
    conversation.handle(1, 1, button(review, "Сохранить"))
    assert [car.id for car in store.search(store.get_profile(1))] == ["affordable"]
