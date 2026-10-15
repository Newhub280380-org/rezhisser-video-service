# rezhisser-video-service — «Режиссёр»

Node.js service (built-in modules plus `pg` for PostgreSQL) with a Russian
web app for planning video ads and a commercial **Studio** (`/studio`):
accounts, subscriptions, payments, Seedance 2.5 generation and a content
library for the CIS and China. You write an ad brief in plain words. A
**rule-based director** turns it into a creative brief, a hook and call to
action, a shot list and a model prompt, then picks a video model from a
server-side allowlist and explains why.

> **Кратко по-русски.** Откройте адрес сервиса (например
> `https://rezhisser-video-service.onrender.com/`) — там приложение
> «Режиссёр». По умолчанию это **демо**: раскадровка настоящая, а видео **не
> создаётся**, деньги **не списываются**, ни Replicate, ни платные ИИ-сервисы
> не вызываются. Режиссёр работает **по правилам и шаблонам**, это не
> нейросеть. Платная генерация закрыта, пока оператор явно не настроит
> **все** предохранители (см. [пошаговую инструкцию для Render](docs/DEPLOY_RENDER.md)).

## What you get

| Part | State |
| --- | --- |
| Web app at `/` and `/app/` (Russian, responsive, accessible) | ✅ Works without any external account. |
| Rule-based director (`rule-based-v1`) | ✅ Deterministic, free, offline. Labelled as "по правилам, без ИИ". |
| Model router (auto or manual choice with a rationale) | ✅ Demo profiles by default. Paid profiles only if the operator configures them. |
| Demo render (`local-simulation`) | ✅ No network, no cost, **no video**: the result says "демонстрация: видео не создавалось". |
| Paid render via Replicate | 🔒 Locked by default. Needs a private-beta session, a quote and confirmation. Tested only with a fake API. |
| Optional LLM advisor | ⛔ Not implemented. `DIRECTOR_ADVISOR` accepts only `none`; any other value stops startup. |
| Studio at `/studio` (RU / 中文): register, login, password reset, dashboard, pricing, library (83 templates: CIS + China), remix, video history | ✅ See [Production stack](#production-stack). |
| Accounts (email + scrypt password, JWT), PostgreSQL | ✅ In-memory/JSON store (`DATA_DIR/accounts/db.json`) when `DATABASE_URL` is not set (development only). |
| Payments: YooKassa (primary) + Stripe (fallback), RUB/KZT/USD/CNY | ✅ When keys are configured. Tested with fake provider APIs only. |
| Real video via ByteDance Seedance 2.5 (ModelArk) + S3/Backblaze storage | ✅ When `SEEDANCE_API_KEY`/`SEEDANCE_MODEL` and `S3_*` are set. Tested with fake APIs only. Concurrency: `SEEDANCE_MAX_CONCURRENT` (default 4); restarts resume polling (`queued`/`processing` jobs). |

> **Honest limitation:** no real Replicate model, price or input schema has
> been verified in this repository (replicate.com could not be reached from
> the build environment). The service therefore ships **only demo model
> profiles**. Real models must be added by the operator after checking the
> model's official API page and pricing (see
> [Model profiles](#model-profiles-video_model_profiles_json)).

## Screenshots (demo mode, local run)

| Landing and brief | Director plan (full page) | Demo result |
| --- | --- | --- |
| ![Landing](docs/screenshots/desktop-1-landing.jpg) | ![Plan](docs/screenshots/desktop-2-plan.jpg) | ![Demo job](docs/screenshots/desktop-3-job.jpg) |

Mobile: [plan](docs/screenshots/mobile-2-plan.jpg) · Beta login: [dialog](docs/screenshots/desktop-4-login.jpg)

## Local setup

```bash
npm start          # http://0.0.0.0:3000 — open http://localhost:3000/
npm test           # node:test, no network
npm run db:migrate # applies src/db/schema.sql + library (needs DATABASE_URL)
npm run cron:cleanup # retention cleanup (same env as the web service)
```

Requires Node.js 18 or newer (`node --test "test/**/*.test.js"` needs Node
18+; `npm ci` needs npm 8+ for the lockfile). Production uses `pg`
(PostgreSQL driver); without `DATABASE_URL` the service uses a local
JSON store (`DATA_DIR`) for development only. Install only when deploying
with a database:

```bash
npm ci --omit=dev   # what railway.json / render.yaml build with
```

## How it works

```
Brief (browser) ──► POST /api/director/plan ──► rule-based plan + model choice (free)
                    POST /api/jobs {brief}   ──► demo job (local simulation, no video)

Private beta only (paid; locked by default):
  POST /api/session {accessKey} ──► HttpOnly session cookie + CSRF token
  POST /api/quotes  {brief}     ──► operator estimate, valid for 10 min, bound to session+brief+model+image
  POST /api/jobs    {brief, quoteId, confirmPaid:true, idempotencyKey}
                                ──► spend limits checked ──► Replicate prediction
```

### The director (rule-based, not AI)

`src/director.js` validates the brief (product, offer, audience, goal,
platform, aspect ratio, duration, mood, voice, CTA, notes) and builds a plan
from fixed tables and templates:

- a hook and CTA picked from templates per goal (the user's own CTA wins), and a creative brief (objective, format, audience, key message, tone and voice, mandatory elements);
- a visual direction (mood, palette, light, camera, pacing, typography) from the mood preset;
- a shot list with visuals, camera, on-screen text and audio per shot, whose timings cover the full duration (5/10/15/30 s);
- a model prompt and negative prompt (English template wording around the user's text), plus style tags for routing.

The same brief always gives the same plan. The UI and the API label it
`engine: "rule-based-v1"` / «Правила и шаблоны (без ИИ, бесплатно)».

**LLM advisor.** The config setting `DIRECTOR_ADVISOR` is reserved for a
future optional, server-side LLM that could suggest wording. Only `none` is
supported now, and any other value makes the server refuse to start, so a
typo can never silently enable a paid API. Adding one would need its own
provider credentials, a spend cap, tests, and a UI label showing when it was
used.

### Model routing

`src/models.js` holds the allowlist. Users never type a model id, URL or token:

- **Auto**: considers only profiles of the requested tier (`demo` or `paid`).
  It rejects incompatible ones (text-to-video when a photo was uploaded,
  image-to-video without a photo, unsupported aspect ratio), then scores the
  rest by style match and duration, then by the operator's estimate. The
  response lists the rationale and the rejected models with reasons.
- **Manual**: the chosen profile is validated and is **never replaced**. If
  it doesn't fit, the user gets an error such as `image_required`.
- There is **no fallback** from demo to paid or from one paid model to
  another. The model that is billed is exactly the one shown in the quote.

Demo profiles (`demo-cinematic`, `demo-social`, `demo-product-photo`) run on
the local simulation and cost nothing.

### Model profiles (`VIDEO_MODEL_PROFILES_JSON`)

Operator-only JSON array (1–20 items). Every field is validated at startup,
and a bad profile stops the server. **The names below are placeholders, not
recommendations.** Before adding a real model, open its page on Replicate,
check the **API** tab (input field names and types), **run it once**, note
the real price, and record the date.

```json
[
  {
    "id": "t2v-main",
    "label": "Текст → видео (основная)",
    "description": "Для сюжетов без фото продукта.",
    "kind": "text-to-video",
    "replicateModel": "OWNER/MODEL",
    "input": { "prompt": "prompt", "aspectRatio": "aspect_ratio", "duration": "duration" },
    "fixedInput": {},
    "aspectRatios": ["9:16", "16:9", "1:1"],
    "aspectRatioValues": { "9:16": "9:16" },
    "durations": [5, 10],
    "strengths": ["cinematic", "people"],
    "estimatedCostUsd": { "5": 0.5, "10": 1.0 },
    "priceVerifiedAt": "YYYY-MM-DD",
    "priceSource": "https://replicate.com/OWNER/MODEL (pricing section)",
    "schemaVerifiedAt": "YYYY-MM-DD"
  },
  {
    "id": "i2v-product",
    "kind": "image-to-video",
    "replicateModel": "OWNER/MODEL:VERSION",
    "input": { "prompt": "prompt", "image": "image" },
    "durations": [5],
    "estimatedCostUsd": 0.4
  }
]
```

| Field | Meaning |
| --- | --- |
| `kind` | `text-to-video` (must not map `image`) or `image-to-video` (must map `image`; the user must upload a photo). |
| `replicateModel` | `owner/model` → `POST /models/{owner}/{model}/predictions`; `owner/model:version` → `POST /predictions` with `version`. |
| `input` | Maps the director's values onto the model's **own** input field names: `prompt` (required), `negativePrompt`, `aspectRatio`, `duration`, `image`. Unmapped values are not sent. |
| `fixedInput` | Constant scalar inputs (e.g. resolution). |
| `aspectRatioValues` | Optional translation when a model uses different values (e.g. `"16:9": "landscape"`). |
| `durations` | Clip lengths the model can produce. Longer ads get the nearest shorter clip, and the UI says so. |
| `estimatedCostUsd` | **Operator's estimate** per clip (number, or object keyed by duration). A paid profile without an estimate can't be quoted. |

The uploaded photo (PNG/JPEG/WebP, checked by magic bytes, default limit
256 KB, compressed in the browser) is sent to the model as a `data:` URL.
Check the model's documentation for the image input formats and size limits
it accepts.

Legacy setup: if `VIDEO_MODEL_PROFILES_JSON` is empty, `REPLICATE_MODEL`
becomes the single `replicate-default` text-to-video profile (input: `prompt`
plus `REPLICATE_EXTRA_INPUT_JSON`). Its estimate comes from
`REPLICATE_ESTIMATED_COST_USD`.

## Production stack

The commercial product runs **next to** the legacy demo / private-beta API
(which is unchanged). Deployment: [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md)
(Railway + PostgreSQL + cron + Backblaze B2). All variables: [`.env.example`](.env.example).

| Part | Where |
| --- | --- |
| DB schema (users, video_jobs, payments, usage_events, projects, library_items, password_resets) | `src/db/schema.sql`, `src/db/postgres.js`, `src/db/memory.js`; `npm run db:migrate` |
| Auth: scrypt hashes, HS256 JWT bound to a token version (password reset revokes old tokens) | `src/accounts.js` |
| Billing: products, tiers, credits, checkout, webhooks, refunds | `src/billing/*` |
| Seedance 2.5 provider + job pipeline (poll, store, refund on failure, resume after restart) | `src/providers/seedance.js`, `src/pipeline.js` |
| S3 client (SigV4, presigned downloads) and retention cleanup cron | `src/storage/s3.js`, `src/cron/cleanup.js` (`npm run cron:cleanup`; Railway schedule `17 3 * * *` in `railway.cron.json`; retention `VIDEO_RETENTION_DAYS`, default 30) |
| Content library: 53 CIS items (RU, KZ, TJ, UZ, KG) + 30 Chinese (中文) items | `src/library/sng.json`, `src/library/china.json` |
| Video pipeline semantics | `src/pipeline.js`: `queued` → `processing` → `succeeded`/`failed`; stored copies at `videos/<userId>/<jobId>.mp4`; on storage failure the temporary provider URL is kept; `queued`/`processing` jobs resume polling after a restart (they hold Seedance slots first); demo jobs complete without a provider call |

**Plans.** Free — demo only. Pro — $5 / 30 days (500 ¢), 50 videos
(`PRO_VIDEOS_PER_PERIOD`). Studio — $20 / 30 days (2000 ¢), unlimited unless
`STUDIO_VIDEOS_PER_PERIOD` is set. Credits (`credits_10` — $1.50 / 150 ¢,
`credits_50` — $6 / 600 ¢) are pay-as-you-go and are used after the plan allowance. Prices for RUB/KZT/CNY are in `src/billing/plans.js`
and can be overridden with `PRICES_JSON`. A failed generation returns the
video/credit automatically.

**Payments.** RUB and KZT go to YooKassa, USD and CNY to Stripe (configurable).
YooKassa notifications are unsigned, so the server re-reads each payment from
the YooKassa API and checks amount and currency before granting anything.
Stripe events are verified with `STRIPE_WEBHOOK_SECRET`. Entitlements are
granted once per payment (guarded state transition) and revoked on full refunds.

**Content library.** Every card is a ready template: Russian/Chinese prompt,
an English model prompt with `{product}`, `{brand}`, `{photo}` placeholders,
negative prompt, format, duration and a shot list (and dialogue for memes,
e.g. «Два косметолога» lip-sync meme, expectation-vs-reality, «это не купишь
за деньги», 直播带货 live-commerce hooks). Memes use original dialogue
"in the style of" a comedy, never copyrighted film footage or audio.

### Account API

Account endpoints take the JWT in the `Authorization` header (`Bearer <token>`, same origin only).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/plans` | Tiers (`free`/`pro`/`studio`), products with prices in minor units, payment providers and their currencies, plus Seedance availability. |
| `POST` | `/api/auth/register` | `{ email, password, locale? }` → `{ token, expiresAt, user, subscription }`. |
| `POST` | `/api/auth/login` | `{ email, password }` → JWT. Per-IP + global rate limit. |
| `POST` | `/api/auth/forgot-password` / `/api/auth/reset-password` | `{ email }` always `200` (needs `PUBLIC_ORIGIN` + Resend for a real mail) / `{ token, password }` (single-use, revokes old JWTs). |
| `GET` | `/api/user/profile` | User, subscription (tier, limits, credits, `canGenerate`) and usage totals. Bearer JWT. |
| `POST` | `/api/payment/checkout` | `{ product: pro\|studio\|credits_10\|credits_50, currency, provider? }` → `{ payment, confirmationUrl }`. Bearer JWT. |
| `GET` | `/api/payment/history` | Payments and usage events. Bearer JWT. |
| `POST` | `/api/payment/webhook/yookassa`, `/api/payment/webhook/stripe` | Provider webhooks (YooKassa re-read via API; Stripe signature check). |
| `POST` | `/api/library/search` | `{ query?, region?, country?, language?, category?, type?, trend?, limit?, offset? }` → `{ total, items, facets }`. Public. |
| `GET` | `/api/library/:id` | Full prompt + template. Public. |
| `GET/POST` | `/api/projects`, `DELETE /api/projects/:id` | Saved projects and favorite prompts (`kind: "project"\|"favorite"`, max 500; Studio blocks exact duplicates client-side). Bearer JWT. |
| `POST` | `/api/jobs` (with bearer token) | `{ prompt?, brief?, libraryItemId?, fields?, remix?, aspect?, duration?, durationSeconds?, image?, imageDataUrl? (+ `image2…5`/`imageDataUrl2…5` for multi-photo prompts) }` (+ `demo:true` for a free demo) → Seedance job (subscription quota first, then credits; `402` when nothing is left). Usage is reserved before the provider call and refunded on failure. `GET` job lists are capped at the newest 100; profile usage totals scan the newest 1000. |
| `GET` | `/api/jobs`, `/api/jobs/:id` (with bearer token) | Own jobs (newest 100) with signed video/download URLs (`VIDEO_URL_TTL_SECONDS`) or the temporary provider URL. |

Without a bearer token `/api/jobs` keeps the legacy behaviour described below.

## Safety model for paid generation

Paid generation is available **only if all** of these are true (see
`GET /api/config` → `paid.reasons` for what is missing):

1. `VIDEO_PROVIDER=replicate` with a valid `REPLICATE_API_TOKEN` and at least one paid profile;
2. `PAID_GENERATION_ENABLED=true`;
3. `BETA_ACCESS_KEY` is set (≥ 24 characters, random);
4. `PAID_DAILY_BUDGET_USD` > 0 (plus `PAID_DAILY_JOB_LIMIT` / `PAID_TOTAL_JOB_LIMIT`);
5. at least one paid profile has `estimatedCostUsd`.

Even then, each paid job requires all of the following:

- **Private-beta session.** `POST /api/session` with the access key, from the
  service's own page (same `Origin`), rate limited per IP and globally. The
  server compares the key with HMAC and `timingSafeEqual` and creates a random
  in-memory session in an `HttpOnly; SameSite=Strict` cookie (`Secure` behind
  HTTPS). The key is never stored in the browser, the URL or the page.
- **CSRF protection.** Every state-changing session request needs the
  `X-CSRF-Token` header and `Origin` equal to the service's own origin. No
  cross-origin request can use the session: CORS never sends
  `Access-Control-Allow-Credentials`.
- **Server-issued quote.** It is bound to the session, profile, brief hash,
  image hash and clip length. It is valid for `QUOTE_TTL_MS` and single-use.
  The user must tick the checkbox and press the confirm button
  (`confirmPaid: true`). Price, cost, model and input fields sent by the
  client are rejected (`field_not_allowed`).
- **Idempotency key.** Repeating it returns the same job (`200
  idempotentReplay`) instead of starting a second prediction. The browser
  keeps the key on retry after a timeout.
- **Server-side limits, checked synchronously before the provider call:**
  the daily USD budget, daily job count, total job count, and
  `REPLICATE_MAX_CONCURRENT` (extra jobs get `503 provider_busy`). The
  estimate is counted when the job starts, **even if it later fails**.
  Account (Seedance) jobs use a separate guard: `SEEDANCE_MAX_CONCURRENT`
  (default 4); when full, new jobs get `503 seedance_busy` and should be
  retried. Usage is reserved before the provider call and refunded
  automatically when the job fails.
- **Public API is demo-only.** The legacy prompt API (`POST /api/jobs
  {prompt}`) can never start a paid prediction (`401`). Paid jobs, briefs and
  plans are hidden from anonymous `GET /api/jobs`.

What this does **not** give you, read carefully:

- It is **not a provider-side spend cap**. The ledger counts the operator's
  *estimates*, not Replicate invoices. Also set a low limit in your Replicate
  billing settings, and don't rely on any vendor cap unless the vendor
  documents it for your account.
- **A timeout, cancel, error or restart may NOT reverse charges.** Replicate
  may bill for a prediction that already started. Jobs interrupted by a
  restart are marked `provider_interrupted` and are **not** retried.
  Account (Seedance) jobs behave differently: usage is reserved before the
  call and **refunded on failure** (`generation_refund` in
  `GET /api/payment/history`); Seedance jobs left `queued`/`processing`
  across a restart **resume polling** instead (see Production stack →
  Video pipeline).
- Sessions and quotes live in memory. The private-beta ledger and demo jobs
  `DATA_DIR`. On the Render free plan the disk is **ephemeral**, so a
  restart, deploy or idle spin-down resets the daily/total counters and the
  job history. Use a persistent disk if you rely on these counters. Run
  **one instance only**, because nothing is shared between instances.
- One shared key is **not** a user-account system. Everyone with the key has
  the same rights and there is no per-user attribution.

**Before selling to the public** (already built here, verify your own
deployment): real user accounts with per-user JWT sessions, payments with
per-user prepaid credits deducted atomically in the database, per-user quotas,
persistent storage (PostgreSQL plus S3-compatible object storage, because
provider output URLs may be temporary), provider webhooks with signature
checks (YooKassa re-read, Stripe HMAC), reconciliation via
`GET /api/payment/history` and provider dashboards, terms of
service and a content moderation policy, monitoring and alerts, and a legal
review for your jurisdiction.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind address (Render sets `PORT`). |
| `ALLOWED_ORIGINS` | `https://business-41.pazi.dev` + local dev origins | CORS allowlist for **other** sites (demo API only, no credentials). The service's own page doesn't need to be listed. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` | Per-IP limit for `/api/*` (code default; `render.yaml` overrides to `30`; `.env.example` shows `60`). |
| `DATA_DIR` | `<cwd>/data` | Job files, `accounts/db.json` (dev store) and `spend-ledger.state`. Start command: `node src/server.js`. |
| `DATABASE_URL` | – | PostgreSQL connection string. Without it the service uses the dev JSON store (`DATA_DIR/accounts/db.json`). Railway: `DATABASE_URL=${{Postgres.DATABASE_URL}}`. |
| `DATABASE_SSL` | driver default | `disable` \| `require` \| `no-verify`. Railway internal network needs none. |
| `DB_AUTO_MIGRATE` | `true` | Applies `src/db/schema.sql` + library upsert at startup (idempotent). Set `false` on Railway (pre-deploy `npm run db:migrate` already runs). |
| `JWT_SECRET` | – | **Secret.** ≥ 32 chars. Startup fails without it when accounts are used (production always). |
| `JWT_TTL_SECONDS` | `604800` (7 d) | Token lifetime, 300 s – 30 d. |
| `SEEDANCE_API_KEY` | – | **Secret.** Without it: accounts work, only demo generation. |
| `SEEDANCE_MODEL` | – | Model/endpoint id from the ModelArk console. Must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`. |
| `SEEDANCE_API_BASE_URL` | `https://ark.ap-southeast.bytepluses.com/api/v3` | BytePlus (intl) or `https://ark.cn-beijing.volces.com/api/v3` (Volcengine China). Must be `https`. |
| `SEEDANCE_RESOLUTION` / `SEEDANCE_GENERATE_AUDIO` | `720p` / `true` | Fixed request fields sent with every task. |
| `SEEDANCE_IMAGE_ROLE` | `first_frame` | How the photo is sent: `first_frame` \| `reference_image` (any string is accepted and forwarded). |
| `SEEDANCE_EXTRA_INPUT_JSON` | – | Optional fixed fields (object; must not set `model`/`content`/`callback_url`). |
| `SEEDANCE_POLL_INTERVAL_MS` / `SEEDANCE_MAX_WAIT_MS` / `SEEDANCE_REQUEST_TIMEOUT_MS` | `5000` / `900000` (15 min) / `30000` | Poll every 1–60 s; give up after up to 60 min (timeout cancels the task, best effort — may still be billed). |
| `SEEDANCE_MAX_CONCURRENT` | `4` | Real-job slots, 1–100. Resumed jobs after a restart take slots first; new jobs wait. |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `us-east-1` / rest unset | Object storage (Backblaze B2 / AWS S3 / MinIO / R2). Without all four credentials: provider `https` URL is kept instead of a stored copy. Must be `https`; `S3_FORCE_PATH_STYLE` defaults `true`. |
| `VIDEO_RETENTION_DAYS` | `30` | Cleanup cron (`npm run cron:cleanup`) deletes stored video and marks jobs `expired`, 1–3650 d. |
| `VIDEO_URL_TTL_SECONDS` | `3600` | Signed playback/download link lifetime, 60 s – 7 d. |
| `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` | – | Without both: YooKassa unavailable (`503` for its currencies). `YOOKASSA_CURRENCIES` default `RUB,KZT`. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | – | Without key: Stripe unavailable. Without webhook secret: webhooks return `404`. `STRIPE_CURRENCIES` default `USD,CNY,KZT,RUB`. |
| `PRO_VIDEOS_PER_PERIOD` / `STUDIO_VIDEOS_PER_PERIOD` | `50` / unlimited | Quota per 30-day period. Studio empty = unlimited. |
| `PRICES_JSON` | built-ins | Overrides like `{"pro":{"RUB":49900}}`; unknown product/currency or non-positive integer fails startup. |
| `RESEND_API_KEY` / `MAIL_FROM` | – | Password-reset mail. Without both, no mail is sent (outside production the link is logged). |
| `SIMULATION_DURATION_MS` | `3000` | Demo job duration. |
| `VIDEO_PROVIDER` | `local-simulation` | `local-simulation` or `replicate`. |
| `DIRECTOR_ADVISOR` | `none` | Only `none` is supported; any other value fails startup. |
| `VIDEO_MODEL_PROFILES_JSON` | – | Paid model allowlist (see above). Used only when `VIDEO_PROVIDER=replicate`. |
| `PAID_GENERATION_ENABLED` | `false` | Must be exactly `true` to unlock paid jobs. |
| `BETA_ACCESS_KEY` | – | **Secret.** ≥ 24 characters. Set it only in the Render dashboard. |
| `PAID_DAILY_BUDGET_USD` | `0` (locked) | Daily limit on the sum of estimates (UTC day). |
| `PAID_DAILY_JOB_LIMIT` | `3` | Paid jobs per UTC day (1–100). |
| `PAID_TOTAL_JOB_LIMIT` | `20` | Paid jobs in total, for as long as the ledger file survives (1–10000). |
| `QUOTE_TTL_MS` | `600000` | Quote lifetime (1–60 min). |
| `SESSION_TTL_MS` | `28800000` | Beta session lifetime (5 min – 24 h). |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | `5` / `900000` | Login attempts per IP (global limit is 10×). |
| `IMAGE_MAX_BYTES` | `262144` | Max decoded upload size (16 KB – 5 MB). |
| `PUBLIC_ORIGIN` | – | Optional. Explicit origin (e.g. `https://rezhisser-video-service.onrender.com`, no path) used for the same-origin check and the `Secure` cookie flag; an invalid value stops startup. Otherwise it is derived from `Host` and `X-Forwarded-Proto`. |
| `REPLICATE_API_TOKEN` | – | **Secret.** Server-side only. |
| `REPLICATE_MODEL` | – | Legacy single model (`owner/model[:version]`). |
| `REPLICATE_ESTIMATED_COST_USD` | – | Estimate for the legacy profile. |
| `REPLICATE_EXTRA_INPUT_JSON` | – | Fixed inputs for the legacy profile. |
| `REPLICATE_API_BASE_URL` | `https://api.replicate.com/v1` | Must be `https`. |
| `REPLICATE_POLL_INTERVAL_MS` | `5000` | 1000–60000. |
| `REPLICATE_MAX_WAIT_MS` | `600000` | 10 s – 30 min. On timeout the prediction is cancelled (best effort; may still be billed). |
| `REPLICATE_REQUEST_TIMEOUT_MS` | `30000` | Per HTTP request. |
| `REPLICATE_MAX_CONCURRENT` | `1` | Concurrent predictions (1–10). |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/`, `/app/` | Web app (strict CSP, no inline scripts, no third-party origins). |
| `GET` | `/api/health` | `{ status, uptimeSeconds, timestamp, videoProvider, realVideoGeneration, paidGenerationEnabled, checks }`. `503` + `degraded` when `checks.database` is not `ok`. `checks` also reports `databaseKind`, `seedance`, `storage`, `payments[]`, `library`. |
| `GET` | `/api/config` | Brief options, public model profiles, director info, `paid: {available, reasons}`, auth state. Contains no secrets. |
| `POST` | `/api/director/plan` | `{ brief, modelId?, tier?, hasImage? }` → `{ plan, selection }`. Free. |
| `GET/POST/DELETE` | `/api/session` | Beta login/logout (same-origin only; DELETE needs CSRF). |
| `POST` | `/api/quotes` | Beta + CSRF. `{ brief, modelId?, image? }` → `{ quote, plan, selection, spend }`. |
| `POST` | `/api/jobs` | `{ brief, modelId?, image? }` → demo job. Paid: add `tier:"paid"`, `quoteId`, `confirmPaid:true`, `idempotencyKey`. Legacy `{ prompt, provider? }` still works. `model`/`input`/`price` fields are rejected (`400`). |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Anonymous users see only demo jobs; paid jobs need a session. Private-beta job bodies live in memory and are lost on restart. |
| `POST` | `/api/auth/register`, `/api/auth/login` | `{ email, password, locale? }` / `{ email, password }` → `{ token, expiresAt, user, subscription }`. Per-IP + global login rate limit; unknown emails still run a dummy scrypt check. Password 8–128 chars. |
| `GET` | `/api/user/profile` | Bearer JWT → `{ user, subscription }` (`tier`, `credits`, `periodVideosUsed/Limit`, `canGenerate`) + usage totals. |
| `POST` | `/api/auth/forgot-password`, `/api/auth/reset-password` | `{ email }` always `200` (no account enumeration); `{ token, password }` rotates `tokenVersion` and revokes all old JWTs, single-use. Reset links use `PUBLIC_ORIGIN`, never the `Host` header. |
| `GET` | `/api/plans` | Public products: `pro`/`studio` subscriptions (30 d, same-tier re-buy extends) + `credits_10`/`credits_50`. Prices in minor units, overridable via `PRICES_JSON`. Also lists tiers, currencies, providers and Seedance availability. |
| `POST` | `/api/payment/checkout` | Bearer. `{ product, currency, provider? }` → `{ payment, confirmationUrl }`. Unknown product/currency, unavailable provider, or provider outage (`502`) are explicit errors. |
| `GET` | `/api/payment/history` | Bearer. `{ payments[], usage[] }` — the billing ledger. |
| `POST` | `/api/payment/webhook/yookassa`, `/api/payment/webhook/stripe` | Provider callbacks. YooKassa is re-read via API (body is never trusted); Stripe checks `Stripe-Signature` (5 min tolerance). Partial YooKassa refunds do not revoke access. |
| `POST` | `/api/library/search` | `{ region?, country?, language?, category?, type?, trend?, query?, limit?, offset? }` → `{ total, items[], facets }` (83 templates: `sng` + `china`). |
| `GET` | `/api/library/:id` | One template with shots + prompts. |
| `GET/POST` | `/api/projects` | Bearer. List (newest first) / save `{ title, libraryItemId?, prompt?, brief?, kind? }`; max 500; no duplicates. Favorites are `kind:"favorite"` (same cap). |
| `DELETE` | `/api/projects/:id` | Bearer. Deletes only your own project. |
| `POST` | `/api/jobs` (account) | Bearer (`Authorization` present routes here). `{ prompt?, brief?, libraryItemId?, remix?, aspect?, durationSeconds?, imageDataUrl? }` → Seedance (subscription quota first, then credits; `402` when empty) or demo. Usage is reserved **before** the provider call and refunded on failure. |
| `GET` | `/api/jobs` (account, 100 max), `/api/jobs/:id` | Bearer. Only your own jobs. `videoUrl` is a signed S3 link (`VIDEO_URL_TTL_SECONDS`) when stored, else the temporary provider `https` URL. |
| `GET` | `/studio` | Studio UI (RU/中文): library, remix, history, pricing, dashboard. JWT stays in `localStorage`, sent only to this origin. |

Every job says explicitly what it is: `provider`, `simulated`,
`realVideoGeneration`, `paid`, `modelId`. A demo job always ends with
`result: { simulated: true, videoUrl: null }`. The UI shows a player and a
download link **only** for a real `https` video URL.

## Using it from business-41.pazi.dev

The new app is served **by this Render service** (same origin). **The Pazi
site has not been changed by this repository**, and its own `/app/` is a
separate thing. Options for the next step, done separately in the Pazi
project:

1. **Link** from Pazi to `https://rezhisser-video-service.onrender.com/app/`
   (simplest, and all features work, including beta login).
2. **Call the demo API** from Pazi's frontend (`/api/director/plan`,
   `POST /api/jobs {brief}` or legacy `{prompt}`). The origin is already in
   `ALLOWED_ORIGINS`. Paid actions are **not** available cross-origin by
   design (SameSite=Strict cookie, no credentialed CORS).
3. Paid generation from Pazi would require real accounts on a shared domain or
   a server-to-server integration with its own authentication. That isn't
   built.

Note: when `VIDEO_PROVIDER=replicate`, the legacy `POST /api/jobs {prompt}`
without `provider` returns `401` (it would otherwise be billable). Clients
should send `provider: "local-simulation"` or use the brief flow.

## Deploying to Render

See **[docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md)** (Russian, step by step)
for the existing, **manually created** Web Service. `render.yaml` is only used
by Render Blueprints. It is **not** applied to a service created manually in
the dashboard, so env vars must be set there by hand.

## Tests

`npm test` runs everything with injected fake `fetch`. No token, no network,
no billing:

- `test/e2e.test.js`: health, CORS, preflight, security headers, rate limit, legacy simulation jobs.
- `test/replicate.test.js`: the Replicate adapter (create/poll, timeouts, cancel, errors, URL extraction), plus the gated beta flow end to end, concurrency cap and restart interruption.
- `test/director.test.js`: determinism, validation, shot timings, "rule-based" labelling, fail-closed advisor setting.
- `test/models.test.js`: profile validation, auto/manual routing, no cross-tier fallback, per-model input mapping, and the **actual endpoint URL and request body** reaching the fake provider for versioned and unversioned profiles.
- `test/auth-spend.test.js`: locked-by-default reasons, each missing safeguard, and that unauthenticated, CSRF-less, cross-origin and legacy requests cause **zero predictions**. Also login rate limit, cookie flags, quotes (mismatch, expiry, single use, other session), idempotent replay, budget and job caps, ledger persistence, and private job listings.
- `test/db.test.js`: repository contract for the in-memory store and, with `TEST_DATABASE_URL=postgres://…` (a throwaway database — tables are dropped), for PostgreSQL.
- `test/accounts.test.js`: password hashing, JWT forgery/expiry, register/login/profile, password reset (single use, revokes old tokens, no Host-header links), login rate limit.
- `test/payments.test.js`: YooKassa and Stripe checkout, webhook verification (re-fetch, signature, amount mismatch, replay), refunds, provider outage.
- `test/generation.test.js`: Seedance requests, Free/Pro/Studio/credits accounting, refunds on failure, S3 SigV4 (AWS reference vector), library remix, projects, restart resume, cleanup cron.
- `test/library.test.js`, `test/studio.test.js`: library coverage and search; Studio CSP, sinks, ids and RU/中文 translations.
- `test/frontend.test.js`: UI routes and CSP, static allowlist (no traversal), no `innerHTML`/`eval`/third-party origins, no secrets in assets, every referenced element exists, accessibility basics, and a demo flow with network disabled.
