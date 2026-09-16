# Мониторинг Autodom

## Архитектура и границы

Расширяем существующий стек Domcom: **Prometheus → Alertmanager**, **Docker → Alloy → Loki**, **Grafana**. Вторые Prometheus/Grafana/Loki для production Autodom не нужны. Bot + Mini App, parser и VIN API выпускаются независимо; мониторинг не меняет allowlist источников, Korea-first, лимиты VIN или пользовательские уведомления.

| Роль | Private scrape target | Job | Что измеряется |
| --- | --- | --- | --- |
| VIN-бот + Mini App | `autodom-bot-metrics:9901/metrics` | `autodom-bot` | HTTP, Telegram, heartbeat, PostgreSQL, процесс, продуктовые события при включении |
| Полный бот + Mini App | `autodom-full-bot:9901/metrics` | `autodom-full-bot` | Те же эксплуатационные метрики и продуктовые события при включении |
| Parser | `autodom-worker-metrics:9901/metrics` | `autodom-worker` | Разрешённые источники, запросы/результаты заданий, время выполнения, BullMQ, heartbeat, процесс |
| VIN API | `autodom-vin-api:8080/metrics` | `autodom-vin` | HTTP, длительность, занятые слоты, реально полученные наблюдения провайдеров, процесс |

Общие labels: `application="autodom"`, `role="bot|worker|vin"`. Prometheus добавляет `job` и `instance`. Интервал scrape 15 с, таймаут 5 с. Metrics не опубликованы на host-портах, в публичном Mini App `/metrics` отсутствует. VIN `/metrics` открыт **только внутри приватной сети**, не требует API token и не занимает слот проверки. Все прикладные POST по-прежнему требуют Bearer. Не проксировать VIN listener целиком в интернет.

Prometheus должен находиться в сетях существующих приложений. `autodom-bot-metrics` сохраняется в aliases приватной сети `coolify`, рядом с `autodom-payment-events`: Coolify может переписывать aliases собственной сети ресурса. Worker и VIN доступны в сети `${AUTODOM_NETWORK}`. Имя сети брать из действующей конфигурации, не предполагать, что оно буквально `autodom`.

Grafana: существующие datasource UIDs **`prometheus`** и **`loki`**, папка **Autodom**. Dashboard UID **`autodom-overview`** — эксплуатация: фильтры роли/источника, ошибки, очереди, свежесть и логи. **`autodom-product`** — пользовательские пути и конверсия после отдельного включения аналитики. Смена datasource в фильтре не меняет конфигурацию сервиса.

## Источник конфигурации

- `deploy/monitoring-scrape.yml`: четыре Autodom scrape jobs, включая отдельный полный бот.
- `deploy/prometheus/autodom.rules.yml`: правила; рядом `autodom.rules.test.yml` с граничными сценариями.
- `deploy/grafana/dashboards/autodom-overview.json` и `autodom-product.json`: эксплуатационный и продуктовый дашборды.
- `deploy/grafana/provisioning/dashboards/autodom.yml`: файловый provider для окружений, где файловое provisioning действительно доступно.
- `deploy/alloy/autodom.alloy`: добавочный pipeline, использует **существующий** `loki.write.loki`.
- `deploy/sync-monitoring.mjs`: синхронизация этих артефактов в checkout Domcom без запуска контейнеров.
- `deploy/provision-grafana.mjs`: адресный импорт только Autodom; не меняет datasource, чужие папки и дашборды.

Не редактировать две независимые копии правил: исходник — Autodom, копия в Domcom создаётся синхронизацией. Изменения обоих репозиториев должны попасть в согласованный release. Production pins и результаты конкретного выпуска записываются в Trello, а не выводятся из имени image tag.

## Метрики и семантика

### Источники, задания и очереди

- `autodom_source_enabled{source}` — operator allowlist, не лицензия и не полный охват рынка.
- `autodom_source_last_success_timestamp_seconds{source}` — время успешного наблюдения страницы; `0` значит неизвестно/нет валидного наблюдения. Это не дата последнего нового объявления и не подтверждение полноты каталога.
- `autodom_source_error{source}` — ошибка последней попытки независимо от размера каталога. Успешное пустое наблюдение и ошибка различаются.
- `autodom_source_requests_total{source,tier,outcome}` — попытки транспорта; ошибка источника не означает продажу объявлений.
- `autodom_collection_jobs_total{source,outcome}` и `autodom_collection_job_duration_seconds{source,outcome}` — `completed`, `paused`, `failed`; histogram включает сбор и bookkeeping ограничения частоты.
- `autodom_collection_queue_jobs{source,state}` — фактические counts BullMQ: `waiting`, `active`, `delayed`, `failed`, `paused`.
- `autodom_queue_collection_success` и `autodom_queue_collection_timestamp_seconds` — качество **последнего полного** snapshot, только роль worker. Сохранённый count при ошибке не является актуальным нулём.

Очереди опрашиваются вне scrape, по существующему Redis-соединению: не более одного sampling-запроса одновременно, 1,5 с на snapshot, следующая попытка через 15 с после завершения. Timeout не освобождает слот незавершённого Redis-запроса и не позволяет опубликовать поздний частичный snapshot. Shutdown прекращает sampling. Bot не получает Redis-зависимость.

Metadata PostgreSQL собирается прежним bounded single-flight: таймаут 1,5 с, кэш/пауза 5 с после завершения. Ошибка делает `autodom_state_collection_success=0`, timestamp последнего полного snapshot не обновляется. Это проверка доступа к небольшим metadata, **не** отдельный PostgreSQL performance exporter, не статистика всех SQL и не полный аудит БД.

### Telegram и уведомления

- `autodom_telegram_updates_total{outcome="success|error"}` и `autodom_telegram_update_duration_seconds` — выполнение обработчика update. Время ожидания polling не включено.
- `autodom_monitor_iterations_total{outcome="success|error|aborted"}` и `autodom_monitor_iteration_duration_seconds` — цикл уведомлений, включая retry, без сна до следующего цикла.
- `autodom_notification_deliveries_total{outcome="sent|blocked|retry|error"}` — **попытки отправки пакета уведомлений**, не число Telegram-сообщений. `sent` только после завершения send; простое продвижение cursor не является отправкой. Telegram 403 — blocked, 429/transport error — retry. Один пакет может содержать несколько сообщений; ошибка после частичной отправки не доказывает, что пользователь не получил ни одного сообщения.
- `autodom_monitor_timestamp_seconds` — начало итерации, **не успешная доставка**. `autodom_monitor_max_age_seconds` учитывает настроенный интервал.

### HTTP и VIN

- `autodom_http_requests_total{route,method,status}` и `autodom_http_request_duration_seconds{route,method,status}` — завершённые запросы либо `status="aborted"` при отключении клиента. `route` — конечный allowlist известных маршрутов, неизвестные URL объединяются в `unmatched`; query string не сохраняется. Методы: `GET`, `POST`, `other`.
- Общие HTTP buckets в секундах: `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120`. p95/p99 — оценки histogram, а не точные таймеры отдельного запроса. При отсутствии трафика перцентили не определены.
- `autodom_vin_in_flight` — занятые admission slots, включая отменённую, но ещё не завершившуюся работу. `autodom_vin_max_in_flight` — текущий настроенный предел. Scrape не потребляет этот ресурс.
- `autodom_vin_provider_observations_total{provider,status}` — только фактически возвращённые поля/наблюдения: `available`, `no_photos`, `not_found`, `unavailable`, `disabled`. Пропущенный Korea-first провайдер не считается `not_found`. Это не точное количество upstream HTTP попыток, не счётчик платёжной квоты Auto.dev и не подтверждение чистой истории автомобиля.

Default process metrics имеют префикс `autodom_`: CPU time, RSS, heap, event-loop lag, GC и uptime. Память интерпретировать с действующим container `mem_limit`; фиксированное число из чужого проекта не является порогом для Autodom.

### Пользовательский путь и конверсия

Реализация: `apps/bot/src/analytics.ts`, контракт `analytics-contract.ts`, сверка финансового журнала `analytics-payments.ts`. Оба бота используют одну PostgreSQL и одинаковый отдельный `AUTODOM_ANALYTICS_KEY` (случайный секрет длиной не менее 32 символов). Без ключа сбор и опросы отключены. Это дополнение к существующей Grafana, не внешний трекер и не новая production-система мониторинга.

`autodom-product` содержит 17 панелей и 31 запрос: активные пользователи по боту/каналу, последовательные воронки, переходы профиля, наблюдаемые ошибки, подтверждённые оплаты/выдачи/возвраты, добровольные причины покупки и непокупки, качество самого сбора.

- `autodom_product_events{bot,surface,window,event,outcome,step}` — количество событий за скользящие `1d`, `7d`, `30d`; **gauge**, не counter. Не применять `increase()`. Повторное действие пользователя может быть отдельным событием.
- `autodom_product_active_users{bot,surface,window}` — уникальные псевдонимы внутри конкретного бота/канала. Нельзя складывать каналы и называть сумму уникальными людьми; `system` включает события журнала, а не активность интерфейса.
- `autodom_product_funnel{bot,surface,window,funnel,stage}` — число последовательных путей из одной стартовой когорты. Привязка отчёта — человек + VIN; общий ключ связывает переход между ботами и Mini App. `bot`/`surface` у воронки означают точку первого наблюдаемого входа, не место последующего платежа.
- Отчёт: VIN отправлен → успешный/частичный результат → предложение отчёта → начало оформления → согласие с условиями → подтверждённая оплата → выданный отчёт. Подбор: заполнение профиля → сохранение → поиск с результатами. Пустой поиск не считается полезным результатом.
- Когорта начинается с первого сохранённого входа в пределах 90-дневной истории. Все этапы должны идти по неубывающему времени события; порядок вставки строк не используется для событий с одинаковой миллисекундой. Более поздний возврат в старый путь не создаёт новую стартовую когорту. Конверсии считаются по этой же когорте, без деления всех оплат периода на все клики периода.
- Оплата, выдача и возврат берутся из подтверждённого финансового журнала, а не из клиентского события. Повтор квитанции, перезапуск и повторная сверка не удваивают финансовое событие. Исторические оплаты за 90 дней видны отдельно, но не получают выдуманных VIN-входов и не попадают в полную воронку без наблюдаемого начала.
- `autodom_product_reasons{bot,surface,window,event,outcome,reason}` — добровольные ответы из конечного списка. Негативный ответ привязан к недавнему предложению после проверки VIN, позитивный — к собственному оплаченному заказу. Отсутствие ответа = причина неизвестна. Самоотбор и заявленный мотив не доказывают причинность.
- Telegram подтверждает отправку, не прочтение. «Пока не дошли до следующего шага» — незавершённый путь, не доказанный отказ. Финансовая выручка не равна прибыли; этот дашборд не рассчитывает прибыль или экономику рекламы.

Снимок собирается вне `/metrics`, раз в 30 секунд, одной задачей. Сверка финансов сканирует журнал порциями по 200 заказов и обходит его повторно; на большой истории первый полный проход не мгновенный. Оба экспортера читают общую БД, поэтому дашборд сначала устраняет дубли `job/instance` через `max`, затем агрегирует.

`autodom_product_collection_success` и `autodom_product_collection_timestamp_seconds` показывают качество снимка. При ошибке timestamp не продвигается; основные панели скрывают неуспешные и старше 90 секунд данные, а не рисуют ложный ноль. Отдельные `autodom_product_ledger_collection_success`/`timestamp_seconds` показывают сверку журнала. `autodom_product_operations_total{operation,result}` и `autodom_product_in_flight` показывают ошибки, переполнение и незавершённую работу.

Сбор best effort: до 16 незавершённых операций, отдельный pool на 2 соединения, ответ вызывающему не позднее 150 мс; таймаут ответа не освобождает занятый слот до завершения SQL. При перегрузке события могут теряться, и это видно по диагностике. Аналитика не должна блокировать поиск или платежи.

#### Приватность и хранение

В отдельной схеме `autodom_analytics` сохраняются HMAC-псевдонимы человека, пути и ключа повторной доставки; только конечные категории и время. Raw Telegram ID, VIN, тексты сообщений, бюджет, контакты, URL и токены не записываются. В Prometheus/Grafana нет даже псевдонима отдельного человека: только агрегаты с ограниченным набором labels.

События хранятся 90 дней; фоновая очистка работает при включённом сборщике ограниченными порциями. Подтверждённый `/delete` удаляет события обоих ботов и сохраняет постоянный HMAC-запрет дальнейшего сбора, включая повторный импорт из журнала. Если БД недоступна, бот честно сообщает о незавершённом удалении и предлагает повторить `/delete`. Финансовые записи заказа не удаляются.

Ключ — только в секрет-хранилище и runtime env двух ботов, не Telegram token, не browser config. Не менять/терять его отдельно от данных: смена ключа разрушает связность и запреты повторного сбора. Резервировать всю новую схему, включая `autodom_analytics.suppressions`, вместе с безопасным хранением ключа; обычный Store JSON/NDJSON snapshot её не включает. Восстановление событий без запретов может вернуть удалённую историю. Доступ к БД/backup — как к псевдонимным персональным данным.

#### Включение и безопасный откат

1. Сверить фактические pins **обоих** ботов и параллельные изменения. Подготовленный worktree `feat/product-analytics-20260916` объединяет full-bot `4591a5d` и VIN-bot `52dde91`; это не разрешение откатывать более новые релизы на эту пару.
2. Сделать проверенную резервную копию. В совместимом bot image с действующим `AUTODOM_DATABASE_URL` выполнить `pnpm bot analytics-migrate` (либо `node apps/bot/dist/cli.js analytics-migrate`). Команда идемпотентна, не требует Telegram token и не обращается к Telegram/VIN/платежам. Создаётся только отдельная схема версии 1; основной журнал миграций и финансовая схема не меняются, parser/VIN API не требуют релиза.
3. Задать одинаковый новый `AUTODOM_ANALYTICS_KEY` обоим ботам. Выпустить их отдельно с соблюдением singleton polling. Проверить `/delete`, оба режима и приватные метрики. Не передавать ключ parser, VIN API, Grafana или клиенту.
4. Синхронизировать четыре scrape jobs и два dashboard JSON существующим скриптом; обновить только необходимый monitoring image/config по runbook ниже. До переключения проверить реальный alias полного бота `autodom-full-bot`.
5. Проверить все targets, свежесть аналитики и сверки журнала, реальный тестовый путь без расхода денег. История кликов начинается только после включения; заранее данных нет.

Для немедленной остановки новых событий можно убрать ключ из обоих ботов, но это одновременно останавливает retention и обработку удаления старой аналитики. Не оставлять такую конфигурацию постоянной: обеспечить удаление прежних данных по запросу и сроку хранения. Предпочтителен совместимый код с сохранённым ключом и privacy lifecycle; откат только Grafana/Prometheus не требует отключения сбора. Не откатывать основную БД и не удалять финансовый журнал. Схема аддитивна и не мешает старым процессам.

#### Проверка в отдельном окружении, 16.09.2026

[Карточка аналитики](https://trello.com/c/12D8xhPT). На этом этапе production ещё не переключался. Проверены TypeScript, сборка bot + Mini App, 947 тестов в 52 файлах на изолированной PostgreSQL; lint завершён без ошибок, но с предупреждениями. На временных PostgreSQL 17 / Prometheus / Grafana 11.6 выполнены все 31 PromQL-запрос и визуальная проверка dashboard. Реальный код Mini App прошёл путь VIN → предложение → условия → диагностическое подтверждение оплаты → выдача; семь этапов одной когорты дали по 1, повтор квитанции не удвоил оплату. Добровольные ответы до/после покупки проверены в браузере, включая ширину 320 и 390 px. Telegram-обработчик проверен с изолированным транспортом; настоящие сообщения пользователям и банковские платежи не отправлялись.

#### Выпуск в production, 16.09.2026

По отдельному разрешению владельца аналитика включена в обоих ботах и существующей Grafana:

- VIN bot + Mini App и full bot + Mini App: `52826c8184e45a615aa7ae5c04fe3235de98672a`, ветка `feat/product-analytics-20260916`. Coolify deployments: `kkdoj3gqz9osm4l3anbabl2h` и `trloirlitt0tnvbnu6jfc8uo`, оба `finished`. Предыдущий polling каждого бота остановлен перед его заменой. SHA-256 работающих CLI и Mini App bundles совпали с проверенными артефактами worktree.
- Схема `autodom_analytics` версии 1 создана отдельной командой миграции. Для одноразового контейнера нужна фактическая приватная сеть PostgreSQL `rbhwjtdnncgcmxo2rrgmst2t`, не общая сеть `coolify`. Основной журнал миграций не изменён.
- Общий HMAC-ключ сохранён в `pass:autodom/analytics/hmac-key`; `AUTODOM_ANALYTICS_KEY` установлен только как runtime-секрет обоих ботов, не как build argument. Ключ не передавался Grafana, parser, VIN API или браузеру.
- Monitoring теперь имеет отдельный репозиторий `NurAbain/monitoring`. Pin этого выпуска: `b3dbf8697ecb1536fbdd0464bf1a7c1686c3619c`, ветка `feat/autodom-product-analytics-20260916`. Пересоздан только Prometheus через фактический operator Compose с прежней TSDB и retention 30 дней; общий Coolify deploy не вызывался, auto-deploy остался выключен. В исходники перенесён уже действовавший production-порог возраста backup 96 часов, без изменения поведения правил.
- Создан только новый dashboard [`autodom-product`](https://grafana.skup.kg/d/autodom-product), numeric ID 48, folder UID `autodom`; существующие 22 dashboard и 5 datasource остались неизменны. Grafana не перезапускалась.

Перед выпуском сделан полный `pg_dump -Fc`, восстановленный без ошибок в отдельную PostgreSQL 18. Приватный backup: `/data/autodom/product-analytics-20260916/before/database.dump`, 84 493 390 байт, SHA-256 `d9bf65e7a6f78d71213ea1f1fa37f0074606d224d4ab3cd66f90665b94fccd1d`. Рядом сохранены прежние runtime/config/Grafana-снимки; итоговое подтверждение выпуска — `release-proof.json` в родительском каталоге. Это защищённые серверные файлы, не артефакты для публикации в Git.

Production-проверки: оба бота healthy, оба снимка аналитики успешны; 46/46 scrape targets UP, все 126 правил healthy, все 31 PromQL-запрос dashboard выполнены. Dashboard проверен в браузере. Идентичности 101 постороннего контейнера сохранены, включая parser и VIN API. Финансовый журнал до/после совпал: 6 заказов, 2 платёжных события, 0 возвратов; сверены также digest строк, не только количества.

Через публичные авторизованные Mini App endpoints проверены два события синтетического пользователя, по одному на бота: повтор nonce не создал дублей; отсутствие авторизации дало 401, поддельное клиентское `payment_succeeded` — 400. Подтверждённый `/delete` удалил оба события и создал общую durable suppression; последующие события от обоих ботов не восстановили историю. Настоящие сообщения клиентам и платные запросы для этой проверки не отправлялись.

Наблюдаемая история шагов начинается с включения. Старые подтверждённые оплаты/выдачи видны отдельно по журналу, но не создают выдуманных начал воронки; пустая когорта и отсутствие добровольных причин пока допустимы. При отключении или откате сохранять обработку удаления/retention, как описано выше; не восстанавливать основную БД ради отката аналитики.

## Логи и приватность

Compose помечает только выбранные контейнеры:

```yaml
labels:
  - io.autodom.application=autodom
  - io.autodom.role=bot # либо worker / vin
```

Использовать list-форму labels: установленный Coolify добавляет собственные labels через append; map-форма превращается в смешанный YAML с числовым ключом и ломает deploy (`non-string key in services.*.labels: 0`).

Alloy обнаруживает только эти labels. Loki labels: `application`, `role`, `level`. Container ID, VIN, chat/user ID, URL, request body, бюджет и контакты в labels не попадают.

Pipeline принимает только JSON до 16 KiB и **пересобирает** строку из конечных allowlist: статическое сообщение события, нормализованный уровень, известный источник и класс ошибки. Неизвестное сообщение заменяется на `Autodom unclassified event (details omitted)`. Неизвестные поля, raw exception message/stack и не-JSON отбрасываются; это намеренная граница централизованной диагностики. Подробный локальный stderr при необходимости изучается отдельно с соответствующими правами. Значения токенов не нужны Prometheus/Alloy/Grafana.

Существующий Domcom pipeline не должен параллельно принимать Autodom: его нынешний allowlist не включает service names `bot`, `worker`, `vin-api`. Если его расширяют, исключить `io.autodom.application=autodom`, иначе возможны дубликаты и обход безопасного pipeline. На одном хосте не запускать второй collector тех же контейнеров.

Alloy уже имеет доступ к Docker socket. `:ro` bind **не делает Docker API read-only**; это доверенный инфраструктурный компонент, не давать socket приложениям. Loki и Prometheus не открывать публично. Retention/доступ общие со стеком Domcom; этот выпуск не меняет его retention и пользователей.

Примеры LogQL:

```logql
{application="autodom", role="worker"}
{application="autodom", level=~"error|fatal"}
sum by (role) (count_over_time({application="autodom", level=~"error|fatal"}[15m]))
```

## Совместимость со справочником подбора

В ветке `feat/bot-filters-20260914` приватный listener parser дополнительно обслуживает `GET /v1/catalog/options`. Маршрут требует отдельный одинаковый `AUTODOM_CATALOG_API_TOKEN` в bot и parser; `/metrics` и `/health` сохраняют прежний приватный контракт и не запускают загрузку справочников. Не публиковать порт 9901 или весь listener наружу.

Bot использует `AUTODOM_CATALOG_API_URL=http://autodom-worker-metrics:9901`, не получает proxy credentials и не обращается к площадке напрямую. Холодный справочник возвращает 202, повторный запрос использует ту же ограниченную кешируемую работу; полные модификации могут готовиться несколько минут. Источник, общая пауза и `Retry-After` сохраняются.

Фильтры требуют согласованного выпуска bot + parser и миграции `0008_catalog_filters.sql`; snapshot становится версии 6, финансовые данные исторической версии 5 сохраняются. Перед миграцией нужна проверенная резервная копия и остановка старых ролей: старые бинарники отвергают новый журнал миграций. Подготовить совместимые обе роли, сначала поднять parser со справочником, затем bot; VIN API и общий monitoring этим выпуском не перенастраивать. Если отключается только справочник, убрать его token, сохранив совместимый код, схему и остальные сервисы; не возвращать старые schema-7 бинарники. Изменения подробного мониторинга `ffdbdea` включены в ветку фильтров, не заменены старой базой.

## Подготовка и проверка конфигурации

Работать в отдельном checkout текущего release, сохраняя чужие изменения. Сначала выпустить метрики сервисов и labels, затем добавлять обязательный VIN target и новые правила, иначе появятся ложные missing-target alerts.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node deploy/sync-monitoring.mjs /path/to/domcom-release
```

Синхронизация меняет только четыре одноимённых scrape jobs, подключение Autodom rules, их файл, отмеченный блок Alloy и каталог Autodom dashboards. Другие jobs остаются. Повторный запуск даёт тот же результат. Не выполняет deploy/restart.

В проверочном окружении с Docker:

```bash
docker run --rm --network none --entrypoint promtool \
  -v "$PWD/deploy/prometheus:/rules:ro" prom/prometheus:v2.47.0 \
  check rules /rules/autodom.rules.yml
docker run --rm --network none --entrypoint promtool \
  -v "$PWD/deploy/prometheus:/rules:ro" prom/prometheus:v2.47.0 \
  test rules /rules/autodom.rules.test.yml
```

Полный собранный Prometheus config проверить `promtool check config`, Alloy — `alloy validate` **после объединения с конфигом Domcom**, поскольку фрагмент ссылается на его `loki.write.loki`.

Импорт в существующую Grafana — по API, как в Domcom; это не требует перезапуска Grafana. Credentials загрузить из секрет-хранилища в environment, не передавать позиционными аргументами и не помещать в Git/чат:

```bash
export GRAFANA_URL=https://grafana.skup.kg
# GRAFANA_TOKEN, либо GRAFANA_USER и GRAFANA_PASSWORD — из secret store.
node deploy/provision-grafana.mjs
```

Скрипт требует существующие datasource `prometheus`/`loki`, создаёт только папку Autodom и импортирует только `autodom-overview` и `autodom-product`. Файловый provider — альтернатива для действительно смонтированного каталога `/var/lib/grafana/autodom-dashboards`; не обещать, что Coolify автоматически монтирует локальные JSON.

## Production rollout без общего рестарта

1. Сверить реальные Coolify git pins, image IDs, env, aliases, Compose и ID всех monitoring-контейнеров. Сохранить конфигурацию/предыдущие images и закрытый backup; не печатать env с секретами.
2. Собрать независимые bot/worker/VIN images из проверенного SHA. Переключать роли отдельно. Перед bot-релизом сохранить singleton polling: старый poller должен завершиться до нового. Не менять DB/Redis, миграции, allowlists, proxy session settings и платёжные credentials.
3. Проверить private `/metrics` и labels контейнеров; `/health`/`/ready` и VIN Bearer 401. Scrape не должен вызывать провайдеров. Не посылать VIN в платные/внешние источники ради проверки мониторинга.
4. Зафиксировать синхронизированную конфигурацию Domcom и pin мониторинга. Его Prometheus config **встроен в image**, простое изменение checkout и reload не обновляет его. Собрать новый monitoring image; использовать сохранённый production Compose и адресный `docker compose up -d --no-deps --no-build --pull never prometheus`, не `down` и не общий Coolify redeploy.
5. Обновить существующий bind-файл Alloy после `alloy validate`, затем вызвать его reload или перезапустить **только Alloy**, сохранив positions volume. При обновлении одиночного bind-файла заменой inode контейнер может видеть прежние байты: использовать запись в существующий файл либо пересоздать только Alloy.
6. Импортировать Grafana dashboards через API. Сверить 4 Autodom targets `up=1`, evaluations `health=ok`, актуальный queue snapshot, запросы datasource и реальные строки Loki. Для включённой аналитики дополнительно проверить её свежесть и финансовую сверку. Проверить dashboard в браузере. Остальные monitoring containers/images/volumes и jobs должны сохраниться.

Общий Coolify deploy monitoring-ресурса здесь не подходит: установленная версия останавливает весь ресурс перед custom start. Точный операторский Compose/путь зависит от действующего ресурса; не запускать пример из другой директории против production volumes.

## Runbook

### Target health

`AutodomTargetDown` / missing targets: проверить `GET /api/v1/targets` Prometheus, private DNS/aliases и сети. `up=0` означает неудачный scrape, не обязательно смерть приложения. Отсутствие series — не зелёный статус. Не публиковать metrics на host для исправления DNS.

### State and freshness

`AutodomStateCollectionFailed/Stale`, `AutodomRoleHeartbeatStale`, `AutodomMonitorStale`: сначала PostgreSQL connection/metadata snapshot и lifecycle роли, затем её рабочий цикл. Живой HTTP listener не доказывает работу poller/monitor.

`AutodomSourceNeverSucceeded/Stale/Error`: смотреть только enabled sources, текущую source_error, timestamp и транспорт. Учитывать crawl delay, scheduled pauses, частичный каталог и блокировки. Не обнулять metadata ради зелёного графика; не помечать исчезнувшие объявления проданными.

### HTTP errors

`AutodomHttpServerErrors`: sustained 5xx >5% при >=100 запросах за 10 мин, выдержка 5 мин. Проверить маршрут, статус, p95/p99, логи и downstream. Health/assets/scrapes не должны размывать знаменатель прикладных API. 401/400 и `aborted` не являются 5xx; всплеск 429 сравнивать с реальной занятостью VIN, не повышать лимит автоматически. Малый трафик означает недостаток данных, а не гарантированный SLA.

### Queue snapshots

`AutodomQueueCollectionFailed/Stale`: сравнить success/timestamp, Redis connectivity и sampler. Старый ненулевой queue count — последний известный снимок. Не удалять BullMQ keys/queues и не восстанавливать данные из нулей. Ошибка sampling не должна накапливать новые команды.

### Queue backlog

`AutodomQueueBacklog`: sustained waiting >100 на enabled source при здоровом свежем snapshot. Проверить worker, rate-limit, retries и upstream, а не просто повышать concurrency. `delayed` часто ожидаем, `failed` — retained history с TTL/count, не все эти jobs выполняются сейчас. Source-level concurrency остаётся 1.

### Event loop

`AutodomEventLoopLag`: p99 event-loop lag >0,5 с в течение 10 мин. Проверить CPU saturation, RSS/heap/GC и тяжёлые синхронные операции. Это не HTTP p99 и не причина отключать таймауты.

### Notification errors

`AutodomNotificationErrors`: доля `retry|error` >10% при >=20 попытках за 10 мин, выдержка 5 мин. Отличать blocked 403 от outage, проверять Telegram throttling и transport. Не включать мониторинг пользователям молча и не менять cursor для сокрытия ошибок. `sent` считает успешный пакет, не уникального пользователя/объявление.

## Откат

Dashboard: импортировать предыдущий JSON с тем же UID, не очищать Grafana volume. Alloy: восстановить прежний bind-файл и reload только Alloy, сохранив positions. Prometheus: вернуть предыдущий проверенный image/Compose/pin и пересоздать только его с тем же TSDB volume. Если откатывается VIN code без `/metrics`, сначала убрать VIN scrape и связанные новые правила, иначе missing-target alert ожидаем.

Приложения возвращаются к совместимым предыдущим **фактическим** SHA отдельно; не откатывать parser на версию до исправления DubiCars `pnr` или ротации Lalafo. Не менять выбранное владельцем отключение Encar VIN. Эксплуатационный мониторинг не меняет основную SQL-схему; у опциональной продуктовой аналитики отдельная аддитивная схема и privacy lifecycle (см. выше). Восстановление production DB для отката не требуется.

## Выпуск 14.09.2026 по Бишкеку / 13.09.2026 UTC

Карточка: [подробный мониторинг Autodom](https://trello.com/c/I0ZwRv0T). Рабочий dashboard: [Autodom • эксплуатация](https://grafana.skup.kg/d/autodom-overview). В JSON 38 панелей данных и 7 заголовков разделов; 49 datasource-запросов.

### Зафиксированные версии

| Ресурс | Git pin / ветка | Фактический image |
|---|---|---|
| bot + Mini App | `792273484afa21e6f2597acaceb2ea000b161738`, `feat/detailed-monitoring-20260914` | `autodom-bot:c46a842637a54183cb0c7aafa16bf7839fe1e787` |
| parser | тот же pin / ветка, независимый ресурс | `autodom-worker:c46a842637a54183cb0c7aafa16bf7839fe1e787` |
| VIN API | тот же pin / ветка, независимый ресурс | `autodom-vin:c46a842637a54183cb0c7aafa16bf7839fe1e787` |
| общий monitoring | `18ef72283de759eb8a6ae862be3a317e24ee344c`, `feat/autodom-detailed-monitoring-20260914` в Domcom | `autodom-monitoring:55f070c4fbca17e5478a580f8e11ba00b3521284` |

`7922734` исправляет только Compose labels и документацию относительно `c46a842`; SHA-256 исполняемых bot/worker/VIN bundles внутри production совпали с локальными проверенными сборками. `18ef72283` уточняет Alloy allowlist и dashboard относительно `55f070c4f`; встроенные в Prometheus scrape/rules не менялись. Поэтому разные Git pins и image tags здесь намеренны, а не доказательство неподтверждённого checkout.

Coolify deployments завершены: VIN `5hgynvicyiyoxq2fwxm6ug2w` и parser `3y73narz21d9baxyrmy79eon` — 21:03:25 UTC; bot `2fsnbaj6yykbufxzqm5alauo` — 21:04:14 UTC. Первые две попытки остановились на build из-за map-формы labels; старые healthy-контейнеры продолжали работать. List-форма прошла тот же production deployment path.

### Реальные проверки

- TypeScript и четыре сборки успешны; **870 тестов в 46 файлах**, включая изолированный PostgreSQL. Lint завершён с exit 0, но с 226 предупреждениями и 12 информационными замечаниями: это не clean lint.
- Реальные Prometheus 2.47 / Alloy 1.16.1: полный config и правила валидны, граничные rule fixtures прошли. В production три Autodom targets `up=1`, все **17 rules `health=ok`**.
- Сохранены все 31 не-Autodom scrape jobs, TSDB volume, ID/start time остальных пяти monitoring-контейнеров. Пересоздан только Prometheus; Alloy применил reload. Grafana обновлена через API, без рестарта.
- Реальные `/health`, `/ready`, `/miniapp` вернули 200; публичный `/metrics` — 404, Mini App API без подписи — 401. Private VIN `/metrics` — 200; POST без Bearer — 401, некорректный VIN с Bearer — 400. Провайдеры ради smoke не вызывались, лимит остался 10.
- Queue snapshot worker свежий и успешный; bot не опрашивает BullMQ. В браузере исправлена ложная «ошибка очереди» для bot: соответствующие панели выбирают только worker. Нулевые timestamps исключены из расчёта возраста, а не превращены в десятки лет или успешный ноль.
- Проверены все 49 запросов и настоящий dashboard в Chromium, включая последние логи. Пустые error/provider series при отсутствии событий остаются `No data`, не объявляются успешными проверками.
- Реальный Docker → Alloy → изолированный Loki и отдельный replay окончательного allowlist: VIN, token, user ID, URL, raw exceptions и неизвестные поля удалены; статические VIN ready/shutdown события сохранены. Production Loki получил очищенные строки всех трёх ролей. Ранее собранное generic startup-событие VIN не переписывалось задним числом.
- Настройки источников, Korea-first, отключение Encar VIN, архивы `copart,bidcars,carway`, proxy/session settings и бизнес-env сохранены. Миграций БД нет; платные запросы, VIN-поиски и сообщения пользователям ради мониторинга не выполнялись.

Общий Alertmanager сохранил существующий receiver `telegram_and_trello` и маршруты severity. Проверены rules/evaluation и конфигурация маршрутизации; отдельная искусственная проверка доставки Telegram/Trello **не выполнялась**. На срезе 21:10 UTC dashboard показывал реальные ошибки последних попыток Bid.Cars и DubiCars. Это не скрывается и не означает отказ самого сервиса мониторинга.

### Материалы для совместимого отката

На сервере `192.168.0.2`: `/data/autodom-detailed-monitoring-20260914/before/` (0700, файлы 0600) содержит прежний операторский Compose, Alloy и закрытые снимки pins/env. Рядом `release-proof.json` — несекретные идентификаторы и результаты. Не копировать закрытые снимки в Git/Trello.

Предыдущие фактические pins: bot `35d5454d8b9192cf75f3f862b5379f40a845ea8f`, parser `5f8d32e770421ed96ff85709e133b26a278c5338`, VIN `f2b19500de96daf6d8c0a98bed149d32b715e328`. Предыдущий monitoring pin/image — `62084a5a47829e2f7718fd4867c14263235b90d3` / `autodom-monitoring:62084a5a47829e2f7718fd4867c14263235b90d3`. При его возврате восстановить также `AUTODOM_MONITORING_IMAGE`, а не только Git pin. Сначала сверить новые параллельные релизы: эти значения — точка до данного выпуска, не разрешение затирать более новый код.
