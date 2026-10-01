'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fakeServices, productionOptions, accountClient, withServer } = require('./helpers/production.js');
const { createOwlBrowserExecutor, parseProxies, summaryOf } = require('../src/automation/owl-browser.js');
const { createAutomationRunner, isBlockedHost } = require('../src/automation/runner.js');
const { createSimulationExecutor } = require('../src/automation/simulation.js');
const { createMemoryDatabase } = require('../src/db/memory.js');

const OWL_BASE = 'https://owl.test';
const OWL_TOKEN = 'owl-test-token-not-real';
const PROXY_URL = ['socks5://', 'proxy-user:', encodeURIComponent('proxy@pass'), '@eu-proxy.example:1080'].join('');

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Scripted Owl Browser HTTP server (same REST contract as the official SDK).
function fakeOwl({ states = ['running', 'done'], result = { success: true, result: '{"summary":"Нашёл 3 товара"}' }, jobError = null, createStatus = 200 } = {}) {
  const calls = [];
  let poll = 0;
  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers });
    if (!url.startsWith(`${OWL_BASE}/api/`)) throw new Error(`unexpected network call: ${method} ${url}`);
    if (init.headers.Authorization !== ['Bearer', OWL_TOKEN].join(' ')) return new Response('unauthorized', { status: 401 });
    const path = url.slice(`${OWL_BASE}/api`.length);
    if (path === '/execute/browser_create_context') return createStatus === 200 ? json(200, { success: true, result: 'ctx_000001' }) : json(createStatus, {});
    if (path === '/execute/browser_navigate') return json(200, { success: true, result: { url: body.url } });
    if (path === '/execute/browser_nla') return json(202, { job_id: 'job_abc123', state: 'queued', poll: '/jobs/job_abc123' });
    if (path === '/jobs/job_abc123' && method === 'GET') {
      const state = states[Math.min(poll, states.length - 1)];
      poll += 1;
      return json(200, { state, result: state === 'done' ? result : null, error: jobError });
    }
    if (path === '/jobs/job_abc123' && method === 'DELETE') return json(200, { cancelled: true });
    if (path === '/execute/browser_close_context') return json(200, { success: true, result: true });
    return json(404, { success: false, error: 'unknown tool' });
  }
  return { fetchImpl, calls };
}

function withOwl(services, owl) {
  return async (url, init) => (String(url).startsWith(OWL_BASE) ? owl.fetchImpl(url, init) : services.fetchImpl(url, init));
}

async function waitForRun(api, id) {
  for (let i = 0; i < 400; i += 1) {
    const res = await api.get(`/api/automation/runs/${id}`);
    if (res.json && res.json.run && !['queued', 'running'].includes(res.json.run.status)) return res.json.run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not finish');
}

async function createTask(api, changes = {}) {
  const res = await api.post('/api/automation/tasks', {
    name: 'Check catalogue',
    url: 'https://example.com/catalogue',
    instruction: 'Find the three cheapest products.',
    region: 'EU',
    ...changes,
  });
  assert.equal(res.status, 201);
  return res.json.task;
}

test('automation runs execute in simulation mode and record status, log and history per user', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services, { simulationDurationMs: 30 }), async ({ base }) => {
    const alice = accountClient(base);
    const bob = accountClient(base);
    assert.equal((await alice.register('runs-alice@example.com')).status, 201);
    assert.equal((await bob.register('runs-bob@example.com')).status, 201);
    const task = await createTask(alice);

    assert.equal((await accountClient(base).post(`/api/automation/tasks/${task.id}/runs`)).status, 401);
    assert.equal((await bob.post(`/api/automation/tasks/${task.id}/runs`)).status, 404);

    const started = await alice.post(`/api/automation/tasks/${task.id}/runs`);
    assert.equal(started.status, 202);
    assert.equal(started.json.run.status, 'queued');
    assert.equal(started.json.run.executor, 'simulation');
    assert.equal(started.json.run.simulated, true);
    assert.equal(started.json.run.userId, undefined);

    const again = await alice.post(`/api/automation/tasks/${task.id}/runs`);
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'automation_run_active');

    const run = await waitForRun(alice, started.json.run.id);
    assert.equal(run.status, 'succeeded');
    assert.match(run.summary, /Симуляция завершена/);
    assert.ok(run.startedAt && run.completedAt);
    assert.ok(run.log.some((entry) => /сайт не открывается/.test(entry.message)));

    const all = await alice.get('/api/automation/runs');
    assert.deepEqual(all.json.executor, { name: 'simulation', simulated: true });
    assert.deepEqual(all.json.runs.map((item) => item.id), [run.id]);
    assert.deepEqual((await alice.get(`/api/automation/tasks/${task.id}/runs`)).json.runs.map((item) => item.id), [run.id]);
    assert.deepEqual((await bob.get('/api/automation/runs')).json.runs, []);
    assert.equal((await bob.get(`/api/automation/runs/${run.id}`)).status, 404);
    assert.equal((await bob.get(`/api/automation/tasks/${task.id}/runs`)).status, 404);
    assert.equal((await alice.get('/api/automation/runs/not-a-uuid')).status, 404);

    assert.equal((await alice.request('PUT', `/api/automation/tasks/${task.id}`, { enabled: false })).status, 200);
    const paused = await alice.post(`/api/automation/tasks/${task.id}/runs`);
    assert.equal(paused.status, 409);
    assert.equal(paused.json.error, 'automation_task_disabled');

    assert.equal((await alice.del(`/api/automation/tasks/${task.id}`)).status, 200);
    assert.deepEqual((await alice.get('/api/automation/runs')).json.runs, []);

    const health = await fetch(`${base}/api/health`);
    assert.equal((await health.json()).checks.automation, 'simulation');
  });
});

test('automation runs refuse local and private network targets', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services, { simulationDurationMs: 30 }), async ({ base }) => {
    const api = accountClient(base);
    assert.equal((await api.register('runs-blocked@example.com')).status, 201);
    const task = await createTask(api, { url: 'http://169.254.169.254/latest/meta-data/' });
    const started = await api.post(`/api/automation/tasks/${task.id}/runs`);
    assert.equal(started.status, 202);
    const run = await waitForRun(api, started.json.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'blocked_url');
  });

  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]', 'printer.local', 'metadata', 'db.internal']) {
    assert.equal(isBlockedHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', 'sub.example.org', '[2606:4700::1111]', '172.32.0.1']) {
    assert.equal(isBlockedHost(host), false, host);
  }
});

test('automation runs execute through Owl Browser when it is configured', async () => {
  const services = fakeServices();
  const owl = fakeOwl();
  const options = productionOptions(services, {
    fetchImpl: withOwl(services, owl),
    owlBrowser: {
      url: OWL_BASE,
      token: OWL_TOKEN,
      pollIntervalMs: 1,
      proxiesJson: JSON.stringify({ EU: PROXY_URL }),
    },
  });
  await withServer(options, async ({ base }) => {
    const api = accountClient(base);
    assert.equal((await api.register('runs-owl@example.com')).status, 201);
    const task = await createTask(api);
    const started = await api.post(`/api/automation/tasks/${task.id}/runs`);
    assert.equal(started.status, 202);
    assert.equal(started.json.run.executor, 'owl-browser');
    assert.equal(started.json.run.simulated, false);
    const run = await waitForRun(api, started.json.run.id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.summary, 'Нашёл 3 товара');
    assert.equal(run.providerJobId, 'job_abc123');
    assert.ok(run.log.some((entry) => entry.message.includes('Открыт сайт https://example.com/catalogue')));

    const tools = owl.calls.map((call) => `${call.method} ${call.url.slice(OWL_BASE.length)}`);
    assert.deepEqual(tools, [
      'POST /api/execute/browser_create_context',
      'POST /api/execute/browser_navigate',
      'POST /api/execute/browser_nla',
      'GET /api/jobs/job_abc123',
      'GET /api/jobs/job_abc123',
      'POST /api/execute/browser_close_context',
    ]);
    assert.deepEqual(owl.calls[0].body, {
      proxy_type: 'socks5', proxy_host: 'eu-proxy.example', proxy_port: 1080, proxy_username: 'proxy-user', proxy_password: 'proxy@pass',
    });
    assert.deepEqual(owl.calls[1].body, { context_id: 'ctx_000001', url: 'https://example.com/catalogue' });
    assert.deepEqual(owl.calls[2].body, { context_id: 'ctx_000001', command: 'Find the three cheapest products.', async: true });
    const serialized = JSON.stringify(run);
    for (const secret of [OWL_TOKEN, 'proxy@pass', 'eu-proxy.example']) assert.ok(!serialized.includes(secret));

    const health = await (await fetch(`${base}/api/health`)).text();
    assert.equal(JSON.parse(health).checks.automation, 'owl-browser');
    assert.ok(!health.includes(OWL_TOKEN));
  });
});

test('Owl Browser failures are reported on the run and the context is always closed', async () => {
  const db = createMemoryDatabase();
  const userId = crypto.randomUUID();
  const task = { id: crypto.randomUUID(), userId, name: 'Task', url: 'https://example.com/', instruction: 'Check.', region: 'US', enabled: true };
  await db.createAutomationTask(task);

  for (const [owl, code, closesContext] of [
    [fakeOwl({ states: ['running', 'failed'], jobError: 'captcha not solved' }), 'owl_browser_task_failed', true],
    [fakeOwl({ states: ['running'] }), 'owl_browser_timeout', true],
    [fakeOwl({ createStatus: 500 }), 'owl_browser_error', false],
  ]) {
    let clock = 0;
    const executor = createOwlBrowserExecutor({
      url: OWL_BASE, token: OWL_TOKEN, pollIntervalMs: 1, maxWaitMs: 1000, fetchImpl: owl.fetchImpl,
      sleep: async () => { clock += 600; }, now: () => clock,
    });
    const runner = createAutomationRunner({ db, executor, logger: { error() {} } });
    const run = await runner.start(task);
    let stored;
    for (let i = 0; i < 200; i += 1) {
      stored = await db.getAutomationRun(run.id, userId);
      if (stored.status === 'failed' || stored.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(stored.status, 'failed');
    assert.equal(stored.error.code, code);
    if (code === 'owl_browser_task_failed') assert.match(stored.error.message, /captcha not solved/);
    const urls = owl.calls.map((call) => `${call.method} ${call.url.slice(OWL_BASE.length)}`);
    assert.equal(urls.includes('POST /api/execute/browser_close_context'), closesContext);
    if (code === 'owl_browser_timeout') assert.ok(urls.includes('DELETE /api/jobs/job_abc123'));
  }

  const rejected = fakeOwl();
  const badToken = createOwlBrowserExecutor({ url: OWL_BASE, token: 'wrong-token', fetchImpl: rejected.fetchImpl });
  await assert.rejects(badToken.run(task), { code: 'owl_browser_auth_failed' });
});

test('Owl Browser configuration is validated at startup', () => {
  assert.equal(createOwlBrowserExecutor({}), null);
  assert.throws(() => createOwlBrowserExecutor({ url: OWL_BASE }), /must be set together/);
  assert.throws(() => createOwlBrowserExecutor({ url: 'http://owl.example:8080', token: OWL_TOKEN }), /https/);
  assert.ok(createOwlBrowserExecutor({ url: 'http://localhost:8080', token: OWL_TOKEN }));
  assert.ok(createOwlBrowserExecutor({ url: 'http://owl:8080', token: OWL_TOKEN, allowHttp: true }));
  assert.throws(() => createOwlBrowserExecutor({ url: ['https://', 'user:pw', '@owl.example'].join(''), token: OWL_TOKEN }), /credentials/);
  assert.throws(() => createOwlBrowserExecutor({ url: OWL_BASE, token: OWL_TOKEN, apiPrefix: '/api?x=1' }), /API_PREFIX/);
  assert.throws(() => parseProxies('{bad'), /not valid JSON/);
  assert.throws(() => parseProxies({ eu: 'http://proxy.example:1' }), /region codes/);
  assert.throws(() => parseProxies({ EU: 'ftp://proxy.example' }), /http\(s\) or socks/);
  assert.equal(summaryOf({ success: true, result: '"plain answer"' }), 'plain answer');
  assert.equal(summaryOf({ answer: 'ok' }), 'ok');
});

test('runner fails interrupted runs on resume and enforces per-user concurrency', async () => {
  const db = createMemoryDatabase();
  const userId = crypto.randomUUID();
  const tasks = [];
  for (let i = 0; i < 4; i += 1) {
    const task = { id: crypto.randomUUID(), userId, name: `Task ${i}`, url: 'https://example.com/', instruction: 'Check.', region: 'US', enabled: true };
    await db.createAutomationTask(task);
    tasks.push(task);
  }
  await db.createAutomationRun({ id: crypto.randomUUID(), taskId: tasks[0].id, userId, taskName: 'Task 0', url: 'https://example.com/', status: 'running', executor: 'owl-browser' });
  const runner = createAutomationRunner({ db, executor: createSimulationExecutor({ durationMs: 5000 }), maxActivePerUser: 2, logger: { error() {} } });
  assert.equal(await runner.resume(), 1);
  const [interrupted] = await db.listAutomationRuns(userId, { taskId: tasks[0].id });
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error.code, 'interrupted');

  await runner.start(tasks[1]);
  await runner.start(tasks[2]);
  await assert.rejects(runner.start(tasks[3]), { code: 'too_many_active_runs' });
  runner.close();
  await assert.rejects(runner.start(tasks[3]), { code: 'automation_unavailable' });
});
