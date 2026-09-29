'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

function loadConfig(env = process.env, overrides = {}) {
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
  return {
    host: env.HOST || '0.0.0.0',
    port: parseNumber(env.PORT, 3000),
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
    rateLimitMax: parseNumber(env.RATE_LIMIT_MAX, 30),
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60000),
    dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
    // How long a simulated job stays "processing" before it is marked as finished.
    simulationDurationMs: parseNumber(env.SIMULATION_DURATION_MS, 3000),
    ...overrides,
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

function createJobStore(dataDir, simulationDurationMs) {
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
    if (job.status === 'succeeded') return job;
    const elapsed = now - new Date(job.createdAt).getTime();
    if (elapsed >= simulationDurationMs) {
      return write({
        ...job,
        status: 'succeeded',
        progress: 100,
        completedAt: new Date(now).toISOString(),
        result: {
          simulated: true,
          videoUrl: null,
          note:
            'No video was generated. This service runs a local simulation only and is not connected to any video provider.',
        },
      });
    }
    const progress = Math.min(99, Math.floor((elapsed / simulationDurationMs) * 100));
    if (job.status === 'processing' && progress === job.progress) return job;
    return write({ ...job, status: 'processing', progress });
  }

  return {
    create(prompt, now = Date.now()) {
      return write({
        id: crypto.randomUUID(),
        prompt,
        status: 'queued',
        progress: 0,
        simulated: true,
        createdAt: new Date(now).toISOString(),
        completedAt: null,
        result: null,
      });
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

function createApp(options = {}) {
  const config = loadConfig(process.env, options);
  const limiter = createRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  const jobs = createJobStore(config.dataDir, config.simulationDurationMs);

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
          videoProvider: 'local-simulation',
          realVideoGeneration: false,
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
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt_required' });
          return;
        }
        if (prompt.length > 2000) {
          sendJson(res, 400, { error: 'prompt_too_long' });
          return;
        }
        sendJson(res, 201, { job: jobs.create(prompt) });
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

  return { server, config, jobs, limiter };
}

function start(options = {}) {
  const app = createApp(options);
  app.server.listen(app.config.port, app.config.host, () => {
    const address = app.server.address();
    console.log(`rezhisser-video-service listening on http://${app.config.host}:${address.port}`);
    console.log(`data directory: ${app.config.dataDir}`);
  });

  const shutdown = (signal) => {
    console.log(`received ${signal}, shutting down`);
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

module.exports = { createApp, start, loadConfig, DEFAULT_ALLOWED_ORIGINS };
