# rezhisser-video-service

Minimal Node.js HTTP service built only on Node's built-in modules (no production
dependencies). It provides a health endpoint, a CORS allowlist, basic security
headers, a per-IP rate limit and a video generation job API with two providers:

- `local-simulation` (**default**): no network calls, no cost, **no real video**.
  Jobs simulate progress and always finish with `videoUrl: null` and
  `simulated: true`.
- `replicate` (opt-in): creates a prediction on [Replicate](https://replicate.com)
  with a server-configured model and returns the video URL it produces.

> **Honest limitation:** out of the box (and on the default Render Blueprint)
> the service runs the local simulation and does **not** generate video. The
> Replicate integration is covered only by tests with a mocked HTTP API; it has
> not been verified against a real Replicate model in this repository.

## Local setup

```bash
npm start          # starts the server (default http://0.0.0.0:3000)
npm test           # runs the test suite with node:test
```

Requires Node.js 18 or newer. There are no dependencies to install.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Interface to bind to. |
| `PORT` | `3000` | Port to listen on (Render sets this automatically). |
| `ALLOWED_ORIGINS` | `https://business-41.pazi.dev` plus local dev origins (`http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`) | Comma-separated CORS allowlist. Origins outside the list get `403`; they are never reflected. |
| `RATE_LIMIT_MAX` | `30` | Maximum `/api/*` requests per IP per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds. |
| `DATA_DIR` | `<cwd>/data` | Directory where job JSON files are stored (created on startup). |
| `SIMULATION_DURATION_MS` | `3000` | How long a simulated job stays in progress before it is marked `succeeded`. |
| `VIDEO_PROVIDER` | `local-simulation` | `local-simulation` or `replicate`. Anything else fails at startup. |
| `REPLICATE_API_TOKEN` | – | **Secret.** Required only when `VIDEO_PROVIDER=replicate`. Never commit it or send it to the browser. |
| `REPLICATE_MODEL` | – | Required only when `VIDEO_PROVIDER=replicate`. `owner/model` (uses `POST /models/{owner}/{model}/predictions`) or `owner/model:version` (uses `POST /predictions` with `version`). |
| `REPLICATE_API_BASE_URL` | `https://api.replicate.com/v1` | Replicate API base URL. Must be `https`. |
| `REPLICATE_POLL_INTERVAL_MS` | `5000` | Delay between status polls (clamped to 1000–60000). |
| `REPLICATE_MAX_WAIT_MS` | `600000` | Maximum time to wait for a prediction (clamped to 10000–1800000). On timeout the prediction is cancelled and the job fails with `provider_timeout`. |
| `REPLICATE_REQUEST_TIMEOUT_MS` | `30000` | Timeout for each HTTP request to Replicate (clamped to 1000–120000). |
| `REPLICATE_MAX_CONCURRENT` | `1` | Maximum Replicate predictions running at once (clamped to 1–10). Extra requests get `503 provider_busy`. |
| `REPLICATE_EXTRA_INPUT_JSON` | – | Optional JSON object merged into the model `input` (for example `{"duration":5}`). The request `prompt` always wins over a `prompt` key here. |

With `VIDEO_PROVIDER=replicate` the server refuses to start if the token or
model is missing or malformed. The token is only sent in the `Authorization`
header to `REPLICATE_API_BASE_URL`; it is never logged, stored in job files or
returned in responses.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Returns `200` with `{ status, uptimeSeconds, timestamp, videoProvider, realVideoGeneration }`. By default `videoProvider: "local-simulation"`, `realVideoGeneration: false`. Used as the Render health check. |
| `POST` | `/api/jobs` | Body `{ "prompt": "...", "provider"?: "local-simulation" \| "replicate" }`. `provider` defaults to `VIDEO_PROVIDER`; `replicate` is only accepted when it is the configured provider (`400 provider_not_enabled` otherwise). Fields such as `model`, `version`, `token`, `apiToken`, `apiKey`, `apiBaseUrl`, `baseUrl`, `url`, `webhook` and `input` are rejected with `400 field_not_allowed`. Returns `201 { job }`. |
| `GET` | `/api/jobs` | Lists all stored jobs. |
| `GET` | `/api/jobs/:id` | Returns a single job, advancing its progress. `404` if unknown. |
| `OPTIONS` | any | CORS preflight; returns `204` for allowed origins. |

Every job states explicitly whether its output is real: `provider`,
`simulated` and `realVideoGeneration`. Job `status` is `queued`, `processing`,
`succeeded` or `failed`. A succeeded Replicate job has
`result: { simulated: false, provider: "replicate", videoUrl, providerPredictionId }`;
a failed job has `error: { code, message, detail? }` with codes such as
`provider_prediction_failed`, `provider_prediction_canceled`, `provider_timeout`,
`provider_request_timeout`, `provider_http_error`, `provider_output_missing` or
`provider_interrupted` (the service restarted while the job was running; it is
not retried to avoid paying twice).

Responses always include `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Requests to `/api/*`
beyond the rate limit return `429` with a `Retry-After` header.

The server shuts down cleanly on `SIGTERM` and `SIGINT`, aborting in-flight
Replicate polling and cancelling the running predictions (best effort).

## Enabling Replicate (real video, costs money)

> ⚠️ **Spend safety — read before enabling.**
> - Set a **low spend/usage limit** in your Replicate account billing settings
>   *before* creating a token.
> - Test **one** request first and check the charge in the Replicate dashboard
>   before letting anyone else use the service.
> - **Never expose `REPLICATE_API_TOKEN` to the browser** or a frontend bundle.
>   It must only exist as a server-side environment variable (Render secret).
> - Pricing differs per model and per output length/resolution, and each model
>   defines its own input and output schema. Verify both on the model's page
>   for the exact model you select.
> - `POST /api/jobs` has no user authentication yet: anyone who can reach the
>   API (within the CORS allowlist and the rate limit) can start a paid job.
>   Keep `REPLICATE_MAX_CONCURRENT` low and add authentication before a public
>   launch.

1. Create a Replicate account and set a low spend limit.
2. Pick a **text-to-video** model on Replicate and read its API page. Confirm
   that it accepts a `prompt` input and returns a video URL (a string, a list
   of URLs, or an object with a `video`/`url` field). If it needs extra inputs
   (duration, resolution, …), put them in `REPLICATE_EXTRA_INPUT_JSON`.
3. Run the model once from the Replicate website and note the price.
4. Create an API token in Replicate.
5. In Render → your service → **Environment**, set:
   - `REPLICATE_API_TOKEN` = your token (secret),
   - `REPLICATE_MODEL` = `owner/model` or `owner/model:version`,
   - `VIDEO_PROVIDER` = `replicate`.
6. Save and redeploy. `GET /api/health` should now report
   `videoProvider: "replicate"` and `realVideoGeneration: true`. If the token
   or model is missing, the deploy fails with a `configuration error` log line.
7. Send exactly one `POST /api/jobs` with a short prompt, poll
   `GET /api/jobs/:id` until it is `succeeded` or `failed`, and check the cost
   in Replicate.

To switch back, set `VIDEO_PROVIDER=local-simulation` (or delete it) and
redeploy.

## Deploying to Render

1. Push this repository to GitHub (or another Git provider Render can read).
2. In Render, choose **New → Blueprint** and point it at this repository. Render
   detects `render.yaml` in the repository root.
3. Confirm the settings from the Blueprint:
   - runtime: Node
   - build command: `npm install --omit=dev`
   - start command: `node src/server.js`
   - health check path: `/api/health`
   - plan: free
   - env vars: `ALLOWED_ORIGINS`, `RATE_LIMIT_MAX=30`,
     `RATE_LIMIT_WINDOW_MS=60000`, `DATA_DIR=/opt/render/project/src/data`,
     `VIDEO_PROVIDER=local-simulation` and the non-secret `REPLICATE_*`
     defaults. `REPLICATE_API_TOKEN` and `REPLICATE_MODEL` are declared with
     `sync: false`, so Render asks for them in the dashboard; they can be left
     empty while the provider is `local-simulation`.
4. Deploy and verify `https://<your-service>.onrender.com/api/health` returns
   `200`.

Alternatively create a Web Service manually with the same settings.

### Ephemeral storage on the free plan

Render's free plan has no persistent disk: the container filesystem is reset on
every deploy, restart and after idle spin-down, so all job files under
`DATA_DIR` are lost. To keep jobs, attach a paid persistent disk in Render and
set `DATA_DIR` to its mount path — no code change is required.

## Tests

`test/e2e.test.js` uses `node:test` with the built-in `fetch` client and covers
the health response, allowed and blocked CORS origins, OPTIONS preflight,
security headers, the `429` rate limit path (with a small test-specific limit),
job simulation and persistence, and configuration defaults.

`test/replicate.test.js` covers provider selection, configuration errors
(missing token/model, invalid model, non-https base URL), rejected
user-supplied model/token fields, mocked create + poll success, failed and
canceled predictions, the maximum-wait timeout (with cancellation), per-request
timeouts, HTTP errors, missing output URLs, the concurrency cap, restart
interruption, and that the default local simulation makes no network calls.
Replicate is replaced by an injected fake `fetch`: no token is needed and no
request reaches Replicate. All tests are deterministic and require no external
services.
