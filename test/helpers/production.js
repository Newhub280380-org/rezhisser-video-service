'use strict';

// Helpers for the production stack (accounts, billing, Seedance, S3). All
// third-party APIs are served by one scripted fake fetch: nothing here can
// reach the real network.

const beta = require('./beta.js');

const JWT_SECRET = 'test-only-jwt-secret-0123456789abcdefghijkl';
const YOOKASSA_BASE = 'https://yookassa.test/v3';
const STRIPE_BASE = 'https://stripe.test/v1';
const SEEDANCE_BASE = 'https://ark.test/api/v3';
const S3_ENDPOINT = 'https://s3.test';
const VIDEO_URL = 'https://cdn.seedance.test/out/video.mp4';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_only_secret';

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Scriptable fake for every external service.
function fakeServices({ seedanceStates = [{ status: 'succeeded', content: { video_url: VIDEO_URL } }] } = {}) {
  const calls = [];
  const yookassaPayments = new Map();
  const yookassaRefunds = new Map();
  const objects = new Map();
  let seedancePoll = 0;
  let seedanceTask = 0;
  const control = { seedanceSubmitStatus: 201, s3Status: 200, yookassaCreateStatus: 200 };

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? init.body : init.body ? Buffer.from(init.body) : undefined;
    calls.push({ url, method, headers: init.headers || {}, body });

    if (url.startsWith(YOOKASSA_BASE)) {
      const path = url.slice(YOOKASSA_BASE.length);
      if (method === 'POST' && path === '/payments') {
        if (control.yookassaCreateStatus !== 200) return json(control.yookassaCreateStatus, { type: 'error' });
        const data = JSON.parse(body);
        const id = `yk-${String(yookassaPayments.size + 1).padStart(8, '0')}`;
        const payment = { id, status: 'pending', paid: false, amount: data.amount, metadata: data.metadata };
        yookassaPayments.set(id, payment);
        return json(200, { ...payment, confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.test/checkout?orderId=${id}` } });
      }
      let match = path.match(/^\/payments\/(.+)$/);
      if (method === 'GET' && match) {
        const payment = yookassaPayments.get(decodeURIComponent(match[1]));
        return payment ? json(200, payment) : json(404, { type: 'error' });
      }
      match = path.match(/^\/refunds\/(.+)$/);
      if (method === 'GET' && match) {
        const refund = yookassaRefunds.get(decodeURIComponent(match[1]));
        return refund ? json(200, refund) : json(404, { type: 'error' });
      }
    }

    if (url.startsWith(STRIPE_BASE)) {
      if (method === 'POST' && url === `${STRIPE_BASE}/checkout/sessions`) {
        return json(200, { id: `cs_test_${calls.length}`, url: `https://checkout.stripe.test/c/pay/cs_test_${calls.length}` });
      }
    }

    if (url.startsWith(SEEDANCE_BASE)) {
      if (method === 'POST') {
        if (control.seedanceSubmitStatus !== 201) return json(control.seedanceSubmitStatus, { error: { code: 'QuotaExceeded' } });
        seedanceTask += 1;
        return json(200, { id: `cgt-test-${seedanceTask}` });
      }
      if (method === 'DELETE') return json(200, {});
      const state = seedanceStates[Math.min(seedancePoll, seedanceStates.length - 1)];
      seedancePoll += 1;
      return json(200, { id: 'cgt-test', model: 'seedance-test', ...state });
    }

    if (url === VIDEO_URL) {
      return new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '14' } });
    }

    if (url.startsWith(S3_ENDPOINT)) {
      const key = new URL(url).pathname;
      if (control.s3Status !== 200) return new Response('', { status: control.s3Status });
      if (method === 'PUT') objects.set(key, body);
      if (method === 'DELETE') objects.delete(key);
      return new Response('', { status: method === 'DELETE' ? 204 : 200 });
    }

    if (url.startsWith('https://api.resend.com')) return json(200, { id: 'email_1' });

    throw new Error(`unexpected network call: ${method} ${url}`);
  }

  return {
    fetchImpl,
    calls,
    objects,
    control,
    yookassa: {
      payments: yookassaPayments,
      succeed(id) {
        Object.assign(yookassaPayments.get(id), { status: 'succeeded', paid: true });
      },
      cancel(id) {
        Object.assign(yookassaPayments.get(id), { status: 'canceled' });
      },
      refund(refundId, paymentId, value) {
        const payment = yookassaPayments.get(paymentId);
        yookassaRefunds.set(refundId, { id: refundId, status: 'succeeded', payment_id: paymentId, amount: { value: value || payment.amount.value, currency: payment.amount.currency } });
      },
    },
  };
}

function productionOptions(services, overrides = {}) {
  const { seedance, s3, yookassa, stripe, mail, ...rest } = overrides;
  return {
    jwtSecret: JWT_SECRET,
    fetchImpl: services.fetchImpl,
    seedance: {
      apiKey: 'ark-test-key-not-real',
      model: 'seedance-2-5-test',
      apiBaseUrl: SEEDANCE_BASE,
      pollIntervalMs: 1,
      maxWaitMs: 5000,
      requestTimeoutMs: 1000,
      maxConcurrent: 4,
      ...seedance,
    },
    s3: {
      endpoint: S3_ENDPOINT,
      region: 'us-west-004',
      bucket: 'rezhisser-videos',
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: true,
      ...s3,
    },
    yookassa: { shopId: '123456', secretKey: 'test_yookassa_secret', apiBaseUrl: YOOKASSA_BASE, currencies: ['RUB', 'KZT'], ...yookassa },
    stripe: { secretKey: 'stripe_test_secret_key', webhookSecret: STRIPE_WEBHOOK_SECRET, apiBaseUrl: STRIPE_BASE, currencies: ['USD', 'CNY', 'KZT', 'RUB'], ...stripe },
    mail: { resendApiKey: '', from: '', ...mail },
    loginRateLimitMax: 100,
    ...rest,
  };
}

// HTTP client for the account API (bearer token, no cookies).
function accountClient(base) {
  const state = { token: null };
  async function request(method, pathname, body, headers = {}) {
    const all = { ...headers };
    if (state.token) all.Authorization = ['Bearer', state.token].join(' ');
    if (body !== undefined) all['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${pathname}`, { method, headers: all, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, headers: res.headers, json: data };
  }
  return {
    state,
    request,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b, h),
    del: (p) => request('DELETE', p),
    async register(email = `user${Math.random().toString(16).slice(2)}@example.com`, password = 'correct horse battery') {
      const res = await request('POST', '/api/auth/register', { email, password });
      if (res.status === 201) state.token = res.json.token;
      return res;
    },
    async waitForJob(id) {
      for (let i = 0; i < 400; i += 1) {
        const res = await request('GET', `/api/jobs/${id}`);
        const job = res.json && res.json.job;
        if (job && !['queued', 'processing'].includes(job.status)) return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('job did not finish');
    },
  };
}

module.exports = {
  ...beta,
  JWT_SECRET,
  YOOKASSA_BASE,
  STRIPE_BASE,
  SEEDANCE_BASE,
  S3_ENDPOINT,
  VIDEO_URL: VIDEO_URL,
  STRIPE_WEBHOOK_SECRET,
  fakeServices,
  productionOptions,
  accountClient,
};
