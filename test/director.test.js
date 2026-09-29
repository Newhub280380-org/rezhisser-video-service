'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BriefError,
  DURATIONS,
  ENGINE,
  briefHash,
  createPlan,
  validateAdvisorSetting,
  validateBrief,
} = require('../src/director.js');

const BRIEF = {
  product: 'Кофейня «Зерно»',
  offer: 'Второй капучино бесплатно',
  audience: 'Студенты',
  goal: 'conversion',
  platform: 'reels',
  duration: 15,
  mood: 'warm',
  voice: 'friendly',
  cta: 'Заходите сегодня',
};

test('the director is deterministic and labelled as rule-based, not AI', () => {
  const a = createPlan(BRIEF);
  const b = createPlan({ ...BRIEF });
  assert.deepEqual(a, b);
  assert.equal(a.engine, ENGINE);
  assert.equal(a.engine, 'rule-based-v1');
  assert.match(a.engineLabel, /без ИИ/);
  assert.equal(a.briefHash, briefHash(a.brief));
  assert.notEqual(createPlan({ ...BRIEF, product: 'Чай' }).briefHash, a.briefHash);
});

test('plans contain a hook, CTA, creative brief, visual direction and prompt', () => {
  const plan = createPlan(BRIEF);
  for (const key of ['hook', 'cta', 'modelPrompt', 'negativePrompt']) {
    assert.equal(typeof plan[key], 'string');
    assert.ok(plan[key].length > 0, key);
  }
  assert.equal(plan.cta, 'Заходите сегодня');
  assert.ok(plan.creativeBrief && typeof plan.creativeBrief === 'object');
  assert.ok(plan.visualDirection && typeof plan.visualDirection === 'object');
  assert.ok(plan.modelPrompt.length <= 2000);
  // Platform defaults fill in the aspect ratio.
  assert.equal(plan.brief.aspect, '9:16');
});

test('shot timings cover the whole duration without gaps for every allowed duration', () => {
  for (const duration of DURATIONS) {
    const { shots } = createPlan({ ...BRIEF, duration });
    assert.ok(shots.length >= 2, `duration ${duration}`);
    assert.equal(shots[0].start, 0);
    assert.equal(shots[shots.length - 1].end, duration);
    for (let i = 1; i < shots.length; i += 1) {
      assert.equal(shots[i].start, shots[i - 1].end);
      assert.ok(shots[i].end > shots[i].start);
    }
    shots.forEach((shot, index) => assert.equal(shot.n, index + 1));
  }
});

test('brief validation rejects missing product, bad enums and non-string fields', () => {
  assert.throws(() => validateBrief({}), (error) => error instanceof BriefError && error.code === 'product_required');
  assert.throws(() => validateBrief(null), BriefError);
  assert.throws(() => validateBrief({ product: 'x', goal: 'hack' }), (error) => error.field === 'goal');
  assert.throws(() => validateBrief({ product: 'x', duration: 7 }), (error) => error.field === 'duration');
  assert.throws(() => validateBrief({ product: 'x', aspect: '3:2' }), (error) => error.field === 'aspect');
  assert.throws(() => validateBrief({ product: { toString: () => 'x' } }), BriefError);
  assert.throws(() => validateBrief({ product: 'x'.repeat(500) }), BriefError);
});

test('brief text is cleaned of control characters and markup is kept as plain text', () => {
  const brief = validateBrief({ product: '  <img src=x onerror=alert(1)>\u0000 Кофе  ' });
  assert.ok(!brief.product.includes('\u0000'));
  assert.equal(brief.product.trim(), brief.product);
  // The server never renders HTML; the UI uses textContent. The text is data.
  const plan = createPlan({ product: '<script>alert(1)</script>' });
  assert.equal(typeof plan.hook, 'string');
});

test('the optional LLM advisor is off and unknown advisors fail closed at startup', () => {
  assert.doesNotThrow(() => validateAdvisorSetting('none'));
  assert.doesNotThrow(() => validateAdvisorSetting(''));
  assert.doesNotThrow(() => validateAdvisorSetting(undefined));
  assert.throws(() => validateAdvisorSetting('openai'));
  assert.throws(() => validateAdvisorSetting('anthropic'));
});
