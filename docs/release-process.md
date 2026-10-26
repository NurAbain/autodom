# Порядок релиза Autodom

Разработка идёт в `staging`, production работает из `main`. Ветка `main` — единственная,
из которой собирается production; `staging` — единственная, куда сливается разработка.

## Ветки

| Ветка | Роль | Что собирается |
|---|---|---|
| `main` | production | все production-приложения Coolify |
| `staging` | интеграция разработки | staging-приложения Coolify (когда они есть) |
| `feat/*`, `fix/*` | задача | ничего; ветка живёт до слияния в `staging` |

Порядок: задача → `staging` → `main`. Хотфикс production: `main` → `staging` (обратный
перенос), чтобы `staging` не отставал.

## Поток задачи

1. Ветка задачи от `staging`: `git switch -c feat/<задача> origin/staging`.
2. Работа и проверки в ветке: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
3. Слияние в `staging` через pull request.
4. Проверка на staging-окружении.
5. Pull request `staging` → `main`, после слияния production собирается сам.

## Как попадает код в production

GitHub не доходит до production-хоста: Coolify доступен только во внутренней сети, и
webhook-запрос от GitHub до него не доходит. Поэтому деплой запускает сторож на хосте:

- `/usr/local/bin/autodom-deploy-watch` — systemd-таймер `autodom-deploy-watch.timer`,
  каждые две минуты опрашивает `git ls-remote` по ветке `main`;
- при изменении ветки коммит закрепляется за приложением (`git_commit_sha`) и запускается
  деплой в Coolify;
- конфигурация: `/etc/autodom/deploy.env` (токен Coolify, root-only) и
  `/etc/autodom/deploy-apps` (список `uuid ветка`).

Ручной деплой одной ветки (когда нужно не дожидаться двух минут):

```bash
scripts/deploy-coolify.sh <application-uuid> [branch]
```

Приложения Coolify и их ветки:

| Приложение | Ветка | Роль |
|---|---|---|
| `autodom-bot-miniapp` | `main` | @autokgbot, VIN-бот |
| `autodom-full-bot-miniapp` | `main` | @autodomkgbot, подбор и Mini App |
| `autodom-parser` | `main` | сбор объявлений |
| `autodom-vin-api` | `main` | VIN API |
| `autodom-outreach` | `main` | outreach |

## Проверка после деплоя

1. Контейнеры: `docker ps` — у всех `running:healthy`.
2. Источники: `source:<источник>:last_success_at` и `source:<источник>:source_error` в
   таблице `metadata` — пустое `source_error` и свежий `last_success_at`.
3. Сбор: `SELECT source, count(*) FROM listings WHERE last_seen > extract(epoch from now())-900 GROUP BY source;`
4. Mini App: `https://autodom.skup.kg/full/miniapp/` отвечает 200.

## Откат

Откат — это новый коммит в `main`, а не перестановка указателей:

1. `git revert` коммита в ветке задачи, слияние в `staging`, затем в `main`.
2. Либо ручной откат закреплённого коммита: `PATCH /api/v1/applications/{uuid}` с
   `git_commit_sha` предыдущего рабочего SHA и запуск деплоя.
3. Прямой `git push --force` в `main` запрещён: production-коммит, который уже собирался,
   не переписывается.

## Правила

- `main` защищён: push запрещён, изменения только через pull request, force-push запрещён.
- `staging` — интеграционная ветка: сюда обязательно сливается `main` после хотфикса.
- Секреты (токены Coolify, GitHub, прокси, Telegram) не попадают в репозиторий: они живут
  в Coolify env, в `/etc/autodom` на хосте и в pass-хранилище.
