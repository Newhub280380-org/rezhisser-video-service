'use strict';

// Server-side spend guard for billable (Replicate) jobs.
//
// - Paid jobs need a server-issued quote bound to the session, model profile,
//   brief and image, confirmed explicitly by the user before it expires.
// - Every paid job needs an idempotency key; repeating the key returns the
//   job that was already created instead of starting a second prediction.
// - Daily USD budget, daily job count and total job count caps are enforced
//   BEFORE the provider is called. The estimate is counted as spent even if
//   the prediction later fails, times out or is cancelled, because the
//   provider may still charge for it.
//
// Limitations: the ledger is a file in DATA_DIR. On an ephemeral filesystem
// (Render free plan) it is reset on every deploy/restart, and the numbers are
// operator estimates, not provider invoices. It is not a provider-side hard
// spend cap.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEDGER_FILE = 'spend-ledger.state';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

function dayKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function createSpendGuard({
  dataDir,
  dailyBudgetUsd = 0,
  dailyJobLimit = 0,
  totalJobLimit = 0,
  quoteTtlMs = 10 * 60 * 1000,
  now = Date.now,
  logger = console,
}) {
  const file = path.join(dataDir, LEDGER_FILE);
  let ledger = { days: {}, totalJobs: 0, totalUsd: 0, idempotency: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') ledger = { ...ledger, ...parsed };
  } catch (error) {
    if (error.code !== 'ENOENT') logger.error('[spend] could not read ledger, starting from zero');
  }
  const quotes = new Map();

  function persist() {
    const keys = Object.keys(ledger.idempotency);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) delete ledger.idempotency[key];
    }
    fs.writeFileSync(file, JSON.stringify(ledger));
  }

  function today() {
    const key = dayKey(now());
    return ledger.days[key] || { jobs: 0, usd: 0 };
  }

  function status() {
    const day = today();
    return {
      day: dayKey(now()),
      dailyBudgetUsd,
      dailyJobLimit,
      totalJobLimit,
      spentTodayUsd: round(day.usd),
      jobsToday: day.jobs,
      totalJobs: ledger.totalJobs,
      totalEstimatedUsd: round(ledger.totalUsd),
      remainingTodayUsd: round(Math.max(0, dailyBudgetUsd - day.usd)),
      remainingJobsToday: Math.max(0, dailyJobLimit - day.jobs),
      remainingTotalJobs: Math.max(0, totalJobLimit - ledger.totalJobs),
    };
  }

  function limitsConfigured() {
    return dailyBudgetUsd > 0 && dailyJobLimit > 0 && totalJobLimit > 0;
  }

  // Returns null when the job fits in every limit, otherwise an error object.
  function check(estimateUsd) {
    if (!limitsConfigured()) {
      return { code: 'spend_limits_not_configured', message: 'Лимиты расходов не заданы на сервере.' };
    }
    if (typeof estimateUsd !== 'number' || !(estimateUsd > 0)) {
      return { code: 'price_not_configured', message: 'Для модели не задана оценка стоимости.' };
    }
    const day = today();
    if (ledger.totalJobs + 1 > totalJobLimit) {
      return { code: 'total_job_limit_reached', message: 'Исчерпан общий лимит платных генераций.' };
    }
    if (day.jobs + 1 > dailyJobLimit) {
      return { code: 'daily_job_limit_reached', message: 'Исчерпан дневной лимит платных генераций.' };
    }
    if (day.usd + estimateUsd > dailyBudgetUsd + 1e-9) {
      return { code: 'daily_budget_exceeded', message: 'Генерация не помещается в дневной бюджет.' };
    }
    return null;
  }

  function pruneQuotes() {
    const t = now();
    for (const [id, quote] of quotes) if (quote.expiresAt <= t && !quote.jobId) quotes.delete(id);
    while (quotes.size > 200) quotes.delete(quotes.keys().next().value);
  }

  return {
    status,
    check,
    limitsConfigured,
    isValidIdempotencyKey(key) {
      return typeof key === 'string' && IDEMPOTENCY_KEY_PATTERN.test(key);
    },
    findIdempotent(key) {
      return Object.prototype.hasOwnProperty.call(ledger.idempotency, key) ? ledger.idempotency[key] : null;
    },
    issueQuote({ sessionId, profileId, briefHash, imageSha256, estimateUsd, clipDuration }) {
      pruneQuotes();
      const quote = {
        id: crypto.randomBytes(18).toString('base64url'),
        sessionId,
        profileId,
        briefHash,
        imageSha256: imageSha256 || null,
        estimateUsd,
        clipDuration,
        createdAt: now(),
        expiresAt: now() + quoteTtlMs,
        jobId: null,
      };
      quotes.set(quote.id, quote);
      return quote;
    },
    getQuote(id) {
      if (typeof id !== 'string' || id.length > 64) return null;
      const quote = quotes.get(id);
      return quote || null;
    },
    // Records the job against every limit. Must be called synchronously right
    // before the provider is started (no await in between), so two concurrent
    // requests cannot both pass check().
    reserve({ quote, idempotencyKey, jobId }) {
      const key = dayKey(now());
      const day = ledger.days[key] || { jobs: 0, usd: 0 };
      day.jobs += 1;
      day.usd = round(day.usd + quote.estimateUsd);
      ledger.days = { [key]: day };
      ledger.totalJobs += 1;
      ledger.totalUsd = round(ledger.totalUsd + quote.estimateUsd);
      ledger.idempotency[idempotencyKey] = jobId;
      quote.jobId = jobId;
      persist();
    },
    ledgerFile: file,
  };
}

module.exports = { createSpendGuard, LEDGER_FILE, IDEMPOTENCY_KEY_PATTERN };
