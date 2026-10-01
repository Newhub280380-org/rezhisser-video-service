'use strict';

// Stripe Checkout client (fallback provider, global cards incl. USD / CNY /
// KZT). Uses the REST API directly; webhook signatures are verified with the
// endpoint secret (Stripe-Signature, HMAC-SHA256, 5 minute tolerance).

const crypto = require('node:crypto');
const { requestJson, assertHttpsBase, ExternalError } = require('../http-client.js');

const TOLERANCE_SECONDS = 300;

function formEncode(params, prefix = '', out = []) {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out.join('&');
}

function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || header.length > 4096 || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/.test(value || '')) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((signature) => crypto.timingSafeEqual(signature, expected));
}

function createStripeClient({ secretKey, webhookSecret, apiBaseUrl = 'https://api.stripe.com/v1', currencies = ['USD', 'CNY', 'KZT', 'RUB'], fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  if (!secretKey) return null;
  const base = assertHttpsBase(apiBaseUrl, 'STRIPE_API_BASE_URL');
  const authorization = ['Bearer', secretKey].join(' ');

  return {
    name: 'stripe',
    currencies,
    webhookConfigured: Boolean(webhookSecret),
    async createPayment({ paymentId, userId, amountMinor, currency, description, returnUrl, cancelUrl }) {
      const res = await requestJson(fetchImpl, `${base}/checkout/sessions`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': paymentId,
        },
        body: formEncode({
          mode: 'payment',
          success_url: returnUrl,
          cancel_url: cancelUrl,
          client_reference_id: paymentId,
          metadata: { paymentId, userId },
          payment_intent_data: { metadata: { paymentId, userId } },
          line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: amountMinor, product_data: { name: description.slice(0, 120) } } }],
        }),
        timeoutMs,
        service: 'stripe',
      });
      if (!res.ok || !res.json || typeof res.json.id !== 'string' || typeof res.json.url !== 'string' || !res.json.url.startsWith('https://')) {
        throw new ExternalError('stripe_error', `Stripe returned HTTP ${res.status}.`, res.status);
      }
      return { providerPaymentId: res.json.id, confirmationUrl: res.json.url };
    },
    verifyWebhook(rawBody, header, nowSeconds) {
      return verifyStripeSignature(rawBody, header, webhookSecret, nowSeconds);
    },
  };
}

module.exports = { createStripeClient, verifyStripeSignature, formEncode };
