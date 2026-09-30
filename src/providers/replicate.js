'use strict';

// Replicate video provider. Uses Node's built-in fetch (no dependencies).
//
// Spend-safety properties:
// - only constructed when VIDEO_PROVIDER=replicate and a token + model are set;
// - the model, input mapping, token and API base URL come from server
//   configuration only (allowlisted model profiles, see src/models.js);
// - billable jobs are gated by src/auth.js and src/spend.js in the server;
// - every HTTP request has a timeout, polling is bounded by maxWaitMs and a
//   hard poll-count cap, and predictions are cancelled (best effort) when the
//   wait budget is exceeded or the service shuts down;
// - the number of concurrent predictions is capped;
// - the API token is never logged or returned in errors.

const NAME = 'replicate';
const AUTH_SCHEME = 'Bearer';

const MODEL_PATTERN = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?::([a-z0-9]+))?$/i;
const PREDICTION_ID_PATTERN = /^[a-z0-9]{1,128}$/i;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_DETAIL_LENGTH = 300;
const OUTPUT_URL_KEYS = ['video', 'url', 'output', 'video_url', 'mp4'];

class ProviderError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function truncate(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

function parseModel(model) {
  const match = typeof model === 'string' ? model.trim().match(MODEL_PATTERN) : null;
  if (!match) {
    throw new ProviderError(
      'provider_misconfigured',
      'REPLICATE_MODEL must look like "owner/model" or "owner/model:version".',
    );
  }
  return { owner: match[1], name: match[2], version: match[3] || null };
}

function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError('provider_misconfigured', 'REPLICATE_API_BASE_URL is not a valid URL.');
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new ProviderError('provider_misconfigured', 'REPLICATE_API_BASE_URL must use https.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError(
      'provider_misconfigured',
      'REPLICATE_API_BASE_URL must not contain credentials, a query string or a fragment.',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function parseExtraInput(value) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProviderError('provider_misconfigured', 'REPLICATE_EXTRA_INPUT_JSON is not valid JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderError(
      'provider_misconfigured',
      'REPLICATE_EXTRA_INPUT_JSON must be a JSON object.',
    );
  }
  return parsed;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// Extracts a video URL from the common Replicate output shapes:
// "https://..." | ["https://...", ...] | { video: "https://..." } |
// { url: "..." } | [{ url: "..." }] ... Only https URLs are accepted.
function extractVideoUrl(output, depth = 0) {
  if (depth > 4 || output === null || output === undefined) return null;
  if (typeof output === 'string') return isHttpsUrl(output) ? output : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = extractVideoUrl(item, depth + 1);
      if (url) return url;
    }
    return null;
  }
  if (typeof output === 'object') {
    for (const key of OUTPUT_URL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(output, key)) {
        const url = extractVideoUrl(output[key], depth + 1);
        if (url) return url;
      }
    }
  }
  return null;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ProviderError('provider_aborted', 'Replicate request was aborted.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('provider_aborted', 'Replicate request was aborted.'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validateReplicateConfig(config = {}) {
  if (!config.apiToken || typeof config.apiToken !== 'string' || !config.apiToken.trim()) {
    throw new ProviderError(
      'provider_misconfigured',
      'VIDEO_PROVIDER=replicate requires REPLICATE_API_TOKEN to be set.',
    );
  }
  if (!config.model && !config.allowNoDefaultModel) {
    throw new ProviderError(
      'provider_misconfigured',
      'VIDEO_PROVIDER=replicate requires REPLICATE_MODEL (or VIDEO_MODEL_PROFILES_JSON) to be set.',
    );
  }
  for (const key of ['pollIntervalMs', 'maxWaitMs', 'requestTimeoutMs', 'maxConcurrent']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new ProviderError('provider_misconfigured', `Replicate option ${key} must be a positive number.`);
    }
  }
  return {
    apiToken: config.apiToken.trim(),
    model: config.model ? parseModel(config.model) : null,
    apiBaseUrl: parseBaseUrl(config.apiBaseUrl || 'https://api.replicate.com/v1'),
    extraInput: parseExtraInput(config.extraInput),
  };
}

function createReplicateProvider(config = {}) {
  const { apiToken, model, apiBaseUrl, extraInput } = validateReplicateConfig(config);
  const { pollIntervalMs, maxWaitMs, requestTimeoutMs, maxConcurrent } = config;
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const sleep = config.sleep || defaultSleep;
  const now = config.now || Date.now;
  const logger = config.logger || console;
  const maxPolls = Math.ceil(maxWaitMs / pollIntervalMs) + 1;
  const active = new Map();
  let closed = false;

  if (typeof fetchImpl !== 'function') {
    throw new ProviderError('provider_misconfigured', 'A fetch implementation is required (Node.js 18+).');
  }

  async function request(method, path, body, outerSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      let res;
      try {
        res = await fetchImpl(`${apiBaseUrl}${path}`, {
          method,
          headers: {
            Authorization: [AUTH_SCHEME, apiToken].join(' '),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        if (timedOut) {
          throw new ProviderError('provider_request_timeout', `Replicate request timed out after ${requestTimeoutMs} ms.`);
        }
        if (outerSignal && outerSignal.aborted) {
          throw new ProviderError('provider_aborted', 'Replicate request was aborted.');
        }
        throw new ProviderError('provider_network_error', 'Could not reach the Replicate API.');
      }

      let text;
      try {
        text = await res.text();
      } catch {
        if (timedOut) {
          throw new ProviderError('provider_request_timeout', `Replicate request timed out after ${requestTimeoutMs} ms.`);
        }
        throw new ProviderError('provider_network_error', 'Failed to read the Replicate API response.');
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        throw new ProviderError('provider_invalid_response', 'Replicate API response was too large.');
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!res.ok) {
        const detail = data && (data.detail || data.title || data.error);
        throw new ProviderError(
          'provider_http_error',
          `Replicate API responded with HTTP ${res.status}.`,
          truncate(detail),
        );
      }
      if (!data || typeof data !== 'object') {
        throw new ProviderError('provider_invalid_response', 'Replicate API returned a non-JSON response.');
      }
      return data;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  // `spec` is either a prompt string (legacy single REPLICATE_MODEL) or a
  // server-built { model: { owner, name, version }, input } from an
  // allowlisted model profile. It never comes from the HTTP request directly.
  function resolveSpec(spec) {
    if (typeof spec === 'string') {
      if (!model) throw new ProviderError('provider_misconfigured', 'No default REPLICATE_MODEL is configured.');
      return { target: model, input: { ...extraInput, prompt: spec } };
    }
    if (!spec || !spec.model || !spec.input || typeof spec.input !== 'object') {
      throw new ProviderError('provider_misconfigured', 'Invalid prediction request.');
    }
    const target = parseModel(
      `${spec.model.owner}/${spec.model.name}${spec.model.version ? `:${spec.model.version}` : ''}`,
    );
    return { target, input: { ...spec.input } };
  }

  function createPrediction(spec, signal) {
    const { target, input } = resolveSpec(spec);
    if (target.version) {
      return request('POST', '/predictions', { version: target.version, input }, signal);
    }
    const modelPath = `/models/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/predictions`;
    return request('POST', modelPath, { input }, signal);
  }

  function getPrediction(id, signal) {
    return request('GET', `/predictions/${encodeURIComponent(id)}`, undefined, signal);
  }

  async function cancelPrediction(id) {
    try {
      await request('POST', `/predictions/${encodeURIComponent(id)}/cancel`, undefined, undefined);
    } catch (error) {
      logger.error(`[replicate] best-effort cancel of prediction ${id} failed: ${error.code || 'error'}`);
    }
  }

  async function generate(spec, { signal, onPrediction } = {}) {
    const deadline = now() + maxWaitMs;
    let prediction = await createPrediction(spec, signal);
    const id = prediction && prediction.id;
    if (typeof id !== 'string' || !PREDICTION_ID_PATTERN.test(id)) {
      throw new ProviderError('provider_invalid_response', 'Replicate API did not return a valid prediction id.');
    }
    let terminal = false;
    try {
      if (onPrediction) onPrediction(id);
      for (let polls = 0; ; polls += 1) {
        const status = prediction.status;
        if (status === 'succeeded') {
          terminal = true;
          const videoUrl = extractVideoUrl(prediction.output);
          if (!videoUrl) {
            throw new ProviderError(
              'provider_output_missing',
              'Replicate prediction succeeded but returned no usable https video URL. Check that REPLICATE_MODEL is a video model.',
            );
          }
          return { videoUrl, predictionId: id };
        }
        if (status === 'failed') {
          terminal = true;
          throw new ProviderError('provider_prediction_failed', 'Replicate prediction failed.', truncate(prediction.error));
        }
        if (status === 'canceled' || status === 'aborted') {
          terminal = true;
          throw new ProviderError('provider_prediction_canceled', 'Replicate prediction was canceled.');
        }
        if (polls >= maxPolls || now() + pollIntervalMs > deadline) {
          throw new ProviderError(
            'provider_timeout',
            `Replicate prediction did not finish within ${maxWaitMs} ms and was cancelled.`,
          );
        }
        await sleep(pollIntervalMs, signal);
        prediction = await getPrediction(id, signal);
        if (!prediction || typeof prediction !== 'object') {
          throw new ProviderError('provider_invalid_response', 'Replicate API returned an invalid prediction.');
        }
      }
    } catch (error) {
      if (!terminal) await cancelPrediction(id);
      throw error;
    }
  }

  function toErrorPayload(error) {
    if (error instanceof ProviderError) {
      const payload = { code: error.code, message: error.message };
      if (error.detail) payload.detail = error.detail;
      return payload;
    }
    return { code: 'provider_error', message: 'Unexpected error while calling Replicate.' };
  }

  return {
    name: NAME,
    realVideoGeneration: true,
    canAccept() {
      return !closed && active.size < maxConcurrent;
    },
    // Starts the prediction in the background. The active entry is registered
    // synchronously so that refresh() never mistakes a new job for an orphan.
    start(job, update, spec) {
      if (closed) throw new ProviderError('provider_closed', 'Provider is shutting down.');
      const controller = new AbortController();
      active.set(job.id, controller);
      return generate(spec || job.prompt, {
        signal: controller.signal,
        onPrediction: (predictionId) =>
          update({ status: 'processing', progress: 0, providerPredictionId: predictionId }),
      })
        .then(({ videoUrl, predictionId }) =>
          update({
            status: 'succeeded',
            progress: 100,
            completedAt: new Date(now()).toISOString(),
            result: { simulated: false, provider: NAME, videoUrl, providerPredictionId: predictionId },
          }),
        )
        .catch((error) => {
          const payload = toErrorPayload(error);
          logger.error(`[replicate] job ${job.id} failed: ${payload.code}`);
          update({ status: 'failed', completedAt: new Date(now()).toISOString(), error: payload });
        })
        .finally(() => active.delete(job.id));
    },
    // A job that is still queued/processing but is not tracked in memory was
    // interrupted (e.g. by a restart). It is not retried to avoid double spend.
    refresh(job, currentTime = now()) {
      if ((job.status === 'queued' || job.status === 'processing') && !active.has(job.id)) {
        return {
          status: 'failed',
          completedAt: new Date(currentTime).toISOString(),
          error: {
            code: 'provider_interrupted',
            message: 'The job was interrupted before the provider finished and was not retried.',
          },
        };
      }
      return null;
    },
    close() {
      closed = true;
      for (const controller of active.values()) controller.abort();
    },
    activeCount() {
      return active.size;
    },
    generate,
  };
}

module.exports = {
  NAME,
  ProviderError,
  createReplicateProvider,
  extractVideoUrl,
  parseModel,
  validateReplicateConfig,
};
