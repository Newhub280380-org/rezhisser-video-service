'use strict';

// Client for the cloud Owl Browser REST API. Pure Node.js (no Electron
// imports) so it can be tested with `npm test` from the repository root.
//
//   POST {api}/execute/browser_create_context  -> { success, result: "<context id>" }
//   POST {api}/execute/browser_navigate        { context_id, url }          (only with a start URL)
//   POST {api}/execute/browser_nla             { context_id, command, async: true } -> 202 { job_id }
//   GET  {api}/jobs/{job_id}                   -> { state: queued|running|done|failed|cancelled, result, error }
//   DELETE {api}/jobs/{job_id}                 (cancel, best effort)
//   POST {api}/execute/browser_close_context   { context_id }
//
// {api} is the instance URL plus /api, e.g. https://trial-04421511.owlbrowser.net/api.

const DEFAULT_OWL_URL = 'https://trial-04421511.owlbrowser.net';
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_TASK_CHARS = 4000;
const MAX_RESULT_CHARS = 20000;
const MAX_RESPONSE_CHARS = 1024 * 1024;

class OwlError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'OwlError';
    this.code = code;
    if (status) this.status = status;
  }
}

function cap(value, max) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

// Accepts https://host, https://host/ or https://host/api/ and returns the
// API base without a trailing slash (https://host/api).
function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(String(value === undefined || value === null ? '' : value).trim());
  } catch {
    throw new OwlError('bad_url', 'Адрес Owl Browser должен быть URL, например https://trial-04421511.owlbrowser.net');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new OwlError('bad_url', 'Адрес Owl Browser должен начинаться с https:// (http:// только для localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OwlError('bad_url', 'Адрес Owl Browser не должен содержать логин, пароль, параметры или #.');
  }
  let pathname = url.pathname;
  while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (!pathname) pathname = '/api';
  return `${url.origin}${pathname}`;
}

function validateTask(value) {
  const task = cap(value === undefined || value === null ? '' : value, MAX_TASK_CHARS + 1);
  if (!task) throw new OwlError('bad_task', 'Опишите задачу.');
  if (task.length > MAX_TASK_CHARS) throw new OwlError('bad_task', `Задача длиннее ${MAX_TASK_CHARS} символов.`);
  return task;
}

function validateStartUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new OwlError('bad_start_url', 'Стартовый сайт должен быть ссылкой вида https://example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new OwlError('bad_start_url', 'Стартовый сайт должен быть http(s)-ссылкой без логина и пароля.');
  }
  return url.toString();
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
  if (typeof value === 'string') return cap(value, MAX_RESULT_CHARS);
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['summary', 'answer', 'message', 'output', 'text']) {
      if (typeof value[key] === 'string' && value[key].trim()) return cap(value[key], MAX_RESULT_CHARS);
    }
  }
  return cap(JSON.stringify(value, null, 2), MAX_RESULT_CHARS);
}

function failureMessage(data) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  const nested = data && data.result;
  if (nested && typeof nested === 'object') {
    for (const key of ['error', 'message', 'detail', 'reason']) {
      if (typeof nested[key] === 'string' && nested[key].trim()) return nested[key];
    }
  }
  return 'инструмент сообщил об ошибке';
}

function cancelledError() {
  return new OwlError('cancelled', 'Задача остановлена.');
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createOwlClient({
  url = DEFAULT_OWL_URL,
  token = '',
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30000,
  pollIntervalMs = 2000,
  maxWaitMs = 600000,
  sleep = abortableSleep,
  now = Date.now,
} = {}) {
  const apiBase = normalizeApiBase(url);
  const secret = String(token || '').trim();
  const longTimeoutMs = Math.max(120000, requestTimeoutMs * 4);

  async function call(method, path, body, { signal, timeoutMs = requestTimeoutMs } = {}) {
    if (signal && signal.aborted) throw cancelledError();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const onAbort = () => timeout.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (secret) headers.Authorization = ['Bearer', secret].join(' ');
    let res;
    let text = '';
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
        redirect: 'error',
      });
      text = await res.text().catch(() => '');
    } catch {
      if (signal && signal.aborted) throw cancelledError();
      if (timeout.signal.aborted) throw new OwlError('timeout', 'Owl Browser не ответил вовремя.');
      throw new OwlError('unreachable', `Не удалось подключиться к Owl Browser (${apiBase}).`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OwlError('auth_failed', 'Owl Browser отклонил доступ: проверьте токен в настройках.', res.status);
    }
    if (res.status === 429) throw new OwlError('rate_limited', 'Owl Browser: превышен лимит запросов.', res.status);
    if (text.length > MAX_RESPONSE_CHARS) throw new OwlError('bad_response', 'Owl Browser вернул слишком большой ответ.', res.status);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok || !json || typeof json !== 'object') {
      throw new OwlError('http_error', `Owl Browser вернул HTTP ${res.status}.`, res.status);
    }
    return { status: res.status, json };
  }

  async function execute(tool, params, options) {
    const res = await call('POST', `/execute/${tool}`, params, options);
    if (res.status === 202) return res.json;
    if (res.json.success === false) {
      throw new OwlError('tool_failed', `Owl Browser (${tool}): ${cap(failureMessage(res.json), 300)}`);
    }
    return 'result' in res.json ? res.json.result : res.json;
  }

  function contextIdOf(result) {
    const id = typeof result === 'string' ? result : result && result.context_id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new OwlError('bad_response', 'Owl Browser не вернул идентификатор контекста.');
    }
    return id;
  }

  async function waitForJob(jobId, signal, log) {
    const deadline = now() + maxWaitMs;
    let lastState = null;
    for (;;) {
      const { json: job } = await call('GET', `/jobs/${encodeURIComponent(jobId)}`, undefined, { signal });
      const state = typeof job.state === 'string' ? cap(job.state, 40) : 'unknown';
      if (state !== lastState) {
        lastState = state;
        log(`Состояние задачи: ${state}`);
      }
      if (state === 'done') return job.result;
      if (state === 'failed' || state === 'cancelled') {
        const detail = typeof job.error === 'string' && job.error.trim() ? `: ${cap(job.error, 300)}` : '';
        throw new OwlError('task_failed', `Задача завершилась со статусом ${state}${detail}`);
      }
      if (now() >= deadline) throw new OwlError('timeout', 'Owl Browser не завершил задачу за отведённое время.');
      await sleep(pollIntervalMs, signal);
    }
  }

  return {
    apiBase,
    async runTask({ task, startUrl } = {}, { log = () => {}, signal } = {}) {
      const command = validateTask(task);
      const site = validateStartUrl(startUrl);
      log(`Подключение к ${apiBase}`);
      const contextId = contextIdOf(await execute('browser_create_context', {}, { signal }));
      log('Создан изолированный контекст браузера');
      let jobId = null;
      try {
        if (site) {
          await execute('browser_navigate', { context_id: contextId, url: site }, { signal, timeoutMs: longTimeoutMs });
          log(`Открыт сайт ${site}`);
        }
        const submitted = await execute('browser_nla', { context_id: contextId, command, async: true }, { signal, timeoutMs: longTimeoutMs });
        const id = submitted && submitted.job_id;
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
          throw new OwlError('bad_response', 'Owl Browser не вернул идентификатор задачи.');
        }
        jobId = id;
        log(`AI-агент Owl Browser выполняет задачу (job ${jobId})`);
        const result = await waitForJob(jobId, signal, log);
        jobId = null;
        return { summary: summaryOf(result) };
      } finally {
        if (jobId) {
          try {
            await call('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
            log('Задача на сервере отменена');
          } catch {}
        }
        try {
          await execute('browser_close_context', { context_id: contextId });
          log('Контекст браузера закрыт');
        } catch {}
      }
    },
  };
}

module.exports = {
  createOwlClient,
  normalizeApiBase,
  validateTask,
  validateStartUrl,
  unwrapResult,
  summaryOf,
  OwlError,
  DEFAULT_OWL_URL,
  MAX_TASK_CHARS,
};
