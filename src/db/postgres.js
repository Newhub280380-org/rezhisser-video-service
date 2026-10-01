'use strict';

// PostgreSQL repository (production). Same async interface as
// src/db/memory.js. Conditional updates are single SQL statements, so quota,
// credit and payment-state changes are atomic across server instances.

const fs = require('node:fs');
const path = require('node:path');
const { DbError } = require('./memory.js');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// camelCase field -> column, per table. Only these fields can be written.
const COLUMNS = {
  users: {
    id: 'id', email: 'email', passwordHash: 'password_hash', locale: 'locale', tier: 'tier',
    subscriptionExpiresAt: 'subscription_expires_at', periodStart: 'period_start',
    periodVideosUsed: 'period_videos_used', credits: 'credits', tokenVersion: 'token_version',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
  video_jobs: {
    id: 'id', userId: 'user_id', status: 'status', provider: 'provider', providerTaskId: 'provider_task_id',
    model: 'model', prompt: 'prompt', brief: 'brief', libraryItemId: 'library_item_id', aspect: 'aspect',
    durationSeconds: 'duration_seconds', hasImage: 'has_image', billingSource: 'billing_source',
    costUsd: 'cost_usd', videoKey: 'video_key', videoUrl: 'video_url', videoBytes: 'video_bytes',
    error: 'error', createdAt: 'created_at', updatedAt: 'updated_at', completedAt: 'completed_at',
    expiresAt: 'expires_at',
  },
  payments: {
    id: 'id', userId: 'user_id', provider: 'provider', providerPaymentId: 'provider_payment_id',
    providerReference: 'provider_reference', product: 'product', amountMinor: 'amount_minor',
    currency: 'currency', status: 'status', confirmationUrl: 'confirmation_url', createdAt: 'created_at',
    updatedAt: 'updated_at', paidAt: 'paid_at', refundedAt: 'refunded_at',
  },
  usage_events: {
    id: 'id', userId: 'user_id', kind: 'kind', source: 'source', amount: 'amount', jobId: 'job_id',
    paymentId: 'payment_id', createdAt: 'created_at',
  },
  projects: {
    id: 'id', userId: 'user_id', kind: 'kind', title: 'title', libraryItemId: 'library_item_id',
    prompt: 'prompt', brief: 'brief', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  automation_tasks: {
    id: 'id', userId: 'user_id', name: 'name', url: 'url', instruction: 'instruction', region: 'region',
    enabled: 'enabled', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  automation_runs: {
    id: 'id', taskId: 'task_id', userId: 'user_id', taskName: 'task_name', url: 'url', status: 'status',
    executor: 'executor', simulated: 'simulated', providerJobId: 'provider_job_id', summary: 'summary',
    log: 'log', error: 'error', createdAt: 'created_at', updatedAt: 'updated_at', startedAt: 'started_at',
    completedAt: 'completed_at',
  },
};
const JSON_COLUMNS = new Set(['brief', 'error', 'log']);
const NUMERIC_FIELDS = new Set(['costUsd', 'videoBytes', 'amountMinor']);

function toRow(table, row) {
  if (!row) return null;
  const out = {};
  for (const [field, column] of Object.entries(COLUMNS[table])) {
    let value = row[column];
    if (value instanceof Date) value = value.toISOString();
    if (NUMERIC_FIELDS.has(field) && value !== null && value !== undefined) value = Number(value);
    out[field] = value === undefined ? null : value;
  }
  return out;
}

function encode(field, value) {
  if (value === undefined) return null;
  if (JSON_COLUMNS.has(field) && value !== null) return JSON.stringify(value);
  return value;
}

function insertSql(table, values) {
  const fields = Object.keys(values).filter((field) => COLUMNS[table][field]);
  const columns = fields.map((field) => COLUMNS[table][field]);
  const params = fields.map((field) => encode(field, values[field]));
  const placeholders = fields.map((_, index) => `$${index + 1}`);
  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values: params,
  };
}

function updateSql(table, id, patch, where = '', whereValues = []) {
  const fields = Object.keys(patch).filter((field) => COLUMNS[table][field] && field !== 'id');
  const sets = fields.map((field, index) => `${COLUMNS[table][field]} = $${index + 2}`);
  sets.push('updated_at = now()');
  const values = [id, ...fields.map((field) => encode(field, patch[field]))];
  const extra = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + values.length}`);
  return {
    text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1${extra ? ` AND ${extra}` : ''} RETURNING *`,
    values: [...values, ...whereValues],
  };
}

function createPostgresDatabase({ connectionString, ssl, pool: injectedPool, libraryItems = [] }) {
  let pool = injectedPool;
  if (!pool) {
    // Loaded lazily so local development and tests need no dependencies.
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString,
      ssl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (error) => console.error(`postgres pool error: ${error.code || error.message}`));
  }

  const query = (text, values) => pool.query(text, values);
  const one = async (table, text, values) => toRow(table, (await query(text, values)).rows[0]);
  const many = async (table, text, values) => (await query(text, values)).rows.map((row) => toRow(table, row));

  return {
    kind: 'postgres',
    async migrate() {
      await query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
      for (const item of libraryItems) {
        await query(
          `INSERT INTO library_items (id, region, country, language, category, type, title, trend, data, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (id) DO UPDATE SET region = EXCLUDED.region, country = EXCLUDED.country,
             language = EXCLUDED.language, category = EXCLUDED.category, type = EXCLUDED.type,
             title = EXCLUDED.title, trend = EXCLUDED.trend, data = EXCLUDED.data, updated_at = now()`,
          [item.id, item.region, item.country, item.language, item.category, item.type, item.title, item.trend, JSON.stringify(item)],
        );
      }
      return { applied: true, libraryItems: libraryItems.length };
    },
    async ping() {
      await query('SELECT 1');
      return true;
    },
    async close() {
      await pool.end();
    },

    async createUser({ id, email, passwordHash, locale = 'ru' }) {
      const sql = insertSql('users', { id, email, passwordHash, locale });
      try {
        return await one('users', sql.text, sql.values);
      } catch (error) {
        if (error.code === '23505') throw new DbError('email_taken', 'Email already registered.');
        throw error;
      }
    },
    getUserById: (id) => one('users', 'SELECT * FROM users WHERE id = $1', [id]),
    getUserByEmail: (email) => one('users', 'SELECT * FROM users WHERE email = $1', [email]),
    updateUserPassword: (id, passwordHash) =>
      one('users', 'UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING *', [id, passwordHash]),
    rollUsagePeriod: (id, now, periodMs) =>
      one(
        'users',
        `UPDATE users SET
           period_videos_used = CASE WHEN period_start + ($3::bigint * interval '1 millisecond') <= $2 THEN 0 ELSE period_videos_used END,
           period_start = CASE WHEN period_start + ($3::bigint * interval '1 millisecond') <= $2 THEN $2 ELSE period_start END
         WHERE id = $1 RETURNING *`,
        [id, new Date(now).toISOString(), periodMs],
      ),
    async incrementPeriodUsage(id, limit) {
      const result = await query(
        'UPDATE users SET period_videos_used = period_videos_used + 1, updated_at = now() WHERE id = $1 AND ($2::int IS NULL OR period_videos_used < $2::int)',
        [id, limit],
      );
      return result.rowCount === 1;
    },
    async decrementPeriodUsage(id) {
      const result = await query('UPDATE users SET period_videos_used = GREATEST(0, period_videos_used - 1), updated_at = now() WHERE id = $1', [id]);
      return result.rowCount === 1;
    },
    async consumeCredits(id, amount) {
      const result = await query('UPDATE users SET credits = credits - $2, updated_at = now() WHERE id = $1 AND credits >= $2', [id, amount]);
      return result.rowCount === 1;
    },
    addCredits: (id, amount) =>
      one('users', 'UPDATE users SET credits = GREATEST(0, credits + $2), updated_at = now() WHERE id = $1 RETURNING *', [id, amount]),
    setSubscription: (id, { tier, expiresAt, resetPeriodAt = null }) =>
      one(
        'users',
        `UPDATE users SET tier = $2, subscription_expires_at = $3,
           period_start = COALESCE($4, period_start),
           period_videos_used = CASE WHEN $4::timestamptz IS NULL THEN period_videos_used ELSE 0 END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, tier, expiresAt ? new Date(expiresAt).toISOString() : null, resetPeriodAt === null ? null : new Date(resetPeriodAt).toISOString()],
      ),

    async createPasswordReset({ tokenHash, userId, expiresAt }) {
      await query('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        tokenHash, userId, new Date(expiresAt).toISOString(),
      ]);
    },
    async consumePasswordReset(tokenHash, now) {
      const result = await query(
        'UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id',
        [tokenHash, new Date(now).toISOString()],
      );
      return result.rows[0] ? result.rows[0].user_id : null;
    },
    async deleteExpiredPasswordResets(now) {
      const result = await query('DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at <= $1', [new Date(now).toISOString()]);
      return result.rowCount;
    },

    createVideoJob(job) {
      const sql = insertSql('video_jobs', job);
      return one('video_jobs', sql.text, sql.values);
    },
    updateVideoJob(id, patch) {
      const sql = updateSql('video_jobs', id, patch);
      return one('video_jobs', sql.text, sql.values);
    },
    getVideoJob: (id) => one('video_jobs', 'SELECT * FROM video_jobs WHERE id = $1', [id]),
    listVideoJobs: (userId, { limit = 50 } = {}) =>
      many('video_jobs', 'SELECT * FROM video_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),
    listActiveVideoJobs: () => many('video_jobs', "SELECT * FROM video_jobs WHERE status IN ('queued', 'processing')", []),
    listExpiredVideoJobs: (now, limit = 100) =>
      many(
        'video_jobs',
        "SELECT * FROM video_jobs WHERE status = 'succeeded' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2",
        [new Date(now).toISOString(), limit],
      ),

    createPayment(payment) {
      const sql = insertSql('payments', payment);
      return one('payments', sql.text, sql.values);
    },
    async updatePayment(id, patch) {
      const sql = updateSql('payments', id, patch);
      try {
        return await one('payments', sql.text, sql.values);
      } catch (error) {
        if (error.code === '23505') throw new DbError('duplicate_provider_payment', 'Provider payment id already used.');
        throw error;
      }
    },
    transitionPayment(id, from, to, patch = {}) {
      const sql = updateSql('payments', id, { ...patch, status: to }, 'status = ANY($1::text[])', [from]);
      return one('payments', sql.text, sql.values);
    },
    getPayment: (id) => one('payments', 'SELECT * FROM payments WHERE id = $1', [id]),
    findPaymentByProviderId: (provider, providerPaymentId) =>
      one('payments', 'SELECT * FROM payments WHERE provider = $1 AND provider_payment_id = $2', [provider, providerPaymentId]),
    findPaymentByReference: (provider, providerReference) =>
      one('payments', 'SELECT * FROM payments WHERE provider = $1 AND provider_reference = $2', [provider, providerReference]),
    listPayments: (userId, { limit = 100 } = {}) =>
      many('payments', 'SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),

    addUsageEvent(event) {
      const sql = insertSql('usage_events', event);
      return one('usage_events', sql.text, sql.values);
    },
    listUsageEvents: (userId, { limit = 100 } = {}) =>
      many('usage_events', 'SELECT * FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),

    createProject(project) {
      const sql = insertSql('projects', project);
      return one('projects', sql.text, sql.values);
    },
    listProjects: (userId, { limit = 200 } = {}) =>
      many('projects', 'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),
    async countProjects(userId) {
      const result = await query('SELECT count(*)::int AS n FROM projects WHERE user_id = $1', [userId]);
      return result.rows[0].n;
    },
    async deleteProject(id, userId) {
      const result = await query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [id, userId]);
      return result.rowCount === 1;
    },
    async createAutomationTask(task, { limit } = {}) {
      const sql = insertSql('automation_tasks', task);
      if (limit === undefined) return one('automation_tasks', sql.text, sql.values);
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [task.userId]);
        const count = await client.query('SELECT count(*)::int AS n FROM automation_tasks WHERE user_id = $1', [task.userId]);
        if (count.rows[0].n >= limit) {
          await client.query('ROLLBACK');
          inTransaction = false;
          return null;
        }
        const result = await client.query(sql.text, sql.values);
        await client.query('COMMIT');
        inTransaction = false;
        return toRow('automation_tasks', result.rows[0]);
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK');
          } catch {}
        }
        throw error;
      } finally {
        client.release();
      }
    },
    listAutomationTasks(userId, { limit = 100 } = {}) {
      return many('automation_tasks', 'SELECT * FROM automation_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    },
    getAutomationTask(id, userId) {
      return one('automation_tasks', 'SELECT * FROM automation_tasks WHERE id = $1 AND user_id = $2', [id, userId]);
    },
    updateAutomationTask(id, userId, patch) {
      const sql = updateSql('automation_tasks', id, patch, 'user_id = $1', [userId]);
      return one('automation_tasks', sql.text, sql.values);
    },
    async deleteAutomationTask(id, userId) {
      const result = await query('DELETE FROM automation_tasks WHERE id = $1 AND user_id = $2', [id, userId]);
      return result.rowCount === 1;
    },
    // Returns null when the task already has a queued or running run.
    async createAutomationRun(run) {
      const sql = insertSql('automation_runs', run);
      try {
        return await one('automation_runs', sql.text, sql.values);
      } catch (error) {
        if (error.code === '23505') return null;
        throw error;
      }
    },
    updateAutomationRun(id, patch) {
      const sql = updateSql('automation_runs', id, patch);
      return one('automation_runs', sql.text, sql.values);
    },
    getAutomationRun(id, userId) {
      return one('automation_runs', 'SELECT * FROM automation_runs WHERE id = $1 AND user_id = $2', [id, userId]);
    },
    listAutomationRuns(userId, { taskId = null, limit = 50 } = {}) {
      if (taskId) {
        return many('automation_runs', 'SELECT * FROM automation_runs WHERE user_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT $3', [userId, taskId, limit]);
      }
      return many('automation_runs', 'SELECT * FROM automation_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
    },
    // Marks queued/running runs created before `before` as failed (e.g. after a restart).
    async failStaleAutomationRuns(before, error) {
      const result = await query(
        `UPDATE automation_runs SET status = 'failed', error = $2, completed_at = now(), updated_at = now()
         WHERE status IN ('queued', 'running') AND created_at < $1`,
        [new Date(before).toISOString(), JSON.stringify(error)],
      );
      return result.rowCount;
    },
    // Keeps the newest `keep` finished runs of a task.
    async pruneAutomationRuns(taskId, keep) {
      const result = await query(
        `DELETE FROM automation_runs WHERE task_id = $1 AND status IN ('succeeded', 'failed') AND id NOT IN (
           SELECT id FROM automation_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2)`,
        [taskId, keep],
      );
      return result.rowCount;
    },
  };
}

module.exports = { createPostgresDatabase, SCHEMA_FILE };
