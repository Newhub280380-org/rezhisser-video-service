'use strict';

// All Replicate tests use an injected fake fetch. No test needs a real token
// and no test makes a network call to Replicate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, loadConfig } = require('../src/server.js');
const beta = require('./helpers/beta.js');
const {
  createReplicateProvider,
  extractVideoUrl,
  parseModel,
} = require('../src/providers/replicate.js');

const FAKE_TOKEN = 'r8_fake_test_token_not_real';
const BASE = 'https://api.replicate.test/v1';
const VIDEO_URL = 'https://replicate.delivery/fake/output.mp4';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Fake fetch that serves a scripted list of prediction states for polling.
function fakeReplicate({ createStatus = 'starting', pollStates = [], createHttpStatus = 201, createBody } = {}) {
  const calls = [];
  let pollIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && url.endsWith('/cancel')) {
      return jsonResponse(200, { id: 'pred123', status: 'canceled' });
    }
    if (init.method === 'POST') {
      return jsonResponse(createHttpStatus, createBody || { id: 'pred123', status: createStatus });
    }
    const state = pollStates[Math.min(pollIndex, pollStates.length - 1)];
    pollIndex += 1;
    return jsonResponse(200, { id: 'pred123', ...state });
  };
  return { fetchImpl, calls };
}

function silentLogger() {
  const messages = [];
  return { messages, error: (msg) => messages.push(String(msg)), log: (msg) => messages.push(String(msg)) };
}

function providerOptions(overrides = {}) {
  return {
    apiToken: FAKE_TOKEN,
    model: 'acme/video-model',
    apiBaseUrl: BASE,
    pollIntervalMs: 1,
    maxWaitMs: 1000,
    requestTimeoutMs: 1000,
    maxConcurrent: 1,
    sleep: async () => {},
    logger: silentLogger(),
    ...overrides,
  };
}

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-replicate-'));
}

async function withServer(options, run) {
  const dataDir = tempDataDir();
  const app = createApp({
    dataDir,
    allowedOrigins: ['http://localhost:3000'],
    rateLimitMax: 1000,
    rateLimitWindowMs: 60000,
    simulationDurationMs: 3000,
    logger: silentLogger(),
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await run({ base, app, dataDir });
  } finally {
    app.closeProviders();
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function postJob(base, body) {
  return fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('provider configuration defaults to local simulation with bounded Replicate settings', () => {
  const config = loadConfig({});
  assert.equal(config.videoProvider, 'local-simulation');
  assert.equal(config.replicate.apiToken, '');
  assert.equal(config.replicate.apiBaseUrl, 'https://api.replicate.com/v1');
  assert.equal(config.replicate.pollIntervalMs, 5000);
  assert.equal(config.replicate.maxWaitMs, 600000);
  assert.equal(config.replicate.requestTimeoutMs, 30000);
  assert.equal(config.replicate.maxConcurrent, 1);

  const clamped = loadConfig({
    VIDEO_PROVIDER: ' Replicate ',
    REPLICATE_POLL_INTERVAL_MS: '1',
    REPLICATE_MAX_WAIT_MS: '999999999',
    REPLICATE_REQUEST_TIMEOUT_MS: '999999999',
    REPLICATE_MAX_CONCURRENT: '500',
  });
  assert.equal(clamped.videoProvider, 'replicate');
  assert.equal(clamped.replicate.pollIntervalMs, 1000);
  assert.equal(clamped.replicate.maxWaitMs, 1800000);
  assert.equal(clamped.replicate.requestTimeoutMs, 120000);
  assert.equal(clamped.replicate.maxConcurrent, 10);
});

test('unknown VIDEO_PROVIDER fails fast', () => {
  assert.throws(
    () => createApp({ dataDir: tempDataDir(), videoProvider: 'fal-ai' }),
    /Unsupported VIDEO_PROVIDER "fal-ai"/,
  );
});

test('replicate provider requires a token and a valid model, without leaking the token', () => {
  const dataDir = tempDataDir();
  assert.throws(
    () => createApp({ dataDir, videoProvider: 'replicate', replicate: { apiToken: '', model: 'acme/video' } }),
    (error) => error.code === 'provider_misconfigured' && /REPLICATE_API_TOKEN/.test(error.message),
  );
  assert.throws(
    () => createApp({ dataDir, videoProvider: 'replicate', replicate: { apiToken: FAKE_TOKEN, model: '' } }),
    (error) => error.code === 'provider_misconfigured' && /REPLICATE_MODEL/.test(error.message),
  );
  assert.throws(
    () => createReplicateProvider(providerOptions({ model: 'https://evil.example/model' })),
    (error) => error.code === 'provider_misconfigured' && !error.message.includes(FAKE_TOKEN),
  );
  assert.throws(
    () => createReplicateProvider(providerOptions({ apiBaseUrl: 'http://api.replicate.com/v1' })),
    /must use https/,
  );
  assert.throws(
    () => createReplicateProvider(providerOptions({ extraInput: '[1,2]' })),
    /must be a JSON object/,
  );
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('parseModel supports owner/model and owner/model:version', () => {
  assert.deepEqual(parseModel('acme/video'), { owner: 'acme', name: 'video', version: null });
  assert.deepEqual(parseModel('acme/video:abc123'), { owner: 'acme', name: 'video', version: 'abc123' });
});

test('without a provider key the server makes no network calls and does not fake a video', async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    throw new Error('network must not be used');
  };
  await withServer({ fetchImpl, simulationDurationMs: 1 }, async ({ base, app }) => {
    assert.deepEqual(Array.from(app.providers.keys()), ['local-simulation']);

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.videoProvider, 'local-simulation');
    assert.equal(health.realVideoGeneration, false);

    const created = await postJob(base, { prompt: 'coffee ad' });
    assert.equal(created.status, 503);
    const body = await created.json();
    assert.equal(body.error, 'provider_not_configured');
    assert.ok(body.missing.includes('REPLICATE_API_TOKEN'));
    assert.equal(body.job, undefined);

    const rejected = await postJob(base, { prompt: 'coffee ad', provider: 'replicate' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'provider_not_enabled');

    const unknown = await postJob(base, { prompt: 'coffee ad', provider: 'fal-ai' });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error, 'unsupported_provider');
  });
  assert.equal(calls.length, 0);
});

test('POST /api/jobs rejects user-supplied model, token and URL fields', async () => {
  await withServer({}, async ({ base }) => {
    for (const field of ['model', 'token', 'apiToken', 'apiBaseUrl', 'webhook']) {
      const res = await postJob(base, { prompt: 'x', [field]: 'https://evil.example' });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'field_not_allowed', field });
    }
    const arrayBody = await postJob(base, ['prompt']);
    assert.equal(arrayBody.status, 400);
  });
});

test('mocked create + poll succeeds and extracts the video URL', async () => {
  const { fetchImpl, calls } = fakeReplicate({
    pollStates: [{ status: 'processing' }, { status: 'succeeded', output: [VIDEO_URL] }],
  });
  const provider = createReplicateProvider(
    providerOptions({ fetchImpl, extraInput: '{"duration":5,"prompt":"ignored"}' }),
  );
  const result = await provider.generate('a coffee commercial');
  assert.deepEqual(result, { videoUrl: VIDEO_URL, predictionId: 'pred123' });

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${BASE}/models/acme/video-model/predictions`);
  assert.deepEqual(calls[0].body, { input: { duration: 5, prompt: 'a coffee commercial' } });
  assert.equal(calls[0].headers.Authorization, ['Bearer', FAKE_TOKEN].join(' '));
  assert.equal(calls[1].url, `${BASE}/predictions/pred123`);
  assert.equal(calls.length, 3);
});

test('versioned model uses the /predictions endpoint with a version field', async () => {
  const { fetchImpl, calls } = fakeReplicate({ createStatus: 'succeeded', createBody: { id: 'pred123', status: 'succeeded', output: VIDEO_URL } });
  const provider = createReplicateProvider(providerOptions({ fetchImpl, model: 'acme/video-model:abc123' }));
  const result = await provider.generate('prompt');
  assert.equal(result.videoUrl, VIDEO_URL);
  assert.equal(calls[0].url, `${BASE}/predictions`);
  assert.deepEqual(calls[0].body, { version: 'abc123', input: { prompt: 'prompt' } });
});

test('failed prediction surfaces a clear error without cancelling', async () => {
  const { fetchImpl, calls } = fakeReplicate({ pollStates: [{ status: 'failed', error: 'NSFW content detected' }] });
  const provider = createReplicateProvider(providerOptions({ fetchImpl }));
  await assert.rejects(provider.generate('x'), (error) => {
    assert.equal(error.code, 'provider_prediction_failed');
    assert.equal(error.detail, 'NSFW content detected');
    return true;
  });
  assert.ok(!calls.some((call) => call.url.endsWith('/cancel')));
});

test('canceled prediction surfaces a clear error', async () => {
  const { fetchImpl } = fakeReplicate({ pollStates: [{ status: 'canceled' }] });
  const provider = createReplicateProvider(providerOptions({ fetchImpl }));
  await assert.rejects(provider.generate('x'), { code: 'provider_prediction_canceled' });
});

test('polling is bounded by maxWaitMs and the prediction is cancelled on timeout', async () => {
  const { fetchImpl, calls } = fakeReplicate({ pollStates: [{ status: 'processing' }] });
  let clock = 0;
  const provider = createReplicateProvider(
    providerOptions({
      fetchImpl,
      pollIntervalMs: 100,
      maxWaitMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
  );
  await assert.rejects(provider.generate('x'), { code: 'provider_timeout' });
  const polls = calls.filter((call) => call.method === 'GET').length;
  assert.ok(polls <= 11, `expected bounded polling, got ${polls}`);
  assert.equal(calls.at(-1).url, `${BASE}/predictions/pred123/cancel`);
});

test('a hanging HTTP request is aborted by the per-request timeout', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const provider = createReplicateProvider(providerOptions({ fetchImpl, requestTimeoutMs: 20 }));
  await assert.rejects(provider.generate('x'), { code: 'provider_request_timeout' });
});

test('HTTP errors are reported without exposing the token', async () => {
  const { fetchImpl } = fakeReplicate({ createHttpStatus: 401, createBody: { detail: 'Invalid token.' } });
  const logger = silentLogger();
  const provider = createReplicateProvider(providerOptions({ fetchImpl, logger }));
  await assert.rejects(provider.generate('x'), (error) => {
    assert.equal(error.code, 'provider_http_error');
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.detail, 'Invalid token.');
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(FAKE_TOKEN));
    return true;
  });
});

test('succeeded prediction without a usable URL returns a clear error', async () => {
  const { fetchImpl } = fakeReplicate({ pollStates: [{ status: 'succeeded', output: { text: 'no video' } }] });
  const provider = createReplicateProvider(providerOptions({ fetchImpl }));
  await assert.rejects(provider.generate('x'), { code: 'provider_output_missing' });
});

test('extractVideoUrl handles common output shapes and rejects unsafe URLs', () => {
  assert.equal(extractVideoUrl(VIDEO_URL), VIDEO_URL);
  assert.equal(extractVideoUrl([VIDEO_URL, 'https://other/x.mp4']), VIDEO_URL);
  assert.equal(extractVideoUrl({ video: VIDEO_URL }), VIDEO_URL);
  assert.equal(extractVideoUrl({ url: VIDEO_URL }), VIDEO_URL);
  assert.equal(extractVideoUrl([{ url: VIDEO_URL }]), VIDEO_URL);
  assert.equal(extractVideoUrl({ output: [VIDEO_URL] }), VIDEO_URL);
  assert.equal(extractVideoUrl('http://insecure.example/x.mp4'), null);
  assert.equal(extractVideoUrl('javascript:alert(1)'), null);
  assert.equal(extractVideoUrl(null), null);
  assert.equal(extractVideoUrl({ text: 'hello' }), null);
});

test('replicate jobs run end to end through the gated beta flow with a mocked provider', async () => {
  const { fetchImpl, calls } = fakeReplicate({
    pollStates: [{ status: 'processing' }, { status: 'succeeded', output: VIDEO_URL }],
  });
  const logger = silentLogger();
  await beta.withServer(beta.paidOptions({ fetchImpl, logger }), async ({ base, dataDir }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.videoProvider, 'replicate');
    assert.equal(health.realVideoGeneration, true);
    assert.equal(health.paidGenerationEnabled, true);

    // The legacy public prompt API can no longer start a billable prediction.
    const legacy = await postJob(base, { prompt: 'coffee ad', provider: 'replicate' });
    assert.equal(legacy.status, 401);
    assert.equal(calls.length, 0);

    const browser = beta.client(base);
    assert.equal((await browser.login()).status, 200);
    const { quote, job: created } = await browser.quoteAndRun({ brief: beta.BRIEF });
    assert.equal(quote.status, 201);
    assert.equal(quote.json.quote.estimateUsd, 0.5);
    assert.equal(created.status, 201);
    const { job } = created.json;
    assert.equal(job.provider, 'replicate');
    assert.equal(job.simulated, false);
    assert.equal(job.realVideoGeneration, true);
    assert.equal(job.paid, true);

    const finished = await browser.waitForTerminal(job.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result.simulated, false);
    assert.equal(finished.result.videoUrl, VIDEO_URL);
    assert.equal(finished.result.providerPredictionId, 'pred123');

    // Legacy REPLICATE_MODEL profile: official-model endpoint, prompt only.
    const create = calls.find((call) => call.method === 'POST');
    assert.equal(create.url, `${BASE}/models/acme/video-model/predictions`);
    assert.deepEqual(Object.keys(create.body.input), ['prompt']);
    assert.equal(create.body.input.prompt, finished.prompt);

    const local = await postJob(base, { prompt: 'coffee ad', provider: 'local-simulation' });
    assert.equal(local.status, 503);
    assert.equal((await local.json()).error, 'provider_not_configured');

    const stored = fs.readdirSync(dataDir).map((file) => fs.readFileSync(path.join(dataDir, file), 'utf8'));
    assert.ok(stored.every((content) => !content.includes(FAKE_TOKEN)));
  });
  assert.ok(logger.messages.every((message) => !message.includes(FAKE_TOKEN)));
});

test('failed replicate jobs are persisted with an explicit error', async () => {
  const { fetchImpl } = fakeReplicate({ pollStates: [{ status: 'failed', error: 'model crashed' }] });
  await beta.withServer(beta.paidOptions({ fetchImpl }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    const { job } = await browser.quoteAndRun({ brief: beta.BRIEF });
    assert.equal(job.status, 201);
    const finished = await browser.waitForTerminal(job.json.job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error.code, 'provider_prediction_failed');
    assert.equal(finished.result, null);
  });
});

test('concurrent replicate jobs are capped and shutdown aborts in-flight jobs', async () => {
  let predictions = 0;
  const fetchImpl = (url, init) => {
    predictions += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  await beta.withServer(beta.paidOptions({ fetchImpl }), async ({ base, app }) => {
    const browser = beta.client(base);
    await browser.login();
    const first = await browser.quoteAndRun({ brief: beta.BRIEF });
    assert.equal(first.job.status, 201);
    const { job } = first.job.json;

    const second = await browser.quoteAndRun({ brief: { ...beta.BRIEF, product: 'Другой продукт' } });
    assert.equal(second.job.status, 503);
    assert.equal(second.job.json.error, 'provider_busy');
    assert.equal(predictions, 1);

    app.closeProviders();
    const finished = await browser.waitForTerminal(job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error.code, 'provider_aborted');
  });
});

test('replicate jobs left in progress by a restart are marked interrupted, not retried', async () => {
  const { fetchImpl, calls } = fakeReplicate();
  await beta.withServer(beta.paidOptions({ fetchImpl }), async ({ base, dataDir }) => {
    const id = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(
      path.join(dataDir, `${id}.json`),
      JSON.stringify({ id, prompt: 'x', provider: 'replicate', status: 'processing', progress: 0, createdAt: new Date().toISOString() }),
    );
    // Paid jobs are private: anonymous readers get 401.
    assert.equal((await fetch(`${base}/api/jobs/${id}`)).status, 401);
    const browser = beta.client(base);
    await browser.login();
    const { json } = await browser.get(`/api/jobs/${id}`);
    assert.equal(json.job.status, 'failed');
    assert.equal(json.job.error.code, 'provider_interrupted');
  });
  assert.equal(calls.length, 0);
});
