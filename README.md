# rezhisser-video-service

Minimal Node.js HTTP service built only on Node's built-in modules (no production
dependencies). It provides a health endpoint, a CORS allowlist, basic security
headers, a per-IP rate limit and a **local simulation** of a video generation job
API.

> **Honest limitation:** this service does **not** generate video. There is no
> integration with any external video provider. The job API simulates progress
> and always returns `videoUrl: null` with `simulated: true`.

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

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Returns `200` with `{ status, uptimeSeconds, timestamp, videoProvider: "local-simulation", realVideoGeneration: false }`. Used as the Render health check. |
| `POST` | `/api/jobs` | Body `{ "prompt": "..." }`. Creates a simulated job and returns `201 { job }`. |
| `GET` | `/api/jobs` | Lists all stored jobs. |
| `GET` | `/api/jobs/:id` | Returns a single job, advancing its simulated progress. `404` if unknown. |
| `OPTIONS` | any | CORS preflight; returns `204` for allowed origins. |

Responses always include `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Requests to `/api/*`
beyond the rate limit return `429` with a `Retry-After` header.

The server shuts down cleanly on `SIGTERM` and `SIGINT`.

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
     `RATE_LIMIT_WINDOW_MS=60000`, `DATA_DIR=/opt/render/project/src/data`
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
job simulation and persistence, and configuration defaults. All tests are
deterministic and require no external services.
