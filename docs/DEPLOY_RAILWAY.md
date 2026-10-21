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
| `DB_AUTO_MIGRATE` | `false` (миграцию уже делает pre-deploy `npm run db:migrate`) |
| `JWT_SECRET` | 48+ случайных символов (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) |
| `SEEDANCE_API_KEY`, `SEEDANCE_MODEL` | ключ и id модели/endpoint Seedance 2.5 из консоли ModelArk |
| `SEEDANCE_API_BASE_URL` | BytePlus: `https://ark.ap-southeast.bytepluses.com/api/v3`, Volcengine (КНР): `https://ark.cn-beijing.volces.com/api/v3` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Backblaze B2 → *Application Keys* (bucket **private**) |
| `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY` | личный кабинет ЮKassa → Интеграция → Ключи API |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers |
| `RESEND_API_KEY`, `MAIL_FROM` | письма «забыли пароль» (без них ссылка не отправляется) |

Без `SEEDANCE_API_KEY` и `SEEDANCE_MODEL` генерация видео отвечает `503` и называет эти переменные — демо-ролик не создаётся.
Без ключей оплаты `POST /api/payment/checkout` отвечает `503` и перечисляет `YOOKASSA_*` / `STRIPE_SECRET_KEY`.

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
`YOOKASSA_CURRENCIES` / `STRIPE_CURRENCIES`). Подписка — предоплаченный
период 30 дней (повторная оплата того же тарифа продлевает срок).

## 4. Cron очистки (30 дней)

1. **+ New → GitHub Repo** → тот же репозиторий, второй сервис `cleanup`.
2. **Settings → Config-as-code → Railway Config File**: `railway.cron.json`
   (запуск `npm run cron:cleanup` ежедневно в 03:17 UTC).
3. Переменные: `DATABASE_URL`, `S3_*`, `VIDEO_RETENTION_DAYS` (как у веб-сервиса).

Скрипт удаляет из бакета видео старше `VIDEO_RETENTION_DAYS`, помечает задачи
`expired` и чистит просроченные токены сброса пароля.

## 5. Проверка

```bash
curl https://<домен>/api/health
# {"status":"ok", ..., "checks":{"database":"ok","databaseKind":"postgres",
#   "seedance":"configured","storage":"configured","payments":["yookassa","stripe"],"library":83}}
```

Studio: `https://<домен>/studio` — регистрация, тарифы, библиотека
(СНГ + 中文), ремикс шаблона с фото, история видео.

Мониторинг: Railway → Observability (логи и метрики), health check
перезапускает сервис при падении; при желании добавьте внешний uptime-монитор
на `/api/health`.
