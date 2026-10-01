'use strict';

// In-process database used for local development and tests when DATABASE_URL
// is not set. It implements the same async repository interface as
// src/db/postgres.js. Every mutation is synchronous inside the event loop, so
// the conditional updates (quota, credits, payment transitions) are atomic.
// Optional persistence: a JSON snapshot written after every mutation.

const fs = require('node:fs');
const path = require('node:path');

const TABLES = ['users', 'passwordResets', 'videoJobs', 'payments', 'usageEvents', 'projects', 'automationTasks', 'automationRuns'];

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function iso(value) {
  if (value === undefined || value === null) return null;
  return new Date(value).toISOString();
}

class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

function createMemoryDatabase({ file = null } = {}) {
  const state = Object.fromEntries(TABLES.map((name) => [name, new Map()]));
  if (file) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const name of TABLES) {
        for (const row of snapshot[name] || []) state[name].set(row.id || row.tokenHash, row);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function persist() {
    if (!file) return;
    const snapshot = Object.fromEntries(TABLES.map((name) => [name, Array.from(state[name].values())]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file);
  }

  function mutate(fn) {
    const result = fn();
    persist();
    return clone(result);
  }

  function byNewest(a, b) {
    return b.createdAt.localeCompare(a.createdAt);
  }

  const nowIso = () => new Date().toISOString();

  return {
    kind: 'memory',
    async migrate() {
      return { applied: true };
    },
    async ping() {
      return true;
    },
    async close() {},

    async createUser({ id, email, passwordHash, locale = 'ru' }) {
      return mutate(() => {
        for (const user of state.users.values()) {
          if (user.email === email) throw new DbError('email_taken', 'Email already registered.');
        }
        const now = nowIso();
        const user = {
          id,
          email,
          passwordHash,
          locale,
          tier: 'free',
          subscriptionExpiresAt: null,
          periodStart: now,
          periodVideosUsed: 0,
          credits: 0,
          tokenVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
        state.users.set(id, user);
        return user;
      });
    },
    async getUserById(id) {
      return clone(state.users.get(id));
    },
    async getUserByEmail(email) {
      for (const user of state.users.values()) if (user.email === email) return clone(user);
      return null;
    },
    async updateUserPassword(id, passwordHash) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user) return null;
        Object.assign(user, { passwordHash, tokenVersion: user.tokenVersion + 1, updatedAt: nowIso() });
        return user;
      });
    },
    async rollUsagePeriod(id, now, periodMs) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user) return null;
        if (Date.parse(user.periodStart) + periodMs <= now) {
          Object.assign(user, { periodStart: iso(now), periodVideosUsed: 0, updatedAt: nowIso() });
        }
        return user;
      });
    },
    async incrementPeriodUsage(id, limit) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user || (limit !== null && user.periodVideosUsed >= limit)) return false;
        user.periodVideosUsed += 1;
        user.updatedAt = nowIso();
        return true;
      });
    },
    async decrementPeriodUsage(id) {
      return mutate(() => {
        const user = state.users.get(id);
        if (user) user.periodVideosUsed = Math.max(0, user.periodVideosUsed - 1);
        return Boolean(user);
      });
    },
    async consumeCredits(id, amount) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user || user.credits < amount) return false;
        user.credits -= amount;
        user.updatedAt = nowIso();
        return true;
      });
    },
    async addCredits(id, amount) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user) return null;
        user.credits = Math.max(0, user.credits + amount);
        user.updatedAt = nowIso();
        return user;
      });
    },
    async setSubscription(id, { tier, expiresAt, resetPeriodAt = null }) {
      return mutate(() => {
        const user = state.users.get(id);
        if (!user) return null;
        user.tier = tier;
        user.subscriptionExpiresAt = iso(expiresAt);
        if (resetPeriodAt !== null) {
          user.periodStart = iso(resetPeriodAt);
          user.periodVideosUsed = 0;
        }
        user.updatedAt = nowIso();
        return user;
      });
    },

    async createPasswordReset({ tokenHash, userId, expiresAt }) {
      mutate(() => {
        state.passwordResets.set(tokenHash, { tokenHash, userId, expiresAt: iso(expiresAt), usedAt: null, createdAt: nowIso() });
      });
    },
    async consumePasswordReset(tokenHash, now) {
      return mutate(() => {
        const reset = state.passwordResets.get(tokenHash);
        if (!reset || reset.usedAt || Date.parse(reset.expiresAt) <= now) return null;
        reset.usedAt = iso(now);
        return reset.userId;
      });
    },
    async deleteExpiredPasswordResets(now) {
      return mutate(() => {
        let removed = 0;
        for (const [key, reset] of state.passwordResets) {
          if (reset.usedAt || Date.parse(reset.expiresAt) <= now) {
            state.passwordResets.delete(key);
            removed += 1;
          }
        }
        return removed;
      });
    },

    async createVideoJob(job) {
      return mutate(() => {
        const now = nowIso();
        const row = {
          providerTaskId: null,
          model: null,
          brief: null,
          libraryItemId: null,
          aspect: null,
          durationSeconds: null,
          hasImage: false,
          costUsd: 0,
          videoKey: null,
          videoUrl: null,
          videoBytes: null,
          error: null,
          completedAt: null,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
          ...job,
        };
        state.videoJobs.set(row.id, row);
        return row;
      });
    },
    async updateVideoJob(id, patch) {
      return mutate(() => {
        const job = state.videoJobs.get(id);
        if (!job) return null;
        Object.assign(job, patch, { updatedAt: nowIso() });
        for (const key of ['completedAt', 'expiresAt']) if (key in patch) job[key] = iso(patch[key]);
        return job;
      });
    },
    async getVideoJob(id) {
      return clone(state.videoJobs.get(id));
    },
    async listVideoJobs(userId, { limit = 50 } = {}) {
      return clone(Array.from(state.videoJobs.values()).filter((job) => job.userId === userId).sort(byNewest).slice(0, limit));
    },
    async listActiveVideoJobs() {
      return clone(Array.from(state.videoJobs.values()).filter((job) => job.status === 'queued' || job.status === 'processing'));
    },
    async listExpiredVideoJobs(now, limit = 100) {
      return clone(
        Array.from(state.videoJobs.values())
          .filter((job) => job.status === 'succeeded' && job.expiresAt && Date.parse(job.expiresAt) <= now)
          .slice(0, limit),
      );
    },

    async createPayment(payment) {
      return mutate(() => {
        const now = nowIso();
        const row = {
          providerPaymentId: null,
          providerReference: null,
          confirmationUrl: null,
          paidAt: null,
          refundedAt: null,
          createdAt: now,
          updatedAt: now,
          ...payment,
        };
        state.payments.set(row.id, row);
        return row;
      });
    },
    async updatePayment(id, patch) {
      return mutate(() => {
        const payment = state.payments.get(id);
        if (!payment) return null;
        if (patch.providerPaymentId) {
          for (const other of state.payments.values()) {
            if (other.id !== id && other.provider === payment.provider && other.providerPaymentId === patch.providerPaymentId) {
              throw new DbError('duplicate_provider_payment', 'Provider payment id already used.');
            }
          }
        }
        Object.assign(payment, patch, { updatedAt: nowIso() });
        return payment;
      });
    },
    // Moves a payment between states only if it is currently in one of
    // `from`. Returns the updated row, or null when another request won.
    async transitionPayment(id, from, to, patch = {}) {
      return mutate(() => {
        const payment = state.payments.get(id);
        if (!payment || !from.includes(payment.status)) return null;
        Object.assign(payment, patch, { status: to, updatedAt: nowIso() });
        for (const key of ['paidAt', 'refundedAt']) if (key in patch) payment[key] = iso(patch[key]);
        return payment;
      });
    },
    async getPayment(id) {
      return clone(state.payments.get(id));
    },
    async findPaymentByProviderId(provider, providerPaymentId) {
      for (const payment of state.payments.values()) {
        if (payment.provider === provider && payment.providerPaymentId === providerPaymentId) return clone(payment);
      }
      return null;
    },
    async findPaymentByReference(provider, providerReference) {
      for (const payment of state.payments.values()) {
        if (payment.provider === provider && payment.providerReference === providerReference) return clone(payment);
      }
      return null;
    },
    async listPayments(userId, { limit = 100 } = {}) {
      return clone(Array.from(state.payments.values()).filter((p) => p.userId === userId).sort(byNewest).slice(0, limit));
    },

    async addUsageEvent(event) {
      return mutate(() => {
        const row = { source: null, amount: 0, jobId: null, paymentId: null, createdAt: nowIso(), ...event };
        state.usageEvents.set(row.id, row);
        return row;
      });
    },
    async listUsageEvents(userId, { limit = 100 } = {}) {
      return clone(Array.from(state.usageEvents.values()).filter((e) => e.userId === userId).sort(byNewest).slice(0, limit));
    },

    async createProject(project) {
      return mutate(() => {
        const now = nowIso();
        const row = { libraryItemId: null, prompt: null, brief: null, createdAt: now, updatedAt: now, ...project };
        state.projects.set(row.id, row);
        return row;
      });
    },
    async listProjects(userId, { limit = 200 } = {}) {
      return clone(Array.from(state.projects.values()).filter((p) => p.userId === userId).sort(byNewest).slice(0, limit));
    },
    async countProjects(userId) {
      return Array.from(state.projects.values()).filter((p) => p.userId === userId).length;
    },
    async deleteProject(id, userId) {
      return mutate(() => {
        const project = state.projects.get(id);
        if (!project || project.userId !== userId) return false;
        state.projects.delete(id);
        return true;
      });
    },
    async createAutomationTask(task, { limit } = {}) {
      return mutate(() => {
        if (limit !== undefined && Array.from(state.automationTasks.values()).filter((item) => item.userId === task.userId).length >= limit) return null;
        const now = nowIso();
        const row = { enabled: true, createdAt: now, updatedAt: now, ...task };
        state.automationTasks.set(row.id, row);
        return row;
      });
    },
    async listAutomationTasks(userId, { limit = 100 } = {}) {
      return clone(Array.from(state.automationTasks.values()).filter((task) => task.userId === userId).sort(byNewest).slice(0, limit));
    },
    async getAutomationTask(id, userId) {
      const task = state.automationTasks.get(id);
      return task && task.userId === userId ? clone(task) : null;
    },
    async updateAutomationTask(id, userId, patch) {
      return mutate(() => {
        const task = state.automationTasks.get(id);
        if (!task || task.userId !== userId) return null;
        Object.assign(task, patch, { updatedAt: nowIso() });
        return task;
      });
    },
    async deleteAutomationTask(id, userId) {
      return mutate(() => {
        const task = state.automationTasks.get(id);
        if (!task || task.userId !== userId) return false;
        state.automationTasks.delete(id);
        for (const run of state.automationRuns.values()) {
          if (run.taskId === id) state.automationRuns.delete(run.id);
        }
        return true;
      });
    },
    async createAutomationRun(run) {
      return mutate(() => {
        for (const item of state.automationRuns.values()) {
          if (item.taskId === run.taskId && ACTIVE_RUN_STATUSES.has(item.status)) return null;
        }
        const now = nowIso();
        const row = {
          simulated: false, providerJobId: null, summary: null, log: [], error: null,
          startedAt: null, completedAt: null, createdAt: now, updatedAt: now, ...run,
        };
        state.automationRuns.set(row.id, row);
        return row;
      });
    },
    async updateAutomationRun(id, patch) {
      return mutate(() => {
        const run = state.automationRuns.get(id);
        if (!run) return null;
        Object.assign(run, patch, { updatedAt: nowIso() });
        return run;
      });
    },
    async getAutomationRun(id, userId) {
      const run = state.automationRuns.get(id);
      return run && run.userId === userId ? clone(run) : null;
    },
    async listAutomationRuns(userId, { taskId = null, limit = 50 } = {}) {
      return clone(
        Array.from(state.automationRuns.values())
          .filter((run) => run.userId === userId && (!taskId || run.taskId === taskId))
          .sort(byNewest)
          .slice(0, limit),
      );
    },
    async failStaleAutomationRuns(before, error) {
      return mutate(() => {
        const cutoff = new Date(before).toISOString();
        let count = 0;
        for (const run of state.automationRuns.values()) {
          if (ACTIVE_RUN_STATUSES.has(run.status) && run.createdAt < cutoff) {
            const now = nowIso();
            Object.assign(run, { status: 'failed', error, completedAt: now, updatedAt: now });
            count += 1;
          }
        }
        return count;
      });
    },
    async pruneAutomationRuns(taskId, keep) {
      return mutate(() => {
        const runs = Array.from(state.automationRuns.values()).filter((run) => run.taskId === taskId).sort(byNewest);
        let count = 0;
        for (const run of runs.slice(keep)) {
          if (!ACTIVE_RUN_STATUSES.has(run.status)) {
            state.automationRuns.delete(run.id);
            count += 1;
          }
        }
        return count;
      });
    },
  };
}

module.exports = { createMemoryDatabase, DbError };
