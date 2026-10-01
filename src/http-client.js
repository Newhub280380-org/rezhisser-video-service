'use strict';

// Minimal outbound HTTP helper for third-party APIs (payments, video, mail).
// Every request has a timeout and a response-size cap; credentials are never
// included in error messages.

const MAX_RESPONSE_CHARS = 1024 * 1024;

class ExternalError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ExternalError';
    this.code = code;
    if (status) this.status = status;
  }
}

function assertHttpsBase(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${name} must use https.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query string or a fragment.`);
  }
  let text = url.toString();
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 30000, service = 'external' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    throw new ExternalError(
      controller.signal.aborted ? `${service}_timeout` : `${service}_unreachable`,
      controller.signal.aborted ? `${service} request timed out.` : `${service} is unreachable.`,
    );
  } finally {
    clearTimeout(timer);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (text.length > MAX_RESPONSE_CHARS) throw new ExternalError(`${service}_bad_response`, `${service} response is too large.`, res.status);
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json };
}

module.exports = { requestJson, assertHttpsBase, ExternalError };
