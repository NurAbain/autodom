import re
import secrets
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import escape

from autodom.budget import money, parse_budget
from autodom.matching import normalize
from autodom.models import Listing, Profile
from autodom.storage import Store

Button = tuple[str, str]
Buttons = tuple[tuple[Button, ...], ...]


@dataclass(frozen=True, slots=True)
class Reply:
    text: str
    buttons: Buttons = ()


START_BUTTONS: Buttons = ((("Начать подбор", "/start"), ("Данные и согласие", "/privacy")),)
CURRENCIES: Buttons = ((("Доллары США · USD", "currency:USD"), ("Сомы · KGS", "currency:KGS")),)
ANY_CAR: Buttons = ((("Пока не знаю / любые", "query:any"),),)
_BISHKEK = timezone(timedelta(hours=6))
_QUIET = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])")


def privacy_text() -> str:
    return (
        "<b>Autodom — помощник при покупке автомобиля</b>\n\n"
        "Бесплатный поиск по бюджету и пожеланиям: только местные автомобили Mashina.kg "
        "с пометкой «В наличии» в Кыргызстане. Другие площадки, США, Корея, машины на заказ "
        "и платные услуги пока не подключены.\n\n"
        "После вашего согласия сохраняю на сервере проекта Telegram ID, ID личного чата, "
        "черновик бюджета и пожеланий, затем профиль и настройки уведомлений. "
        "Это нужно для поиска и бесплатного мониторинга. Бюджет и контакты партнёрам не передаются; "
        "профиль и уведомления доступны только в личном чате. Данные хранятся до удаления: "
        "/delete удаляет профиль и незавершённый ввод из рабочей базы. "
        "Локальные резервные копии хранятся до 7 дней; удалённые данные могут оставаться в них до истечения этого срока.\n\n"
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
        f"Бюджет: <b>{budget}</b>\nАвтомобили: {query}\n"
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
    if listing.url.startswith("https://mashina.kg/details/") and len(listing.url) <= 600:
        title = f'<a href="{escape(listing.url, quote=True)}">{title}</a>'
    price = listing.price(currency)
    parts = [str(listing.year) if listing.year else "год не указан"]
    parts.extend(
        value[:60] for value in (listing.mileage, listing.transmission, listing.body_type) if value
    )
    city = escape(listing.city[:80]) if listing.city else "город не указан"
    observed = (
        datetime.fromtimestamp(listing.observed_at, _BISHKEK).strftime("%d.%m.%Y %H:%M")
        + " (Бишкек, UTC+6)"
        if listing.observed_at is not None
        else "время наблюдения неизвестно"
    )
    return (
        f"<b>{title}</b>\n"
        f"{money(price, currency) if price is not None else 'цена не указана'} · {city}\n"
        f"{escape(' · '.join(parts))}\n"
        f"Наличие на сайте: {escape(listing.availability[:50]) or 'не указано'}. Источник: Mashina.kg.\n"
        f"Последнее наблюдение: {observed}. Цену и наличие подтвердите у продавца."
    )


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
        if profile:
            self.store.set_monitoring(user_id, False)
        self.store.set_draft(user_id, "currency", {"consent": True})
        return [
            Reply(
                "В какой валюте удобнее задать бюджет?\n"
                "Это бюджет цены автомобиля в объявлении; проверку, оформление и обслуживание стоит учитывать отдельно. "
                "На время изменения поиска мониторинг приостановлен. /cancel — отменить ввод.",
                CURRENCIES,
            )
        ]

    def _catalog_note(self) -> str:
        count = self.store.stats()["listings"]
        total = self.store.get_meta("catalog_total")
        error = (
            "\nИсточник сейчас отвечает с ошибкой. Собранная часть каталога может быть неполной "
            "или устаревать; новые наблюдения появятся после восстановления."
            if self.store.get_meta("source_error")
            else ""
        )
        if not count:
            return "Свежие данные каталога пока недоступны. Попробуйте /search позже." + error
        suffix = (
            f" из примерно {int(total):,}".replace(",", " ") if total and total.isdigit() else ""
        )
        return (
            f"В собранной части каталога {count:,}{suffix} объявлений Mashina.kg. "
            "Это не весь рынок; поиск показывает только свежие наблюдения местных машин «В наличии». "
            "Другие площадки, импорт на заказ и платные услуги пока не подключены."
        ).replace(",", " ") + error

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
                    + self._catalog_note()
                    + "\n\nМожно изменить пожелания или включить бесплатный мониторинг.",
                    menu(profile),
                )
            ]
        heading = (
            f"<b>Подходящие автомобили · {offset + 1}–{offset + len(listings)} из {count}</b>\n"
            + profile_text(profile)
            + "\n\nСовпадают с выбранными словами и входят в бюджет. Сначала — недавно найденные варианты.\n"
            + self._catalog_note()
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
        if text.startswith("currency:") and (not draft or draft[0] != "currency"):
            return [
                Reply(
                    "Валюта выбирается только на соответствующем шаге. /edit — начать изменение поиска."
                )
            ]
        if text.startswith("query:") and (not draft or draft[0] != "query" or text != "query:any"):
            return [
                Reply(
                    "Эта кнопка не относится к текущему шагу. Продолжите ввод или используйте /cancel."
                )
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
            last = self.store.get_meta("last_sync_at")
            note = self._catalog_note()
            if last:
                note += f"\nПоследний успешный сбор страницы: {escape(last)}."
            return [Reply(note, menu(profile) if profile else START_BUTTONS)]
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
                return [Reply(profile_text(profile), menu(profile))]
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
                        "\n\nЭто общие рекомендации, а не заключение о состоянии конкретной машины.",
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
        if state == "currency":
            currency = text.removeprefix("currency:").upper()
            currency = {"СОМ": "KGS", "СОМЫ": "KGS", "$": "USD"}.get(currency, currency)
            if currency not in {"USD", "KGS"}:
                return [Reply("Выберите валюту кнопкой: USD или KGS.", CURRENCIES)]
            self.store.set_draft(user_id, "budget", {"currency": currency, "consent": True})
            return [
                Reply(
                    f"Какой бюджет в {'долларах' if currency == 'USD' else 'сомах'}?\nНапример: 15000, 15к или диапазон 10000–15000. Без обозначения валюты."
                )
            ]
        if state == "budget":
            try:
                minimum, maximum = parse_budget(text)
            except ValueError as error:
                return [Reply(str(error))]
            data.update({"minimum": minimum, "maximum": maximum})
            self.store.set_draft(user_id, "query", data)
            return [
                Reply(
                    "Какие автомобили рассматриваете?\nНапример: Toyota Camry, Honda Accord. "
                    "Запятая разделяет альтернативы; можно указать только марку или тип кузова. Если не определились — нажмите «Пока не знаю».",
                    ANY_CAR,
                )
            ]
        if state == "query":
            unknown = text.casefold() in {
                "query:any",
                "любые",
                "любой",
                "любая",
                "не знаю",
                "пока не знаю",
                "все",
            }
            if (
                len(text) > 160
                or len(text.split(",")) > 5
                or text.startswith("/")
                or (not unknown and any(not normalize(part) for part in text.split(",")))
            ):
                return [
                    Reply(
                        "Укажите до пяти непустых вариантов с буквами или цифрами через запятую, не более 160 символов, либо выберите «Пока не знаю».",
                        ANY_CAR,
                    )
                ]
            if unknown:
                text = ""
            profile = self.store.save_profile(
                Profile(
                    user_id=user_id,
                    chat_id=chat_id,
                    currency=data["currency"],
                    budget_min_minor=data["minimum"],
                    budget_max_minor=data["maximum"],
                    query=text,
                    quiet_start_minute=profile.quiet_start_minute if profile else None,
                    quiet_end_minute=profile.quiet_end_minute if profile else None,
                )
            )
            self.store.clear_draft(user_id)
            return [
                Reply(
                    "Поиск сохранён. Подбор и мониторинг бесплатны. Уведомления включите отдельной кнопкой."
                )
            ] + self.search(profile)
        raise RuntimeError("Unknown stored conversation state")
