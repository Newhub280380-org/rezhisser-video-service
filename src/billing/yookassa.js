'use strict';

// YooKassa (ex Yandex.Kassa) client: https://yookassa.ru/developers/api
// Primary provider for RUB (and KZT where the shop contract allows it).
// Webhook notifications are not signed by YooKassa, so every notification is
// verified by re-reading the object from the API with the shop credentials.

const { requestJson, assertHttpsBase, ExternalError } = require('../http-client.js');

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function formatAmount(minor) {
  return (minor / 100).toFixed(2);
}

function parseAmount(amount) {
  if (!amount || typeof amount.value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount.value)) return null;
  const [whole, fraction = ''] = amount.value.split('.');
  return { minor: Number(whole) * 100 + Number(fraction.padEnd(2, '0')), currency: amount.currency };
}

function createYooKassaClient({ shopId, secretKey, apiBaseUrl = 'https://api.yookassa.ru/v3', currencies = ['RUB'], fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  if (!shopId || !secretKey) return null;
  const base = assertHttpsBase(apiBaseUrl, 'YOOKASSA_API_BASE_URL');
  const authorization = `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;

  async function call(method, path, body, idempotenceKey) {
    const headers = { Authorization: authorization, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
    const res = await requestJson(fetchImpl, `${base}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs, service: 'yookassa',
    });
    if (!res.ok || !res.json) {
      throw new ExternalError('yookassa_error', `YooKassa returned HTTP ${res.status}.`, res.status);
    }
    return res.json;
  }

  return {
    name: 'yookassa',
    currencies,
    async createPayment({ paymentId, userId, amountMinor, currency, description, returnUrl }) {
      const data = await call(
        'POST',
        '/payments',
        {
          amount: { value: formatAmount(amountMinor), currency },
          capture: true,
          confirmation: { type: 'redirect', return_url: returnUrl },
          description: description.slice(0, 128),
          metadata: { paymentId, userId },
        },
        paymentId,
      );
      const url = data.confirmation && data.confirmation.confirmation_url;
      if (typeof data.id !== 'string' || !ID_PATTERN.test(data.id) || typeof url !== 'string' || !url.startsWith('https://')) {
        throw new ExternalError('yookassa_bad_response', 'YooKassa response has no confirmation URL.');
      }
      return { providerPaymentId: data.id, confirmationUrl: url };
    },
    async getPayment(id) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      const data = await call('GET', `/payments/${encodeURIComponent(id)}`);
      return { id: data.id, status: data.status, paid: data.paid === true, amount: parseAmount(data.amount), metadata: data.metadata || {} };
    },
    async getRefund(id) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      const data = await call('GET', `/refunds/${encodeURIComponent(id)}`);
      return { id: data.id, status: data.status, paymentId: data.payment_id, amount: parseAmount(data.amount) };
    },
  };
}

module.exports = { createYooKassaClient, formatAmount, parseAmount };
