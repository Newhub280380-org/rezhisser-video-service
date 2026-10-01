'use strict';

// Account video pipeline: submit to Seedance, poll until done, copy the result
// into S3-compatible storage, and refund the reserved generation on failure.
// Jobs live in the database, so polling resumes after a restart.

const { StorageError } = require('./storage/s3.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function createVideoPipeline({ db, provider, storage, billing, logger = console, now = Date.now, pollIntervalMs = 5000, maxWaitMs = 900000, retentionDays = 30, demoDurationMs = 3000 }) {
  const timers = new Set();
  let closed = false;

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  async function fail(job, error) {
    const updated = await db.updateVideoJob(job.id, {
      status: 'failed',
      error: { code: error.code || 'failed', message: String(error.message || 'Generation failed.').slice(0, 300) },
      completedAt: new Date(now()).toISOString(),
    });
    try {
      await billing.refundGeneration(job);
    } catch (refundError) {
      logger.error(`refund for job ${job.id} failed: ${refundError.code || 'error'}`);
    }
    return updated;
  }

  async function finish(job, result) {
    const patch = {
      status: 'succeeded',
      completedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + retentionDays * DAY_MS).toISOString(),
      error: null,
    };
    if (storage) {
      const key = `videos/${job.userId}/${job.id}.mp4`;
      try {
        const stored = await storage.copyFromUrl(result.videoUrl, key);
        Object.assign(patch, { videoKey: key, videoBytes: stored.bytes, videoUrl: null });
      } catch (error) {
        // Keep the provider URL (temporary) rather than losing the video.
        logger.error(`storing job ${job.id} failed: ${error instanceof StorageError ? error.code : 'error'}`);
        patch.videoUrl = result.videoUrl;
      }
    } else {
      patch.videoUrl = result.videoUrl;
    }
    return db.updateVideoJob(job.id, patch);
  }

  async function poll(job, startedAt, release = provider.acquire()) {
    try {
      while (!closed) {
        if (now() - startedAt > maxWaitMs) {
          await provider.cancel(job.providerTaskId);
          return fail(job, { code: 'timeout', message: 'Генерация заняла слишком много времени.' });
        }
        let state;
        try {
          state = await provider.get(job.providerTaskId);
        } catch (error) {
          logger.error(`seedance poll for job ${job.id} failed: ${error.code || 'error'}`);
          state = { status: 'processing' };
        }
        if (state.status === 'succeeded') return finish(job, state);
        if (state.status === 'failed') return fail(job, state.error || {});
        await sleep(pollIntervalMs);
      }
      return null;
    } finally {
      release();
    }
  }

  async function runReal(job, input, release = provider.acquire()) {
    let taskId;
    try {
      taskId = await provider.submit(input);
    } catch (error) {
      release();
      logger.error(`seedance submit for job ${job.id} failed: ${error.code || 'error'}`);
      return fail(job, { code: 'provider_error', message: 'Сервис генерации не принял задачу.' });
    }
    let updated;
    try {
      updated = await db.updateVideoJob(job.id, { status: 'processing', providerTaskId: taskId });
    } catch (error) {
      release();
      throw error;
    }
    return poll(updated, Date.parse(job.createdAt) || now(), release);
  }

  async function runDemo(job) {
    await db.updateVideoJob(job.id, { status: 'processing' });
    await sleep(demoDurationMs);
    if (closed) return null;
    return db.updateVideoJob(job.id, { status: 'succeeded', completedAt: new Date(now()).toISOString() });
  }

  function track(promise, job) {
    promise.catch((error) => logger.error(`job ${job.id} crashed: ${error.code || error.message}`));
    return promise;
  }

  return {
    // Fire-and-forget; returns the promise for tests.
    // `release` is a provider slot already reserved by the caller.
    start(job, input, release) {
      return track(job.billingSource === 'demo' ? runDemo(job) : runReal(job, input, release || undefined), job);
    },
    // Re-attaches pollers to jobs left running by a previous process.
    async resume() {
      const active = await db.listActiveVideoJobs();
      let resumed = 0;
      for (const job of active) {
        if (job.billingSource === 'demo') {
          await db.updateVideoJob(job.id, { status: 'succeeded', completedAt: new Date(now()).toISOString() });
        } else if (job.providerTaskId && provider) {
          track(poll(job, Date.parse(job.createdAt)), job);
          resumed += 1;
        } else {
          await fail(job, { code: 'interrupted', message: 'Сервер перезапустился до отправки задачи.' });
        }
      }
      return resumed;
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

module.exports = { createVideoPipeline };
