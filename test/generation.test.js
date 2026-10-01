'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSeedanceProvider } = require('../src/providers/seedance.js');
const { createS3Storage } = require('../src/storage/s3.js');
const { createMemoryDatabase } = require('../src/db/memory.js');
const { runCleanup } = require('../src/cron/cleanup.js');
const {
  withServer,
  fakeServices,
  productionOptions,
  accountClient,
  silentLogger,
  BRIEF,
  PNG_1PX,
  SEEDANCE_BASE,
  S3_ENDPOINT,
  VIDEO_URL,
} = require('./helpers/production.js');

// Gives a fresh account paid access without going through a payment.
async function upgrade(app, api, tier = 'pro') {
  const profile = await api.get('/api/user/profile');
  await app.db.setSubscription(profile.json.user.id, {
    tier,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    resetPeriodAt: new Date().toISOString(),
  });
  return profile.json.user.id;
}

test('Seedance provider builds ModelArk task requests', async () => {
  assert.equal(createSeedanceProvider({ apiKey: '' }), null);
  assert.throws(() => createSeedanceProvider({ apiKey: 'k', model: '' }), /SEEDANCE_MODEL/);
  assert.throws(() => createSeedanceProvider({ apiKey: 'k', model: 'm', apiBaseUrl: 'http://insecure.test' }));

  const services = fakeServices();
  assert.throws(() => createSeedanceProvider({ apiKey: 'k', model: 'm', extraInput: '{"model":"evil"}' }), /must not set/);
  const provider = createSeedanceProvider({ apiKey: 'ark-key', model: 'seedance-2-5', apiBaseUrl: SEEDANCE_BASE, fetchImpl: services.fetchImpl, extraInput: '{"seed":7}' });
  const request = provider.buildRequest({ prompt: 'hello', image: 'data:image/png;base64,AAAA', aspect: '9:16', duration: 5 });
  assert.equal(request.model, 'seedance-2-5');
  assert.equal(request.seed, 7);
  assert.deepEqual(request.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'first_frame' });
  assert.equal(request.ratio, '9:16');

  const taskId = await provider.submit({ prompt: 'hello', aspect: '16:9', duration: 10 });
  assert.equal(taskId, 'cgt-test-1');
  const submit = services.calls[0];
  assert.equal(submit.url, `${SEEDANCE_BASE}/contents/generations/tasks`);
  assert.equal(submit.headers.Authorization.split(' ')[0], 'Bearer');
  assert.deepEqual(await provider.get(taskId), { status: 'succeeded', videoUrl: VIDEO_URL, duration: null });
});

test('Seedance provider maps running, failed and malformed results', async () => {
  const services = fakeServices({
    seedanceStates: [
      { status: 'running' },
      { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'blocked' } },
      { status: 'succeeded', content: { video_url: 'http://insecure.test/v.mp4' } },
    ],
  });
  const provider = createSeedanceProvider({ apiKey: 'ark-key', model: 'seedance-2-5', apiBaseUrl: SEEDANCE_BASE, fetchImpl: services.fetchImpl });
  assert.deepEqual(await provider.get('cgt-1'), { status: 'processing' });
  assert.deepEqual(await provider.get('cgt-1'), { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'blocked' } });
  assert.equal((await provider.get('cgt-1')).status, 'failed');
  await assert.rejects(provider.get('../../etc'));
});

test('account jobs: Free tier is demo-only; Pro generates with Seedance and stores to S3', async () => {
  const services = fakeServices({ seedanceStates: [{ status: 'queued' }, { status: 'running' }, { status: 'succeeded', content: { video_url: VIDEO_URL } }] });
  await withServer(productionOptions(services, { simulationDurationMs: 20 }), async ({ base, app }) => {
    const api = accountClient(base);
    await api.register();

    // Free: real generation needs a plan; demo works without billing.
    const denied = await api.post('/api/jobs', { brief: BRIEF });
    assert.equal(denied.status, 402);
    assert.equal(denied.json.error, 'upgrade_required');
    const demo = await api.post('/api/jobs', { libraryItemId: 'sng-meme-001', demo: true });
    assert.equal(demo.status, 201);
    assert.equal(demo.json.job.simulated, true);
    assert.equal((await api.waitForJob(demo.json.job.id)).status, 'succeeded');
    assert.equal(services.calls.filter((c) => c.url.startsWith(SEEDANCE_BASE)).length, 0);

    await upgrade(app, api, 'pro');
    const created = await api.post('/api/jobs', { brief: BRIEF, image: PNG_1PX });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.job.provider, 'seedance');
    assert.equal(created.json.job.billingSource, 'subscription');
    assert.equal(created.json.subscription.periodVideosUsed, 1);

    const job = await api.waitForJob(created.json.job.id);
    assert.equal(job.status, 'succeeded');
    assert.match(job.video.url, new RegExp(`^${S3_ENDPOINT}/rezhisser-videos/videos/`));
    assert.match(job.video.url, /X-Amz-Signature=[a-f0-9]{64}$/);
    assert.match(job.video.downloadUrl, /response-content-disposition=attachment/);
    assert.ok(Date.parse(job.expiresAt) > Date.now() + 29 * 24 * 3600 * 1000);
    assert.equal(services.objects.get(`/rezhisser-videos/videos/${(await api.get('/api/user/profile')).json.user.id}/${job.id}.mp4`).toString(), 'fake-mp4-bytes');

    const submit = JSON.parse(services.calls.find((c) => c.url.startsWith(SEEDANCE_BASE) && c.method === 'POST').body);
    assert.equal(submit.model, 'seedance-2-5-test');
    assert.equal(submit.content[1].type, 'image_url');
    assert.match(submit.content[1].image_url.url, /^data:image\/png;base64,/);

    const list = await api.get('/api/jobs');
    assert.equal(list.status, 200);
    assert.equal(list.json.jobs.length, 2);

    // Other users cannot read the job.
    const other = accountClient(base);
    await other.register();
    assert.equal((await other.get(`/api/jobs/${job.id}`)).status, 404);

    const profile = await api.get('/api/user/profile');
    assert.deepEqual(profile.json.usage, { totalVideos: 1, totalDemos: 1, succeeded: 2 });
  });
});

test('library remix: placeholders are filled and photo templates require an image', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base, app }) => {
    const api = accountClient(base);
    await api.register();
    await upgrade(app, api, 'studio');
    const item = app.library.items.find((i) => i.needsPhoto && i.promptEn.includes('{product}'));
    assert.ok(item, 'a photo template with a {product} placeholder exists');

    const missing = await api.post('/api/jobs', { libraryItemId: item.id });
    assert.equal(missing.status, 422);
    assert.equal(missing.json.error, 'image_required');

    const res = await api.post('/api/jobs', { libraryItemId: item.id, image: PNG_1PX, fields: { product: 'Сапоги «Вера»', brand: 'Brand<script>' } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.match(res.json.job.prompt, /Сапоги «Вера»/);
    assert.equal(res.json.job.prompt.includes('{product}'), false);
    assert.equal(res.json.job.aspect, item.aspect);
    assert.equal(res.json.subscription.unlimited, true);
    assert.equal((await api.waitForJob(res.json.job.id)).status, 'succeeded');

    assert.equal((await api.post('/api/jobs', { libraryItemId: 'nope-nope' })).status, 400);
    assert.equal((await api.post('/api/jobs', {})).status, 400);
    assert.equal((await api.post('/api/jobs', { prompt: 'x', provider: 'replicate' })).status, 400);
  });
});

test('failed generations refund credits; Pro quota is enforced', async () => {
  const states = [{ status: 'failed', error: { code: 'InternalError' } }];
  const services = fakeServices({ seedanceStates: states });
  await withServer(productionOptions(services, { proVideosPerPeriod: 1 }), async ({ base, app }) => {
    const api = accountClient(base);
    await api.register();
    const userId = (await api.get('/api/user/profile')).json.user.id;
    await app.db.addCredits(userId, 1);

    const res = await api.post('/api/jobs', { prompt: 'Ролик про сапоги, 9:16' });
    assert.equal(res.status, 201);
    assert.equal(res.json.job.billingSource, 'credits');
    assert.equal(res.json.subscription.credits, 0);
    const job = await api.waitForJob(res.json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'InternalError');
    assert.equal((await api.get('/api/user/profile')).json.subscription.credits, 1, 'credit refunded');
    const usage = (await api.get('/api/payment/history')).json.usage.map((e) => e.kind);
    assert.ok(usage.includes('generation_refund'));

    // Submit failure also refunds.
    services.control.seedanceSubmitStatus = 429;
    await upgrade(app, api, 'pro');
    const r2 = await api.post('/api/jobs', { prompt: 'Ролик' });
    assert.equal(r2.json.job.billingSource, 'subscription');
    assert.equal((await api.waitForJob(r2.json.job.id)).error.code, 'provider_error');
    assert.equal((await api.get('/api/user/profile')).json.subscription.periodVideosUsed, 0);

    // Quota: 1 video per period, then credits, then 402.
    services.control.seedanceSubmitStatus = 201;
    states.splice(0, 1, { status: 'running' });
    assert.equal((await api.post('/api/jobs', { prompt: 'Ролик 1' })).json.job.billingSource, 'subscription');
    assert.equal((await api.post('/api/jobs', { prompt: 'Ролик 2' })).json.job.billingSource, 'credits');
    const over = await api.post('/api/jobs', { prompt: 'Ролик 3' });
    assert.equal(over.status, 402);
    assert.equal(over.json.error, 'quota_exceeded');
  });
});

test('without SEEDANCE_API_KEY only demo jobs are possible', async () => {
  await withServer(productionOptions(fakeServices(), { seedance: { apiKey: '' } }), async ({ base }) => {
    const api = accountClient(base);
    await api.register();
    const res = await api.post('/api/jobs', { prompt: 'x' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'generation_unavailable');
    assert.equal((await api.post('/api/jobs', { prompt: 'x', demo: true })).status, 201);
  });
});

test('requests without a bearer token keep using the legacy demo /api/jobs', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief: BRIEF }) });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.job.provider, 'local-simulation');
  });
});

test('projects and favorites', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    const api = accountClient(base);
    assert.equal((await api.get('/api/projects')).status, 401);
    await api.register();
    const fav = await api.post('/api/projects', { kind: 'favorite', libraryItemId: 'sng-meme-001' });
    assert.equal(fav.status, 201);
    assert.equal(fav.json.project.title.length > 0, true);
    const proj = await api.post('/api/projects', { title: 'Кампания сапоги', brief: BRIEF, prompt: 'p' });
    assert.equal(proj.status, 201);
    assert.equal((await api.post('/api/projects', { libraryItemId: 'missing-id' })).status, 400);
    assert.equal((await api.post('/api/projects', {})).status, 400);
    const list = await api.get('/api/projects');
    assert.equal(list.json.projects.length, 2);
    assert.equal(list.json.projects[0].userId, undefined);

    const other = accountClient(base);
    await other.register();
    assert.equal((await other.del(`/api/projects/${fav.json.project.id}`)).status, 404);
    assert.equal((await api.del(`/api/projects/${fav.json.project.id}`)).status, 200);
    assert.equal((await api.get('/api/projects')).json.projects.length, 1);
  });
});

test('jobs left running by a restart are resumed or failed with a refund', async () => {
  const services = fakeServices();
  const db = createMemoryDatabase();
  const userId = crypto.randomUUID();
  await db.createUser({ id: userId, email: 'resume@example.com', passwordHash: 'h' });
  await db.addCredits(userId, 0);
  const created = new Date().toISOString();
  await db.createVideoJob({ id: crypto.randomUUID(), userId, status: 'processing', provider: 'seedance', providerTaskId: 'cgt-resume-1', prompt: 'p', billingSource: 'credits', createdAt: created });
  const orphan = await db.createVideoJob({ id: crypto.randomUUID(), userId, status: 'queued', provider: 'seedance', prompt: 'p', billingSource: 'credits', createdAt: created });
  await withServer(productionOptions(services, { database: db }), async ({ app }) => {
    assert.equal(await app.pipeline.resume(), 1);
    for (let i = 0; i < 200 && (await db.listActiveVideoJobs()).length > 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const jobs = await db.listVideoJobs(userId);
    assert.deepEqual(jobs.map((j) => j.status).sort(), ['failed', 'succeeded']);
    assert.equal((await db.getVideoJob(orphan.id)).error.code, 'interrupted');
    assert.equal((await db.getUserById(userId)).credits, 1);
  });
});

test('S3 SigV4 presigned URL matches the AWS reference example', () => {
  const storage = createS3Storage({
    endpoint: 'https://s3.amazonaws.com',
    region: 'us-east-1',
    bucket: 'examplebucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    forcePathStyle: false,
    now: () => new Date('2013-05-24T00:00:00Z'),
  });
  const url = storage.presignGet('test.txt', 86400);
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
});

test('S3 client signs PUT/DELETE and rejects unsafe keys and sources', async () => {
  const services = fakeServices();
  const storage = createS3Storage({ endpoint: S3_ENDPOINT, bucket: 'rezhisser-videos', accessKeyId: 'id', secretAccessKey: 'secret', fetchImpl: services.fetchImpl });
  assert.equal(createS3Storage({ endpoint: '', bucket: 'b', accessKeyId: 'i', secretAccessKey: 's' }), null);
  await storage.putObject('videos/a/b.mp4', Buffer.from('x'), 'video/mp4');
  const put = services.calls[0];
  assert.equal(put.url, `${S3_ENDPOINT}/rezhisser-videos/videos/a/b.mp4`);
  assert.match(put.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.equal(put.headers['x-amz-content-sha256'], crypto.createHash('sha256').update('x').digest('hex'));
  await storage.deleteObject('videos/a/b.mp4');
  assert.equal(services.objects.size, 0);
  assert.throws(() => storage.presignGet('../secret'), (e) => e.code === 'invalid_key');
  await assert.rejects(storage.copyFromUrl('http://cdn.test/v.mp4', 'videos/x.mp4'), (e) => e.code === 'invalid_source');
  services.control.s3Status = 500;
  await assert.rejects(storage.putObject('videos/y.mp4', Buffer.from('y')), (e) => e.code === 'storage_error');
});

test('cleanup cron deletes videos older than the retention period', async () => {
  const services = fakeServices();
  const storage = createS3Storage({ endpoint: S3_ENDPOINT, bucket: 'rezhisser-videos', accessKeyId: 'id', secretAccessKey: 'secret', fetchImpl: services.fetchImpl });
  const db = createMemoryDatabase();
  const userId = crypto.randomUUID();
  await db.createUser({ id: userId, email: 'old@example.com', passwordHash: 'h' });
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 1e9).toISOString();
  const oldJob = await db.createVideoJob({ id: crypto.randomUUID(), userId, status: 'succeeded', videoKey: `videos/${userId}/old.mp4`, expiresAt: past });
  const freshJob = await db.createVideoJob({ id: crypto.randomUUID(), userId, status: 'succeeded', videoKey: `videos/${userId}/new.mp4`, expiresAt: future });
  await storage.putObject(oldJob.videoKey, Buffer.from('old'));
  await storage.putObject(freshJob.videoKey, Buffer.from('new'));
  await db.createPasswordReset({ tokenHash: 'expired', userId, expiresAt: past });

  const result = await runCleanup({ db, storage, logger: silentLogger() });
  assert.deepEqual(result, { expired: 1, failed: 0, resets: 1 });
  assert.equal((await db.getVideoJob(oldJob.id)).status, 'expired');
  assert.equal((await db.getVideoJob(oldJob.id)).videoKey, null);
  assert.equal((await db.getVideoJob(freshJob.id)).status, 'succeeded');
  assert.deepEqual([...services.objects.keys()], [`/rezhisser-videos/${freshJob.videoKey}`]);

  // Storage failures are reported and retried on the next run.
  await db.updateVideoJob(freshJob.id, { expiresAt: past });
  services.control.s3Status = 500;
  assert.deepEqual(await runCleanup({ db, storage, logger: silentLogger() }), { expired: 0, failed: 1, resets: 0 });
  assert.equal((await db.getVideoJob(freshJob.id)).status, 'succeeded');
});
