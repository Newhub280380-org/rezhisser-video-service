'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, loadConfig, DEFAULT_ALLOWED_ORIGINS } = require('../src/server.js');

const ALLOWED_ORIGIN = 'https://business-41.pazi.dev';
const BLOCKED_ORIGIN = 'https://evil.example.com';

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-jobs-'));
}

async function withServer(options, run) {
  const dataDir = tempDataDir();
  const app = createApp({
    dataDir,
    allowedOrigins: [ALLOWED_ORIGIN, 'http://localhost:3000'],
    rateLimitMax: 1000,
    rateLimitWindowMs: 60000,
    simulationDurationMs: 3000,
    ...options,
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    await run({ base, app, dataDir });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('GET /api/health returns a truthful 200 JSON response', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.videoProvider, 'local-simulation');
    assert.equal(body.realVideoGeneration, false);
    assert.equal(body.integrations.replicate.configured, false);
    assert.deepEqual(body.integrations.replicate.missing, ['VIDEO_PROVIDER', 'REPLICATE_API_TOKEN']);
    assert.deepEqual(body.integrations.seedance.missing, ['SEEDANCE_API_KEY', 'SEEDANCE_MODEL']);
    assert.equal(JSON.stringify(body).includes('Bearer'), false);
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });
});

test('allowed origin is echoed back in CORS headers', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(res.headers.get('vary'), 'Origin');
  });
});

test('disallowed origin is rejected and never reflected', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: BLOCKED_ORIGIN } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await res.json(), { error: 'origin_not_allowed' });
  });
});

test('OPTIONS preflight from an allowed origin succeeds', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/i);
    assert.equal(res.headers.get('access-control-max-age'), '600');
  });
});

test('OPTIONS preflight from a disallowed origin is rejected', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'OPTIONS',
      headers: { Origin: BLOCKED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('security headers are set on every response', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('rate limit returns 429 once the configured maximum is exceeded', async () => {
  await withServer({ rateLimitMax: 2, rateLimitWindowMs: 60000 }, async ({ base }) => {
    const first = await fetch(`${base}/api/health`);
    const second = await fetch(`${base}/api/health`);
    const third = await fetch(`${base}/api/health`);

    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-ratelimit-limit'), '2');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);

    const body = await third.json();
    assert.equal(body.error, 'rate_limit_exceeded');
  });
});

test('rate limit does not apply to non-/api routes', async () => {
  await withServer({ rateLimitMax: 1 }, async ({ base }) => {
    await fetch(`${base}/api/health`);
    const res = await fetch(`${base}/unknown`);
    assert.equal(res.status, 404);
  });
});

test('POST /api/jobs refuses to invent a video when no provider key is set', async () => {
  await withServer({}, async ({ base, dataDir }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ prompt: 'a cat riding a bicycle' }),
    });

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'provider_not_configured');
    assert.ok(body.missing.includes('REPLICATE_API_TOKEN'));
    assert.ok(body.missing.includes('SEEDANCE_API_KEY'));
    assert.equal(body.job, undefined);
    assert.deepEqual(fs.readdirSync(dataDir).filter((file) => file.endsWith('.json')), []);
  });
});

test('POST /api/jobs rejects a missing prompt', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'prompt_required' });
  });
});

test('an unconfigured render is not stored and cannot be polled into a fake success', async () => {
  await withServer({}, async ({ base }) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'sunset timelapse' }),
    });
    assert.equal(created.status, 503);
    const missing = await fetch(`${base}/api/jobs/00000000-0000-4000-8000-000000000099`);
    assert.equal(missing.status, 404);
  });
});

test('GET /api/jobs lists nothing when generation is not configured', async () => {
  await withServer({}, async ({ base }) => {
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'one' }),
    });
    assert.equal(created.status, 503);

    const list = await fetch(`${base}/api/jobs`);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.jobs.length, 0);

    const missing = await fetch(`${base}/api/jobs/00000000-0000-4000-8000-000000000000`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'job_not_found' });
  });
});

test('job ids containing path traversal are rejected', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/api/jobs/${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(res.status, 404);
  });
});

test('configuration falls back to documented defaults', () => {
  const config = loadConfig({});
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.rateLimitMax, 30);
  assert.equal(config.rateLimitWindowMs, 60000);
  assert.deepEqual(config.allowedOrigins, DEFAULT_ALLOWED_ORIGINS);
  assert.equal(DEFAULT_ALLOWED_ORIGINS[0], ALLOWED_ORIGIN);

  const custom = loadConfig({
    ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    RATE_LIMIT_MAX: '5',
    RATE_LIMIT_WINDOW_MS: '1000',
    DATA_DIR: '/tmp/jobs',
  });
  assert.deepEqual(custom.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.equal(custom.rateLimitMax, 5);
  assert.equal(custom.rateLimitWindowMs, 1000);
  assert.equal(custom.dataDir, '/tmp/jobs');
});
