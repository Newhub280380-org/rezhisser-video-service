'use strict';

// Standalone Owl Browser desktop client (owl-client/): API client against a
// fake Owl API, settings storage and the hardened window. No network and no
// Electron needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOwlClient,
  normalizeApiBase,
  validateStartUrl,
  summaryOf,
  DEFAULT_OWL_URL,
} = require('../owl-client/owl-api.js');
const { loadSettings, saveSettings, publicSettings } = require('../owl-client/settings.js');

const CLIENT_DIR = path.join(__dirname, '..', 'owl-client');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owl-client-'));
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

// Fake Owl Browser: records calls, job finishes after `pollsUntilDone` polls.
function fakeOwl({ pollsUntilDone = 1, finalState = 'done', result = { success: true, result: '{"answer":"10 videos found"}' }, status = null } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body, redirect: init.redirect });
    if (status) return response(status, { error: 'nope' });
    const { pathname } = new URL(url);
    if (pathname.endsWith('/execute/browser_create_context')) return response(200, { success: true, result: 'ctx_1' });
    if (pathname.endsWith('/execute/browser_navigate')) return response(200, { success: true, result: true });
    if (pathname.endsWith('/execute/browser_nla')) return response(202, { job_id: 'job_1' });
    if (pathname.endsWith('/execute/browser_close_context')) return response(200, { success: true, result: true });
    if (pathname.endsWith('/jobs/job_1') && init.method === 'GET') {
      polls += 1;
      if (polls < pollsUntilDone) return response(200, { state: 'running' });
      return response(200, { state: finalState, result, error: finalState === 'failed' ? 'captcha' : undefined });
    }
    if (pathname.endsWith('/jobs/job_1') && init.method === 'DELETE') return response(200, { success: true });
    return response(404, { error: 'not found' });
  };
  return { calls, fetchImpl };
}

test('owl client: API base from the trial URL, with or without /api', () => {
  assert.equal(DEFAULT_OWL_URL, 'https://trial-04421511.owlbrowser.net');
  assert.equal(normalizeApiBase('https://trial-04421511.owlbrowser.net'), 'https://trial-04421511.owlbrowser.net/api');
  assert.equal(normalizeApiBase(' https://trial-04421511.owlbrowser.net/ '), 'https://trial-04421511.owlbrowser.net/api');
  assert.equal(normalizeApiBase('https://trial-04421511.owlbrowser.net/api/'), 'https://trial-04421511.owlbrowser.net/api');
  assert.equal(normalizeApiBase('http://localhost:8080'), 'http://localhost:8080/api');
  assert.throws(() => normalizeApiBase('http://trial-04421511.owlbrowser.net'), /https/);
  assert.throws(() => normalizeApiBase('file:///etc/passwd'), /https/);
  assert.throws(() => normalizeApiBase(['https://', 'u:', 'p@', 'owl.example'].join('')), /логин/);
  assert.throws(() => normalizeApiBase('https://owl.example/?x=1'), /параметры/);
  assert.throws(() => normalizeApiBase('not a url'), /URL/);
  assert.equal(validateStartUrl(''), null);
  assert.equal(validateStartUrl('https://www.youtube.com'), 'https://www.youtube.com/');
  assert.throws(() => validateStartUrl('javascript:alert(1)'), /http/);
});

test('owl client: runs a task (context → navigate → NLA job → poll → close) with the bearer token', async () => {
  const owl = fakeOwl({ pollsUntilDone: 2 });
  const lines = [];
  const client = createOwlClient({
    url: 'https://trial-04421511.owlbrowser.net/api/',
    token: 'tok_123',
    fetchImpl: owl.fetchImpl,
    sleep: async () => {},
  });
  const result = await client.runTask(
    { task: '  Найди топ-10 видео про AI  ', startUrl: 'https://www.youtube.com' },
    { log: (line) => lines.push(line) },
  );
  assert.deepEqual(result, { summary: '10 videos found' });
  assert.deepEqual(owl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'POST /api/execute/browser_create_context',
    'POST /api/execute/browser_navigate',
    'POST /api/execute/browser_nla',
    'GET /api/jobs/job_1',
    'GET /api/jobs/job_1',
    'POST /api/execute/browser_close_context',
  ]);
  for (const call of owl.calls) {
    assert.equal(new URL(call.url).origin, 'https://trial-04421511.owlbrowser.net');
    assert.equal(call.headers.Authorization, ['Bearer', 'tok_123'].join(' '));
    assert.equal(call.redirect, 'error');
  }
  assert.deepEqual(owl.calls[1].body, { context_id: 'ctx_1', url: 'https://www.youtube.com/' });
  assert.deepEqual(owl.calls[2].body, { context_id: 'ctx_1', command: 'Найди топ-10 видео про AI', async: true });
  assert.ok(lines.some((line) => line.includes('running')));
  assert.ok(!lines.join('\n').includes('tok_123'));
});

test('owl client: no start URL skips navigation; no token sends no Authorization', async () => {
  const owl = fakeOwl();
  const client = createOwlClient({ fetchImpl: owl.fetchImpl, sleep: async () => {} });
  await client.runTask({ task: 'task' });
  assert.ok(!owl.calls.some((c) => c.url.endsWith('/browser_navigate')));
  assert.ok(owl.calls.every((c) => !('Authorization' in c.headers)));
});

test('owl client: errors are readable and the context is always closed', async () => {
  await assert.rejects(createOwlClient({ fetchImpl: fakeOwl().fetchImpl }).runTask({ task: '   ' }), /Опишите задачу/);

  const denied = fakeOwl({ status: 401 });
  await assert.rejects(createOwlClient({ token: 'bad', fetchImpl: denied.fetchImpl }).runTask({ task: 'x' }), (error) => {
    assert.equal(error.code, 'auth_failed');
    assert.ok(!error.message.includes('bad'));
    return true;
  });

  const failed = fakeOwl({ finalState: 'failed' });
  await assert.rejects(
    createOwlClient({ fetchImpl: failed.fetchImpl, sleep: async () => {} }).runTask({ task: 'x' }),
    /failed: captcha/,
  );
  assert.ok(failed.calls.at(-1).url.endsWith('/execute/browser_close_context'));

  const down = createOwlClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.runTask({ task: 'x' }), (error) => error.code === 'unreachable');
});

test('owl client: Stop cancels the running job on the server and closes the context', async () => {
  const owl = fakeOwl({ pollsUntilDone: 1000 });
  const controller = new AbortController();
  let polls = 0;
  const client = createOwlClient({
    fetchImpl: owl.fetchImpl,
    sleep: async () => {
      polls += 1;
      if (polls === 2) controller.abort();
      if (controller.signal.aborted) throw Object.assign(new Error('Задача остановлена.'), { code: 'cancelled' });
    },
  });
  await assert.rejects(client.runTask({ task: 'x' }, { signal: controller.signal }), (error) => error.code === 'cancelled');
  const tail = owl.calls.slice(-2).map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(tail, ['DELETE /api/jobs/job_1', 'POST /api/execute/browser_close_context']);
});

test('owl client: timeout when the job never finishes', async () => {
  let time = 0;
  const client = createOwlClient({
    fetchImpl: fakeOwl({ pollsUntilDone: 1000 }).fetchImpl,
    maxWaitMs: 5000,
    pollIntervalMs: 2000,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  await assert.rejects(client.runTask({ task: 'x' }), (error) => error.code === 'timeout');
});

test('owl client: result summaries', () => {
  assert.equal(summaryOf({ success: true, result: '"plain text"' }), 'plain text');
  assert.equal(summaryOf({ summary: 'done' }), 'done');
  assert.equal(summaryOf(null), 'Owl Browser завершил задачу без текстового ответа.');
  assert.equal(summaryOf([1, 2]), JSON.stringify([1, 2], null, 2));
});

test('owl client settings: defaults, encrypted token, env overrides', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const encrypt = (text) => Buffer.from(`enc:${text}`);
  const decrypt = (buffer) => buffer.toString().replace(/^enc:/, '');

  assert.deepEqual(loadSettings(file, { decrypt }), { url: DEFAULT_OWL_URL, token: '' });

  const saved = saveSettings(file, { url: 'https://trial-04421511.owlbrowser.net/api/', token: ' tok_abc ' }, { encrypt });
  assert.deepEqual(saved, { url: 'https://trial-04421511.owlbrowser.net/api/', token: 'tok_abc', persisted: true });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('tok_abc'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadSettings(file, { decrypt }), { url: 'https://trial-04421511.owlbrowser.net/api/', token: 'tok_abc' });
  assert.deepEqual(publicSettings(saved), {
    url: 'https://trial-04421511.owlbrowser.net/api/',
    apiBase: 'https://trial-04421511.owlbrowser.net/api',
    hasToken: true,
  });

  // Without encryption the token is never written to disk.
  const plain = saveSettings(file, { url: '', token: 'tok_plain' }, { encrypt: null });
  assert.deepEqual(plain, { url: DEFAULT_OWL_URL, token: 'tok_plain', persisted: false });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('tok_plain'));
  assert.equal(loadSettings(file, { decrypt }).token, '');

  assert.throws(() => saveSettings(file, { url: 'http://owl.example', token: '' }), /https/);
  assert.throws(() => saveSettings(file, { url: DEFAULT_OWL_URL, token: 'a b' }), /недопустимые/);

  assert.deepEqual(
    loadSettings(file, { decrypt, env: { OWL_BROWSER_URL: 'https://owl.example', OWL_BROWSER_TOKEN: 'env_tok' } }),
    { url: 'https://owl.example', token: 'env_tok' },
  );

  fs.writeFileSync(file, '{broken');
  assert.deepEqual(loadSettings(file, { decrypt }), { url: DEFAULT_OWL_URL, token: '' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('owl client package: standalone Electron app, hardened window, safe page', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'main.js');
  assert.ok(pkg.devDependencies.electron);
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!('electron' in (rootPkg.dependencies || {})) && !('electron' in (rootPkg.devDependencies || {})));
  assert.ok(!JSON.stringify(pkg.build).includes('../src'), 'the client must not bundle the backend');

  const main = fs.readFileSync(path.join(CLIENT_DIR, 'main.js'), 'utf8');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /will-navigate/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.ok(!/require\(['"]\.\.\//.test(main), 'the client must not require backend code');

  const html = fs.readFileSync(path.join(CLIENT_DIR, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  for (const id of ['task', 'start-url', 'run', 'stop', 'log', 'url', 'token', 'clear-token', 'settings-form', 'task-form']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const renderer = fs.readFileSync(path.join(CLIENT_DIR, 'renderer', 'renderer.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(renderer));
  for (const match of renderer.matchAll(/\$\('([a-z-]+)'\)/g)) assert.match(html, new RegExp(`id="${match[1]}"`));
});

test('owl client: Stop interrupts the real poll delay immediately', async () => {
  const owl = fakeOwl({ pollsUntilDone: 1000 });
  const controller = new AbortController();
  const client = createOwlClient({ fetchImpl: owl.fetchImpl, pollIntervalMs: 60000 });
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(client.runTask({ task: 'x' }, { signal: controller.signal }), (error) => error.code === 'cancelled');
  assert.ok(Date.now() - started < 5000);
  assert.ok(owl.calls.some((c) => c.method === 'DELETE'));
});
