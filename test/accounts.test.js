'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTokenService,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  validatePassword,
} = require('../src/accounts.js');
const { withServer, silentLogger, fakeServices, productionOptions, accountClient, JWT_SECRET } = require('./helpers/production.js');

test('passwords are hashed with scrypt and verified in constant time', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$/);
  assert.equal(hash.includes('correct horse'), false);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
});

test('email and password validation', () => {
  assert.equal(normalizeEmail('  Vera@Example.COM '), 'vera@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), (e) => e.code === 'invalid_email');
  assert.throws(() => validatePassword('short'), (e) => e.code === 'weak_password');
  assert.equal(validatePassword('long enough'), 'long enough');
});

test('JWT tokens are signed, expire and are bound to the token version', () => {
  let clock = 1_700_000_000_000;
  const tokens = createTokenService({ secret: JWT_SECRET, ttlSeconds: 600, now: () => clock });
  const { token } = tokens.issue({ id: '0b0c9d0e-1111-4222-8333-444455556666', tokenVersion: 2 });
  const payload = tokens.verify(token);
  assert.equal(payload.sub, '0b0c9d0e-1111-4222-8333-444455556666');
  assert.equal(payload.tv, 2);

  const [h, p] = token.split('.');
  assert.equal(tokens.verify(`${h}.${p}.AAAA`), null);
  const other = createTokenService({ secret: `${JWT_SECRET}-other`, ttlSeconds: 600, now: () => clock });
  assert.equal(other.verify(token), null);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
  assert.equal(tokens.verify(none), null);

  clock += 601 * 1000;
  assert.equal(tokens.verify(token), null);
  assert.throws(() => createTokenService({ secret: 'short' }));
});

test('register, login, profile and password reset over HTTP', async () => {
  const services = fakeServices();
  const logs = [];
  const logger = { ...silentLogger(), log: (line) => logs.push(String(line)) };
  await withServer(productionOptions(services, { logger }), async ({ base }) => {
    const api = accountClient(base);

    assert.equal((await api.get('/api/user/profile')).status, 401);

    const reg = await api.register('Vera@Example.com', 'sapogi-2026!');
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.email, 'vera@example.com');
    assert.equal(reg.json.subscription.tier, 'free');
    assert.equal(reg.json.subscription.canGenerate, false);
    assert.equal(reg.headers.get('cache-control'), 'no-store');

    assert.equal((await accountClient(base).register('vera@example.com', 'another-pass')).status, 409);
    assert.equal((await accountClient(base).register('bad', 'another-pass')).status, 400);
    assert.equal((await accountClient(base).register('x@example.com', 'short')).status, 400);

    const profile = await api.get('/api/user/profile');
    assert.equal(profile.status, 200);
    assert.equal(profile.json.user.email, 'vera@example.com');
    assert.deepEqual(profile.json.usage, { totalVideos: 0, totalDemos: 0, succeeded: 0 });
    assert.equal(profile.json.user.passwordHash, undefined);

    const anon = accountClient(base);
    assert.equal((await anon.post('/api/auth/login', { email: 'vera@example.com', password: 'wrong-password' })).status, 401);
    assert.equal((await anon.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' })).status, 401);
    const login = await anon.post('/api/auth/login', { email: 'VERA@example.com', password: 'sapogi-2026!' });
    assert.equal(login.status, 200);
    assert.ok(login.json.token);

    // Without mail keys the API says so. It does not log a reset link or pretend the letter went out.
    const unknown = await anon.post('/api/auth/forgot-password', { email: 'nobody@example.com' });
    const known = await anon.post('/api/auth/forgot-password', { email: 'vera@example.com' });
    assert.equal(unknown.status, 503);
    assert.equal(known.status, 503);
    assert.equal(known.json.error, 'mail_not_configured');
    assert.deepEqual(known.json.missing, unknown.json.missing);
    assert.ok(known.json.missing.includes('RESEND_API_KEY'));
    assert.ok(known.json.missing.includes('MAIL_FROM'));
    assert.ok(known.json.missing.includes('PUBLIC_ORIGIN'));
    assert.equal(logs.some((line) => line.includes('token=')), false);
    assert.equal(services.calls.some((call) => call.url.includes('resend.com')), false);
  });
});

test('reset emails are not sent with Host-derived links when PUBLIC_ORIGIN is missing', async () => {
  const services = fakeServices();
  const errors = [];
  const logger = { ...silentLogger(), error: (line) => errors.push(String(line)) };
  await withServer(productionOptions(services, { logger, mail: { resendApiKey: 're_test_key', from: 'Rezhisser <no-reply@example.com>' } }), async ({ base }) => {
    const api = accountClient(base);
    await api.register('host@example.com', 'password-123');
    const res = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'evil.example' },
      body: JSON.stringify({ email: 'host@example.com' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'mail_not_configured');
    assert.deepEqual(body.missing, ['PUBLIC_ORIGIN']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(services.calls.filter((c) => new URL(c.url).origin === 'https://api.resend.com').length, 0);
    assert.equal(errors.some((l) => l.includes('token=')), false);
  });

  await withServer(
    productionOptions(services, { publicOrigin: 'https://rezhisser.example', mail: { resendApiKey: 're_test_key', from: 'no-reply@example.com' } }),
    async ({ base }) => {
      const api = accountClient(base);
      await api.register('mail@example.com', 'password-123');
      assert.equal((await api.post('/api/auth/forgot-password', { email: 'mail@example.com' })).status, 202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const sent = services.calls.find((c) => c.url === 'https://api.resend.com/emails');
      assert.ok(sent);
      const letter = JSON.parse(sent.body).text;
      assert.match(letter, /https:\/\/rezhisser\.example\/studio#\/reset\?token=/);
      const token = letter.match(/token=([A-Za-z0-9_-]+)/)[1];
      assert.equal((await api.post('/api/auth/reset-password', { token: 'x'.repeat(43), password: 'new-password-1' })).status, 400);
      assert.equal((await api.post('/api/auth/reset-password', { token, password: 'new-password-1' })).status, 200);
      assert.equal((await api.post('/api/auth/reset-password', { token, password: 'new-password-2' })).status, 400);
      assert.equal((await api.post('/api/auth/login', { email: 'mail@example.com', password: 'password-123' })).status, 401);
      assert.equal((await api.post('/api/auth/login', { email: 'mail@example.com', password: 'new-password-1' })).status, 200);
    },
  );
});

test('account login attempts are rate limited', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services, { loginRateLimitMax: 3 }), async ({ base }) => {
    const api = accountClient(base);
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await api.post('/api/auth/login', { email: 'a@example.com', password: 'whatever-123' })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });
});

test('tokens from another secret or a deleted session are rejected', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    const forged = createTokenService({ secret: 'z'.repeat(40) }).issue({ id: '0b0c9d0e-1111-4222-8333-444455556666', tokenVersion: 0 });
    const api = accountClient(base);
    api.state.token = forged.token;
    assert.equal((await api.get('/api/user/profile')).status, 401);
    api.state.token = 'not.a.jwt';
    assert.equal((await api.get('/api/payment/history')).status, 401);
  });
});

test('health reports production checks', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.seedance, 'configured');
    assert.equal(body.checks.storage, 'configured');
    assert.deepEqual(body.checks.payments, ['yookassa', 'stripe']);
    assert.ok(body.checks.library >= 80);
  });
});

test('in production without email delivery no reset tokens are created', async () => {
  const services = fakeServices();
  const logs = [];
  const logger = { ...silentLogger(), log: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) };
  await withServer(productionOptions(services, { logger, nodeEnv: 'production' }), async ({ base, app }) => {
    const api = accountClient(base);
    await api.register('prod@example.com', 'password-123');
    const res = await api.post('/api/auth/forgot-password', { email: 'prod@example.com' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'mail_not_configured');
    assert.ok(res.json.missing.includes('RESEND_API_KEY'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(logs.some((l) => l.includes('token=')), false);
    assert.equal(await app.db.deleteExpiredPasswordResets(Date.now() + 86400000), 0);
  });
});
