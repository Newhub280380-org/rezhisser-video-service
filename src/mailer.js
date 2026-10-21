'use strict';

// Transactional email (password reset) via the Resend HTTP API.
// Without RESEND_API_KEY and MAIL_FROM, send() returns false and does not
// invent a delivery. The account API answers 503 and names the missing variables.

const { requestJson } = require('./http-client.js');

function createMailer({ apiKey, from, fetchImpl = globalThis.fetch, logger = console, apiBaseUrl = 'https://api.resend.com' }) {
  const configured = Boolean(apiKey && from);
  return {
    configured,
    async send({ to, subject, text }) {
      if (!configured) return false;
      const res = await requestJson(fetchImpl, `${apiBaseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: ['Bearer', apiKey].join(' '), 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        timeoutMs: 15000,
        service: 'mail',
      });
      if (!res.ok) logger.error(`mail delivery failed with HTTP ${res.status}`);
      return res.ok;
    },
  };
}

module.exports = { createMailer };
