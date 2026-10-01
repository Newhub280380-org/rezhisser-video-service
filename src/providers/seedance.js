'use strict';

// ByteDance Seedance (2.5) video generation via the Ark "content generation
// tasks" API (BytePlus ModelArk internationally, Volcengine Ark in China).
//
//   POST {base}/contents/generations/tasks         -> { id }
//   GET  {base}/contents/generations/tasks/{id}    -> { status, content: { video_url } }
//   DELETE {base}/contents/generations/tasks/{id}  (cancel, best effort)
//
// The model id, API key and base URL come only from server configuration.
// The key is never logged or returned to clients.

const { requestJson, assertHttpsBase, ExternalError } = require('../http-client.js');

const NAME = 'seedance';
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNNING = new Set(['queued', 'running', 'pending', 'processing', 'submitted']);

function parseExtra(value) {
  if (!value) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('SEEDANCE_EXTRA_INPUT_JSON is not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SEEDANCE_EXTRA_INPUT_JSON must be a JSON object.');
  for (const key of ['model', 'content', 'callback_url']) {
    if (key in parsed) throw new Error(`SEEDANCE_EXTRA_INPUT_JSON must not set "${key}".`);
  }
  return parsed;
}

function httpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function createSeedanceProvider({
  apiKey,
  model,
  apiBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3',
  imageRole = 'first_frame',
  resolution = '720p',
  generateAudio = true,
  extraInput = '',
  requestTimeoutMs = 30000,
  maxConcurrent = 4,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) return null;
  if (!model || !MODEL_PATTERN.test(model)) throw new Error('SEEDANCE_MODEL must be set to the Seedance model/endpoint id.');
  const base = assertHttpsBase(apiBaseUrl, 'SEEDANCE_API_BASE_URL');
  const extra = parseExtra(extraInput);
  const authorization = ['Bearer', apiKey].join(' ');
  let active = 0;

  async function call(method, path, body) {
    const res = await requestJson(fetchImpl, `${base}${path}`, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: requestTimeoutMs,
      service: 'seedance',
    });
    if (!res.ok || !res.json) {
      const detail = res.json && res.json.error && typeof res.json.error.code === 'string' ? `: ${res.json.error.code.slice(0, 80)}` : '';
      throw new ExternalError('seedance_error', `Seedance returned HTTP ${res.status}${detail}.`, res.status);
    }
    return res.json;
  }

  return {
    name: NAME,
    model,
    realVideoGeneration: true,
    canAccept: () => active < maxConcurrent,
    acquire() {
      active += 1;
      let released = false;
      return () => {
        if (!released) active -= 1;
        released = true;
      };
    },
    activeCount: () => active,
    buildRequest({ prompt, image, aspect, duration }) {
      const content = [{ type: 'text', text: prompt }];
      if (image) content.push({ type: 'image_url', image_url: { url: image }, role: imageRole });
      return {
        ...extra,
        model,
        content,
        ratio: aspect || 'adaptive',
        duration,
        resolution,
        generate_audio: generateAudio,
      };
    },
    async submit(input) {
      const data = await call('POST', '/contents/generations/tasks', this.buildRequest(input));
      const id = data.id || data.task_id;
      if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) throw new ExternalError('seedance_bad_response', 'Seedance did not return a task id.');
      return id;
    },
    async get(taskId) {
      if (!TASK_ID_PATTERN.test(taskId)) throw new ExternalError('seedance_bad_task', 'Invalid task id.');
      const data = await call('GET', `/contents/generations/tasks/${encodeURIComponent(taskId)}`);
      const status = String(data.status || '').toLowerCase();
      if (status === 'succeeded') {
        const videoUrl = httpsUrl((data.content && data.content.video_url) || (data.result && data.result.video_url));
        if (!videoUrl) return { status: 'failed', error: { code: 'no_output', message: 'Seedance finished without a video URL.' } };
        return { status: 'succeeded', videoUrl, duration: Number(data.duration) || null };
      }
      if (RUNNING.has(status)) return { status: 'processing' };
      const error = data.error && typeof data.error === 'object' ? data.error : {};
      return {
        status: 'failed',
        error: {
          code: typeof error.code === 'string' ? error.code.slice(0, 80) : status || 'failed',
          message: typeof error.message === 'string' ? error.message.slice(0, 300) : 'Seedance generation failed.',
        },
      };
    },
    async cancel(taskId) {
      if (!TASK_ID_PATTERN.test(taskId)) return;
      await call('DELETE', `/contents/generations/tasks/${encodeURIComponent(taskId)}`).catch(() => null);
    },
  };
}

module.exports = { createSeedanceProvider, NAME };
