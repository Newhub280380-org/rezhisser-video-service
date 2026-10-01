'use strict';

// Static and HTTP checks for the Studio SPA (/studio): strict CSP, no unsafe
// sinks or third-party origins, all referenced elements and translations
// (ru / 中文) exist, and the bearer token never leaves the origin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { PUBLIC_DIR } = require('../src/static.js');
const { withServer } = require('./helpers/beta.js');

const html = fs.readFileSync(path.join(PUBLIC_DIR, 'studio.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC_DIR, 'studio.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC_DIR, 'studio.css'), 'utf8');
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function dictionaries() {
  const start = js.indexOf('var I18N = {');
  const end = js.indexOf('\n  };', start);
  assert.ok(start > 0 && end > start, 'I18N block found');
  return vm.runInNewContext(`(${js.slice(start + 'var I18N = '.length, end + 4)})`);
}

test('/studio is served with the strict CSP', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/studio`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    const body = await res.text();
    assert.match(body, /\/assets\/studio\.js/);
    for (const asset of ['/assets/studio.js', '/assets/studio.css']) assert.equal((await fetch(`${base}${asset}`)).status, 200);
  });
});

test('studio assets have no unsafe sinks, inline code or third-party origins', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!jsCode.includes(sink), `studio.js must not use ${sink}`);
  }
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc="\/assets\/studio\.js")/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html + css + jsCode, /https?:\/\/(?!www\.w3\.org)/i);
  assert.doesNotMatch(html + js, /r8_[A-Za-z0-9]{10,}|sk_live_|live_[A-Za-z0-9]{20,}/);
});

test('every element the script uses exists and every label is translated', () => {
  const ids = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 20);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} exists`);

  const { ru, zh } = dictionaries();
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40);
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(ru, key), `ru.${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh.${key}`);
  }
  for (const key of Object.keys(ru)) assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh.${key} mirrors ru`);
  assert.match(Object.values(zh).join(''), /[\u4e00-\u9fff]/);
});

test('the client only sends the token to same-origin API paths', () => {
  const fetchCalls = [...jsCode.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(fetchCalls.length > 0);
  for (const arg of fetchCalls) assert.doesNotMatch(arg, /^['"`]?(https?:|\/\/)/, `fetch(${arg})`);
  assert.match(jsCode, /Authorization/);
  // Checkout redirects are restricted to https URLs returned by our API.
  assert.match(jsCode, /indexOf\('https:'\) === 0/);
});

test('the studio covers auth, dashboard, pricing, library, remix and history', () => {
  for (const route of ['library', 'remix', 'login', 'register', 'forgot', 'reset', 'dashboard', 'pricing', 'history']) {
    assert.ok(js.includes(`'${route}'`), `route ${route}`);
  }
  for (const endpoint of ['/api/auth/register', '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/user/profile', '/api/payment/checkout', '/api/payment/history', '/api/library/search', '/api/jobs', '/api/plans']) {
    assert.ok(js.includes(endpoint), endpoint);
  }
});
