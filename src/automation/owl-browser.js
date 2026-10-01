'use strict';

// Owl Browser executor (https://www.owlbrowser.net). Talks to a self-hosted
// Owl Browser HTTP server with the same REST contract as the official SDK:
//
//   POST {base}{prefix}/execute/browser_create_context  -> { success, result: "<context id>" }
//   POST {base}{prefix}/execute/browser_navigate        { context_id, url }
//   POST {base}{prefix}/execute/browser_nla             { context_id, command, async: true } -> 202 { job_id }
//   GET  {base}{prefix}/jobs/{job_id}                   -> { state: queued|running|done|failed|cancelled, result, error }
//   DELETE {base}{prefix}/jobs/{job_id}                 (cancel, best effort)
//   POST {base}{prefix}/execute/browser_close_context   { context_id }
//
// browser_nla is Owl's natural-language agent: the AI provider (LLM) it uses
// is configured on the Owl Browser server. The token, URL and proxies come
// only from server configuration and are never logged or returned to clients.

const { requestJson, assertHttpsBase, ExternalError } = require('../http-client.js');

const NAME = 'owl-browser';
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PROXY_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks5', 'socks5h']);
const MAX_SUMMARY_CHARS = 4000;

function cap(value, max) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function baseUrl(value, allowHttp) {
  if (!allowHttp) return assertHttpsBase(value, 'OWL_BROWSER_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OWL_BROWSER_URL is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OWL_BROWSER_URL must be an http(s) URL without credentials, query or fragment.');
  }
  let text = url.toString();
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

function apiPrefixOf(value) {
  const raw = String(value === undefined || value === null ? '/api' : value).trim();
  if (!raw) return '';
  if (!/^\/?[A-Za-z0-9_\-/]*$/.test(raw)) throw new Error('OWL_BROWSER_API_PREFIX must be a plain path such as /api.');
  let prefix = raw.startsWith('/') ? raw : `/${raw}`;
  while (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  return prefix;
}

// OWL_BROWSER_PROXIES_JSON maps a task region to a proxy URL, for example
// {"EU": "socks5://eu-proxy.example:1080", "US": "http://us-proxy.example:8080"}.
function parseProxies(value) {
  if (!value) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('OWL_BROWSER_PROXIES_JSON is not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OWL_BROWSER_PROXIES_JSON must be a JSON object.');
  const proxies = {};
  for (const [region, proxy] of Object.entries(parsed)) {
    if (!/^[A-Z]{2}$/.test(region)) throw new Error('OWL_BROWSER_PROXIES_JSON keys must be region codes such as EU or US.');
    let url;
    try {
      url = new URL(proxy);
    } catch {
      url = null;
    }
    const type = url ? url.protocol.replace(':', '') : '';
    if (!url || !PROXY_PROTOCOLS.has(type) || !url.hostname) {
      throw new Error(`OWL_BROWSER_PROXIES_JSON: proxy for ${region} must be an http(s) or socks URL.`);
    }
    const params = { proxy_type: type, proxy_host: url.hostname };
    if (url.port) params.proxy_port = Number(url.port);
    if (url.username) params.proxy_username = decodeURIComponent(url.username);
    if (url.password) params.proxy_password = decodeURIComponent(url.password);
    proxies[region] = params;
  }
  return proxies;
}

// Job results are the tool envelope {success, result}, and for browser_nla the
// inner result is often a JSON string. Peel at most three layers.
function unwrapResult(raw) {
  let value = raw;
  for (let i = 0; i < 3; i += 1) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
        continue;
      } catch {
        return value;
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value && Object.keys(value).length <= 3) {
      value = value.result;
      continue;
    }
    break;
  }
  return value;
}

function summaryOf(result) {
  const value = unwrapResult(result);
  if (value === null || value === undefined || value === '') return 'Owl Browser завершил задачу без текстового ответа.';
  if (typeof value === 'string') return cap(value, MAX_SUMMARY_CHARS);
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['summary', 'answer', 'message', 'output', 'text']) {
      if (typeof value[key] === 'string' && value[key].trim()) return cap(value[key], MAX_SUMMARY_CHARS);
    }
  }
  return cap(JSON.stringify(value), MAX_SUMMARY_CHARS);
}

function failureMessage(data) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  const nested = data && data.result;
  if (nested && typeof nested === 'object') {
    for (const key of ['error', 'message', 'detail', 'reason']) {
      if (typeof nested[key] === 'string' && nested[key].trim()) return nested[key];
    }
  }
  return 'tool reported failure';
}

function createOwlBrowserExecutor({
  url,
  token,
  apiPrefix = '/api',
  allowHttp = false,
  proxiesJson = '',
  requestTimeoutMs = 30000,
  pollIntervalMs = 2000,
  maxWaitMs = 600000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  if (!url && !token) return null;
  if (!url || !token) throw new Error('OWL_BROWSER_URL and OWL_BROWSER_TOKEN must be set together.');
  const base = `${baseUrl(url, allowHttp)}${apiPrefixOf(apiPrefix)}`;
  const proxies = parseProxies(proxiesJson);
  const authorization = ['Bearer', token].join(' ');
  const longTimeoutMs = Math.max(120000, requestTimeoutMs * 4);

  async function call(method, path, body, timeoutMs = requestTimeoutMs) {
    const res = await requestJson(fetchImpl, `${base}${path}`, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      service: 'owl_browser',
    });
    if (res.status === 401 || res.status === 403) {
      throw new ExternalError('owl_browser_auth_failed', 'Owl Browser отклонил токен доступа (OWL_BROWSER_TOKEN).', res.status);
    }
    if (res.status === 429) throw new ExternalError('owl_browser_rate_limited', 'Owl Browser: превышен лимит запросов.', res.status);
    if (!res.ok || !res.json) throw new ExternalError('owl_browser_error', `Owl Browser вернул HTTP ${res.status}.`, res.status);
    return res;
  }

  async function execute(tool, params, timeoutMs) {
    const res = await call('POST', `/execute/${tool}`, params, timeoutMs);
    if (res.status === 202) return res.json;
    if (res.json.success === false) {
      throw new ExternalError('owl_browser_tool_failed', `Owl Browser (${tool}): ${cap(failureMessage(res.json), 300)}`);
    }
    return 'result' in res.json ? res.json.result : res.json;
  }

  function contextIdOf(result) {
    const id = typeof result === 'string' ? result : result && result.context_id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ExternalError('owl_browser_bad_response', 'Owl Browser не вернул идентификатор контекста.');
    }
    return id;
  }

  async function waitForJob(jobId, signal, log) {
    const deadline = now() + maxWaitMs;
    let lastState = null;
    for (;;) {
      if (signal && signal.aborted) throw new ExternalError('cancelled', 'Запуск остановлен: сервер завершает работу.');
      const res = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
      const job = res.json;
      const state = typeof job.state === 'string' ? cap(job.state, 40) : 'unknown';
      if (state !== lastState) {
        lastState = state;
        await log(`Owl Browser: состояние задачи — ${state}`);
      }
      if (state === 'done') return job.result;
      if (state === 'failed' || state === 'cancelled') {
        const detail = typeof job.error === 'string' && job.error.trim() ? `: ${cap(job.error, 300)}` : '';
        throw new ExternalError('owl_browser_task_failed', `Owl Browser: задача завершилась со статусом ${state}${detail}`);
      }
      if (now() >= deadline) throw new ExternalError('owl_browser_timeout', 'Owl Browser не завершил задачу за отведённое время.');
      await sleep(pollIntervalMs);
    }
  }

  return {
    name: NAME,
    simulated: false,
    maxWaitMs,
    async run(task, { log = async () => {}, setProviderJobId = async () => {}, signal } = {}) {
      const proxy = proxies[task.region];
      await log(proxy ? `Регион ${task.region}: используется прокси оператора` : `Регион ${task.region}: прокси не настроен, используется IP сервера Owl Browser`);
      const contextId = contextIdOf(await execute('browser_create_context', proxy ? { ...proxy } : {}));
      await log('Owl Browser: создан изолированный контекст браузера');
      let jobId = null;
      try {
        await execute('browser_navigate', { context_id: contextId, url: task.url }, longTimeoutMs);
        await log(`Открыт сайт ${task.url}`);
        const submitted = await execute('browser_nla', { context_id: contextId, command: task.instruction, async: true }, longTimeoutMs);
        jobId = submitted && submitted.job_id;
        if (typeof jobId !== 'string' || !ID_PATTERN.test(jobId)) {
          jobId = null;
          throw new ExternalError('owl_browser_bad_response', 'Owl Browser не вернул идентификатор задачи.');
        }
        await setProviderJobId(jobId);
        await log('AI-агент Owl Browser выполняет инструкцию');
        const result = await waitForJob(jobId, signal, log);
        jobId = null;
        return { summary: summaryOf(result) };
      } finally {
        if (jobId) {
          try {
            await call('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
          } catch {}
        }
        try {
          await execute('browser_close_context', { context_id: contextId });
        } catch {}
      }
    },
  };
}

module.exports = { createOwlBrowserExecutor, parseProxies, unwrapResult, summaryOf, NAME };
