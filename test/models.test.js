'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlan } = require('../src/director.js');
const {
  DEMO_PROFILES,
  RoutingError,
  buildProviderInput,
  estimateFor,
  loadPaidProfiles,
  publicProfile,
  selectProfile,
  validateImage,
} = require('../src/models.js');
const beta = require('./helpers/beta.js');

// Placeholder model names: these are NOT real, verified Replicate models.
const T2V = {
  id: 'paid-t2v',
  label: 'Тест: текст → видео',
  kind: 'text-to-video',
  replicateModel: 'example-owner/example-t2v',
  input: { prompt: 'prompt', negativePrompt: 'negative_prompt', aspectRatio: 'aspect_ratio', duration: 'duration' },
  fixedInput: { fps: 24 },
  aspectRatios: ['9:16', '16:9'],
  aspectRatioValues: { '9:16': 'portrait' },
  durations: [5, 10],
  strengths: ['vertical'],
  estimatedCostUsd: { 5: 0.4, 10: 0.8 },
};
const I2V = {
  id: 'paid-i2v',
  label: 'Тест: фото → видео',
  kind: 'image-to-video',
  replicateModel: 'example-owner/example-i2v:0123abcd',
  input: { prompt: 'text', image: 'start_image' },
  durations: [5],
  estimatedCostUsd: 0.3,
};

test('routing presets are free and are not a video provider', () => {
  assert.ok(DEMO_PROFILES.length >= 3);
  for (const profile of DEMO_PROFILES) {
    assert.equal(profile.provider, 'local-simulation');
    assert.equal(profile.paid, false);
    assert.equal(profile.realVideo, false);
    assert.equal(profile.estimatedCostUsd, 0);
    assert.ok(Object.isFrozen(profile));
    assert.throws(() => buildProviderInput(profile, createPlan({ product: 'x' })), RoutingError);
  }
  assert.ok(DEMO_PROFILES.some((p) => p.kind === 'image-to-video'));
  assert.ok(DEMO_PROFILES.some((p) => p.kind === 'text-to-video'));
});

test('paid profiles are strictly validated from operator JSON', () => {
  const [t2v, i2v] = loadPaidProfiles({ profilesJson: JSON.stringify([T2V, I2V]) });
  assert.deepEqual(t2v.parsedModel, { owner: 'example-owner', name: 'example-t2v', version: null });
  assert.deepEqual(i2v.parsedModel, { owner: 'example-owner', name: 'example-i2v', version: '0123abcd' });
  assert.equal(estimateFor(t2v, 10), 0.8);
  assert.equal(estimateFor(t2v, 15), null);
  assert.equal(estimateFor(i2v, 5), 0.3);

  const bad = [
    'not json',
    '[]',
    JSON.stringify([{ ...T2V, id: 'demo-x' }]),
    JSON.stringify([{ ...T2V, replicateModel: 'https://evil.example/x' }]),
    JSON.stringify([{ ...T2V, input: {} }]),
    JSON.stringify([{ ...T2V, input: { prompt: 'prompt', extra: 'x' } }]),
    JSON.stringify([{ ...T2V, input: { prompt: 'prompt', image: 'image' } }]),
    JSON.stringify([{ ...I2V, input: { prompt: 'text' } }]),
    JSON.stringify([{ ...T2V, estimatedCostUsd: -1 }]),
    JSON.stringify([{ ...T2V, estimatedCostUsd: 1000 }]),
    JSON.stringify([{ ...T2V, fixedInput: { nested: { a: 1 } } }]),
    JSON.stringify([{ ...T2V, aspectRatios: ['21:9'] }]),
    JSON.stringify([T2V, T2V]),
  ];
  for (const value of bad) {
    assert.throws(() => loadPaidProfiles({ profilesJson: value }), (error) => error.code === 'provider_misconfigured', value);
  }
});

test('legacy REPLICATE_MODEL becomes a prompt-only profile with an optional operator estimate', () => {
  const [legacy] = loadPaidProfiles({ legacyModel: 'acme/video-model', legacyExtraInput: '{"fps":8,"prompt":"ignored"}' });
  assert.equal(legacy.id, 'replicate-default');
  assert.deepEqual(legacy.input, { prompt: 'prompt' });
  assert.deepEqual(legacy.fixedInput, { fps: 8 });
  assert.equal(legacy.estimatedCostUsd, null);
  const [priced] = loadPaidProfiles({ legacyModel: 'acme/video-model', legacyEstimatedCostUsd: '0.25' });
  assert.equal(priced.estimatedCostUsd, 0.25);
});

test('auto routing stays inside the requested tier and explains its choice', () => {
  const paid = loadPaidProfiles({ profilesJson: JSON.stringify([T2V, I2V]) });
  const profiles = [...DEMO_PROFILES, ...paid];
  const plan = createPlan({ product: 'Кофе', platform: 'reels', duration: 10 });

  const demo = selectProfile({ profiles, plan, tier: 'demo' });
  assert.equal(demo.profile.paid, false);
  assert.equal(demo.mode, 'auto');
  assert.ok(demo.rationale.length >= 3);
  assert.ok(demo.rejected.some((item) => item.id === 'demo-product-photo'));

  const chosen = selectProfile({ profiles, plan, tier: 'paid' });
  assert.equal(chosen.profile.id, 'paid-t2v');
  assert.equal(chosen.clipDuration, 10);

  // With a photo, text-only models are rejected and the i2v model is chosen.
  const withImage = selectProfile({ profiles, plan, tier: 'paid', hasImage: true });
  assert.equal(withImage.profile.id, 'paid-i2v');
  assert.equal(withImage.clipDuration, 5);

  // No paid profile fits → error, never a silent fallback to another tier.
  const wide = createPlan({ product: 'Кофе', platform: 'telegram' });
  assert.throws(
    () => selectProfile({ profiles: paid.filter((p) => p.id === 'paid-t2v'), plan: wide, tier: 'paid' }),
    (error) => error.code === 'no_matching_model',
  );
  assert.throws(() => selectProfile({ profiles: DEMO_PROFILES, plan, tier: 'paid' }), (error) => error.code === 'no_models_configured');
  assert.throws(() => selectProfile({ profiles, plan, tier: 'free-money' }), (error) => error.code === 'invalid_tier');
});

test('manual choice is validated and never replaced by another model', () => {
  const paid = loadPaidProfiles({ profilesJson: JSON.stringify([T2V, I2V]) });
  const profiles = [...DEMO_PROFILES, ...paid];
  const plan = createPlan({ product: 'Кофе', platform: 'reels', duration: 5 });
  assert.equal(selectProfile({ profiles, plan, modelId: 'demo-cinematic' }).profile.id, 'demo-cinematic');
  assert.throws(() => selectProfile({ profiles, plan, modelId: 'paid-i2v' }), (error) => error.code === 'image_required');
  assert.throws(() => selectProfile({ profiles, plan, modelId: 'paid-t2v', hasImage: true }), (error) => error.code === 'image_not_supported');
  assert.throws(() => selectProfile({ profiles, plan, modelId: 'owner/any-model' }), (error) => error.code === 'unknown_model');
  const square = createPlan({ product: 'Кофе', platform: 'telegram' });
  assert.throws(() => selectProfile({ profiles, plan: square, modelId: 'paid-t2v' }), (error) => error.code === 'aspect_not_supported');
});

test('buildProviderInput maps the plan onto each profile\'s own input fields', () => {
  const [t2v, i2v] = loadPaidProfiles({ profilesJson: JSON.stringify([T2V, I2V]) });
  const plan = createPlan({ product: 'Кофе', platform: 'reels', duration: 10 });
  assert.deepEqual(buildProviderInput(t2v, plan, { clipDuration: 10 }), {
    fps: 24,
    prompt: plan.modelPrompt,
    negative_prompt: plan.negativePrompt,
    aspect_ratio: 'portrait',
    duration: 10,
  });
  const image = validateImage(beta.PNG_1PX, 262144);
  assert.deepEqual(buildProviderInput(i2v, plan, { clipDuration: 5, image }), { text: plan.modelPrompt, start_image: beta.PNG_1PX });
  assert.throws(() => buildProviderInput(i2v, plan, { clipDuration: 5 }), (error) => error.code === 'image_required');
});

test('image validation checks type, magic bytes and size', () => {
  assert.equal(validateImage(undefined, 1000), null);
  const image = validateImage(beta.PNG_1PX, 262144);
  assert.equal(image.mime, 'image/png');
  assert.match(image.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateImage('data:image/png;base64,' + Buffer.from('not a png at all').toString('base64'), 262144), { code: 'invalid_image' });
  assert.throws(() => validateImage('data:image/svg+xml;base64,PHN2Zz4=', 262144), { code: 'invalid_image' });
  assert.throws(() => validateImage('https://example.com/cat.png', 262144), { code: 'invalid_image' });
  assert.throws(() => validateImage(beta.PNG_1PX, 10), { code: 'image_too_large' });
});

test('public profiles do not leak input mapping or fixed inputs', () => {
  const [t2v] = loadPaidProfiles({ profilesJson: JSON.stringify([T2V]) });
  const pub = publicProfile(t2v);
  assert.equal(pub.input, undefined);
  assert.equal(pub.fixedInput, undefined);
  assert.equal(pub.providerModel, 'example-owner/example-t2v');
});

test('the selected profile\'s endpoint and mapped input are what actually reach the provider', async () => {
  const { fetchImpl, calls } = beta.fakeReplicate();
  const options = beta.paidOptions({
    fetchImpl,
    modelProfilesJson: JSON.stringify([T2V, I2V]),
    replicate: { model: '', estimatedCostUsd: '' },
  });
  await beta.withServer(options, async ({ base }) => {
    const browser = beta.client(base);
    await browser.login();

    // Auto mode → unversioned text-to-video profile → official-model endpoint.
    const brief = { ...beta.BRIEF, duration: 10 };
    const t2v = await browser.quoteAndRun({ brief });
    assert.equal(t2v.quote.json.selection.model.id, 'paid-t2v');
    assert.equal(t2v.quote.json.quote.estimateUsd, 0.8);
    assert.equal(t2v.job.status, 201);
    const done = await browser.waitForTerminal(t2v.job.json.job.id);
    assert.equal(done.status, 'succeeded');
    const first = calls.filter((call) => call.method === 'POST')[0];
    assert.equal(first.url, `${beta.BASE}/models/example-owner/example-t2v/predictions`);
    assert.deepEqual(Object.keys(first.body.input).sort(), ['aspect_ratio', 'duration', 'fps', 'negative_prompt', 'prompt']);
    assert.equal(first.body.input.aspect_ratio, 'portrait');
    assert.equal(first.body.input.duration, 10);
    assert.equal(first.body.version, undefined);

    // With a photo → versioned image-to-video profile → /predictions + version.
    const i2v = await browser.quoteAndRun({ brief, image: beta.PNG_1PX });
    assert.equal(i2v.quote.json.selection.model.id, 'paid-i2v');
    assert.equal(i2v.job.status, 201);
    await browser.waitForTerminal(i2v.job.json.job.id);
    const second = calls.filter((call) => call.method === 'POST')[1];
    assert.equal(second.url, `${beta.BASE}/predictions`);
    assert.equal(second.body.version, '0123abcd');
    assert.deepEqual(Object.keys(second.body.input).sort(), ['start_image', 'text']);
    assert.equal(second.body.input.start_image, beta.PNG_1PX);

    // Clients can't pass arbitrary model ids or provider fields.
    const unknown = await browser.quote({ brief, modelId: 'someone/expensive-model' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown_model');
    const forced = await browser.post('/api/jobs', { brief, tier: 'paid', replicateModel: 'x/y', confirmPaid: true });
    assert.equal(forced.status, 400);
    assert.equal(forced.json.error, 'field_not_allowed');
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});
