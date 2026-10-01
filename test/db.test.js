'use strict';

// Repository contract shared by the in-memory store and PostgreSQL. The
// PostgreSQL run is enabled with TEST_DATABASE_URL (it drops and recreates
// the tables in that database — never point it at real data).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../src/db/index.js');
const { createMemoryDatabase } = require('../src/db/memory.js');
const { createLibrary } = require('../src/library/index.js');

const DAY = 24 * 3600 * 1000;

async function contract(t, db) {
  const id = crypto.randomUUID();
  const email = `${id.slice(0, 8)}@example.com`;

  await t.test('users, unique email and token version', async () => {
    const user = await db.createUser({ id, email, passwordHash: 'h1' });
    assert.equal(user.tier, 'free');
    assert.equal(user.credits, 0);
    assert.equal(user.tokenVersion, 0);
    await assert.rejects(db.createUser({ id: crypto.randomUUID(), email, passwordHash: 'h2' }), (e) => e.code === 'email_taken');
    assert.equal((await db.getUserByEmail(email)).id, id);
    const updated = await db.updateUserPassword(id, 'h3');
    assert.equal(updated.passwordHash, 'h3');
    assert.equal(updated.tokenVersion, 1);
  });

  await t.test('credits and period usage are atomic and bounded', async () => {
    assert.equal(await db.consumeCredits(id, 1), false);
    await db.addCredits(id, 2);
    assert.equal(await db.consumeCredits(id, 1), true);
    assert.equal(await db.consumeCredits(id, 1), true);
    assert.equal(await db.consumeCredits(id, 1), false);
    await db.addCredits(id, -50);
    assert.equal((await db.getUserById(id)).credits, 0);

    assert.equal(await db.incrementPeriodUsage(id, 2), true);
    assert.equal(await db.incrementPeriodUsage(id, 2), true);
    assert.equal(await db.incrementPeriodUsage(id, 2), false);
    await db.decrementPeriodUsage(id);
    assert.equal((await db.getUserById(id)).periodVideosUsed, 1);
    assert.equal(await db.incrementPeriodUsage(id, null), true);

    const rolled = await db.rollUsagePeriod(id, Date.now() + 31 * DAY, 30 * DAY);
    assert.equal(rolled.periodVideosUsed, 0);
  });

  await t.test('subscriptions', async () => {
    const expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
    await db.incrementPeriodUsage(id, null);
    const user = await db.setSubscription(id, { tier: 'pro', expiresAt, resetPeriodAt: new Date().toISOString() });
    assert.equal(user.tier, 'pro');
    assert.equal(Date.parse(user.subscriptionExpiresAt), Date.parse(expiresAt));
    assert.equal(user.periodVideosUsed, 0);
  });

  await t.test('password resets are single use and expire', async () => {
    await db.createPasswordReset({ tokenHash: `a-${id}`, userId: id, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await db.createPasswordReset({ tokenHash: `b-${id}`, userId: id, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await db.consumePasswordReset(`a-${id}`, Date.now()), id);
    assert.equal(await db.consumePasswordReset(`a-${id}`, Date.now()), null);
    assert.equal(await db.consumePasswordReset(`b-${id}`, Date.now()), null);
    assert.ok((await db.deleteExpiredPasswordResets(Date.now())) >= 2);
  });

  await t.test('video jobs', async () => {
    const jobId = crypto.randomUUID();
    const job = await db.createVideoJob({ id: jobId, userId: id, status: 'queued', provider: 'seedance', prompt: 'p', brief: { a: 1 }, billingSource: 'credits', aspect: '9:16', durationSeconds: 5, hasImage: true });
    assert.equal(job.status, 'queued');
    assert.deepEqual(job.brief, { a: 1 });
    assert.ok((await db.listActiveVideoJobs()).some((j) => j.id === jobId));
    const past = new Date(Date.now() - 1000).toISOString();
    await db.updateVideoJob(jobId, { status: 'succeeded', videoKey: 'videos/x.mp4', completedAt: past, expiresAt: past });
    assert.ok((await db.listExpiredVideoJobs(Date.now(), 10)).some((j) => j.id === jobId));
    assert.equal((await db.listVideoJobs(id)).length, 1);
    assert.equal((await db.getVideoJob(jobId)).videoKey, 'videos/x.mp4');
  });

  await t.test('payments: provider id lookup and guarded transitions', async () => {
    const paymentId = crypto.randomUUID();
    await db.createPayment({ id: paymentId, userId: id, provider: 'yookassa', product: 'pro', amountMinor: 45000, currency: 'RUB', status: 'pending' });
    await db.updatePayment(paymentId, { providerPaymentId: `yk-${paymentId}` });
    assert.equal((await db.findPaymentByProviderId('yookassa', `yk-${paymentId}`)).id, paymentId);
    assert.equal(await db.findPaymentByProviderId('stripe', `yk-${paymentId}`), null);
    const first = await db.transitionPayment(paymentId, ['pending'], 'succeeded', { paidAt: new Date().toISOString(), providerReference: `pi-${paymentId}` });
    assert.equal(first.status, 'succeeded');
    assert.equal(await db.transitionPayment(paymentId, ['pending'], 'succeeded'), null);
    assert.equal((await db.findPaymentByReference('yookassa', `pi-${paymentId}`)).id, paymentId);
    assert.equal((await db.listPayments(id)).length, 1);
  });

  await t.test('usage events and projects', async () => {
    await db.addUsageEvent({ id: crypto.randomUUID(), userId: id, kind: 'generation', source: 'credits', amount: 1 });
    assert.equal((await db.listUsageEvents(id))[0].kind, 'generation');
    const projectId = crypto.randomUUID();
    await db.createProject({ id: projectId, userId: id, kind: 'favorite', title: 'Два косметолога', libraryItemId: 'sng-meme-001' });
    assert.equal(await db.countProjects(id), 1);
    assert.equal(await db.deleteProject(projectId, crypto.randomUUID()), false);
    assert.equal(await db.deleteProject(projectId, id), true);
    assert.equal(await db.countProjects(id), 0);
  });
}

test('memory repository satisfies the contract', async (t) => {
  await contract(t, createMemoryDatabase());
});

test('memory repository persists to a JSON snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rezhisser-db-'));
  try {
    const id = crypto.randomUUID();
    const db = createDatabase({ dataDir: dir });
    await db.createUser({ id, email: 'persist@example.com', passwordHash: 'h' });
    await db.addCredits(id, 7);
    const reopened = createDatabase({ dataDir: dir });
    assert.equal((await reopened.getUserByEmail('persist@example.com')).credits, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postgres repository satisfies the contract', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query('DROP TABLE IF EXISTS usage_events, projects, payments, video_jobs, password_resets, library_items, users CASCADE');
  const library = createLibrary();
  const db = createDatabase({ pool, libraryItems: library.items });
  try {
    const result = await db.migrate();
    assert.equal(result.libraryItems, library.size);
    await db.migrate(); // idempotent
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM library_items WHERE language = 'zh'");
    assert.ok(rows[0].n >= 20);
    await contract(t, db);
  } finally {
    await db.close();
  }
});
