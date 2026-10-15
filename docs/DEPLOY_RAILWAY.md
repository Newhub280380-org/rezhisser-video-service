# Деплой на Railway (production)

Стек: **Node.js-сервис** (`railway.json`) + **PostgreSQL** (плагин Railway) +
**cron-сервис очистки** (`railway.cron.json`) + **Backblaze B2** для видео +
**Seedance 2.5** (ByteDance ModelArk) для генерации + **ЮKassa / Stripe** для оплаты.

## 1. Проект и база

1. Railway → **New Project → Deploy from GitHub repo** → `rezhisser-video-service`.
   Railway найдёт `railway.json`: сборка `npm ci --omit=dev`, перед каждым
   деплоем `npm run db:migrate`, health check `GET /api/health`
   (503, если база недоступна).
2. **+ New → Database → PostgreSQL**.
3. В переменных веб-сервиса: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. **Settings → Networking → Generate Domain**, затем
   `PUBLIC_ORIGIN=https://<ваш-домен>` (без `/` в конце).

## 2. Переменные

Полный список с пояснениями — в [`.env.example`](../.env.example). Минимум:

| Переменная | Значение |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (без неё — dev-хранилище в `DATA_DIR`, не для продакшена) |
| `DB_AUTO_MIGRATE` | `false` (миграцию уже делает pre-deploy `npm run db:migrate`; схема + библиотека применяются идемпотентно) |
| `JWT_SECRET` | 32+ случайных символов (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) — без него старт с аккаунтами падает; `JWT_TTL_SECONDS` по умолчанию `604800` (7 дн, 300 с – 30 дн) |
| `SEEDANCE_API_KEY`, `SEEDANCE_MODEL` | ключ и id модели/endpoint Seedance 2.5 из консоли ModelArk (`SEEDANCE_MODEL` — `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`) |
| `SEEDANCE_API_BASE_URL` | BytePlus: `https://ark.ap-southeast.bytepluses.com/api/v3`, Volcengine (КНР): `https://ark.cn-beijing.volces.com/api/v3` (только `https`) |
| `SEEDANCE_MAX_CONCURRENT` | `4` (1–100; при переполнении новые задачи получают `503 seedance_busy`; задачи после рестарта занимают слоты первыми) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Backblaze B2 → *Application Keys* (bucket **private**) |
| `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` | личный кабинет ЮKassa → Интеграция → Ключи API |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers |
| `RESEND_API_KEY`, `MAIL_FROM` | письма «забыли пароль» (без них ссылка не отправляется) |

Без `SEEDANCE_API_KEY` аккаунты работают, но доступен только демо-режим.
Без ключей оплаты `POST /api/payment/checkout` отвечает `503`.

## 3. Вебхуки оплаты

* **ЮKassa** → Интеграция → HTTP-уведомления:
  `https://<домен>/api/payment/webhook/yookassa`, события
  `payment.succeeded`, `payment.canceled`, `refund.succeeded`.
  Уведомления ЮKassa не подписаны, поэтому сервер **перечитывает платёж
  через API** и сверяет сумму и валюту — подделать оплату телом запроса нельзя.
* **Stripe** → Developers → Webhooks:
  `https://<домен>/api/payment/webhook/stripe`, события
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`. Подпись `Stripe-Signature` проверяется.

Маршрутизация: RUB/KZT → ЮKassa, USD/CNY → Stripe (настраивается
`YOOKASSA_CURRENCIES` / `STRIPE_CURRENCIES`; без вебхук-секрета Stripe
вебхуки отдают `404`). Подписка — предоплаченный
период 30 дней (повторная оплата того же тарифа продлевает срок).
`POST /api/payment/checkout` без ключей провайдера отвечает `503`;
провайдер недоступен во время запроса — `502`. Частичный возврат ЮKassa
доступ не отзывает; ошибки задач Seedance возвращают списание
(`generation_refund` в `GET /api/payment/history`).

## 4. Cron очистки (по умолчанию 30 дней)

1. **+ New → GitHub Repo** → тот же репозиторий, второй сервис `cleanup`.
2. **Settings → Config-as-code → Railway Config File**: `railway.cron.json`
   (запуск `npm run cron:cleanup` ежедневно в 03:17 UTC).
3. Переменные: `DATABASE_URL`, `S3_*`, `VIDEO_RETENTION_DAYS` (как у веб-сервиса).

Скрипт удаляет из бакета видео старше `VIDEO_RETENTION_DAYS` (1–3650 дн),
помечает задачи `expired` (ссылки больше не выдаются: `videoKey`/`videoUrl`
обнуляются) и чистит просроченные токены сброса пароля.

## 5. Проверка и диагностика

```bash
curl https://<домен>/api/health
# {"status":"ok", ..., "checks":{"database":"ok","databaseKind":"postgres",
#   "seedance":"configured","storage":"configured","payments":["yookassa","stripe"],"library":83}}
```

Studio: `https://<домен>/studio` — регистрация, тарифы, библиотека
(СНГ + 中文, 53 + 30 шаблонов), ремикс шаблона с фото, история видео
(ссылки живут `VIDEO_URL_TTL_SECONDS`, по умолчанию 3600 с).

Типичные проверки после деплоя:

- `503 {"status":"degraded"}` на `/api/health` — нет `DATABASE_URL` или база
  недоступна (сервис слушает порт даже без базы).
- `configuration error: PUBLIC_ORIGIN must be an origin…` в логах — уберите
  `/` в конце `PUBLIC_ORIGIN`.
- `configuration error: S3_…` — проверьте `S3_ENDPOINT` (`https`),
  имя бакета и ключи; без S3 видео остаётся по временной ссылке провайдера.
- `503 {"error":"seedance_busy"}` на `POST /api/jobs` с токеном —
  заняты все `SEEDANCE_MAX_CONCURRENT` слотов; повторите позже.
- `404` на Stripe-вебхуке — нет `STRIPE_WEBHOOK_SECRET`.

Мониторинг: Railway → Observability (логи и метрики), health check
перезапускает сервис при падении; при желании добавьте внешний uptime-монитор
на `/api/health`.
