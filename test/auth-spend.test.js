'use strict';

// Paid generation must stay locked unless the operator configured every
// safeguard, and even then it needs a beta session, CSRF token, same-origin
// request, a fresh server-issued quote, explicit confirmation and an
// idempotency key. Every test counts calls to a fake fetch: a "blocked"
// request must never reach the provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/server.js');
const { createAuth, MIN_KEY_LENGTH } = require('../src/auth.js');
const { createSpendGuard } = require('../src/spend.js');
const beta = require('./helpers/beta.js');

function countingFetch() {
  const fake = beta.fakeReplicate();
  return { ...fake, predictions: () => fake.calls.filter((call) => call.method === 'POST').length };
}

const PAID_BODY = { brief: beta.BRIEF, modelId: 'replicate-default', tier: 'paid' };

test('by default everything is an offline demo and paid generation is locked', async () => {
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    throw new Error('network must not be used');
  };
  await beta.withServer({ fetchImpl }, async ({ base }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.videoProvider, 'local-simulation');
    assert.equal(health.realVideoGeneration, false);
    assert.equal(health.paidGenerationEnabled, false);

    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.paid.available, false);
    const codes = config.paid.reasons.map((reason) => reason.code);
    for (const code of ['provider_not_configured', 'paid_generation_disabled', 'access_control_not_configured', 'spend_limits_not_configured']) {
      assert.ok(codes.includes(code), code);
    }
    assert.equal(config.director.engine, 'rule-based-v1');
    assert.equal(config.director.llmAdvisor, 'none');
    assert.ok(config.models.every((model) => model.paid === false && model.realVideo === false));

    const browser = beta.client(base);
    assert.equal((await browser.login('anything-at-all-long-enough-123')).status, 503);
    assert.equal((await browser.quote({ brief: beta.BRIEF })).status, 403);
    const paid = await browser.post('/api/jobs', { brief: beta.BRIEF, tier: 'paid' });
    assert.equal(paid.status, 422);
    assert.equal(paid.json.error, 'no_models_configured');

    // The shot list is local. Rendering does not invent a video.
    const plan = await browser.post('/api/director/plan', { brief: beta.BRIEF });
    assert.equal(plan.status, 200);
    assert.equal(plan.json.selection.model.paid, false);
    assert.equal(plan.json.selection.estimateUsd, 0);
    const demo = await browser.post('/api/jobs', { brief: beta.BRIEF, modelId: plan.json.selection.model.id });
    assert.equal(demo.status, 503);
    assert.equal(demo.json.error, 'provider_not_configured');
    assert.ok(demo.json.missing.includes('REPLICATE_API_TOKEN'));
    assert.ok(demo.json.missing.includes('SEEDANCE_API_KEY'));
    assert.equal(demo.json.job, undefined);
    assert.deepEqual(config.integrations.replicate.missing, ['VIDEO_PROVIDER', 'REPLICATE_API_TOKEN']);
  });
  assert.equal(networkCalls, 0);
});

test('each missing safeguard keeps paid generation locked', async () => {
  const missing = [
    [{ paidGenerationEnabled: false }, 'paid_generation_disabled'],
    [{ betaAccessKey: '' }, 'access_control_not_configured'],
    [{ paidDailyBudgetUsd: 0 }, 'spend_limits_not_configured'],
    [{ replicate: { estimatedCostUsd: '' } }, 'price_not_configured'],
  ];
  for (const [override, code] of missing) {
    const fake = countingFetch();
    await beta.withServer(beta.paidOptions({ fetchImpl: fake.fetchImpl, ...override }), async ({ base, app }) => {
      const status = app.paidStatus();
      assert.equal(status.available, false, code);
      assert.deepEqual(status.reasons.map((reason) => reason.code), [code]);
      const browser = beta.client(base);
      await browser.login();
      const quote = await browser.quote(PAID_BODY);
      assert.equal(quote.status, 403, code);
      assert.equal(quote.json.error, 'paid_generation_locked');
      const job = await browser.post('/api/jobs', { ...PAID_BODY, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() });
      assert.equal(job.status, 403, code);
    });
    assert.equal(fake.predictions(), 0, code);
  }
});

test('a short or empty access key never enables login', () => {
  assert.throws(() => createApp({ betaAccessKey: 'short-key', logger: beta.silentLogger() }), /at least/);
  assert.equal(MIN_KEY_LENGTH, 24);
  const auth = createAuth({ accessKey: '' });
  assert.equal(auth.configured, false);
  assert.equal(auth.verifyKey(''), false);
  assert.equal(auth.getSession({ headers: { cookie: 'rv_session=abc' } }), null);
});

test('unauthenticated, cross-origin or CSRF-less requests cannot trigger paid predictions', async () => {
  const fake = countingFetch();
  await beta.withServer(beta.paidOptions({ fetchImpl: fake.fetchImpl }), async ({ base }) => {
    // No session at all (e.g. a server-to-server script).
    const anon = beta.client(base);
    assert.equal((await anon.quote(PAID_BODY)).status, 401);
    const anonJob = await anon.post('/api/jobs', { ...PAID_BODY, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(anonJob.status, 401);
    const legacy = await anon.post('/api/jobs', { prompt: 'coffee ad', provider: 'replicate' });
    assert.equal(legacy.status, 401);
    const legacyDefault = await anon.post('/api/jobs', { prompt: 'coffee ad' });
    assert.equal(legacyDefault.status, 401);

    // A valid session, but requests without the CSRF token are refused.
    const browser = beta.client(base);
    assert.equal((await browser.login()).status, 200);
    const quote = await browser.quote(PAID_BODY);
    assert.equal(quote.status, 201);
    const noCsrf = beta.client(base, { csrf: false });
    noCsrf.state.cookie = browser.state.cookie;
    const job = { ...PAID_BODY, quoteId: quote.json.quote.id, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() };
    assert.equal((await noCsrf.post('/api/jobs', job)).status, 403);
    assert.equal((await browser.post('/api/jobs', job, { 'X-CSRF-Token': 'x'.repeat(43) })).status, 403);
    assert.equal((await browser.post('/api/jobs', job, { 'X-CSRF-Token': 'é'.repeat(43) })).status, 403);

    // Missing Origin, or an allowed cross-origin client, can't use the session.
    const noOrigin = beta.client(base, { origin: null });
    Object.assign(noOrigin.state, browser.state);
    assert.equal((await noOrigin.post('/api/jobs', job)).status, 403);
    const pazi = beta.client(base, { origin: 'http://localhost:3000' });
    Object.assign(pazi.state, browser.state);
    const crossJob = await pazi.post('/api/jobs', job);
    assert.equal(crossJob.status, 403);
    assert.equal(crossJob.json.error, 'csrf_failed');
    assert.equal((await pazi.login()).status, 403);
    const evil = beta.client(base, { origin: 'https://evil.example' });
    Object.assign(evil.state, browser.state);
    assert.equal((await evil.post('/api/jobs', job)).status, 403);

    // The allowed cross-origin client still gets a public answer (no credentials),
    // and that answer is a refusal, not a fake video.
    const demo = await pazi.post('/api/jobs', { prompt: 'demo', provider: 'local-simulation' });
    assert.equal(demo.status, 503);
    assert.equal(demo.json.error, 'provider_not_configured');
    assert.equal(demo.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(demo.headers.get('access-control-allow-credentials'), null);
  });
  assert.equal(fake.predictions(), 0);
});

test('login is rate limited, rejects wrong keys and sets a hardened cookie', async () => {
  await beta.withServer(beta.paidOptions({ loginRateLimitMax: 3 }), async ({ base }) => {
    const browser = beta.client(base);
    const wrong = await browser.login('wrong-key-wrong-key-wrong-key');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const ok = await browser.login();
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.ok(!JSON.stringify(ok.json).includes(beta.FAKE_ACCESS_KEY));
    assert.equal((await browser.login()).status, 200);
    const limited = await browser.login();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);

    // Behind an HTTPS proxy (Render) the cookie is marked Secure.
    const https = beta.client(base, { origin: base.replace('http://', 'https://') });
    const secure = await https.request('POST', '/api/session', { accessKey: beta.FAKE_ACCESS_KEY }, { 'X-Forwarded-Proto': 'https' });
    assert.ok(secure.status === 200 || secure.status === 429);
  });
  await beta.withServer(beta.paidOptions(), async ({ base }) => {
    const https = beta.client(base, { origin: base.replace('http://', 'https://') });
    const secure = await https.request('POST', '/api/session', { accessKey: beta.FAKE_ACCESS_KEY }, { 'X-Forwarded-Proto': 'https' });
    assert.equal(secure.status, 200);
    assert.match(secure.headers.get('set-cookie'), /; Secure/);
  });
});

test('config and session responses never expose secrets', async () => {
  await beta.withServer(beta.paidOptions(), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    for (const pathname of ['/api/config', '/api/session', '/api/health']) {
      const text = JSON.stringify((await browser.get(pathname)).json);
      assert.ok(!text.includes(beta.FAKE_ACCESS_KEY), pathname);
      assert.ok(!text.includes(beta.FAKE_TOKEN), pathname);
    }
  });
});

test('paid jobs need confirmation, a valid unused matching quote and an idempotency key', async () => {
  const fake = countingFetch();
  await beta.withServer(beta.paidOptions({ fetchImpl: fake.fetchImpl }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    const quote = (await browser.quote(PAID_BODY)).json.quote;
    assert.equal(quote.estimateUsd, 0.5);
    assert.equal(quote.currency, 'USD');
    assert.ok(quote.warnings.some((line) => /НЕ вернуть/.test(line)));
    const base_ = { ...PAID_BODY, quoteId: quote.id, confirmPaid: true };

    const noKey = await browser.post('/api/jobs', base_);
    assert.equal(noKey.json.error, 'idempotency_key_required');
    const noConfirm = await browser.post('/api/jobs', { ...base_, confirmPaid: 'yes', idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(noConfirm.json.error, 'confirmation_required');
    const bogus = await browser.post('/api/jobs', { ...base_, quoteId: 'nope', idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(bogus.json.error, 'quote_invalid');
    const changed = await browser.post('/api/jobs', {
      ...base_,
      brief: { ...beta.BRIEF, product: 'Совсем другой продукт' },
      idempotencyKey: beta.newIdempotencyKey(),
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error, 'quote_mismatch');
    const forgedPrice = await browser.post('/api/jobs', { ...base_, estimateUsd: 0.0001, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(forgedPrice.json.error, 'field_not_allowed');

    // A quote belongs to the session that requested it.
    const other = beta.client(base);
    await other.login();
    const stolen = await other.post('/api/jobs', { ...base_, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(stolen.json.error, 'quote_invalid');
    assert.equal(fake.predictions(), 0);

    const key = beta.newIdempotencyKey();
    const first = await browser.post('/api/jobs', { ...base_, idempotencyKey: key });
    assert.equal(first.status, 201);
    // Retrying with the same key (double click, network retry) returns the
    // same job and does not start a second prediction.
    const replay = await browser.post('/api/jobs', { ...base_, idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.idempotentReplay, true);
    assert.equal(replay.json.job.id, first.json.job.id);
    // The quote is single-use.
    const reuse = await browser.post('/api/jobs', { ...base_, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.json.error, 'quote_already_used');
    await browser.waitForTerminal(first.json.job.id);
  });
  assert.equal(fake.predictions(), 1);
});

test('expired quotes are refused', async () => {
  const fake = countingFetch();
  await beta.withServer(beta.paidOptions({ fetchImpl: fake.fetchImpl, quoteTtlMs: 1 }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    const quote = (await browser.quote(PAID_BODY)).json.quote;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await browser.post('/api/jobs', { ...PAID_BODY, quoteId: quote.id, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'quote_expired');
  });
  assert.equal(fake.predictions(), 0);
});

test('daily budget and job caps are enforced before the provider is called', async () => {
  const fake = countingFetch();
  await beta.withServer(beta.paidOptions({ fetchImpl: fake.fetchImpl, paidDailyBudgetUsd: 1 }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    for (const product of ['Один', 'Два']) {
      const { job } = await browser.quoteAndRun({ ...PAID_BODY, brief: { ...beta.BRIEF, product } });
      assert.equal(job.status, 201);
      await browser.waitForTerminal(job.json.job.id);
    }
    const over = await browser.quote({ ...PAID_BODY, brief: { ...beta.BRIEF, product: 'Три' } });
    assert.equal(over.status, 403);
    assert.equal(over.json.error, 'daily_budget_exceeded');
    assert.equal(over.json.spend.spentTodayUsd, 1);
  });
  assert.equal(fake.predictions(), 2);

  const fake2 = countingFetch();
  await beta.withServer(beta.paidOptions({ fetchImpl: fake2.fetchImpl, paidDailyJobLimit: 1 }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    // Two quotes issued while under the limit; only one may start a job.
    const a = await browser.quote({ ...PAID_BODY, brief: { ...beta.BRIEF, product: 'A' } });
    const b = await browser.quote({ ...PAID_BODY, brief: { ...beta.BRIEF, product: 'B' } });
    const runA = await browser.post('/api/jobs', { ...PAID_BODY, brief: { ...beta.BRIEF, product: 'A' }, quoteId: a.json.quote.id, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(runA.status, 201);
    await browser.waitForTerminal(runA.json.job.id);
    const runB = await browser.post('/api/jobs', { ...PAID_BODY, brief: { ...beta.BRIEF, product: 'B' }, quoteId: b.json.quote.id, confirmPaid: true, idempotencyKey: beta.newIdempotencyKey() });
    assert.equal(runB.status, 403);
    assert.equal(runB.json.error, 'daily_job_limit_reached');
  });
  assert.equal(fake2.predictions(), 1);
});

test('the spend ledger survives a restart on the same disk and resets daily counters only', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-spend-'));
  try {
    let time = Date.parse('2026-01-01T10:00:00Z');
    const opts = { dataDir, dailyBudgetUsd: 1, dailyJobLimit: 5, totalJobLimit: 2, now: () => time, logger: beta.silentLogger() };
    const guard = createSpendGuard(opts);
    assert.equal(guard.check(0.6), null);
    const quote = guard.issueQuote({ sessionId: 's', profileId: 'p', briefHash: 'h', estimateUsd: 0.6, clipDuration: 5 });
    guard.reserve({ quote, idempotencyKey: 'key_aaaaaaaaaaaaaaaa', jobId: 'job1' });
    assert.equal(guard.check(0.6).code, 'daily_budget_exceeded');

    const restarted = createSpendGuard(opts);
    assert.equal(restarted.findIdempotent('key_aaaaaaaaaaaaaaaa'), 'job1');
    assert.equal(restarted.check(0.6).code, 'daily_budget_exceeded');
    assert.equal(restarted.getQuote(quote.id), null, 'quotes are memory-only');

    time += 24 * 60 * 60 * 1000;
    assert.equal(restarted.check(0.6), null);
    const q2 = restarted.issueQuote({ sessionId: 's', profileId: 'p', briefHash: 'h', estimateUsd: 0.6, clipDuration: 5 });
    restarted.reserve({ quote: q2, idempotencyKey: 'key_bbbbbbbbbbbbbbbb', jobId: 'job2' });
    time += 24 * 60 * 60 * 1000;
    assert.equal(restarted.check(0.1).code, 'total_job_limit_reached');

    assert.equal(createSpendGuard({ ...opts, dailyBudgetUsd: 0 }).check(0.1).code, 'spend_limits_not_configured');
    assert.equal(guard.isValidIdempotencyKey('short'), false);
    assert.equal(guard.isValidIdempotencyKey('../../etc/passwd_aaaa'), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('paid jobs and briefs are hidden from anonymous job listings', async () => {
  await beta.withServer(beta.paidOptions({ fetchImpl: beta.fakeReplicate().fetchImpl }), async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();
    const { job } = await browser.quoteAndRun(PAID_BODY);
    await browser.waitForTerminal(job.json.job.id);
    const refused = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'demo', provider: 'local-simulation' }),
    });
    assert.equal(refused.status, 503);

    const anon = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(anon.jobs.length, 0);
    assert.equal((await fetch(`${base}/api/jobs/${job.json.job.id}`)).status, 401);

    const mine = (await browser.get('/api/jobs')).json;
    assert.equal(mine.jobs.length, 1);
    assert.ok(mine.jobs.every((item) => item.brief === undefined && item.plan === undefined));

    // Logout needs CSRF too, and ends the session.
    const noCsrf = beta.client(base, { csrf: false });
    noCsrf.state.cookie = browser.state.cookie;
    assert.equal((await noCsrf.request('DELETE', '/api/session')).status, 403);
    assert.equal((await browser.request('DELETE', '/api/session')).status, 200);
    assert.equal((await browser.quote(PAID_BODY)).status, 401);
  });
});

test('PUBLIC_ORIGIN is validated and pins the same-origin check', async () => {
  for (const bad of ['not a url', 'https://x.example/path', 'ftp://x.example', 'https://x.example?a=1']) {
    assert.throws(() => createApp({ publicOrigin: bad, logger: beta.silentLogger() }), /PUBLIC_ORIGIN/, bad);
  }
  await beta.withServer(beta.paidOptions({ publicOrigin: 'https://rezhisser.example///' }), async ({ base, app }) => {
    assert.equal(app.config.publicOrigin, 'https://rezhisser.example');
    // The real Host no longer counts as "same origin" once PUBLIC_ORIGIN is set.
    assert.equal((await beta.client(base).login()).status, 403);
    const pinned = beta.client(base, { origin: 'https://rezhisser.example' });
    const res = await pinned.login();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /; Secure/);
  });
});
