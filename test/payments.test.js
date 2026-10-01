'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyStripeSignature, formEncode } = require('../src/billing/stripe.js');
const { parseAmount, formatAmount } = require('../src/billing/yookassa.js');
const { loadProducts, DEFAULT_PRODUCTS } = require('../src/billing/plans.js');
const { withServer, fakeServices, productionOptions, accountClient, STRIPE_WEBHOOK_SECRET, YOOKASSA_BASE, STRIPE_BASE } = require('./helpers/production.js');

function stripeHeader(raw, secret = STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function stripeWebhook(base, event, header) {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/payment/webhook/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header === undefined ? stripeHeader(raw) : header },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

async function yookassaWebhook(base, event, id) {
  const res = await fetch(`${base}/api/payment/webhook/yookassa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The notification body is deliberately misleading: only the id is used.
    body: JSON.stringify({ type: 'notification', event, object: { id, status: 'succeeded', paid: true, amount: { value: '0.01', currency: 'RUB' } } }),
  });
  return { status: res.status, json: await res.json() };
}

test('amount helpers and signature verification', () => {
  assert.equal(formatAmount(45000), '450.00');
  assert.deepEqual(parseAmount({ value: '450.00', currency: 'RUB' }), { minor: 45000, currency: 'RUB' });
  assert.deepEqual(parseAmount({ value: '5', currency: 'USD' }), { minor: 500, currency: 'USD' });
  assert.equal(parseAmount({ value: '-1', currency: 'USD' }), null);
  assert.equal(formEncode({ a: { b: [1, 'x y'] } }), 'a%5Bb%5D%5B0%5D=1&a%5Bb%5D%5B1%5D=x%20y');

  const raw = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  assert.equal(verifyStripeSignature(raw, stripeHeader(raw, 'whsec_x', now), 'whsec_x', now), true);
  assert.equal(verifyStripeSignature(raw, stripeHeader(raw, 'whsec_y', now), 'whsec_x', now), false);
  assert.equal(verifyStripeSignature(`${raw} `, stripeHeader(raw, 'whsec_x', now), 'whsec_x', now), false);
  assert.equal(verifyStripeSignature(raw, stripeHeader(raw, 'whsec_x', now - 301), 'whsec_x', now), false);
  assert.equal(verifyStripeSignature(raw, undefined, 'whsec_x', now), false);
});

test('plans: default prices cover all currencies and PRICES_JSON overrides them', () => {
  for (const product of Object.values(DEFAULT_PRODUCTS)) {
    for (const currency of ['RUB', 'KZT', 'USD', 'CNY']) assert.ok(product.prices[currency] > 0, `${product.id} ${currency}`);
  }
  assert.equal(DEFAULT_PRODUCTS.pro.prices.USD, 500);
  assert.equal(DEFAULT_PRODUCTS.studio.prices.USD, 2000);
  const products = loadProducts(JSON.stringify({ pro: { RUB: 49900 } }));
  assert.equal(products.pro.prices.RUB, 49900);
  assert.equal(products.pro.prices.USD, 500);
  assert.throws(() => loadProducts('{"pro":{"RUB":-1}}'));
  assert.throws(() => loadProducts('not json'));
});

test('GET /api/plans lists tiers, products and providers', async () => {
  await withServer(productionOptions(fakeServices()), async ({ base }) => {
    const res = await fetch(`${base}/api/plans`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.tiers.map((t) => t.id), ['free', 'pro', 'studio']);
    assert.deepEqual(body.currencies, ['RUB', 'KZT', 'USD', 'CNY']);
    assert.ok(body.products.some((p) => p.id === 'credits_10'));
    assert.deepEqual(body.paymentProviders.map((p) => p.name), ['yookassa', 'stripe']);
    assert.equal(body.generation.available, true);
  });
});

test('YooKassa checkout → verified webhook grants Pro; refund revokes it', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    const api = accountClient(base);
    assert.equal((await api.post('/api/payment/checkout', { product: 'pro', currency: 'RUB' })).status, 401);
    await api.register();

    assert.equal((await api.post('/api/payment/checkout', { product: 'gold', currency: 'RUB' })).status, 400);
    assert.equal((await api.post('/api/payment/checkout', { product: 'pro', currency: 'EUR' })).status, 400);

    const checkout = await api.post('/api/payment/checkout', { product: 'pro', currency: 'rub' });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.json.payment.provider, 'yookassa');
    assert.equal(checkout.json.payment.amount, '450.00');
    assert.equal(checkout.json.payment.status, 'pending');
    assert.match(checkout.json.confirmationUrl, /^https:\/\/yoomoney\.test\//);

    const create = services.calls.find((c) => c.url === `${YOOKASSA_BASE}/payments` && c.method === 'POST');
    assert.equal(create.headers['Idempotence-Key'], checkout.json.payment.id);
    assert.match(create.headers.Authorization, /^Basic /);
    const sent = JSON.parse(create.body);
    assert.deepEqual(sent.amount, { value: '450.00', currency: 'RUB' });
    assert.equal(sent.capture, true);
    assert.match(sent.confirmation.return_url, new RegExp(`/studio#/dashboard\\?payment=${checkout.json.payment.id}$`));

    const providerId = [...services.yookassa.payments.keys()][0];

    // A notification for a still-pending payment changes nothing.
    assert.deepEqual((await yookassaWebhook(base, 'payment.succeeded', providerId)).json, { received: true, handled: false });
    assert.equal((await api.get('/api/user/profile')).json.subscription.tier, 'free');
    // Unknown payments are ignored.
    assert.equal((await yookassaWebhook(base, 'payment.succeeded', 'yk-unknown-0001')).json.handled, false);

    services.yookassa.succeed(providerId);
    assert.equal((await yookassaWebhook(base, 'payment.succeeded', providerId)).json.handled, true);
    // Replays are idempotent.
    assert.equal((await yookassaWebhook(base, 'payment.succeeded', providerId)).json.handled, false);

    const profile = await api.get('/api/user/profile');
    assert.equal(profile.json.subscription.tier, 'pro');
    assert.equal(profile.json.subscription.periodVideosLimit, 50);
    assert.equal(profile.json.subscription.canGenerate, true);
    const expires = Date.parse(profile.json.subscription.subscriptionExpiresAt);
    assert.ok(Math.abs(expires - (Date.now() + 30 * 24 * 3600 * 1000)) < 60000);

    const history = await api.get('/api/payment/history');
    assert.equal(history.json.payments[0].status, 'succeeded');
    assert.ok(history.json.usage.some((e) => e.kind === 'subscription'));

    // Partial refund: recorded by YooKassa, access kept.
    services.yookassa.refund('rf-partial-0001', providerId, '100.00');
    assert.equal((await yookassaWebhook(base, 'refund.succeeded', 'rf-partial-0001')).json.handled, false);
    services.yookassa.refund('rf-full-00000001', providerId);
    assert.equal((await yookassaWebhook(base, 'refund.succeeded', 'rf-full-00000001')).json.handled, true);
    assert.equal((await api.get('/api/user/profile')).json.subscription.tier, 'free');
    assert.equal((await api.get('/api/payment/history')).json.payments[0].status, 'refunded');
  });
});

test('YooKassa: amount mismatch is rejected, cancellation is recorded', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    const api = accountClient(base);
    await api.register();
    await api.post('/api/payment/checkout', { product: 'credits_10', currency: 'KZT' });
    await api.post('/api/payment/checkout', { product: 'credits_10', currency: 'RUB' });
    const [first, second] = [...services.yookassa.payments.keys()];

    services.yookassa.succeed(first);
    services.yookassa.payments.get(first).amount = { value: '1.00', currency: 'KZT' };
    assert.equal((await yookassaWebhook(base, 'payment.succeeded', first)).json.handled, false);
    assert.equal((await api.get('/api/user/profile')).json.subscription.credits, 0);

    services.yookassa.cancel(second);
    assert.equal((await yookassaWebhook(base, 'payment.canceled', second)).json.handled, true);
    const statuses = (await api.get('/api/payment/history')).json.payments.map((p) => p.status).sort();
    assert.deepEqual(statuses, ['canceled', 'pending']);

    const bad = await fetch(`${base}/api/payment/webhook/yookassa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":1}' });
    assert.equal(bad.status, 400);
  });
});

test('YooKassa outage: checkout fails cleanly and the payment is canceled', async () => {
  const services = fakeServices();
  services.control.yookassaCreateStatus = 500;
  await withServer(productionOptions(services), async ({ base }) => {
    const api = accountClient(base);
    await api.register();
    const res = await api.post('/api/payment/checkout', { product: 'pro', currency: 'RUB' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'payment_provider_error');
    assert.equal((await api.get('/api/payment/history')).json.payments[0].status, 'canceled');
  });
});

test('Stripe fallback for USD/CNY: signed webhook grants credits, refund revokes', async () => {
  const services = fakeServices();
  await withServer(productionOptions(services), async ({ base }) => {
    const api = accountClient(base);
    await api.register();
    assert.equal((await api.post('/api/payment/checkout', { product: 'pro', currency: 'USD', provider: 'yookassa' })).status, 400);

    const checkout = await api.post('/api/payment/checkout', { product: 'credits_50', currency: 'CNY' });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.json.payment.provider, 'stripe');
    assert.match(checkout.json.confirmationUrl, /^https:\/\/checkout\.stripe\.test\//);
    const create = services.calls.find((c) => c.url === `${STRIPE_BASE}/checkout/sessions`);
    assert.equal(create.headers['Idempotency-Key'], checkout.json.payment.id);
    const form = new URLSearchParams(create.body);
    assert.equal(form.get('line_items[0][price_data][currency]'), 'cny');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '4300');
    assert.equal(form.get('client_reference_id'), checkout.json.payment.id);

    const providerSessionId = `cs_test_${services.calls.indexOf(create) + 1}`;
    const completed = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: providerSessionId, payment_status: 'paid', amount_total: 4300, currency: 'cny', payment_intent: 'pi_test_1' } },
    };

    assert.equal((await stripeWebhook(base, completed, 't=1,v1=00')).status, 400);
    assert.equal((await stripeWebhook(base, completed, stripeHeader(JSON.stringify(completed), 'whsec_wrong'))).status, 400);
    const tampered = { ...completed, data: { object: { ...completed.data.object, amount_total: 1 } } };
    assert.equal((await stripeWebhook(base, tampered)).json.handled, false);

    assert.equal((await stripeWebhook(base, completed)).json.handled, true);
    assert.equal((await stripeWebhook(base, completed)).json.handled, false);
    assert.equal((await api.get('/api/user/profile')).json.subscription.credits, 50);

    const refunded = { id: 'evt_2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_test_1', refunded: true } } };
    assert.equal((await stripeWebhook(base, refunded)).json.handled, true);
    assert.equal((await api.get('/api/user/profile')).json.subscription.credits, 0);
  });
});

test('Stripe webhooks are disabled without a webhook secret', async () => {
  await withServer(productionOptions(fakeServices(), { stripe: { webhookSecret: '' } }), async ({ base }) => {
    assert.equal((await stripeWebhook(base, { type: 'x', data: { object: {} } })).status, 404);
  });
});

test('payments are unavailable when no provider is configured', async () => {
  await withServer(productionOptions(fakeServices(), { yookassa: { shopId: '' }, stripe: { secretKey: '' } }), async ({ base }) => {
    const api = accountClient(base);
    await api.register();
    const res = await api.post('/api/payment/checkout', { product: 'pro', currency: 'RUB' });
    assert.equal(res.status, 503);
    assert.equal((await yookassaWebhook(base, 'payment.succeeded', 'yk-00000001')).status, 404);
  });
});
