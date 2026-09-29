'use strict';

// Browser-facing checks for the bundled UI: it is served same-origin with a
// strict CSP, contains no secrets or unsafe HTML sinks, and every element the
// script needs exists in the page. The demo flow is exercised over HTTP with
// a fetch that fails if anything tries to reach the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_DIR, ROUTES } = require('../src/static.js');
const beta = require('./helpers/beta.js');

const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
// Code without block and line comments (string contents are kept).
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the UI is served at /, /app and /app/ with a strict CSP', async () => {
  await beta.withServer({}, async ({ base }) => {
    for (const pathname of ['/', '/app', '/app/']) {
      const res = await fetch(`${base}${pathname}`);
      assert.equal(res.status, 200, pathname);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await res.text(), /Демо \/ без настоящего видео/);
    }
    for (const [route, entry] of Object.entries(ROUTES)) {
      if (!route.startsWith('/assets/')) continue;
      const res = await fetch(`${base}${route}`);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get('content-type'), entry.type);
    }
    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  });
});

test('only allowlisted files are served (no traversal or directory listing)', async () => {
  await beta.withServer({}, async ({ base }) => {
    for (const pathname of [
      '/public/index.html',
      '/assets/../src/server.js',
      '/assets/%2e%2e/src/server.js',
      '/assets/',
      '/package.json',
      '/.env',
      '/index.html',
    ]) {
      const res = await fetch(`${base}${pathname}`);
      assert.equal(res.status, 404, pathname);
      assert.match(res.headers.get('content-type'), /application\/json/);
    }
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 404);
  });
});

test('public assets contain no unsafe HTML sinks, eval or third-party origins', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('"]) {
    assert.ok(!jsCode.includes(sink), `app.js must not use ${sink}`);
  }
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc="\/assets\/app\.js")/i, 'no inline scripts');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\sstyle=/i, 'no inline styles (CSP)');
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html + css, /https?:\/\/(?!www\.w3\.org)/i, 'no third-party origins');
  assert.doesNotMatch(jsCode, /https?:\/\/(?!www\.w3\.org)/i, 'the script only talks to its own origin');
});

test('public assets contain no secrets or provider tokens', () => {
  for (const [name, content] of [['index.html', html], ['app.js', js], ['app.css', css]]) {
    assert.doesNotMatch(content, /r8_[A-Za-z0-9]{10,}/, `${name}: Replicate token`);
    assert.doesNotMatch(content, /sk-[A-Za-z0-9]{10,}/, `${name}: API key`);
    assert.doesNotMatch(content, /BETA_ACCESS_KEY\s*=/, `${name}: access key value`);
    assert.doesNotMatch(content, /REPLICATE_API_TOKEN/, `${name}: token variable`);
  }
});

test('every element id used by the script exists in the page', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]));
  assert.ok(used.size > 20);
  for (const id of used) assert.ok(ids.has(id), `#${id} is missing from index.html`);
  assert.equal(ids.size, [...html.matchAll(/\sid="([^"]+)"/g)].length, 'ids are unique');
});

test('the page has accessibility basics and honest labels', () => {
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  // Every form control has a label.
  for (const match of html.matchAll(/<(input|select|textarea)\b[^>]*\sid="([^"]+)"[^>]*>/g)) {
    const [tag, , id] = match;
    if (/type="(hidden|radio|checkbox)"/.test(tag)) continue;
    assert.ok(html.includes(`for="${id}"`) || /aria-label(ledby)?=/.test(tag), `#${id} needs a label`);
  }
  assert.match(html, /по правилам/);
  assert.match(html, /pazi\.dev/);
  assert.match(js, /видео не создавалось/);
});

test('the demo flow works over HTTP with no network access at all', async () => {
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    throw new Error('no network in demo');
  };
  await beta.withServer({ fetchImpl, simulationDurationMs: 30 }, async ({ base }) => {
    const browser = beta.client(base);
    const config = (await browser.get('/api/config')).json;
    assert.ok(config.options.goals.length > 0);
    assert.ok(config.models.length >= 3);

    const planned = await browser.post('/api/director/plan', { brief: { ...beta.BRIEF, product: '<img src=x onerror=alert(1)>' } });
    assert.equal(planned.status, 200);
    // Text is returned as JSON data; the UI renders it with textContent only.
    assert.match(planned.headers.get('content-type'), /application\/json/);
    assert.ok(planned.json.plan.shots.length >= 2);

    const created = await browser.post('/api/jobs', { brief: beta.BRIEF, modelId: planned.json.selection.model.id });
    assert.equal(created.status, 201);
    const done = await browser.waitForTerminal(created.json.job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.simulated, true);
    assert.equal(done.result.videoUrl, null);
    assert.equal(done.plan.engine, 'rule-based-v1');

    const i2v = await browser.post('/api/jobs', { brief: beta.BRIEF, modelId: 'demo-product-photo' });
    assert.equal(i2v.status, 422);
    assert.equal(i2v.json.error, 'image_required');
    const withPhoto = await browser.post('/api/jobs', { brief: beta.BRIEF, modelId: 'demo-product-photo', image: beta.PNG_1PX });
    assert.equal(withPhoto.status, 201);
    assert.equal(withPhoto.json.job.hasImage, true);
    assert.ok(!JSON.stringify(withPhoto.json).includes(beta.PNG_1PX), 'uploaded image is not echoed back');
  });
  assert.equal(networkCalls, 0);
});
