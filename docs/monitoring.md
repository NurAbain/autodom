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
  io.autodom.application: autodom
  io.autodom.role: bot # либо worker / vin
```

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
