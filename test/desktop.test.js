'use strict';

// Desktop (Electron) app wiring: configuration, navigation rules and the
// bundled local server. Electron itself is not required to run these tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/server.js');
const { accountClient } = require('./helpers/production.js');
const {
  resolveDesktopConfig,
  classifyNavigation,
  loadOrCreateSecret,
  startLocalServer,
  DEFAULT_START_PATH,
} = require('../desktop/config.js');

const DESKTOP_DIR = path.join(__dirname, '..', 'desktop');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-desktop-'));
}

function noNetwork(url) {
  throw new Error(`unexpected network call: ${url}`);
}

test('desktop config: cloud mode from REZHISSER_URL, local mode otherwise', () => {
  assert.deepEqual(resolveDesktopConfig({}), { mode: 'local', origin: null, startPath: DEFAULT_START_PATH });
  assert.equal(DEFAULT_START_PATH, '/automation');
  assert.deepEqual(resolveDesktopConfig({ REZHISSER_URL: ' https://rezhisser.example/some/path ' }), {
    mode: 'cloud',
    origin: 'https://rezhisser.example',
    startPath: '/automation',
  });
  assert.equal(resolveDesktopConfig({ REZHISSER_URL: 'http://localhost:3000', REZHISSER_START_PATH: '/studio' }).origin, 'http://localhost:3000');
  assert.equal(resolveDesktopConfig({ REZHISSER_URL: 'http://127.0.0.1:3000' }).origin, 'http://127.0.0.1:3000');
  assert.equal(resolveDesktopConfig({ REZHISSER_START_PATH: '/' }).startPath, '/');
  assert.throws(() => resolveDesktopConfig({ REZHISSER_URL: 'http://rezhisser.example' }), /https/);
  assert.throws(() => resolveDesktopConfig({ REZHISSER_URL: 'file:///etc/passwd' }), /https/);
  assert.throws(() => resolveDesktopConfig({ REZHISSER_URL: ['https://', 'user:', 'pw@', 'rezhisser.example'].join('') }), /credentials/);
  assert.throws(() => resolveDesktopConfig({ REZHISSER_URL: 'not a url' }), /REZHISSER_URL/);
  assert.throws(() => resolveDesktopConfig({ REZHISSER_START_PATH: 'https://evil.example/' }), /REZHISSER_START_PATH/);
});

test('desktop navigation: service pages stay inside, web links open externally, other schemes are denied', () => {
  const origin = 'https://rezhisser.example';
  assert.equal(classifyNavigation('https://rezhisser.example/studio', origin), 'internal');
  assert.equal(classifyNavigation('https://rezhisser.example.evil.test/', origin), 'external');
  assert.equal(classifyNavigation('http://rezhisser.example/', origin), 'external');
  assert.equal(classifyNavigation('https://yoomoney.ru/checkout/payments/v2/contract', origin), 'external');
  assert.equal(classifyNavigation('file:///etc/passwd', origin), 'deny');
  assert.equal(classifyNavigation('javascript:alert(1)', origin), 'deny');
  assert.equal(classifyNavigation('smb://host/share', origin), 'deny');
  assert.equal(classifyNavigation('::not a url::', origin), 'deny');
});

test('desktop local secret is created once with private permissions and reused', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'nested', 'jwt-secret');
    const first = loadOrCreateSecret(file);
    assert.ok(first.length >= 32);
    assert.equal(loadOrCreateSecret(file), first);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      assert.equal(loadOrCreateSecret(file), first);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      fs.chmodSync(file, 0o644);
    }
    fs.writeFileSync(file, 'short');
    assert.notEqual(loadOrCreateSecret(file), 'short');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop local server runs on 127.0.0.1, serves the dashboard, runs tasks and keeps sign-in across restarts', async () => {
  const userDataDir = tempDir();
  const options = { simulationDurationMs: 30, fetchImpl: noNetwork, logger: { log() {}, error() {}, warn() {} } };
  let server = await startLocalServer({ createApp, userDataDir, options });
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.app.server.address().address, '127.0.0.1');
    assert.equal(server.app.db.kind, 'memory');
    assert.equal(server.app.automation.executor.simulated, true);

    const page = await fetch(`${server.origin}/automation`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /run-list/);

    const api = accountClient(server.origin);
    assert.equal((await api.register('desktop@example.com')).status, 201);
    const created = await api.post('/api/automation/tasks', {
      name: 'Desktop task',
      url: 'https://example.com/',
      instruction: 'Open the page and report the title.',
      region: 'EU',
    });
    assert.equal(created.status, 201);
    const started = await api.post(`/api/automation/tasks/${created.json.task.id}/runs`);
    assert.equal(started.status, 202);
    let run = null;
    for (let i = 0; i < 400; i += 1) {
      run = (await api.get(`/api/automation/runs/${started.json.run.id}`)).json.run;
      if (!['queued', 'running'].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(run.status, 'succeeded');
    assert.equal(run.simulated, true);

    await server.close();
    await server.close();
    server = await startLocalServer({ createApp, userDataDir, options });
    const again = accountClient(server.origin);
    again.state.token = api.state.token;
    const tasks = await again.get('/api/automation/tasks');
    assert.equal(tasks.status, 200);
    assert.deepEqual(tasks.json.tasks.map((task) => task.name), ['Desktop task']);
    const runs = await again.get('/api/automation/runs');
    assert.equal(runs.json.runs.length, 1);
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('desktop package is a hardened Electron shell that bundles the server', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'main.js');
  assert.equal(pkg.scripts.start, 'electron .');
  assert.ok(pkg.devDependencies.electron);
  assert.ok(pkg.devDependencies['electron-builder']);
  const resources = pkg.build.extraResources.map((entry) => `${entry.from}->${entry.to}`);
  assert.deepEqual(resources, ['../src->server/src', '../public->server/public']);

  const main = fs.readFileSync(path.join(DESKTOP_DIR, 'main.js'), 'utf8');
  assert.match(main, /classifyNavigation\(url, origin\) === 'external'/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.doesNotMatch(main, /nodeIntegration: true|webSecurity: false|allowRunningInsecureContent/);

  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(rootPkg.dependencies.electron, undefined, 'the cloud service must not depend on Electron');
});
