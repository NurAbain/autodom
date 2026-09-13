# Мониторинг Autodom

## Архитектура и границы

Расширяем существующий стек Domcom: **Prometheus → Alertmanager**, **Docker → Alloy → Loki**, **Grafana**. Вторые Prometheus/Grafana/Loki для production Autodom не нужны. Bot + Mini App, parser и VIN API выпускаются независимо; мониторинг не меняет allowlist источников, Korea-first, лимиты VIN или пользовательские уведомления.

| Роль | Private scrape target | Job | Что измеряется |
| --- | --- | --- | --- |
| Bot + Mini App | `autodom-bot-metrics:9901/metrics` | `autodom-bot` | HTTP, обработка Telegram, отправки уведомлений, heartbeat, доступ к metadata PostgreSQL, процесс |
| Parser | `autodom-worker-metrics:9901/metrics` | `autodom-worker` | Разрешённые источники, запросы/результаты заданий, время выполнения, BullMQ, heartbeat, процесс |
| VIN API | `autodom-vin-api:8080/metrics` | `autodom-vin` | HTTP, длительность, занятые слоты, реально полученные наблюдения провайдеров, процесс |

Общие labels: `application="autodom"`, `role="bot|worker|vin"`. Prometheus добавляет `job` и `instance`. Интервал scrape 15 с, таймаут 5 с. Metrics не опубликованы на host-портах, в публичном Mini App `/metrics` отсутствует. VIN `/metrics` открыт **только внутри приватной сети**, не требует API token и не занимает слот проверки. Все прикладные POST по-прежнему требуют Bearer. Не проксировать VIN listener целиком в интернет.

Prometheus должен находиться в сетях существующих приложений. `autodom-bot-metrics` сохраняется в aliases приватной сети `coolify`, рядом с `autodom-payment-events`: Coolify может переписывать aliases собственной сети ресурса. Worker и VIN доступны в сети `${AUTODOM_NETWORK}`. Имя сети брать из действующей конфигурации, не предполагать, что оно буквально `autodom`.

Grafana: существующие datasource UIDs **`prometheus`** и **`loki`**, папка **Autodom**, dashboard UID **`autodom-overview`**. Дашборд содержит фильтры роли/источника и отдельные панели ошибок, очередей, свежести и логов. Смена datasource в фильтре не меняет конфигурацию сервиса.

## Источник конфигурации

- `deploy/monitoring-scrape.yml`: три Autodom scrape jobs.
- `deploy/prometheus/autodom.rules.yml`: правила; рядом `autodom.rules.test.yml` с граничными сценариями.
- `deploy/grafana/dashboards/autodom-overview.json`: дашборд.
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

Синхронизация меняет только три одноимённых scrape jobs, подключение Autodom rules, их файл, отмеченный блок Alloy и каталог Autodom dashboards. Другие jobs остаются. Повторный запуск даёт тот же результат. Не выполняет deploy/restart.

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

Скрипт требует существующие datasource `prometheus`/`loki`, создаёт только папку Autodom и импортирует только `autodom-overview`. Файловый provider — альтернатива для действительно смонтированного каталога `/var/lib/grafana/autodom-dashboards`; не обещать, что Coolify автоматически монтирует локальные JSON.

## Production rollout без общего рестарта

1. Сверить реальные Coolify git pins, image IDs, env, aliases, Compose и ID всех monitoring-контейнеров. Сохранить конфигурацию/предыдущие images и закрытый backup; не печатать env с секретами.
2. Собрать независимые bot/worker/VIN images из проверенного SHA. Переключать роли отдельно. Перед bot-релизом сохранить singleton polling: старый poller должен завершиться до нового. Не менять DB/Redis, миграции, allowlists, proxy session settings и платёжные credentials.
3. Проверить private `/metrics` и labels контейнеров; `/health`/`/ready` и VIN Bearer 401. Scrape не должен вызывать провайдеров. Не посылать VIN в платные/внешние источники ради проверки мониторинга.
4. Зафиксировать синхронизированную конфигурацию Domcom и pin мониторинга. Его Prometheus config **встроен в image**, простое изменение checkout и reload не обновляет его. Собрать новый monitoring image; использовать сохранённый production Compose и адресный `docker compose up -d --no-deps --no-build --pull never prometheus`, не `down` и не общий Coolify redeploy.
5. Обновить существующий bind-файл Alloy после `alloy validate`, затем вызвать его reload или перезапустить **только Alloy**, сохранив positions volume. При обновлении одиночного bind-файла заменой inode контейнер может видеть прежние байты: использовать запись в существующий файл либо пересоздать только Alloy.
6. Импортировать Grafana dashboard через API. Сверить 3 Autodom targets `up=1`, evaluations `health=ok`, актуальный queue snapshot, запросы datasource и реальные строки Loki. Проверить dashboard в браузере. Остальные monitoring containers/images/volumes и jobs должны сохраниться.

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

Приложения возвращаются к совместимым предыдущим **фактическим** SHA отдельно; не откатывать parser на версию до исправления DubiCars `pnr` или ротации Lalafo. Не менять выбранное владельцем отключение Encar VIN. SQL-миграций мониторинг не добавляет; восстановление production DB для отката не требуется.

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

## Последующий выпуск подбора: 14.09.2026 по Бишкеку

По прямому разрешению владельца bot + Mini App и parser выпущены на `feat/bot-filters-20260914`, **`8774af9a2b21d2f87461d5c985ff5c301249c085`**. Это точный production pin кода; последующая документационная правка ветки не требует перевыпуска. Coolify: bot `rbhwjtdnncgcmxo2rrgmst2t`, deployment `8tmgkoueuv1g9mfwpxthxupq` (13.09 23:28:45 UTC); parser `c5qg89dmptxinwciibhjpfth`, deployment `2uyficb43xmub1mwryessx6f` (23:27:04 UTC). Оба `finished`, фактические контейнеры healthy.

### Конфигурация и доказательство версии

- Образы `autodom-bot:8774af9a2b21d2f87461d5c985ff5c301249c085` и `autodom-worker:8774af9a2b21d2f87461d5c985ff5c301249c085`; соответствующие image env обновлены вместе с Git pins. `SOURCE_COMMIT` bot совпал. Raw-compose parser не экспортирует эту переменную: SHA256 исполняемого CLI отдельно совпал с образом из точного Git archive (`a1b74574feaf93a702d76ddd6326362db8e9d962767cf988e55976e130dad9b9`); для bot — `811ad1e6360a43a290da271ba15a8eee6c6038fcc901fe0276bf7aea39a3daa7`.
- Справочник теперь включён: `AUTODOM_CATALOG_API_TOKEN` одинаков в bot/parser, хранится в `pass:autodom/catalog/api-token`; bot `AUTODOM_CATALOG_API_URL=http://autodom-worker-metrics:9901`. Только runtime env, не build-time и не браузер. Настоящий маршрут из bot: 401 без auth, холодный 202 → 200, 302 марки.
- VIN API остался на `792273484afa21e6f2597acaceb2ea000b161738`, Domcom payments — на `9aaca11d101f93817a6b093d921f51d753549103`. Их, общий monitoring, PostgreSQL и Redis этим выпуском не перевыпускали. Сохранены прежние source allowlist, Lalafo session pool, proxy/VIN/payment настройки; кроме двух image tags и трёх catalog-настроек бизнес-env не менялся.

### Реальная миграция и backup

**Теперь production schema 8 / snapshot 6.** Оба прежних schema-7 процесса остановлены до изменения БД. На восстановленной из online dump отдельной PostgreSQL 18 (без сети и опубликованных портов) миграция заняла 44,44 с, сохранила и нормализовала 157 581 объявление. После остановки bot/parser сделан второй согласованный dump. Настоящий runtime CLI применил production-миграцию за 44,67 с: 157 608 объявлений сохранены и нормализованы, checksum миграции `5c0a7c7d1382c82bcfe7c5b79764d870871d9b5d00d424f959d54d9745ade859`. Сначала восстановлена готовность parser, затем bot.

Закрытые материалы на сервере: `/data/autodom-bot-filters-20260914-8774af9/before/`, каталог 0700, закрытые файлы 0600. Не копировать конфигурационные snapshots в Git/Trello.

| Dump | Размер, байт | SHA256 | Проверка |
|---|---:|---|---|
| `online-schema7.dump` | 74272650 | `d8998ef04962e1a040c5191deb1aa63ff61991f4744bf6ff34c2c5df471b2ef0` | Полное восстановление и настоящая миграция |
| `quiesced-schema7.dump` | 74288157 | `57ce9254dddbd0350fb86efcbe95afe2fa47e961106f02ae856fcf50375e2f51` | Согласованная точка перед production-миграцией, PGDMP/checksum; отдельно не восстанавливался |

Рядом с `before/` сохранены точный исходный archive и `release-proof.json`. Временный файл с DB credentials удалён; отдельный восстановленный PostgreSQL и его volume удалены после проверки.

### Production smoke и платёжные границы

- Настоящий Mini App `https://autodom.skup.kg/miniapp/`, Chromium 390×844 и 1440×1000: согласие → бюджет → Toyota/Camry → поколения, поиск/страницы/повтор холодной загрузки → review → явное сохранение без мониторинга → 2031 совпадение → загруженное фото реальной Camry. До сохранения профиля не было; после сохранены фильтры, `monitoring=false`, черновик удалён. Подставлен только native Telegram bridge отдельной подписанной диагностической identity; реальный пользовательский клиент Telegram не проверялся. Диагностический профиль затем удалён штатным `/delete` с подтверждением; остался прежний один профиль.
- Public health/ready/Mini App — 200, metrics/private catalog/payment listener — 404, orders без Telegram auth — 401. Все три Prometheus targets Autodom `up=1`. Оригинальный PDF GET/HEAD — 200, `application/pdf`, attachment; 1 905 032 байта, SHA256 `625d54b9e58b916566d36d7d903d97f342eb3f8599be77ad002a6699917a2daf`, HEAD без тела. Исходные водяные знаки фотографий не удалялись.
- Сохранён существующий Finik gateway `https://payments.domcom24.com`: merchant/PEM только там. Из нового bot проверены health 200, invoice 401 без token / 422 с прежним token и неполным телом; неподписанный callback 401. Старый callback отвергает `ad_` вместо включения подписки Domcom. Из настоящего gateway приватный listener нового bot — 401 без token / 400 с правильным token и неполным телом. Браузерные «Мои заказы» успешно показали пустой список физических услуг.
- **Это не реальная платёжная транзакция.** Счетов, списаний, подписанных Finik callback, возвратов и платных VIN-запросов не создавали; до и после — 0 заказов / 0 payment events / 0 refunds. Finik остаётся только для согласованных физических осмотров; конкретные предложения без цены/исполнителя/условий не открывались. Цифровой VIN через Finik внутри Telegram, выдача за пять минут и уведомления о заказах администратору `706854211` не включены. Наличие ID администратора не означает реализации процесса. Пользователям ради smoke не отправляли сообщения и не включали мониторинг.

### Ограничения отката после schema 8

Прежние pins раздела выше и `7922734` **не являются совместимым откатом bot/parser** после этой миграции. Сохранять schema 8 / snapshot 6, финансовый журнал и совместимый код. Не удалять запись миграции и не восстанавливать dump поверх новых пользовательских/финансовых записей; восстановление только в отдельную пустую БД, сверка новых записей и отдельное решение о переключении. Предпочтительно исправление вперёд.

Остановка новых checkout: убрать gateway URL/token у bot вместе, но сохранить отдельный callback listener/token для уже выданных счетов. У gateway нет долговечной очереди relay; его 5-секундный таймаут не доказывает отсутствие платежа, повторная доставка зависит от Finik. До этой остановки и миграции отдельно проверено отсутствие платёжных заказов. Не откатывать VIN, источник Encar или общий monitoring вместе с UI и не затирать более поздние изменения настроек.

[Подбор #88](https://trello.com/c/gCRH5ssD) выпущен; [коммерческий процесс #87](https://trello.com/c/V89xZLbg) остаётся ручной работой, несмотря на выпущенные оформление/PDF.
