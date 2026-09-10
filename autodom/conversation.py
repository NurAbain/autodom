import re
import secrets
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from html import escape

from autodom.budget import money, parse_budget
from autodom.matching import normalize, normalize_city
from autodom.models import (
    BODY_TYPES,
    BUDGET_SCOPES,
    MARKETS,
    TRANSMISSIONS,
    USE_CASES,
    Listing,
    Profile,
)
from autodom.sources import enabled_markets, enabled_sources, listing_url_allowed, source_status
from autodom.storage import Store

Button = tuple[str, str]
Buttons = tuple[tuple[Button, ...], ...]


@dataclass(frozen=True, slots=True)
class Reply:
    text: str
    buttons: Buttons = ()


START_BUTTONS: Buttons = ((("Начать подбор", "/start"), ("Данные и согласие", "/privacy")),)
_BISHKEK = timezone(timedelta(hours=6))
_QUIET = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])")
_OPTIONAL_DEFAULTS = {
    "city": "",
    "body_type": "",
    "year_min": None,
    "mileage_max_km": None,
    "transmission": "",
    "use_case": "",
    "allow_import": None,
    "purchase_by": "",
}
_FIELD_LABELS = {
    "market": "Рынок",
    "currency": "Валюта",
    "budget": "Бюджет",
    "query": "Марки и модели",
    "budget_scope": "Что входит в бюджет",
    "city": "Город объявления",
    "body_type": "Кузов",
    "year_min": "Год от",
    "mileage_max_km": "Пробег до, км",
    "transmission": "Коробка передач",
    "use_case": "Для чего автомобиль",
    "allow_import": "Готовность ждать импорт",
    "purchase_by": "Планируемая дата покупки",
}
_CHOICES = {
    "budget_scope": BUDGET_SCOPES,
    "body_type": BODY_TYPES,
    "transmission": TRANSMISSIONS,
    "use_case": USE_CASES,
    "allow_import": {"yes": "Готов ждать импорт", "no": "Без импорта"},
}
_FILTER_NOTE = (
    "Жёсткие фильтры поиска и уведомлений: рынок, цена объявления, слова марки/модели, "
    "город, кузов, год, пробег, коробка и запрет импорта, если выбраны. "
    "Неизвестные или нераспознанные данные не проходят соответствующий выбранный фильтр. "
    "Город — место объявления, не пункт доставки.\n"
    "Цель и дата покупки — только заметки: не определяют пригодность машины и не останавливают мониторинг.\n"
    "Бюджет «под ключ» исключает иностранные объявления: полной стоимости ввоза пока нет. "
    "Даже для местных объявлений проверяется цена машины, а не все расходы покупки. "
    "Аукционы сравниваются с бюджетом только по Buy Now, пока предложение активно: "
    "текущая ставка, оценка и результат завершённых торгов не являются ценой покупки. "
    "Готовность к импорту не включает выключенные источники и не гарантирует срок доставки."
)
_USE_CASE_TIPS = {
    "city": "Для городских поездок проверьте реальные габариты парковки и расход в пробках.",
    "family": "Для семейных поездок проверьте крепления детских кресел, ремни и место для пассажиров и багажа.",
    "work": "Для работы уточните допустимую нагрузку, стоимость простоя и доступность расходников.",
    "travel": "Для дальних поездок проверьте запасное колесо, тормоза и историю обслуживания перед выездом.",
}


def privacy_text() -> str:
    sources = ", ".join(source.name for source in enabled_sources())
    return (
        "<b>Autodom — помощник при покупке автомобиля</b>\n\n"
        f"Бесплатный поиск по бюджету и пожеланиям. Включённые источники: {sources}. "
        "Иностранные адаптеры без согласованного доступа не собирают и не показывают объявления. "
        "Цена за рубежом не включает доставку, таможню, оформление и возможный ремонт; "
        "доступность экспорта не подтверждена. Платные услуги не подключены.\n\n"
        "После вашего согласия сохраняю на сервере проекта Telegram ID, ID личного чата, "
        "черновик рынка, бюджета, моделей и дополнительных предпочтений (город, кузов, год, пробег, "
        "коробка, цель, готовность к импорту, планируемая дата покупки), затем профиль и настройки уведомлений. "
        "Это нужно для поиска и бесплатного мониторинга. Бюджет и контакты партнёрам не передаются; "
        "профиль и уведомления доступны только в личном чате. Данные хранятся до удаления: "
        "/delete удаляет профиль и незавершённый ввод из рабочей базы. "
        "Локальные резервные копии хранятся до 7 дней; удалённые данные могут оставаться в них до истечения этого срока.\n\n"
        "Профиль сохраняется только после проверки и кнопки «Сохранить». Дополнительные поля необязательны. "
        "Цель и дата покупки — заметки, не оценка пригодности автомобиля и не срок остановки мониторинга. "
        "Мониторинг включается отдельно. /privacy — это описание; /cancel — отмена ввода. "
        "До нажатия «Согласен на хранение» новый черновик не сохраняется."
    )


def profile_text(profile: Profile) -> str:
    budget = (
        f"до {money(profile.budget_max_minor, profile.currency)}"
        if profile.budget_min_minor == 0
        else f"{money(profile.budget_min_minor, profile.currency)} — {money(profile.budget_max_minor, profile.currency)}"
    )
    query = escape(profile.query) if profile.query else "любые модели"
    quiet = "выключены"
    if profile.quiet_start_minute is not None and profile.quiet_end_minute is not None:
        start, end = profile.quiet_start_minute, profile.quiet_end_minute
        quiet = f"{start // 60:02d}:{start % 60:02d}–{end // 60:02d}:{end % 60:02d}"
    return (
        f"Рынок: <b>{MARKETS[profile.market]}</b>\n"
        f"Бюджет: <b>{budget}</b> · {BUDGET_SCOPES[profile.budget_scope]}\nАвтомобили: {query}\n"
        f"Город объявления: {escape(profile.city) if profile.city else 'любой'}\n"
        f"Кузов: {BODY_TYPES.get(profile.body_type, 'любой')}; "
        f"год от: {profile.year_min if profile.year_min is not None else 'не задан'}\n"
        f"Пробег до: {str(profile.mileage_max_km) + ' км' if profile.mileage_max_km is not None else 'не задан'}; "
        f"коробка: {TRANSMISSIONS.get(profile.transmission, 'любая')}\n"
        f"Импорт: {'готов ждать' if profile.allow_import is True else 'исключён' if profile.allow_import is False else 'не уточнён, разрешён из включённых источников'}\n"
        f"Цель (заметка): {USE_CASES.get(profile.use_case, 'не задана')}; "
        f"дата покупки (заметка): {escape(profile.purchase_by) if profile.purchase_by else 'не задана'}\n"
        f"Мониторинг: {'включён' if profile.monitoring else 'на паузе'}\n"
        f"Тихие часы (Бишкек, UTC+6): {quiet}. /quiet — настройка."
    )


def menu(profile: Profile) -> Buttons:
    monitor = (
        ("Приостановить", f"monitor:{profile.revision}:off")
        if profile.monitoring
        else ("Включить мониторинг", f"monitor:{profile.revision}:on")
    )
    return (
        (("Найти автомобили", "/search"),),
        (monitor, ("Изменить поиск", "/edit")),
        (("Мой поиск", "/profile"), ("Советы", "/tips")),
        (("Данные и согласие", "/privacy"),),
    )


def listing_text(listing: Listing, currency: str) -> str:
    title = escape(listing.title[:140])
    if listing_url_allowed(listing.source, listing.url):
        title = f'<a href="{escape(listing.url, quote=True)}">{title}</a>'
    price = listing.price(currency)
    original = listing.original_price_minor
    if original is not None and listing.original_currency:
        label = (
            "Buy Now — цена выкупа: " if listing.price_kind == "buy_now" else "Цена объявления: "
        )
        price_text = label + money(original, listing.original_currency)
        if listing.original_currency != currency:
            price_text += (
                f" (≈ {money(price, currency)} по НБКР)"
                if price is not None
                else " (свежий пересчёт в валюту бюджета недоступен)"
            )
    else:
        price_text = money(price, currency) if price is not None else "цена не указана"
    parts = [str(listing.year) if listing.year else "год не указан"]
    parts.extend(
        value[:80]
        for value in (listing.mileage, listing.transmission, listing.body_type, listing.trim)
        if value
    )
    if listing.registration_month:
        parts.append("регистрация: " + listing.registration_month[:10])
    city = escape(listing.city[:80]) if listing.city else "город не указан"
    observed = (
        datetime.fromtimestamp(listing.observed_at, _BISHKEK).strftime("%d.%m.%Y %H:%M")
        + " (Бишкек, UTC+6)"
        if listing.observed_at is not None
        else "время наблюдения неизвестно"
    )
    text = (
        f"<b>{title}</b>\n"
        f"{price_text} · {city} · {MARKETS[listing.market]}\n"
        f"{escape(' · '.join(parts))}\n"
        f"Статус на сайте: {escape(listing.availability[:50]) or 'не указан'}. "
        f"Источник: {escape(listing.source)}.\n"
        f"Последнее наблюдение: {observed}. Цену и наличие подтвердите у продавца."
    )
    if listing.market != "KG":
        text += "\nДоставка, таможня, оформление и ремонт не включены. Экспорт не подтверждён."
        text += (
            "\n" + escape(listing.condition[:600])
            if listing.condition
            else "\nИстория ДТП и документов неизвестна."
        )
        text += " Независимая проверка не выполнена."
        if listing.fx_date and price is not None and listing.original_currency != currency:
            text += f"\nДаты курсов НБКР: {escape(listing.fx_date)}."
    if listing.auction_house or listing.auction_status:
        auction_status = {
            "active": "активен на момент наблюдения",
            "ended": "завершён",
            "unknown": "не подтверждён",
        }.get(listing.auction_status, "не подтверждён")
        text += (
            f"\nАукцион: {escape(listing.auction_house[:30]) or 'не указан'}, "
            f"лот {escape(listing.auction_lot[:40]) or 'не указан'} — {auction_status}."
        )
        if listing.vin:
            text += "\nVIN / номер кузова: " + escape(listing.vin[:40]) + "."
        if listing.auction_at is not None:
            auction_time = datetime.fromtimestamp(listing.auction_at, _BISHKEK).strftime(
                "%d.%m.%Y %H:%M"
            )
            text += f"\nНачало основных торгов: {auction_time} (Бишкек, UTC+6)."
        for label, amount in (
            ("Текущая ставка — не цена покупки", listing.current_bid_minor),
            ("Финальная ставка завершённых торгов — не предложение", listing.final_bid_minor),
        ):
            if amount is not None:
                text += f"\n{label}: {money(amount, 'USD')}."
        if listing.estimated_min_minor is not None and listing.estimated_max_minor is not None:
            text += (
                f"\nОценка источника — не цена покупки: {money(listing.estimated_min_minor, 'USD')}"
                f"–{money(listing.estimated_max_minor, 'USD')}."
            )
        if price is None:
            text += "\nПодтверждённой цены для текущего подбора нет; Buy Now может быть недоступен."
        text += "\nАукционные и брокерские сборы также не включены. Условия выкупа подтвердите до оплаты."
    return text


def pack_replies(header: str, sections: list[str], buttons: Buttons = ()) -> list[Reply]:
    chunks = []
    current = header
    for section in sections:
        if len(current) + len(section) + 2 > 3800:
            if current:
                chunks.append(Reply(current))
            current = section
        else:
            current += ("\n\n" if current else "") + section
    if current:
        chunks.append(Reply(current, buttons))
    return chunks


class Conversation:
    def __init__(self, store: Store):
        self.store = store
        # Consent is the only pre-persistence state; old consent buttons expire on restart.
        self._consents: OrderedDict[int, str] = OrderedDict()

    def _privacy(self, user_id: int, profile: Profile | None) -> list[Reply]:
        if profile:
            return [Reply(privacy_text(), menu(profile))]
        nonce = secrets.token_urlsafe(12)
        self._consents.pop(user_id, None)
        self._consents[user_id] = nonce
        if len(self._consents) > 2048:
            self._consents.popitem(last=False)
        return [
            Reply(
                privacy_text(), ((("Согласен на хранение — начать подбор", f"consent:{nonce}"),),)
            )
        ]

    def _begin(self, user_id: int, profile: Profile | None) -> list[Reply]:
        data = {"consent": True, "budget_scope": "car", **_OPTIONAL_DEFAULTS}
        if profile:
            self.store.set_monitoring(user_id, False)
            data.update({field: getattr(profile, field) for field in _OPTIONAL_DEFAULTS})
            data.update(
                market=profile.market,
                currency=profile.currency,
                minimum=profile.budget_min_minor,
                maximum=profile.budget_max_minor,
                query=profile.query,
                budget_scope=profile.budget_scope,
            )
        markets = enabled_markets()
        if len(markets) == 1:
            data["market"] = markets[0]
        return self._prompt(user_id, "currency" if len(markets) == 1 else "market", data)

    @staticmethod
    def _draft_profile(user_id: int, data: dict, profile: Profile | None) -> Profile:
        return Profile(
            user_id=user_id,
            chat_id=user_id,
            currency=data["currency"],
            budget_min_minor=data["minimum"],
            budget_max_minor=data["maximum"],
            query=data["query"],
            market=data.get("market", "KG"),
            budget_scope=data.get("budget_scope", "car"),
            quiet_start_minute=profile.quiet_start_minute if profile else None,
            quiet_end_minute=profile.quiet_end_minute if profile else None,
            **{field: data.get(field, default) for field, default in _OPTIONAL_DEFAULTS.items()},
        )

    def _prompt(self, user_id: int, state: str, data: dict, error: str = "") -> list[Reply]:
        data = {**data, "nonce": secrets.token_urlsafe(12)}
        self.store.set_draft(user_id, state, data)

        def choice(label: str, value: str) -> Button:
            return label, f"draft:{data['nonce']}:{state}:{value}"

        if state == "review":
            candidate = self._draft_profile(user_id, data, self.store.get_profile(user_id))
            text = (
                "<b>Проверьте поиск перед сохранением</b>\n"
                "Что входит в ваш бюджет? При первом вводе по умолчанию — цена автомобиля. "
                "Можно сохранить сразу или уточнить любое поле; незаполненные поля не добавляют ограничений.\n\n"
                + profile_text(candidate)
                + "\n\n"
                + _FILTER_NOTE
                + "\n\nПока это черновик. /cancel — оставить прежний поиск; мониторинг останется на паузе."
            )
            buttons = ((choice("Сохранить поиск", "save"),),) + tuple(
                (choice(label, "edit." + field),) for field, label in _FIELD_LABELS.items()
            )
        else:
            prompts = {
                "market": "На каком рынке искать? Иностранная цена не включает доставку, таможню, оформление и ремонт.",
                "currency": "В какой валюте задать бюджет? Значение бюджета уточняется перед сохранением.",
                "budget": f"Какой бюджет в {data.get('pending_currency', data.get('currency', 'USD'))}? Например: 15000, 15к или 10000–15000. Без обозначения валюты.",
                "query": "Какие автомобили рассматриваете? Например: Toyota Camry, Honda Accord. Запятая разделяет альтернативы; внутри варианта все слова обязательны. Если не определились — «Пока не знаю».",
                "budget_scope": "Что входит в бюджет? Цена автомобиля — сравнение с ценой объявления. Под ключ — иностранные объявления исключены, пока нет полной стоимости ввоза; для местных проверяется только цена машины, дополнительные расходы не рассчитаны.",
                "city": "Город объявления (до 80 символов), например Бишкек. Это место автомобиля в источнике, не адрес доставки. При выборе города объявления без известного города исключаются.",
                "body_type": "Какой кузов? Неизвестный или нераспознанный кузов не пройдёт выбранный фильтр.",
                "year_min": f"Самый ранний год выпуска: целое число от 1900 до {datetime.now(UTC).year + 1}. Неизвестный год не пройдёт фильтр.",
                "mileage_max_km": "Максимальный пробег в километрах: целое число от 0 до 10 000 000. Можно разделять тысячи пробелами. Неизвестный пробег не пройдёт фильтр.",
                "transmission": "Какая коробка передач? Неизвестная или нераспознанная коробка не пройдёт фильтр.",
                "use_case": "Для чего автомобиль? Это заметка для общих советов, не оценка пригодности конкретной модели и не фильтр.",
                "allow_import": "Готовы ждать импорт? «Без импорта» исключает зарубежные объявления. Готовность не гарантирует срок и не включает выключенные источники; бюджет под ключ всё равно исключает иностранные объявления.",
                "purchase_by": "Планируемая дата покупки: ГГГГ-ММ-ДД (например 2026-12-31) или ДД.ММ.ГГГГ. Это заметка, не фильтр и не дата автоматической остановки мониторинга. Прошлая дата допустима.",
            }
            text = prompts[state]
            choices = _CHOICES.get(state, {})
            if state == "market":
                markets = enabled_markets()
                choices = {
                    market: MARKETS[market]
                    for market in ((*markets, "ALL") if len(markets) > 1 else markets)
                }
            elif state == "currency":
                choices = {"USD": "Доллары США · USD", "KGS": "Сомы · KGS"}
            buttons = tuple((choice(label, value),) for value, label in choices.items())
            if state == "query" or state in _OPTIONAL_DEFAULTS:
                buttons += (
                    (
                        choice(
                            "Пока не знаю / без ограничения"
                            if state == "query"
                            else "Не знаю / пропустить (снять значение)",
                            "skip",
                        ),
                    ),
                )
            if data.get("return_review") or state in {"currency", "budget", "query"}:
                if state != "currency" or data.get("return_review") or len(enabled_markets()) > 1:
                    buttons += ((choice("Назад — сохранить прежнее значение", "back"),),)
            text += "\n/cancel — отменить весь ввод. Мониторинг на время изменений приостановлен."
        return [Reply((escape(error) + "\n\n" if error else "") + text, buttons)]

    def _advance(self, user_id: int, state: str, data: dict) -> list[Reply]:
        if data.pop("return_review", False):
            return self._prompt(user_id, "review", data)
        return self._prompt(
            user_id,
            {"market": "currency", "currency": "budget", "budget": "query"}.get(state, "review"),
            data,
        )

    def _catalog_note(self, profile: Profile | None = None) -> str:
        lines = []
        for source in source_status(self.store):
            if not source["enabled"]:
                if profile is None:
                    lines.append(
                        f"{source['name']}: выключен до согласования доступа; сбор и показ запрещены."
                    )
                continue
            if profile is not None and profile.market not in ("ALL", source["market"]):
                continue
            lines.append(
                f"{source['name']} · {MARKETS[source['market']]}: "
                f"{source['listings']:,} сохранённых объявлений.".replace(",", " ")
            )
            if source["last_sync"]:
                lines.append(f"Последняя успешная страница: {escape(source['last_sync'])}.")
            if source["total"] is not None:
                lines.append(f"Последний запрос источника: {escape(source['total'])} объявлений.")
            if source["scope"]:
                lines.append("Охват запроса: " + escape(source["scope"][:400]))
            if source["error"]:
                lines.append(
                    "Ошибка этого источника; его данные могут быть неполными или устаревшими."
                )
        if not lines:
            lines.append("Рынок поиска сейчас выключен. Выберите доступный рынок через /edit.")
        lines.append(
            "Это не весь рынок. В выдаче — наблюдения за последние 48 часов; "
            "зарубежные объявления означают публикацию на сайте, а не подтверждённое наличие."
        )
        if profile is not None and profile.market in ("KR", "ALL"):
            lines.append(
                "Для цен KRW нужен свежий курс НБКР; без него сравнение по бюджету не выполняется."
            )
        return "\n".join(lines)

    def search(self, profile: Profile, offset: int = 0) -> list[Reply]:
        count = self.store.count_matches(profile)
        if offset >= count and offset:
            return [Reply("Выдача изменилась. Откройте её заново: /search.", menu(profile))]
        listings = self.store.search(profile, limit=5, offset=offset)
        if not listings:
            return [
                Reply(
                    "Совпадений в свежей собранной части каталога нет. Это не означает, что таких машин нет на всём рынке.\n\n"
                    + profile_text(profile)
                    + "\n\n"
                    + _FILTER_NOTE
                    + "\n\n"
                    + self._catalog_note(profile)
                    + "\n\nМожно изменить пожелания или включить бесплатный мониторинг.",
                    menu(profile),
                )
            ]
        heading = (
            f"<b>Совпадения по фильтрам · {offset + 1}–{offset + len(listings)} из {count}</b>\n"
            + profile_text(profile)
            + "\n\n"
            + _FILTER_NOTE
            + "\nСначала — недавно найденные варианты.\n"
            + self._catalog_note(profile)
        )
        buttons = menu(profile)
        if offset + len(listings) < count:
            buttons = (
                (("Ещё варианты", f"page:{profile.revision}:{offset + len(listings)}"),),
            ) + buttons
        return pack_replies(
            heading, [listing_text(listing, profile.currency) for listing in listings], buttons
        )

    def handle(self, user_id: int, chat_id: int, text: str) -> list[Reply]:
        if chat_id != user_id:
            return [Reply("Бюджет, профиль и уведомления доступны только в личном чате с ботом.")]
        text = text.strip()
        profile = self.store.get_profile(user_id)
        command = text.split(maxsplit=1)[0].split("@", 1)[0].lower() if text else ""
        draft = self.store.get_draft(user_id)
        consent = self._consents.pop(user_id, None)
        if text.startswith("consent:"):
            if profile or consent is None or text != f"consent:{consent}":
                return [
                    Reply(
                        "Согласие не принято: откройте актуальное описание /privacy.",
                        menu(profile) if profile else START_BUTTONS,
                    )
                ]
            return self._begin(user_id, None)
        action = None
        if text.startswith("draft:"):
            parts = text.split(":")
            if (
                not draft
                or len(parts) != 4
                or parts[1] != draft[1].get("nonce")
                or parts[2] != draft[0]
                or draft[0] == "delete_confirm"
            ):
                return [
                    Reply(
                        "Эта кнопка устарела или не относится к вашему текущему шагу. Продолжите текущий ввод или /edit."
                    )
                ]
            state = draft[0]
            action = parts[3]
            allowed = set(_CHOICES.get(state, {}))
            if state == "review":
                allowed = {"save", *("edit." + field for field in _FIELD_LABELS)}
            elif state == "currency":
                allowed.update(("USD", "KGS"))
            elif state == "market":
                markets = enabled_markets()
                allowed.update((*markets, "ALL") if len(markets) > 1 else markets)
            if state == "query" or state in _OPTIONAL_DEFAULTS:
                allowed.add("skip")
            if (
                draft[1].get("return_review")
                or state in {"budget", "query"}
                or (state == "currency" and len(enabled_markets()) > 1)
            ):
                allowed.add("back")
            if action not in allowed:
                return [
                    Reply("Эта кнопка не относится к текущему шагу. Продолжите ввод или /cancel.")
                ]
        if text.startswith("monitor:"):
            parts = text.split(":")
            if (
                not profile
                or len(parts) != 3
                or parts[1] != str(profile.revision)
                or parts[2] not in {"on", "off"}
            ):
                return [
                    Reply(
                        "Настройки изменились. Откройте актуальный поиск: /profile.",
                        menu(profile) if profile else START_BUTTONS,
                    )
                ]
            command = "/resume" if parts[2] == "on" else "/pause"
        if command == "/privacy":
            return self._privacy(user_id, profile)
        if command == "/start":
            if profile:
                return [Reply("Ваш сохранённый поиск:\n\n" + profile_text(profile), menu(profile))]
            return self._privacy(user_id, None)
        if command in {"/begin", "/edit"}:
            if not profile and not (draft and draft[1].get("consent") is True):
                return self._privacy(user_id, None)
            return self._begin(user_id, profile)
        if command == "/cancel":
            if draft and draft[0] == "delete_confirm" and draft[1].get("previous"):
                previous_state, previous_data = draft[1]["previous"]
                self.store.set_draft(user_id, previous_state, previous_data)
            else:
                self.store.clear_draft(user_id)
            note = (
                "Удаление отменено. Незавершённый ввод сохранён."
                if draft and draft[0] == "delete_confirm" and draft[1].get("previous")
                else "Удаление отменено."
                if draft and draft[0] == "delete_confirm"
                else "Ввод отменён."
            )
            if profile:
                note += " Сохранённый поиск не изменён."
                note += (
                    " Мониторинг остаётся на паузе; /resume — включить."
                    if not profile.monitoring
                    else " Мониторинг остаётся включён."
                )
            return [Reply(note, menu(profile) if profile else START_BUTTONS)]
        if command == "/help":
            return [
                Reply(
                    "/start — начать или открыть поиск\n/search — подходящие автомобили\n/profile — бюджет и пожелания\n"
                    "/edit — изменить поиск\n/resume — включить бесплатный мониторинг\n/pause — приостановить\n"
                    "/quiet HH:MM-HH:MM — тихие часы (Бишкек, UTC+6); /quiet off — отключить\n"
                    "/privacy — хранение данных и согласие\n/tips — советы перед покупкой\n/status — состояние каталога\n"
                    "/cancel — отменить ввод\n/delete — удалить мои данные\n\n"
                    "Бюджет можно ввести как 15000, 15к или 10000–15000. Модели — через запятую: Toyota Camry, Honda Accord. "
                    "Внутри одного варианта все слова обязательны. Можно выбрать «Пока не знаю».",
                    menu(profile) if profile else START_BUTTONS,
                )
            ]
        if command == "/status":
            return [Reply(self._catalog_note(), menu(profile) if profile else START_BUTTONS)]
        if command == "/delete":
            if not profile and not draft:
                return [Reply("Сохранённых данных нет.", START_BUTTONS)]
            previous = draft[1].get("previous") if draft and draft[0] == "delete_confirm" else draft
            nonce = secrets.token_urlsafe(12)
            self.store.set_draft(user_id, "delete_confirm", {"nonce": nonce, "previous": previous})
            return [
                Reply(
                    "Удалить Telegram ID, бюджет, пожелания, незавершённый ввод и настройки уведомлений из рабочей базы? "
                    "Мониторинг остановится сразу. Локальные резервные копии хранятся до 7 дней. "
                    "Восстановить поиск здесь можно только новым вводом.",
                    ((("Удалить мои данные", f"delete:{nonce}"), ("Отмена", "/cancel")),),
                )
            ]
        if text.startswith("delete:"):
            if not draft or draft[0] != "delete_confirm" or text != f"delete:{draft[1]['nonce']}":
                return [
                    Reply(
                        "Подтверждение устарело. Для удаления используйте /delete.",
                        menu(profile) if profile else START_BUTTONS,
                    )
                ]
            self.store.delete_user(user_id)
            return [
                Reply(
                    "Профиль и незавершённый ввод удалены. Уведомления остановлены.", START_BUTTONS
                )
            ]
        if command in {
            "/profile",
            "/search",
            "/pause",
            "/resume",
            "/tips",
            "/quiet",
        } or text.startswith("page:"):
            if not profile:
                return [Reply("Сначала задайте бюджет и пожелания через /start.", START_BUTTONS)]
            if command == "/profile":
                return [Reply(profile_text(profile) + "\n\n" + _FILTER_NOTE, menu(profile))]
            if command == "/quiet":
                value = text.partition(" ")[2].strip()
                if value.lower() == "off":
                    start = end = None
                elif match := _QUIET.fullmatch(value):
                    hours_from, minutes_from, hours_to, minutes_to = map(int, match.groups())
                    start, end = hours_from * 60 + minutes_from, hours_to * 60 + minutes_to
                    if start == end:
                        return [
                            Reply(
                                "Начало и конец должны различаться. Для отключения: /quiet off.",
                                menu(profile),
                            )
                        ]
                else:
                    return [
                        Reply(
                            "Задайте /quiet 22:00-07:00 или /quiet off. Часовой пояс: Бишкек (UTC+6). "
                            "Начало включительно, конец не включается; переход через полночь допустим. "
                            "Тихие часы задерживают уведомления, но не включают мониторинг.",
                            menu(profile),
                        )
                    ]
                profile = self.store.set_quiet_hours(user_id, start, end)
                return [Reply("Тихие часы сохранены.\n\n" + profile_text(profile), menu(profile))]
            if command == "/pause":
                profile = self.store.set_monitoring(user_id, False)
                return [
                    Reply(
                        "Мониторинг приостановлен. Поиск остаётся доступным бесплатно.",
                        menu(profile),
                    )
                ]
            if command == "/resume":
                if draft and draft[0] == "delete_confirm":
                    return [
                        Reply(
                            "Сначала подтвердите удаление или отмените его: /cancel. Настройки мониторинга не изменены."
                        )
                    ]
                if draft:
                    return [
                        Reply(
                            "Сначала завершите изменение поиска или /cancel. Мониторинг остаётся на паузе."
                        )
                    ]
                if not profile.monitoring:
                    profile = self.store.set_monitoring(user_id, True)
                return [
                    Reply(
                        "Бесплатный мониторинг включён. Буду присылать новые совпадения в нашем каталоге и снижение цены. "
                        "Уже собранные варианты смотрите через /search: повторно отправлять весь каталог не буду. "
                        "Новая запись в каталоге не обязательно только что опубликована на сайте. /pause — остановить.",
                        menu(profile),
                    )
                ]
            if command == "/tips":
                return [
                    Reply(
                        "<b>Перед покупкой</b>\n\n"
                        + profile_text(profile)
                        + "\n\n• Оставьте отдельный резерв на проверку, оформление, первые расходники и возможный ремонт; фильтр бюджета самовольно не уменьшается."
                        "\n• До поездки уточните наличие, окончательную цену, документы и право продавца распоряжаться автомобилем."
                        "\n• Сверьте VIN на машине и в документах. Объявление не подтверждает отсутствие ДТП, юридических ограничений или скрученного пробега."
                        "\n• До передачи денег проведите независимую диагностику. Не переводите задаток только на основании переписки."
                        "\n• Похожие модели сравнивайте по состоянию и полной стоимости владения, а не только по году выпуска."
                        "\n\nЭто общие рекомендации, а не заключение о состоянии или пригодности конкретной машины."
                        + (
                            "\n" + _USE_CASE_TIPS[profile.use_case]
                            if profile.use_case in _USE_CASE_TIPS
                            else ""
                        ),
                        menu(profile),
                    )
                ]
            offset = 0
            if text.startswith("page:"):
                try:
                    _, revision, raw_offset = text.split(":")
                    if revision != str(profile.revision):
                        raise ValueError("Stale search")
                    offset = int(raw_offset)
                except ValueError:
                    return [Reply("Откройте актуальную выдачу: /search.", menu(profile))]
                if not 0 <= offset <= 1_000_000:
                    return [Reply("Откройте актуальную выдачу: /search.", menu(profile))]
            return self.search(profile, offset)
        if not draft:
            return [
                Reply(
                    "Используйте /edit для изменения пожеланий или /search для подбора.",
                    menu(profile) if profile else START_BUTTONS,
                )
            ]
        state, data = draft
        if state == "delete_confirm":
            return [
                Reply(
                    "Ожидаю подтверждение удаления. /delete — новая кнопка; /cancel — сохранить данные."
                )
            ]
        if not profile and data.get("consent") is not True:
            return self._privacy(user_id, None)
        if action is None and (
            ":" in text
            or text.startswith("/")
            or any(ord(char) < 32 or ord(char) == 127 for char in text)
        ):
            return [
                Reply(
                    "Команда или кнопка не может быть значением поля. Продолжите ввод или /cancel."
                )
            ]
        if state == "review":
            if action == "save":
                candidate = self._draft_profile(user_id, data, profile)
                profile = self.store.save_profile(candidate)
                self.store.clear_draft(user_id)
                return [
                    Reply(
                        "Поиск сохранён. Подбор и мониторинг бесплатны. Уведомления включите отдельной кнопкой."
                    )
                ] + self.search(profile)
            if action and action.startswith("edit."):
                return self._prompt(
                    user_id, action.removeprefix("edit."), {**data, "return_review": True}
                )
            return self._prompt(
                user_id,
                "review",
                data,
                "Для сохранения нажмите «Сохранить», для исправления — нужное поле.",
            )
        if action == "back":
            data.pop("pending_currency", None)
            if data.pop("return_review", False):
                return self._prompt(user_id, "review", data)
            return self._prompt(
                user_id,
                {"currency": "market", "budget": "currency", "query": "budget"}[state],
                data,
            )
        unknown = text.casefold() in {
            "любые",
            "любой",
            "любая",
            "не знаю",
            "пока не знаю",
            "все",
            "пропустить",
        }
        if action == "skip" or (
            action is None and unknown and (state == "query" or state in _OPTIONAL_DEFAULTS)
        ):
            data[state] = _OPTIONAL_DEFAULTS.get(state, "")
            return self._advance(user_id, state, data)
        value = action if action is not None else text
        if len(value) > 160:
            return self._prompt(
                user_id,
                state,
                data,
                "Слишком длинный ввод: максимум 160 символов, для города — 80.",
            )
        if state == "market":
            market = value.upper()
            markets = enabled_markets()
            allowed = (*markets, "ALL") if len(markets) > 1 else markets
            if market not in allowed:
                return self._prompt(user_id, state, data, "Выберите включённый рынок кнопкой.")
            data["market"] = market
        elif state == "currency":
            currency = value.upper()
            currency = {"СОМ": "KGS", "СОМЫ": "KGS", "$": "USD"}.get(currency, currency)
            if currency not in {"USD", "KGS"}:
                return self._prompt(user_id, state, data, "Выберите USD или KGS.")
            if data.get("return_review") and currency != data["currency"]:
                return self._prompt(user_id, "budget", {**data, "pending_currency": currency})
            data["currency"] = currency
        elif state == "budget":
            try:
                minimum, maximum = parse_budget(value)
            except ValueError as error:
                return self._prompt(user_id, state, data, str(error))
            data.update(minimum=minimum, maximum=maximum)
            if "pending_currency" in data:
                data["currency"] = data.pop("pending_currency")
        elif state == "query":
            if len(value.split(",")) > 5 or any(not normalize(part) for part in value.split(",")):
                return self._prompt(
                    user_id,
                    state,
                    data,
                    "Укажите до пяти непустых вариантов с буквами или цифрами через запятую, не более 160 символов, либо выберите «Пока не знаю».",
                )
            data["query"] = value
        elif state in _CHOICES:
            choices = _CHOICES[state]
            selected = value.casefold()
            if selected not in choices:
                selected = next(
                    (key for key, label in choices.items() if label.casefold() == selected), ""
                )
            if selected not in choices:
                return self._prompt(user_id, state, data, "Выберите один из вариантов кнопкой.")
            data[state] = selected == "yes" if state == "allow_import" else selected
        elif state == "city":
            if len(value) > 80 or not any(char.isalpha() for char in normalize_city(value)):
                return self._prompt(
                    user_id,
                    state,
                    data,
                    "Введите название города с буквами, не более 80 символов, или пропустите.",
                )
            data["city"] = value
        elif state in {"year_min", "mileage_max_km"}:
            digits = (
                value.replace(" ", "").replace("\u00a0", "") if state == "mileage_max_km" else value
            )
            minimum, maximum = (
                (1900, datetime.now(UTC).year + 1) if state == "year_min" else (0, 10_000_000)
            )
            if not re.fullmatch(r"[0-9]+", digits) or not minimum <= int(digits) <= maximum:
                return self._prompt(
                    user_id,
                    state,
                    data,
                    f"Введите целое число от {minimum} до {maximum} или пропустите.",
                )
            data[state] = int(digits)
        elif state == "purchase_by":
            try:
                if re.fullmatch(r"[0-9]{2}\.[0-9]{2}\.[0-9]{4}", value):
                    parsed = datetime.strptime(value, "%d.%m.%Y").date()
                elif re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
                    parsed = date.fromisoformat(value)
                else:
                    raise ValueError("Invalid date format")
            except ValueError:
                return self._prompt(
                    user_id,
                    state,
                    data,
                    "Введите существующую календарную дату ГГГГ-ММ-ДД или ДД.ММ.ГГГГ, либо пропустите.",
                )
            data[state] = parsed.isoformat()
        else:
            return [
                Reply(
                    "Черновик использует прежний шаг. /edit — начать ввод заново; /cancel — отменить."
                )
            ]
        return self._advance(user_id, state, data)
