'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, loadEnvFile } = require('../src/server.js');
const { integrationReport } = require('../src/integrations.js');
const { withServer, fakeServices, productionOptions, accountClient } = require('./helpers/production.js');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-integrations-'));
}

async function boot(options, run) {
  const dataDir = tempDataDir();
  const app = createApp({ dataDir, rateLimitMax: 1000, logger: { log() {}, error() {}, warn() {} }, ...options });
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

test('integration report lists missing variable names and never values', () => {
  const report = integrationReport({
    videoProvider: 'local-simulation',
    replicate: { apiToken: 'super-secret-replicate-token' },
    seedance: { apiKey: '', model: '' },
    s3: { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' },
    yookassa: { shopId: '', secretKey: '' },
    stripe: { secretKey: '', webhookSecret: '' },
    mail: { resendApiKey: '', from: '' },
    publicOrigin: '',
    owlBrowser: { url: '', token: '' },
    databaseUrl: '',
    jwtSecret: '',
  });
  assert.equal(report.replicate.configured, false);
  assert.deepEqual(report.replicate.missing, ['VIDEO_PROVIDER']);
  assert.deepEqual(report.seedance.missing, ['SEEDANCE_API_KEY', 'SEEDANCE_MODEL']);
  assert.equal(JSON.stringify(report).includes('super-secret-replicate-token'), false);
});

test('health and config name missing keys and do not leak a configured token', async () => {
  let calls = 0;
  await boot({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('network must not be used');
    },
    replicate: { apiToken: 'super-secret-replicate-token' },
  }, async ({ base }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.realVideoGeneration, false);
    assert.deepEqual(health.integrations.replicate.missing, ['VIDEO_PROVIDER']);
    assert.deepEqual(health.integrations.seedance.missing, ['SEEDANCE_API_KEY', 'SEEDANCE_MODEL']);
    assert.deepEqual(health.integrations.automation.missing, ['OWL_BROWSER_URL', 'OWL_BROWSER_TOKEN']);
    assert.deepEqual(config.integrations.mail.missing, ['RESEND_API_KEY', 'MAIL_FROM', 'PUBLIC_ORIGIN']);
    const text = JSON.stringify({ health, config });
    assert.equal(text.includes('super-secret-replicate-token'), false);
  });
  assert.equal(calls, 0);
});

test('cleared production keys are reported on the endpoints that used to fake success', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services, {
    seedance: { apiKey: '', model: '' },
    yookassa: { shopId: '', secretKey: '' },
    stripe: { secretKey: '', webhookSecret: '' },
    mail: { resendApiKey: '', from: '' },
    publicOrigin: '',
  }), async ({ base }) => {
    const api = accountClient(base);
    await api.register('keys@example.com', 'password-123');

    const video = await api.post('/api/jobs', { prompt: 'ролик' });
    assert.equal(video.status, 503);
    assert.equal(video.json.error, 'generation_unavailable');
    assert.deepEqual(video.json.missing, ['SEEDANCE_API_KEY', 'SEEDANCE_MODEL']);

    const demo = await api.post('/api/jobs', { prompt: 'ролик', demo: true });
    assert.equal(demo.status, 400);
    assert.equal(demo.json.error, 'demo_disabled');

    const pay = await api.post('/api/payment/checkout', { product: 'pro', currency: 'RUB' });
    assert.equal(pay.status, 503);
    assert.ok(pay.json.missing.includes('YOOKASSA_SHOP_ID'));
    assert.ok(pay.json.missing.includes('STRIPE_SECRET_KEY'));

    const mail = await api.post('/api/auth/forgot-password', { email: 'keys@example.com' });
    assert.equal(mail.status, 503);
    assert.deepEqual(mail.json.missing, ['RESEND_API_KEY', 'MAIL_FROM', 'PUBLIC_ORIGIN']);

    const task = await api.post('/api/automation/tasks', {
      name: 'Check',
      url: 'https://example.com/',
      instruction: 'Open the page.',
      region: 'US',
    });
    const run = await api.post(`/api/automation/tasks/${task.json.task.id}/runs`);
    assert.equal(run.status, 503);
    assert.deepEqual(run.json.missing, ['OWL_BROWSER_URL', 'OWL_BROWSER_TOKEN']);
    assert.equal(services.calls.length, 0);
  });
});

test('loadEnvFile reads .env without overriding the process or inventing keys', () => {
  const file = path.join(os.tmpdir(), `rezhisser-env-${process.pid}.env`);
  const fresh = `REZHISSER_ENV_FRESH_${process.pid}`;
  const kept = `REZHISSER_ENV_KEPT_${process.pid}`;
  const quoted = `REZHISSER_ENV_QUOTED_${process.pid}`;
  delete process.env[fresh];
  process.env[kept] = 'from-process';
  delete process.env[quoted];
  fs.writeFileSync(file, `# comment\n${fresh}=from-file\n${kept}=from-file\nexport ${quoted}="a b"\nNOT A KEY\n`);
  try {
    loadEnvFile(file);
    loadEnvFile(path.join(os.tmpdir(), 'missing-rezhisser.env'));
    assert.equal(process.env[fresh], 'from-file');
    assert.equal(process.env[kept], 'from-process');
    assert.equal(process.env[quoted], 'a b');
  } finally {
    delete process.env[fresh];
    delete process.env[kept];
    delete process.env[quoted];
    fs.rmSync(file, { force: true });
  }
});
