'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLocalSimulationProvider } = require('./providers/local-simulation.js');
const { createReplicateProvider } = require('./providers/replicate.js');

const KNOWN_PROVIDERS = ['local-simulation', 'replicate'];
const DEFAULT_PROVIDER = 'local-simulation';
// Request fields that could redirect spend or leak credentials. Model, token and
// endpoint are server-side configuration only.
const FORBIDDEN_JOB_FIELDS = [
  'model',
  'version',
  'token',
  'apiToken',
  'apiKey',
  'apiBaseUrl',
  'baseUrl',
  'url',
  'webhook',
  'input',
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://business-41.pazi.dev',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadConfig(env = process.env, overrides = {}) {
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
  const { replicate: replicateOverrides, ...rest } = overrides;
  return {
    host: env.HOST || '0.0.0.0',
    port: parseNumber(env.PORT, 3000),
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
    rateLimitMax: parseNumber(env.RATE_LIMIT_MAX, 30),
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60000),
    dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
    // How long a simulated job stays "processing" before it is marked as finished.
    simulationDurationMs: parseNumber(env.SIMULATION_DURATION_MS, 3000),
    videoProvider: (env.VIDEO_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase(),
    replicate: {
      apiToken: env.REPLICATE_API_TOKEN || '',
      model: (env.REPLICATE_MODEL || '').trim(),
      apiBaseUrl: env.REPLICATE_API_BASE_URL || 'https://api.replicate.com/v1',
      pollIntervalMs: clamp(parseNumber(env.REPLICATE_POLL_INTERVAL_MS, 5000), 1000, 60000),
      maxWaitMs: clamp(parseNumber(env.REPLICATE_MAX_WAIT_MS, 600000), 10000, 1800000),
      requestTimeoutMs: clamp(parseNumber(env.REPLICATE_REQUEST_TIMEOUT_MS, 30000), 1000, 120000),
      maxConcurrent: clamp(parseNumber(env.REPLICATE_MAX_CONCURRENT, 1), 1, 10),
      extraInput: env.REPLICATE_EXTRA_INPUT_JSON || '',
      ...replicateOverrides,
    },
    ...rest,
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    check(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
      }
      entry.count += 1;
      const remaining = Math.max(0, max - entry.count);
      return { allowed: entry.count <= max, remaining, resetAt: entry.resetAt };
    },
    reset() {
      hits.clear();
    },
  };
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

function createJobStore(dataDir, resolveProvider) {
  fs.mkdirSync(dataDir, { recursive: true });

  const jobPath = (id) => path.join(dataDir, `${id}.json`);

  function isValidId(id) {
    return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
  }

  function write(job) {
    fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
    return job;
  }

  function read(id) {
    if (!isValidId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  function advance(job, now = Date.now()) {
    if (TERMINAL_STATUSES.has(job.status)) return job;
    const provider = resolveProvider(job.provider || DEFAULT_PROVIDER);
    const patch = provider
      ? provider.refresh(job, now)
      : {
          status: 'failed',
          completedAt: new Date(now).toISOString(),
          error: {
            code: 'provider_unavailable',
            message: `Provider "${job.provider}" is not enabled on this server.`,
          },
        };
    return patch ? write({ ...job, ...patch }) : job;
  }

  return {
    create(prompt, provider, now = Date.now()) {
      return write({
        id: crypto.randomUUID(),
        prompt,
        provider: provider.name,
        status: 'queued',
        progress: 0,
        simulated: !provider.realVideoGeneration,
        realVideoGeneration: provider.realVideoGeneration,
        createdAt: new Date(now).toISOString(),
        completedAt: null,
        result: null,
        error: null,
      });
    },
    update(id, patch) {
      const job = read(id);
      return job ? write({ ...job, ...patch }) : null;
    },
    get(id, now = Date.now()) {
      const job = read(id);
      return job ? advance(job, now) : null;
    },
    list(now = Date.now()) {
      let files = [];
      try {
        files = fs.readdirSync(dataDir).filter((file) => file.endsWith('.json'));
      } catch {
        return [];
      }
      return files
        .map((file) => read(path.basename(file, '.json')))
        .filter(Boolean)
        .map((job) => advance(job, now))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createProviders(config) {
  if (!KNOWN_PROVIDERS.includes(config.videoProvider)) {
    throw new Error(
      `Unsupported VIDEO_PROVIDER "${config.videoProvider}". Use one of: ${KNOWN_PROVIDERS.join(', ')}.`,
    );
  }
  const providers = new Map();
  providers.set(
    DEFAULT_PROVIDER,
    createLocalSimulationProvider({ simulationDurationMs: config.simulationDurationMs }),
  );
  // The Replicate provider is only constructed (and can only make network
  // calls) when it is explicitly selected by server configuration.
  if (config.videoProvider === 'replicate') {
    providers.set(
      'replicate',
      createReplicateProvider({ ...config.replicate, fetchImpl: config.fetchImpl, logger: config.logger }),
    );
  }
  return providers;
}

function createApp(options = {}) {
  const config = loadConfig(process.env, options);
  const limiter = createRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  const providers = createProviders(config);
  const defaultProvider = providers.get(config.videoProvider);
  const jobs = createJobStore(config.dataDir, (name) => providers.get(name));

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    res.setHeader('Vary', 'Origin');

    const origin = req.headers.origin;

    if (origin && !config.allowedOrigins.includes(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (origin) {
      // Credentials are intentionally not allowed: the API is stateless and
      // requires no cookies or authorization headers.
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.startsWith('/api/')) {
      const { allowed, remaining, resetAt } = limiter.check(clientIp(req));
      res.setHeader('X-RateLimit-Limit', String(config.rateLimitMax));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        sendJson(
          res,
          429,
          { error: 'rate_limit_exceeded', retryAfterSeconds: retryAfter },
          { 'Retry-After': String(retryAfter) },
        );
        return;
      }
    }

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          videoProvider: defaultProvider.name,
          realVideoGeneration: defaultProvider.realVideoGeneration,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'invalid_json' });
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          sendJson(res, 400, { error: 'invalid_json' });
          return;
        }
        const forbidden = FORBIDDEN_JOB_FIELDS.find((field) =>
          Object.prototype.hasOwnProperty.call(payload, field),
        );
        if (forbidden) {
          sendJson(res, 400, { error: 'field_not_allowed', field: forbidden });
          return;
        }
        let provider = defaultProvider;
        if (payload.provider !== undefined) {
          if (typeof payload.provider !== 'string' || !KNOWN_PROVIDERS.includes(payload.provider)) {
            sendJson(res, 400, { error: 'unsupported_provider', supported: KNOWN_PROVIDERS });
            return;
          }
          provider = providers.get(payload.provider);
          if (!provider) {
            sendJson(res, 400, {
              error: 'provider_not_enabled',
              enabled: Array.from(providers.keys()),
            });
            return;
          }
        }
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt_required' });
          return;
        }
        if (prompt.length > 2000) {
          sendJson(res, 400, { error: 'prompt_too_long' });
          return;
        }
        if (provider.canAccept && !provider.canAccept()) {
          sendJson(res, 503, { error: 'provider_busy' }, { 'Retry-After': '30' });
          return;
        }
        const job = jobs.create(prompt, provider);
        provider.start(job, (patch) => {
          try {
            jobs.update(job.id, patch);
          } catch (error) {
            console.error(`failed to persist job ${job.id}: ${error.code || 'error'}`);
          }
        });
        sendJson(res, 201, { job });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: jobs.list() });
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(decodeURIComponent(jobMatch[1]));
        if (!job) {
          sendJson(res, 404, { error: 'job_not_found' });
          return;
        }
        sendJson(res, 200, { job });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = error && error.statusCode ? error.statusCode : 500;
      if (!res.headersSent) {
        sendJson(res, statusCode, {
          error: statusCode === 413 ? 'payload_too_large' : 'internal_error',
        });
      }
    }
  });

  function closeProviders() {
    for (const provider of providers.values()) provider.close();
  }

  return { server, config, jobs, limiter, providers, closeProviders };
}

function start(options = {}) {
  let app;
  try {
    app = createApp(options);
  } catch (error) {
    console.error(`configuration error: ${error.message}`);
    process.exit(1);
  }
  app.server.listen(app.config.port, app.config.host, () => {
    const address = app.server.address();
    console.log(`rezhisser-video-service listening on http://${app.config.host}:${address.port}`);
    console.log(`data directory: ${app.config.dataDir}`);
    console.log(`video provider: ${app.config.videoProvider}`);
  });

  const shutdown = (signal) => {
    console.log(`received ${signal}, shutting down`);
    app.closeProviders();
    app.server.close(() => {
      console.log('server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return app;
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start, loadConfig, DEFAULT_ALLOWED_ORIGINS, KNOWN_PROVIDERS };
