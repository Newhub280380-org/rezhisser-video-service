'use strict';

// Production API: accounts (JWT), profile, payments, content library, saved
// projects and account video jobs (Seedance). Mounted by src/server.js before
// the legacy demo / private-beta routes.

const crypto = require('node:crypto');
const {
  AccountError,
  normalizeEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
  getDummyHash,
  bearerToken,
  hashResetToken,
} = require('./accounts.js');
const { BillingError } = require('./billing/index.js');
const { CURRENCIES, TIERS, PERIOD_MS } = require('./billing/plans.js');
const { LibraryError } = require('./library/index.js');

const RESET_TTL_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCALES = ['ru', 'zh', 'en'];
const ASPECTS = ['9:16', '16:9', '1:1'];
const MAX_PROJECTS = 500;
const MAX_AUTOMATION_TASKS = 100;
const AUTOMATION_REGIONS = ['US', 'EU', 'UK', 'CA', 'AU', 'JP', 'SG'];
const FORBIDDEN_JOB_FIELDS = ['model', 'version', 'token', 'apiKey', 'apiBaseUrl', 'baseUrl', 'url', 'webhook', 'input', 'cost', 'price', 'provider', 'billingSource'];

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Strip control characters except newlines and tabs.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function fillPlaceholders(template, fields = {}) {
  const values = {
    product: cleanText(fields.product, 120) || 'the product',
    brand: cleanText(fields.brand, 80) || 'the brand',
    photo: 'the uploaded photo',
  };
  return template.replace(/\{(product|brand|photo)\}/g, (_, name) => values[name]);
}

function createProductionApi({
  config,
  db,
  library,
  billing,
  tokens,
  seedance,
  storage,
  mailer,
  pipeline,
  loginLimiter,
  globalLoginLimiter,
  helpers,
  logger = console,
  now = Date.now,
}) {
  const { sendJson, readJson, readBody, requestOrigin, clientIp, createPlan, validateImage, BriefError, RoutingError } = helpers;

  function profileOf(user) {
    return {
      user: { id: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt },
      subscription: billing.usageSummary(user),
    };
  }

  async function authenticate(req) {
    const token = bearerToken(req);
    if (!token) return null;
    const payload = tokens.verify(token);
    if (!payload || !UUID_PATTERN.test(payload.sub)) return null;
    const user = await db.getUserById(payload.sub);
    if (!user || user.tokenVersion !== payload.tv) return null;
    return user;
  }

  async function requireUser(req, res) {
    const user = await authenticate(req);
    if (!user) sendJson(res, 401, { error: 'auth_required', message: 'Войдите в аккаунт.' }, { 'Cache-Control': 'no-store' });
    return user;
  }

  function loginRateLimited(req, res) {
    const perIp = loginLimiter.check(`account:${clientIp(req)}`);
    const global = globalLoginLimiter.check('account:global');
    if (perIp.allowed && global.allowed) return false;
    const retryAfter = Math.max(1, Math.ceil((Math.max(perIp.resetAt, global.resetAt) - now()) / 1000));
    sendJson(res, 429, { error: 'too_many_attempts', retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
    return true;
  }

  function issue(res, status, user) {
    const { token, expiresAt } = tokens.issue(user);
    sendJson(res, status, { token, expiresAt, ...profileOf(user) }, { 'Cache-Control': 'no-store' });
  }

  function publicJob(job) {
    let video = null;
    if (job.status === 'succeeded') {
      if (job.videoKey && storage) {
        const ttl = config.videoUrlTtlSeconds;
        video = {
          url: storage.presignGet(job.videoKey, ttl),
          downloadUrl: storage.presignGet(job.videoKey, ttl, { downloadName: `rezhisser-${job.id.slice(0, 8)}.mp4` }),
          bytes: job.videoBytes,
        };
      } else if (job.videoUrl) {
        video = { url: job.videoUrl, downloadUrl: job.videoUrl, bytes: null };
      }
    }
    return {
      id: job.id,
      status: job.status,
      provider: job.provider,
      realVideoGeneration: job.billingSource !== 'demo',
      simulated: job.billingSource === 'demo',
      prompt: job.prompt,
      libraryItemId: job.libraryItemId,
      aspect: job.aspect,
      durationSeconds: job.durationSeconds,
      hasImage: job.hasImage,
      billingSource: job.billingSource,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
      error: job.error,
      video,
    };
  }

  function sendKnownError(res, error) {
    if (error instanceof AccountError || error instanceof BillingError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    if (error instanceof LibraryError) {
      sendJson(res, 400, { error: error.code, message: error.message });
      return true;
    }
    if (error instanceof BriefError) {
      sendJson(res, 400, { error: error.code, field: error.field, message: error.message });
      return true;
    }
    if (error instanceof RoutingError) {
      sendJson(res, 400, { error: error.code, message: error.message });
      return true;
    }
    return false;
  }

  // ---- route handlers -----------------------------------------------------

  async function register(req, res) {
    if (loginRateLimited(req, res)) return;
    const payload = await readJson(req, res, 4 * 1024);
    if (!payload) return;
    const email = normalizeEmail(payload.email);
    const password = validatePassword(payload.password);
    const locale = LOCALES.includes(payload.locale) ? payload.locale : 'ru';
    let user;
    try {
      user = await db.createUser({ id: crypto.randomUUID(), email, passwordHash: await hashPassword(password), locale });
    } catch (error) {
      if (error.code === 'email_taken') {
        sendJson(res, 409, { error: 'email_taken', message: 'Этот email уже зарегистрирован.' });
        return;
      }
      throw error;
    }
    issue(res, 201, user);
  }

  async function login(req, res) {
    if (loginRateLimited(req, res)) return;
    const payload = await readJson(req, res, 4 * 1024);
    if (!payload) return;
    let email = null;
    try {
      email = normalizeEmail(payload.email);
    } catch {
      email = null;
    }
    const user = email ? await db.getUserByEmail(email) : null;
    const ok = await verifyPassword(typeof payload.password === 'string' ? payload.password.slice(0, 256) : '', user ? user.passwordHash : await getDummyHash());
    if (!user || !ok) {
      sendJson(res, 401, { error: 'invalid_credentials', message: 'Неверный email или пароль.' });
      return;
    }
    issue(res, 200, user);
  }

  async function forgotPassword(req, res) {
    if (loginRateLimited(req, res)) return;
    const payload = await readJson(req, res, 4 * 1024);
    if (!payload) return;
    let email = null;
    try {
      email = normalizeEmail(payload.email);
    } catch {
      email = null;
    }
    const user = email ? await db.getUserByEmail(email) : null;
    if (user && mailer.configured && !config.publicOrigin) {
      // Links built from the Host header could point to an attacker's domain.
      logger.error('password reset email not sent: PUBLIC_ORIGIN must be set when email delivery is enabled');
    } else if (user && !mailer.configured && config.nodeEnv === 'production') {
      logger.error('password reset email not sent: RESEND_API_KEY and MAIL_FROM are not configured');
    } else if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.createPasswordReset({ tokenHash: hashResetToken(token), userId: user.id, expiresAt: new Date(now() + RESET_TTL_MS).toISOString() });
      const link = `${requestOrigin(req)}/studio#/reset?token=${token}`;
      mailer
        .send({
          to: user.email,
          subject: 'Rezhisser: восстановление пароля / 重置密码',
          text: `Ссылка для нового пароля (действует 1 час):\n${link}\n\n重置密码链接（1 小时内有效）：\n${link}\n\nЕсли вы не запрашивали сброс, просто проигнорируйте письмо.`,
        })
        .catch((error) => logger.error(`password reset mail failed: ${error.code || 'error'}`));
    }
    // Same answer whether or not the account exists.
    sendJson(res, 202, { status: 'sent', message: 'Если такой аккаунт есть, мы отправили письмо со ссылкой.' });
  }

  async function resetPassword(req, res) {
    if (loginRateLimited(req, res)) return;
    const payload = await readJson(req, res, 4 * 1024);
    if (!payload) return;
    const password = validatePassword(payload.password);
    if (typeof payload.token !== 'string' || payload.token.length < 20 || payload.token.length > 128) {
      sendJson(res, 400, { error: 'invalid_token', message: 'Ссылка недействительна или устарела.' });
      return;
    }
    const userId = await db.consumePasswordReset(hashResetToken(payload.token), now());
    if (!userId) {
      sendJson(res, 400, { error: 'invalid_token', message: 'Ссылка недействительна или устарела.' });
      return;
    }
    const user = await db.updateUserPassword(userId, await hashPassword(password));
    issue(res, 200, user);
  }

  async function checkout(req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    const payload = await readJson(req, res, 4 * 1024);
    if (!payload) return;
    const result = await billing.checkout(user, {
      product: payload.product,
      currency: typeof payload.currency === 'string' ? payload.currency.toUpperCase() : payload.currency,
      provider: payload.provider,
      origin: requestOrigin(req),
    });
    sendJson(res, 201, result, { 'Cache-Control': 'no-store' });
  }

  async function createJob(req, res, user) {
    const payload = await readJson(req, res, Math.ceil(config.imageMaxBytes * 1.4) + 64 * 1024);
    if (!payload) return;
    const forbidden = FORBIDDEN_JOB_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(payload, field));
    if (forbidden) {
      sendJson(res, 400, { error: 'field_not_allowed', field: forbidden });
      return;
    }
    const image = validateImage(payload.image, config.imageMaxBytes);
    let item = null;
    if (payload.libraryItemId !== undefined && payload.libraryItemId !== null) {
      item = library.get(payload.libraryItemId);
      if (!item) {
        sendJson(res, 400, { error: 'unknown_library_item' });
        return;
      }
    }
    let prompt;
    let aspect = ASPECTS.includes(payload.aspect) ? payload.aspect : item ? item.aspect : '9:16';
    let duration = [5, 10].includes(payload.duration) ? payload.duration : item ? item.duration : 5;
    let brief = null;
    if (payload.brief !== undefined) {
      const plan = createPlan(payload.brief, { hasImage: Boolean(image) });
      prompt = plan.modelPrompt;
      brief = plan.brief;
      aspect = plan.brief.aspect;
      duration = plan.brief.duration <= 5 ? 5 : 10;
    } else if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
      prompt = fillPlaceholders(cleanText(payload.prompt, 2000), payload.fields);
    } else if (item) {
      prompt = fillPlaceholders(item.promptEn, payload.fields);
    } else {
      sendJson(res, 400, { error: 'prompt_required', message: 'Нужен бриф, промт или шаблон из библиотеки.' });
      return;
    }
    if (item && item.needsPhoto && !image && payload.demo !== true) {
      sendJson(res, 422, { error: 'image_required', message: 'Этот шаблон работает с вашим фото — загрузите его.' });
      return;
    }
    const demo = payload.demo === true;
    if (!demo) {
      if (!seedance) {
        sendJson(res, 503, { error: 'generation_unavailable', message: 'Генерация видео не настроена на сервере (SEEDANCE_API_KEY).' });
        return;
      }
      if (!seedance.canAccept()) {
        sendJson(res, 503, { error: 'provider_busy', message: 'Очередь занята, попробуйте через минуту.' }, { 'Retry-After': '30' });
        return;
      }
    }
    // Reserve the provider slot before any await so parallel requests cannot
    // exceed SEEDANCE_MAX_CONCURRENT; the pipeline releases it.
    const release = demo ? null : seedance.acquire();
    let billingSource;
    let job;
    try {
      billingSource = demo ? 'demo' : await billing.consumeGeneration(user);
    } catch (error) {
      if (release) release();
      throw error;
    }
    try {
      job = await db.createVideoJob({
        id: crypto.randomUUID(),
        userId: user.id,
        status: 'queued',
        provider: demo ? 'local-simulation' : seedance.name,
        model: demo ? null : seedance.model,
        prompt,
        brief,
        libraryItemId: item ? item.id : null,
        aspect,
        durationSeconds: duration,
        hasImage: Boolean(image),
        billingSource,
        costUsd: 0,
      });
    } catch (error) {
      if (release) release();
      if (!demo) await billing.refundGeneration({ userId: user.id, billingSource, id: null });
      throw error;
    }
    try {
      if (!demo) await billing.recordGeneration(user.id, billingSource, job.id);
    } catch (error) {
      // The ledger entry is informational; never strand a reserved slot.
      logger.error(`usage event for job ${job.id} failed: ${error.code || 'error'}`);
    }
    pipeline.start(job, { prompt, image: image ? image.dataUrl : null, aspect, duration }, release);
    const fresh = await db.getUserById(user.id);
    sendJson(res, 201, { job: publicJob(job), subscription: billing.usageSummary(fresh) });
  }

  async function projects(req, res, user) {
    if (req.method === 'GET') {
      const list = await db.listProjects(user.id);
      sendJson(res, 200, { projects: list.map(({ userId, ...rest }) => rest) });
      return;
    }
    const payload = await readJson(req, res, 16 * 1024);
    if (!payload) return;
    const kind = payload.kind === 'favorite' ? 'favorite' : 'project';
    const libraryItemId = payload.libraryItemId === undefined || payload.libraryItemId === null ? null : payload.libraryItemId;
    if (libraryItemId !== null && !library.get(libraryItemId)) {
      sendJson(res, 400, { error: 'unknown_library_item' });
      return;
    }
    const title = cleanText(payload.title, 120) || (libraryItemId ? library.get(libraryItemId).title : '');
    if (!title) {
      sendJson(res, 400, { error: 'title_required' });
      return;
    }
    if ((await db.countProjects(user.id)) >= MAX_PROJECTS) {
      sendJson(res, 409, { error: 'too_many_projects' });
      return;
    }
    let brief = null;
    if (payload.brief !== undefined && payload.brief !== null) {
      brief = createPlan(payload.brief).brief;
    }
    const { userId, ...project } = await db.createProject({
      id: crypto.randomUUID(),
      userId: user.id,
      kind,
      title,
      libraryItemId,
      prompt: cleanText(payload.prompt, 2000) || null,
      brief,
    });
    sendJson(res, 201, { project });
  }

  function automationTaskInput(payload, existing = {}) {
    const name = cleanText(payload.name === undefined ? existing.name : payload.name, 120);
    const urlText = cleanText(payload.url === undefined ? existing.url : payload.url, 2048);
    const instruction = cleanText(payload.instruction === undefined ? existing.instruction : payload.instruction, 4000);
    const region = payload.region === undefined ? (existing.region || 'US') : String(payload.region).toUpperCase();
    let url;
    try {
      url = new URL(urlText);
    } catch {
      url = null;
    }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return { error: 'invalid_url' };
    }
    if (!name) return { error: 'name_required' };
    if (!instruction) return { error: 'instruction_required' };
    if (!AUTOMATION_REGIONS.includes(region)) return { error: 'invalid_region' };
    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') return { error: 'invalid_enabled' };
    return {
      name,
      url: url.toString(),
      instruction,
      region,
      enabled: payload.enabled === undefined ? (existing.enabled !== false) : payload.enabled,
    };
  }

  async function automationTasks(req, res, user) {
    if (req.method === 'GET') {
      const tasks = await db.listAutomationTasks(user.id, { limit: MAX_AUTOMATION_TASKS });
      sendJson(res, 200, { tasks: tasks.map(({ userId, ...task }) => task) }, { 'Cache-Control': 'no-store' });
      return;
    }
    const payload = await readJson(req, res, 8 * 1024);
    if (!payload) return;
    const input = automationTaskInput(payload);
    if (input.error) {
      sendJson(res, 400, { error: input.error });
      return;
    }
    const task = await db.createAutomationTask(
      { id: crypto.randomUUID(), userId: user.id, ...input },
      { limit: MAX_AUTOMATION_TASKS },
    );
    if (!task) {
      sendJson(res, 409, { error: 'too_many_automation_tasks' });
      return;
    }
    const { userId, ...publicTask } = task;
    sendJson(res, 201, { task: publicTask });
  }

  async function updateAutomationTask(req, res, user, id) {
    if (!UUID_PATTERN.test(id)) {
      sendJson(res, 404, { error: 'automation_task_not_found' });
      return;
    }
    const existing = await db.getAutomationTask(id, user.id);
    if (!existing) {
      sendJson(res, 404, { error: 'automation_task_not_found' });
      return;
    }
    if (req.method === 'DELETE') {
      const deleted = await db.deleteAutomationTask(id, user.id);
      sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'automation_task_not_found' });
      return;
    }
    const payload = await readJson(req, res, 8 * 1024);
    if (!payload) return;
    const input = automationTaskInput(payload, existing);
    if (input.error) {
      sendJson(res, 400, { error: input.error });
      return;
    }
    const updated = await db.updateAutomationTask(id, user.id, input);
    if (!updated) {
      sendJson(res, 404, { error: 'automation_task_not_found' });
      return;
    }
    const { userId, ...task } = updated;
    sendJson(res, 200, { task });
  }

  async function health() {
    let database = 'ok';
    try {
      await db.ping();
    } catch {
      database = 'error';
    }
    return {
      database,
      databaseKind: db.kind,
      seedance: seedance ? 'configured' : 'not_configured',
      storage: storage ? 'configured' : 'not_configured',
      payments: billing.providers.map((p) => p.name),
      library: library.size,
    };
  }

  // Returns true when the request was handled.
  async function handle(req, res, pathname) {
    try {
      return await route(req, res, pathname);
    } catch (error) {
      if (sendKnownError(res, error)) return true;
      throw error;
    }
  }

  async function route(req, res, pathname) {
    const { method } = req;

    if (method === 'GET' && pathname === '/api/plans') {
      sendJson(res, 200, {
        tiers: Object.values(TIERS),
        products: billing.products,
        currencies: CURRENCIES,
        paymentProviders: billing.providers,
        generation: { provider: seedance ? seedance.name : null, available: Boolean(seedance) },
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/auth/register') return register(req, res).then(() => true);
    if (method === 'POST' && pathname === '/api/auth/login') return login(req, res).then(() => true);
    if (method === 'POST' && pathname === '/api/auth/forgot-password') return forgotPassword(req, res).then(() => true);
    if (method === 'POST' && pathname === '/api/auth/reset-password') return resetPassword(req, res).then(() => true);

    if (method === 'GET' && pathname === '/api/user/profile') {
      const user = await requireUser(req, res);
      if (user) {
        const jobs = await db.listVideoJobs(user.id, { limit: 1000 });
        const fresh = (await db.rollUsagePeriod(user.id, now(), PERIOD_MS)) || user;
        sendJson(
          res,
          200,
          {
            ...profileOf(fresh),
            usage: {
              totalVideos: jobs.filter((job) => job.billingSource !== 'demo').length,
              totalDemos: jobs.filter((job) => job.billingSource === 'demo').length,
              succeeded: jobs.filter((job) => job.status === 'succeeded').length,
            },
          },
          { 'Cache-Control': 'no-store' },
        );
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/payment/checkout') return checkout(req, res).then(() => true);

    if (method === 'GET' && pathname === '/api/payment/history') {
      const user = await requireUser(req, res);
      if (user) sendJson(res, 200, await billing.history(user), { 'Cache-Control': 'no-store' });
      return true;
    }

    if (method === 'POST' && pathname === '/api/payment/webhook/yookassa') {
      const payload = await readJson(req, res, 64 * 1024);
      if (!payload) return true;
      const result = await billing.handleYooKassaNotification(payload);
      sendJson(res, 200, { received: true, handled: result.handled });
      return true;
    }

    if (method === 'POST' && pathname === '/api/payment/webhook/stripe') {
      const raw = await readBody(req, 256 * 1024);
      const result = await billing.handleStripeEvent(raw, req.headers['stripe-signature']);
      sendJson(res, 200, { received: true, handled: result.handled });
      return true;
    }

    if (method === 'POST' && pathname === '/api/library/search') {
      const payload = await readJson(req, res, 4 * 1024);
      if (payload) sendJson(res, 200, library.search(payload));
      return true;
    }

    const libraryMatch = pathname.match(/^\/api\/library\/([a-z0-9-]{1,64})$/);
    if (method === 'GET' && libraryMatch) {
      const item = library.get(libraryMatch[1]);
      if (item) sendJson(res, 200, { item });
      else sendJson(res, 404, { error: 'library_item_not_found' });
      return true;
    }

    if (pathname === '/api/projects' && (method === 'GET' || method === 'POST')) {
      const user = await requireUser(req, res);
      if (user) await projects(req, res, user);
      return true;
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === 'DELETE' && projectMatch) {
      const user = await requireUser(req, res);
      if (!user) return true;
      const id = decodeURIComponent(projectMatch[1]);
      const removed = UUID_PATTERN.test(id) && (await db.deleteProject(id, user.id));
      sendJson(res, removed ? 200 : 404, removed ? { deleted: true } : { error: 'project_not_found' });
      return true;
    }

    if (pathname === '/api/automation/tasks' && (method === 'GET' || method === 'POST')) {
      const user = await requireUser(req, res);
      if (user) await automationTasks(req, res, user);
      return true;
    }
    const automationTaskMatch = pathname.match(/^\/api\/automation\/tasks\/([^/]+)$/);
    if (automationTaskMatch && ['PUT', 'DELETE'].includes(method)) {
      const user = await requireUser(req, res);
      if (user) await updateAutomationTask(req, res, user, automationTaskMatch[1]);
      return true;
    }

    // Account jobs: only when the request carries a bearer token. Requests
    // without one fall through to the public demo / private-beta job API.
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if ((pathname === '/api/jobs' || jobMatch) && req.headers.authorization !== undefined) {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (method === 'POST' && pathname === '/api/jobs') {
        await createJob(req, res, user);
        return true;
      }
      if (method === 'GET' && pathname === '/api/jobs') {
        const list = await db.listVideoJobs(user.id, { limit: 100 });
        sendJson(res, 200, { jobs: list.map(publicJob) }, { 'Cache-Control': 'no-store' });
        return true;
      }
      if (method === 'GET' && jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        const job = UUID_PATTERN.test(id) ? await db.getVideoJob(id) : null;
        if (!job || job.userId !== user.id) sendJson(res, 404, { error: 'job_not_found' });
        else sendJson(res, 200, { job: publicJob(job) }, { 'Cache-Control': 'no-store' });
        return true;
      }
    }
    return false;
  }

  return { handle, authenticate, health, publicJob };
}

module.exports = { createProductionApi, fillPlaceholders };
