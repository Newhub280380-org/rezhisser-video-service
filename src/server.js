'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLocalSimulationProvider } = require('./providers/local-simulation.js');
const { createReplicateProvider } = require('./providers/replicate.js');
const { createPlan, briefOptions, validateAdvisorSetting, BriefError, ENGINE } = require('./director.js');
const {
  DEMO_PROFILES,
  RoutingError,
  loadPaidProfiles,
  selectProfile,
  buildProviderInput,
  estimateFor,
  validateImage,
  publicProfile,
} = require('./models.js');
const { createAuth } = require('./auth.js');
const { createSpendGuard } = require('./spend.js');
const { createStaticHandler } = require('./static.js');

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
  'cost',
  'price',
  'estimateUsd',
  'estimatedCostUsd',
  'replicateModel',
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

function parseMoney(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : 0;
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
    // Rule-based director is always used. No LLM advisor is implemented.
    directorAdvisor: env.DIRECTOR_ADVISOR || 'none',
    // Operator-defined allowlist of Replicate model profiles (JSON array).
    modelProfilesJson: env.VIDEO_MODEL_PROFILES_JSON || '',
    // Paid generation is locked unless ALL of these are configured.
    paidGenerationEnabled: (env.PAID_GENERATION_ENABLED || '').trim().toLowerCase() === 'true',
    betaAccessKey: env.BETA_ACCESS_KEY || '',
    paidDailyBudgetUsd: parseMoney(env.PAID_DAILY_BUDGET_USD),
    paidDailyJobLimit: clamp(parseNumber(env.PAID_DAILY_JOB_LIMIT, 3), 1, 100),
    paidTotalJobLimit: clamp(parseNumber(env.PAID_TOTAL_JOB_LIMIT, 20), 1, 10000),
    quoteTtlMs: clamp(parseNumber(env.QUOTE_TTL_MS, 600000), 60000, 3600000),
    sessionTtlMs: clamp(parseNumber(env.SESSION_TTL_MS, 28800000), 300000, 86400000),
    loginRateLimitMax: clamp(parseNumber(env.LOGIN_RATE_LIMIT_MAX, 5), 1, 100),
    loginRateLimitWindowMs: clamp(parseNumber(env.LOGIN_RATE_LIMIT_WINDOW_MS, 900000), 1000, 86400000),
    imageMaxBytes: clamp(parseNumber(env.IMAGE_MAX_BYTES, 262144), 16384, 5242880),
    // Optional explicit public origin of this service (e.g. https://x.onrender.com).
    publicOrigin: (env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, ''),
    replicate: {
      apiToken: env.REPLICATE_API_TOKEN || '',
      model: (env.REPLICATE_MODEL || '').trim(),
      apiBaseUrl: env.REPLICATE_API_BASE_URL || 'https://api.replicate.com/v1',
      pollIntervalMs: clamp(parseNumber(env.REPLICATE_POLL_INTERVAL_MS, 5000), 1000, 60000),
      maxWaitMs: clamp(parseNumber(env.REPLICATE_MAX_WAIT_MS, 600000), 10000, 1800000),
      requestTimeoutMs: clamp(parseNumber(env.REPLICATE_REQUEST_TIMEOUT_MS, 30000), 1000, 120000),
      maxConcurrent: clamp(parseNumber(env.REPLICATE_MAX_CONCURRENT, 1), 1, 10),
      extraInput: env.REPLICATE_EXTRA_INPUT_JSON || '',
      estimatedCostUsd: env.REPLICATE_ESTIMATED_COST_USD || '',
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
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
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
    create(prompt, provider, now = Date.now(), extra = {}) {
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
        ...extra,
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
  let paidProfiles = [];
  if (config.videoProvider === 'replicate') {
    providers.set(
      'replicate',
      createReplicateProvider({
        ...config.replicate,
        allowNoDefaultModel: Boolean(config.modelProfilesJson),
        fetchImpl: config.fetchImpl,
        logger: config.logger,
      }),
    );
    paidProfiles = loadPaidProfiles({
      profilesJson: config.modelProfilesJson,
      legacyModel: config.replicate.model,
      legacyExtraInput: config.replicate.extraInput,
      legacyEstimatedCostUsd: config.replicate.estimatedCostUsd,
    });
  }
  return { providers, paidProfiles };
}

function requestOrigin(req, config) {
  if (config.publicOrigin) return config.publicOrigin;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host || 'localhost'}`;
}

function isSecureRequest(req, config) {
  return requestOrigin(req, config).startsWith('https://');
}

function isLocalSimulationJob(job) {
  return (job.provider || DEFAULT_PROVIDER) === DEFAULT_PROVIDER;
}

const PAID_WARNINGS = [
  'Сумма — оценка оператора сервиса. Фактическое списание определяет провайдер (Replicate).',
  'Таймаут, отмена или ошибка могут НЕ вернуть деньги: провайдер может списать оплату за начатую генерацию.',
  'Оценка учитывается в дневном бюджете сразу при запуске, даже если генерация потом завершится ошибкой.',
];

function createApp(options = {}) {
  const config = loadConfig(process.env, options);
  const limiter = createRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });
  validateAdvisorSetting(config.directorAdvisor);
  const { providers, paidProfiles } = createProviders(config);
  const defaultProvider = providers.get(config.videoProvider);
  const profiles = [...DEMO_PROFILES, ...paidProfiles];
  const jobs = createJobStore(config.dataDir, (name) => providers.get(name));
  const auth = createAuth({ accessKey: config.betaAccessKey, sessionTtlMs: config.sessionTtlMs });
  const spend = createSpendGuard({
    dataDir: config.dataDir,
    dailyBudgetUsd: config.paidDailyBudgetUsd,
    dailyJobLimit: config.paidDailyJobLimit,
    totalJobLimit: config.paidTotalJobLimit,
    quoteTtlMs: config.quoteTtlMs,
    logger: config.logger || console,
  });
  const loginLimiter = createRateLimiter({ max: config.loginRateLimitMax, windowMs: config.loginRateLimitWindowMs });
  const globalLoginLimiter = createRateLimiter({
    max: config.loginRateLimitMax * 10,
    windowMs: config.loginRateLimitWindowMs,
  });
  const staticFiles = createStaticHandler();

  // Paid generation is available only when every safeguard is configured.
  function paidStatus() {
    const reasons = [];
    if (!providers.has('replicate')) {
      reasons.push({ code: 'provider_not_configured', message: 'Платный провайдер не подключён (VIDEO_PROVIDER=local-simulation).' });
    }
    if (!config.paidGenerationEnabled) {
      reasons.push({ code: 'paid_generation_disabled', message: 'Платная генерация выключена (PAID_GENERATION_ENABLED).' });
    }
    if (!auth.configured) {
      reasons.push({ code: 'access_control_not_configured', message: 'Не настроен доступ закрытой беты (BETA_ACCESS_KEY).' });
    }
    if (!spend.limitsConfigured()) {
      reasons.push({ code: 'spend_limits_not_configured', message: 'Не задан дневной бюджет (PAID_DAILY_BUDGET_USD).' });
    }
    if (providers.has('replicate') && !paidProfiles.some((profile) => profile.estimatedCostUsd !== null)) {
      reasons.push({ code: 'price_not_configured', message: 'Ни для одной платной модели не задана оценка стоимости.' });
    }
    return { available: reasons.length === 0, reasons };
  }

  function sessionFor(req) {
    return auth.getSession(req);
  }

  // Cookie-authenticated state-changing requests must come from this origin
  // and carry the session's CSRF token.
  function verifySessionRequest(req, res) {
    const session = sessionFor(req);
    if (!session) {
      sendJson(res, 401, { error: 'auth_required', message: 'Нужен вход в закрытую бету.' });
      return null;
    }
    if (req.headers.origin !== requestOrigin(req, config) || !auth.checkCsrf(req, session)) {
      sendJson(res, 403, { error: 'csrf_failed', message: 'Запрос отклонён защитой от подделки (CSRF).' });
      return null;
    }
    return session;
  }

  function planFromPayload(payload, hasImage) {
    const plan = createPlan(payload.brief, { hasImage });
    const tier = payload.tier === undefined ? 'demo' : payload.tier;
    const modelId = payload.modelId === undefined || payload.modelId === null ? 'auto' : payload.modelId;
    if (typeof modelId !== 'string' || modelId.length > 64) {
      throw new RoutingError('unknown_model', 'Такой модели нет в списке сервера.');
    }
    const selection = selectProfile({ profiles, plan, tier, modelId, hasImage });
    return { plan, selection };
  }

  function describeSelection(selection) {
    return {
      mode: selection.mode,
      model: publicProfile(selection.profile),
      clipDuration: selection.clipDuration,
      rationale: selection.rationale,
      rejected: selection.rejected,
      estimateUsd: selection.profile.paid ? estimateFor(selection.profile, selection.clipDuration) : 0,
    };
  }

  function sendDirectorError(res, error) {
    if (error instanceof BriefError) {
      sendJson(res, 400, { error: error.code, field: error.field, message: error.message });
      return true;
    }
    if (error instanceof RoutingError) {
      const status = ['image_too_large', 'invalid_image', 'unknown_model', 'invalid_tier'].includes(error.code) ? 400 : 422;
      const body = { error: error.code, message: error.message };
      if (error.details) body.details = error.details;
      sendJson(res, status, body);
      return true;
    }
    return false;
  }

  async function readJson(req, res, limitBytes) {
    const raw = await readBody(req, limitBytes);
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, { error: 'invalid_json' });
      return null;
    }
    return payload;
  }

  const uploadLimitBytes = Math.ceil(config.imageMaxBytes * 1.4) + 64 * 1024;

  function startJob(job, provider, spec) {
    provider.start(
      job,
      (patch) => {
        try {
          jobs.update(job.id, patch);
        } catch (error) {
          console.error(`failed to persist job ${job.id}: ${error.code || 'error'}`);
        }
      },
      spec,
    );
  }

  // Everything after the body is read is synchronous up to provider.start(),
  // so concurrent requests cannot both pass the limit/idempotency checks.
  function createPaidJob(req, res, payload, plan, selection, image) {
    const status = paidStatus();
    if (!status.available) {
      sendJson(res, 403, { error: 'paid_generation_locked', reasons: status.reasons });
      return;
    }
    const session = verifySessionRequest(req, res);
    if (!session) return;
    if (!spend.isValidIdempotencyKey(payload.idempotencyKey)) {
      sendJson(res, 400, { error: 'idempotency_key_required' });
      return;
    }
    const existingId = spend.findIdempotent(payload.idempotencyKey);
    if (existingId) {
      const existing = jobs.get(existingId);
      if (!existing) {
        sendJson(res, 409, { error: 'idempotency_key_reused', message: 'Этот ключ уже использован.' });
        return;
      }
      sendJson(res, 200, { job: existing, idempotentReplay: true });
      return;
    }
    if (payload.confirmPaid !== true) {
      sendJson(res, 400, { error: 'confirmation_required', message: 'Подтвердите платный запуск.' });
      return;
    }
    const quote = spend.getQuote(payload.quoteId);
    if (!quote || quote.sessionId !== session.id) {
      sendJson(res, 400, { error: 'quote_invalid', message: 'Сначала получите оценку стоимости.' });
      return;
    }
    if (quote.jobId) {
      sendJson(res, 409, { error: 'quote_already_used', jobId: quote.jobId });
      return;
    }
    if (quote.expiresAt <= Date.now()) {
      sendJson(res, 409, { error: 'quote_expired', message: 'Оценка устарела — запросите новую.' });
      return;
    }
    const { profile, clipDuration } = selection;
    if (
      quote.profileId !== profile.id ||
      quote.briefHash !== plan.briefHash ||
      quote.imageSha256 !== (image ? image.sha256 : null) ||
      quote.clipDuration !== clipDuration
    ) {
      sendJson(res, 409, { error: 'quote_mismatch', message: 'Бриф или модель изменились после оценки.' });
      return;
    }
    const provider = providers.get(profile.provider);
    if (!provider) {
      sendJson(res, 400, { error: 'provider_not_enabled', enabled: Array.from(providers.keys()) });
      return;
    }
    if (provider.canAccept && !provider.canAccept()) {
      sendJson(res, 503, { error: 'provider_busy' }, { 'Retry-After': '30' });
      return;
    }
    const limit = spend.check(quote.estimateUsd);
    if (limit) {
      sendJson(res, 403, { error: limit.code, message: limit.message, spend: spend.status() });
      return;
    }
    const input = buildProviderInput(profile, plan, { clipDuration, image });
    const job = jobs.create(plan.modelPrompt, provider, Date.now(), {
      paid: true,
      modelId: profile.id,
      modelLabel: profile.label,
      modelKind: profile.kind,
      clipDuration,
      estimatedCostUsd: quote.estimateUsd,
      brief: plan.brief,
      plan,
      hasImage: Boolean(image),
    });
    spend.reserve({ quote, idempotencyKey: payload.idempotencyKey, jobId: job.id });
    startJob(job, provider, { model: profile.parsedModel, input });
    sendJson(res, 201, { job, spend: spend.status() });
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    res.setHeader('Vary', 'Origin');

    const origin = req.headers.origin;
    const sameOrigin = Boolean(origin) && origin === requestOrigin(req, config);

    if (origin && !sameOrigin && !config.allowedOrigins.includes(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (origin && !sameOrigin) {
      // Credentials are intentionally not allowed cross-origin: the session
      // cookie is SameSite=Strict and only the same-origin UI can use paid
      // actions. Allowed cross-origin clients get the public demo API only.
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (!pathname.startsWith('/api/') && staticFiles.handle(req, res, pathname)) {
      return;
    }

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
          paidGenerationEnabled: paidStatus().available,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        const session = sessionFor(req);
        sendJson(res, 200, {
          service: 'rezhisser-video-service',
          videoProvider: defaultProvider.name,
          director: {
            engine: ENGINE,
            label: 'Режиссёр по правилам (без ИИ)',
            llmAdvisor: 'none',
          },
          options: briefOptions(),
          models: profiles.map(publicProfile),
          paid: paidStatus(),
          auth: { configured: auth.configured, authenticated: Boolean(session) },
          limits: {
            imageMaxBytes: config.imageMaxBytes,
            quoteTtlSeconds: Math.round(config.quoteTtlMs / 1000),
          },
        });
        return;
      }

      if (pathname === '/api/session') {
        if (req.method === 'GET') {
          const session = sessionFor(req);
          sendJson(
            res,
            200,
            session
              ? {
                  authenticated: true,
                  csrfToken: session.csrfToken,
                  expiresAt: new Date(session.expiresAt).toISOString(),
                  spend: spend.status(),
                }
              : { authenticated: false, configured: auth.configured },
            { 'Cache-Control': 'no-store' },
          );
          return;
        }
        if (req.method === 'POST') {
          if (!sameOrigin) {
            sendJson(res, 403, { error: 'csrf_failed', message: 'Вход возможен только со страницы сервиса.' });
            return;
          }
          if (!auth.configured) {
            sendJson(res, 503, { error: 'access_control_not_configured', message: 'Вход в бету не настроен.' });
            return;
          }
          const ip = clientIp(req);
          const perIp = loginLimiter.check(ip);
          const global = globalLoginLimiter.check('global');
          if (!perIp.allowed || !global.allowed) {
            const retryAfter = Math.max(1, Math.ceil((Math.max(perIp.resetAt, global.resetAt) - Date.now()) / 1000));
            sendJson(res, 429, { error: 'too_many_login_attempts', retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
            return;
          }
          const payload = await readJson(req, res, 4 * 1024);
          if (!payload) return;
          if (!auth.verifyKey(payload.accessKey)) {
            sendJson(res, 401, { error: 'invalid_access_key', message: 'Неверный ключ доступа.' });
            return;
          }
          const session = auth.createSession();
          sendJson(
            res,
            200,
            { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString(), spend: spend.status() },
            { 'Set-Cookie': auth.sessionCookie(session, isSecureRequest(req, config)), 'Cache-Control': 'no-store' },
          );
          return;
        }
        if (req.method === 'DELETE') {
          const session = verifySessionRequest(req, res);
          if (!session) return;
          auth.destroySession(session);
          sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': auth.clearCookie(isSecureRequest(req, config)) });
          return;
        }
      }

      if (req.method === 'POST' && pathname === '/api/director/plan') {
        const payload = await readJson(req, res, 64 * 1024);
        if (!payload) return;
        try {
          const { plan, selection } = planFromPayload(payload, payload.hasImage === true);
          sendJson(res, 200, { plan, selection: describeSelection(selection) });
        } catch (error) {
          if (!sendDirectorError(res, error)) throw error;
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/quotes') {
        const status = paidStatus();
        if (!status.available) {
          sendJson(res, 403, { error: 'paid_generation_locked', reasons: status.reasons });
          return;
        }
        const session = verifySessionRequest(req, res);
        if (!session) return;
        const payload = await readJson(req, res, uploadLimitBytes);
        if (!payload) return;
        try {
          const image = validateImage(payload.image, config.imageMaxBytes);
          const { plan, selection } = planFromPayload({ ...payload, tier: 'paid' }, Boolean(image));
          if (!selection.profile.paid) {
            sendJson(res, 400, { error: 'not_a_paid_model', message: 'Демо-модели бесплатны, оценка не нужна.' });
            return;
          }
          const estimateUsd = estimateFor(selection.profile, selection.clipDuration);
          if (estimateUsd === null) {
            sendJson(res, 409, { error: 'price_not_configured', message: 'Оператор не задал оценку стоимости для этой модели.' });
            return;
          }
          const limit = spend.check(estimateUsd);
          if (limit) {
            sendJson(res, 403, { error: limit.code, message: limit.message, spend: spend.status() });
            return;
          }
          const quote = spend.issueQuote({
            sessionId: session.id,
            profileId: selection.profile.id,
            briefHash: plan.briefHash,
            imageSha256: image ? image.sha256 : null,
            estimateUsd,
            clipDuration: selection.clipDuration,
          });
          sendJson(res, 201, {
            quote: {
              id: quote.id,
              estimateUsd,
              currency: 'USD',
              expiresAt: new Date(quote.expiresAt).toISOString(),
              clipDuration: selection.clipDuration,
              priceVerifiedAt: selection.profile.priceVerifiedAt,
              priceSource: selection.profile.priceSource,
              warnings: PAID_WARNINGS,
            },
            plan,
            selection: describeSelection(selection),
            spend: spend.status(),
          });
        } catch (error) {
          if (!sendDirectorError(res, error)) throw error;
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        const payload = await readJson(req, res, uploadLimitBytes);
        if (!payload) return;
        const forbidden = FORBIDDEN_JOB_FIELDS.find((field) =>
          Object.prototype.hasOwnProperty.call(payload, field),
        );
        if (forbidden) {
          sendJson(res, 400, { error: 'field_not_allowed', field: forbidden });
          return;
        }

        if (payload.brief !== undefined) {
          if (payload.provider !== undefined || payload.prompt !== undefined) {
            sendJson(res, 400, { error: 'field_not_allowed', field: payload.provider !== undefined ? 'provider' : 'prompt' });
            return;
          }
          try {
            const image = validateImage(payload.image, config.imageMaxBytes);
            const { plan, selection } = planFromPayload(payload, Boolean(image));
            if (selection.profile.paid) {
              createPaidJob(req, res, payload, plan, selection, image);
              return;
            }
            const provider = providers.get(DEFAULT_PROVIDER);
            const job = jobs.create(plan.modelPrompt, provider, Date.now(), {
              paid: false,
              modelId: selection.profile.id,
              modelLabel: selection.profile.label,
              modelKind: selection.profile.kind,
              clipDuration: selection.clipDuration,
              estimatedCostUsd: 0,
              brief: plan.brief,
              plan,
              hasImage: Boolean(image),
            });
            startJob(job, provider);
            sendJson(res, 201, { job });
          } catch (error) {
            if (!sendDirectorError(res, error)) throw error;
          }
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
        if (provider.realVideoGeneration) {
          // Billable providers are never reachable through the public
          // prompt-only API: they require the private-beta session, a
          // server-issued quote and explicit confirmation.
          if (!sessionFor(req)) {
            sendJson(res, 401, { error: 'auth_required', message: 'Платная генерация доступна только в закрытой бете.' });
            return;
          }
          sendJson(res, 400, { error: 'quote_required', message: 'Используйте бриф, оценку (/api/quotes) и подтверждение.' });
          return;
        }
        const job = jobs.create(prompt, provider);
        startJob(job, provider);
        sendJson(res, 201, { job });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        const all = jobs.list();
        // Paid jobs (real outputs) are visible only inside the private beta.
        const visible = sessionFor(req) ? all : all.filter(isLocalSimulationJob);
        // The list is a summary: briefs and plans are only returned by id.
        sendJson(res, 200, { jobs: visible.map(({ brief, plan, ...summary }) => summary) });
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(decodeURIComponent(jobMatch[1]));
        if (!job) {
          sendJson(res, 404, { error: 'job_not_found' });
          return;
        }
        if (!isLocalSimulationJob(job) && !sessionFor(req)) {
          sendJson(res, 401, { error: 'auth_required' });
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

  return { server, config, jobs, limiter, providers, profiles, auth, spend, paidStatus, closeProviders };
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
    const paid = app.paidStatus();
    console.log(
      paid.available
        ? 'paid generation: AVAILABLE for private-beta sessions (quote + confirmation required)'
        : `paid generation: locked (${paid.reasons.map((reason) => reason.code).join(', ')})`,
    );
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
