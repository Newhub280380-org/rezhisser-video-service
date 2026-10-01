'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibrary, loadItems } = require('../src/library/index.js');
const { withServer, fakeServices, productionOptions } = require('./helpers/production.js');

const library = createLibrary();

test('library covers every SNS country and a separate Chinese stream', () => {
  const by = (field, value) => library.items.filter((item) => item[field] === value).length;
  for (const country of ['ru', 'kz', 'tj', 'uz', 'kg']) assert.ok(by('country', country) >= 5, country);
  assert.ok(by('region', 'china') >= 25);
  for (const item of library.items.filter((i) => i.region === 'china')) {
    assert.equal(item.language, 'zh', item.id);
    assert.match(item.prompt, /[\u4e00-\u9fff]/, `${item.id} prompt is Chinese`);
  }
  for (const item of library.items.filter((i) => i.region === 'sng')) assert.equal(item.language, 'ru', item.id);
  for (const category of ['beauty', 'tech', 'fashion', 'luxury', 'memes', 'live-commerce']) {
    assert.ok(library.items.some((i) => i.region === 'china' && i.category === category), `china ${category}`);
  }
  for (const [country, category] of [['ru', 'memes'], ['kz', 'halal'], ['tj', 'crafts'], ['uz', 'cotton'], ['kg', 'tourism']]) {
    assert.ok(library.items.some((i) => i.country === country && i.category === category), `${country} ${category}`);
  }
});

test('every item is a complete, ready-to-generate template', () => {
  for (const item of library.items) {
    assert.ok(item.promptEn.length >= 40, item.id);
    assert.ok(item.template.shots.length >= 2, item.id);
    assert.equal(/https?:\/\//.test(JSON.stringify(item)), false, `${item.id} has no external links`);
  }
});

test('the two-cosmetologists lip-sync meme is in the library', () => {
  const meme = library.get('sng-meme-001');
  assert.ok(meme);
  assert.equal(meme.type, 'meme');
  const lines = meme.template.dialogue.map((d) => d.line).join(' ');
  assert.match(lines, /сапоги/i);
  assert.match(`${meme.prompt} ${meme.promptEn}`, /lip|губ/i);
  assert.ok(library.items.some((i) => i.region === 'china' && i.type === 'meme' && /对口型|lip/i.test(`${i.prompt} ${i.promptEn}`)));
});

test('search filters, paginates and validates input', () => {
  const zh = library.search({ language: 'zh', category: 'beauty' });
  assert.ok(zh.total >= 5);
  assert.ok(zh.items.every((i) => i.language === 'zh' && i.category === 'beauty'));
  assert.equal(zh.items[0].prompt, undefined, 'search returns summaries');

  const text = library.search({ query: 'сапоги' });
  assert.ok(text.items.some((i) => i.id === 'sng-meme-001'));

  const page = library.search({ limit: 5, offset: 5 });
  assert.equal(page.items.length, 5);
  assert.equal(page.total, library.size);
  assert.ok(page.facets.region.sng > 0 && page.facets.region.china > 0);

  assert.throws(() => library.search({ category: 'weapons' }), (e) => e.code === 'invalid_filter');
  assert.throws(() => library.search({ query: 'x'.repeat(201) }), (e) => e.code === 'invalid_filter');
  assert.throws(() => loadItems([{ items: [library.items[0], library.items[0]] }]), /duplicate/);
});

test('POST /api/library/search and GET /api/library/:id are public', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    const res = await fetch(`${base}/api/library/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'china', type: 'live-commerce' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total >= 5);
    assert.ok(body.items.every((i) => i.type === 'live-commerce'));

    const bad = await fetch(`${base}/api/library/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"country":"xx"}' });
    assert.equal(bad.status, 400);

    const item = await fetch(`${base}/api/library/sng-meme-001`);
    assert.equal(item.status, 200);
    const full = (await item.json()).item;
    assert.ok(full.prompt && full.promptEn && full.negativePrompt && full.template.dialogue.length >= 2);

    assert.equal((await fetch(`${base}/api/library/nope-404`)).status, 404);
    assert.equal((await fetch(`${base}/api/library/..%2F..%2Fpackage.json`)).status, 404);
  });
});
