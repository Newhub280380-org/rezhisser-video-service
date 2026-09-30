'use strict';

// Shared helpers for tests of the private-beta (paid) flow. Every test injects
// a fake fetch, so nothing here can reach a real provider.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../src/server.js');

const FAKE_TOKEN = 'r8_fake_test_token_not_real';
const FAKE_ACCESS_KEY = 'test-only-beta-access-key-0123456789';
const BASE = 'https://api.replicate.test/v1';
const VIDEO_URL = 'https://replicate.delivery/fake/output.mp4';
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BRIEF = Object.freeze({
  product: 'Кофейня «Зерно»',
  offer: 'Второй капучино бесплатно',
  audience: 'Студенты и офисные сотрудники',
  goal: 'conversion',
  platform: 'reels',
  aspect: '9:16',
  duration: 10,
  mood: 'premium',
  voice: 'none',
  cta: 'Заходите сегодня',
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Fake Replicate API: records every call and serves scripted prediction states.
function fakeReplicate({ pollStates = [{ status: 'succeeded', output: VIDEO_URL }], createStatus = 'starting' } = {}) {
  const calls = [];
  let pollIndex = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && url.endsWith('/cancel')) return jsonResponse(200, { id: 'pred123', status: 'canceled' });
    if (init.method === 'POST') return jsonResponse(201, { id: 'pred123', status: createStatus });
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

// Options for a server where paid generation is fully configured (with fakes).
function paidOptions(overrides = {}) {
  const { replicate, ...rest } = overrides;
  return {
    videoProvider: 'replicate',
    paidGenerationEnabled: true,
    betaAccessKey: FAKE_ACCESS_KEY,
    paidDailyBudgetUsd: 5,
    paidDailyJobLimit: 3,
    paidTotalJobLimit: 20,
    replicate: {
      apiToken: FAKE_TOKEN,
      model: 'acme/video-model',
      apiBaseUrl: BASE,
      pollIntervalMs: 1,
      maxWaitMs: 5000,
      requestTimeoutMs: 1000,
      maxConcurrent: 1,
      estimatedCostUsd: '0.5',
      ...replicate,
    },
    ...rest,
  };
}

async function withServer(options, run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-beta-'));
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

let idempotencyCounter = 0;
function newIdempotencyKey() {
  idempotencyCounter += 1;
  return `test_key_${process.pid}_${idempotencyCounter}_abcdef`;
}

// A minimal browser-like client: same-origin Origin header, session cookie
// and CSRF token (Node's fetch sends neither Origin nor cookies by itself).
function client(base, { origin = base, csrf = true } = {}) {
  const state = { cookie: null, csrf: null };
  async function request(method, pathname, body, extraHeaders = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (state.cookie) headers.Cookie = state.cookie;
    if (csrf && state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extraHeaders);
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json };
  }
  return {
    state,
    request,
    get: (p, headers) => request('GET', p, undefined, headers),
    post: (p, body, headers) => request('POST', p, body, headers),
    async login(accessKey = FAKE_ACCESS_KEY) {
      const res = await request('POST', '/api/session', { accessKey });
      const setCookie = res.headers.get('set-cookie');
      if (res.status === 200 && setCookie) {
        state.cookie = setCookie.split(';')[0];
        state.csrf = res.json.csrfToken;
      }
      return res;
    },
    quote(body) {
      return request('POST', '/api/quotes', body);
    },
    async quoteAndRun(body, { idempotencyKey = newIdempotencyKey() } = {}) {
      const quote = await request('POST', '/api/quotes', body);
      if (quote.status !== 201) return { quote, job: null, idempotencyKey };
      const job = await request('POST', '/api/jobs', {
        ...body,
        modelId: quote.json.selection.model.id,
        tier: 'paid',
        quoteId: quote.json.quote.id,
        confirmPaid: true,
        idempotencyKey,
      });
      return { quote, job, idempotencyKey };
    },
    async waitForTerminal(id) {
      for (let i = 0; i < 400; i += 1) {
        const res = await request('GET', `/api/jobs/${id}`);
        const job = res.json && res.json.job;
        if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('job did not finish');
    },
  };
}

module.exports = {
  BASE,
  BRIEF,
  FAKE_ACCESS_KEY,
  FAKE_TOKEN,
  PNG_1PX,
  VIDEO_URL,
  client,
  fakeReplicate,
  jsonResponse,
  newIdempotencyKey,
  paidOptions,
  silentLogger,
  withServer,
};
