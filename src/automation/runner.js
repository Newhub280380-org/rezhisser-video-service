'use strict';

// Automation runner: executes saved site tasks with the configured executor
// (Owl Browser or local simulation), records each run with its log and result
// in the database, and limits how many runs execute at once. Status is read
// back by the dashboard through the account API.

const crypto = require('node:crypto');
const net = require('node:net');
const { ExternalError } = require('../http-client.js');

const MAX_LOG_ENTRIES = 50;
const MAX_LOG_CHARS = 500;
const STALE_MARGIN_MS = 5 * 60 * 1000;
const INTERRUPTED = { code: 'interrupted', message: 'Запуск прерван: сервер был перезапущен.' };

class AutomationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
  }
}

function ipv4Blocked(address) {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// Tasks run on the operator's Owl Browser server, so never point it at
// loopback, private, link-local or intranet-only hosts.
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (net.isIPv4(host)) return ipv4Blocked(host);
  if (net.isIPv6(host)) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('::ffff:')) return true;
    return /^(fc|fd|fe[89ab])/.test(host);
  }
  if (!host.includes('.')) return true;
  return ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function publicRun(run) {
  if (!run) return null;
  const { userId, ...rest } = run;
  return rest;
}

function createAutomationRunner({ db, executor, logger = console, now = Date.now, maxConcurrent = 2, maxQueued = 20, maxActivePerUser = 3, keepRuns = 50 }) {
  const queue = [];
  const controllers = new Map();
  const perUser = new Map();
  let active = 0;
  let closed = false;
  const staleAfterMs = (executor.maxWaitMs || 600000) + STALE_MARGIN_MS;

  function entry(message) {
    return { at: new Date(now()).toISOString(), message: String(message).slice(0, MAX_LOG_CHARS) };
  }

  async function safeUpdate(id, patch) {
    try {
      return await db.updateAutomationRun(id, patch);
    } catch (error) {
      logger.error(`automation run ${id} update failed: ${error.code || 'error'}`);
      return null;
    }
  }

  function release(userId) {
    const count = (perUser.get(userId) || 1) - 1;
    if (count <= 0) perUser.delete(userId);
    else perUser.set(userId, count);
  }

  async function execute(run, task) {
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const log = Array.isArray(run.log) ? run.log.slice() : [];
    const append = async (message) => {
      log.push(entry(message));
      while (log.length > MAX_LOG_ENTRIES) log.shift();
      await safeUpdate(run.id, { log });
    };
    try {
      const current = await db.getAutomationRun(run.id, run.userId);
      if (!current || current.status !== 'queued') return;
      log.push(entry(executor.simulated ? 'Запуск начат (симуляция)' : 'Запуск начат'));
      await safeUpdate(run.id, { status: 'running', startedAt: new Date(now()).toISOString(), log });
      let url = null;
      try {
        url = new URL(task.url);
      } catch {}
      if (!url || isBlockedHost(url.hostname)) {
        throw new AutomationError('blocked_url', 'Адрес ведёт на локальную или внутреннюю сеть: такие сайты запускать нельзя.');
      }
      const result = await executor.run(
        { id: task.id, url: url.toString(), instruction: task.instruction, region: task.region },
        {
          log: append,
          setProviderJobId: (providerJobId) => safeUpdate(run.id, { providerJobId }),
          signal: controller.signal,
        },
      );
      log.push(entry('Запуск завершён успешно'));
      await safeUpdate(run.id, {
        status: 'succeeded',
        summary: String((result && result.summary) || '').slice(0, 4000) || null,
        log,
        error: null,
        completedAt: new Date(now()).toISOString(),
      });
    } catch (error) {
      const known = error instanceof AutomationError || error instanceof ExternalError || Boolean(error && error.code === 'cancelled');
      const failure = known
        ? { code: String(error.code).slice(0, 80), message: String(error.message).slice(0, 300) }
        : { code: 'automation_failed', message: 'Запуск завершился ошибкой.' };
      if (!known) logger.error(`automation run ${run.id} failed: ${(error && error.code) || 'error'}`);
      log.push(entry(`Ошибка: ${failure.message}`));
      await safeUpdate(run.id, { status: 'failed', error: failure, log, completedAt: new Date(now()).toISOString() });
    } finally {
      controllers.delete(run.id);
      try {
        await db.pruneAutomationRuns(run.taskId, keepRuns);
      } catch {}
    }
  }

  function pump() {
    while (!closed && active < maxConcurrent && queue.length > 0) {
      const { run, task } = queue.shift();
      active += 1;
      execute(run, task).finally(() => {
        active -= 1;
        release(run.userId);
        pump();
      });
    }
  }

  return {
    executor: { name: executor.name, simulated: Boolean(executor.simulated) },

    // Returns the queued run, or throws AutomationError.
    async start(task) {
      if (closed) throw new AutomationError('automation_unavailable', 'Сервер завершает работу.');
      if ((perUser.get(task.userId) || 0) >= maxActivePerUser) {
        throw new AutomationError('too_many_active_runs', 'Слишком много одновременных запусков. Дождитесь завершения текущих.');
      }
      if (queue.length >= maxQueued) throw new AutomationError('automation_busy', 'Очередь запусков заполнена. Попробуйте позже.');
      await db.failStaleAutomationRuns(now() - staleAfterMs, INTERRUPTED);
      const run = await db.createAutomationRun({
        id: crypto.randomUUID(),
        taskId: task.id,
        userId: task.userId,
        taskName: task.name,
        url: task.url,
        status: 'queued',
        executor: executor.name,
        simulated: Boolean(executor.simulated),
        log: [entry('Запуск поставлен в очередь')],
      });
      if (!run) throw new AutomationError('automation_run_active', 'Эта задача уже выполняется.');
      perUser.set(task.userId, (perUser.get(task.userId) || 0) + 1);
      queue.push({ run, task });
      pump();
      return run;
    },

    // Runs left queued/running by a previous process cannot continue. The
    // in-process store belongs to this process only; with PostgreSQL other
    // instances may still own recent runs, so only stale ones are failed.
    async resume() {
      const cutoff = db.kind === 'memory' ? now() + 1000 : now() - staleAfterMs;
      return db.failStaleAutomationRuns(cutoff, INTERRUPTED);
    },

    close() {
      closed = true;
      queue.length = 0;
      for (const controller of controllers.values()) controller.abort();
    },
  };
}

module.exports = { createAutomationRunner, AutomationError, isBlockedHost, publicRun };
