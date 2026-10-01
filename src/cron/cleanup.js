'use strict';

// Retention job: deletes generated videos older than VIDEO_RETENTION_DAYS
// (default 30) from object storage and marks the jobs as expired; also prunes
// used/expired password-reset tokens. Run as a Railway cron service:
//   node src/cron/cleanup.js

const path = require('node:path');
const { createDatabase } = require('../db/index.js');
const { createS3Storage } = require('../storage/s3.js');
const { loadConfig } = require('../server.js');

async function runCleanup({ db, storage, now = Date.now(), batchSize = 100, logger = console }) {
  let expired = 0;
  let failed = 0;
  for (;;) {
    const jobs = await db.listExpiredVideoJobs(now, batchSize);
    if (jobs.length === 0) break;
    let progressed = false;
    for (const job of jobs) {
      try {
        if (job.videoKey && storage) await storage.deleteObject(job.videoKey);
        await db.updateVideoJob(job.id, { status: 'expired', videoKey: null, videoUrl: null });
        expired += 1;
        progressed = true;
      } catch (error) {
        failed += 1;
        logger.error(`cleanup of job ${job.id} failed: ${error.code || 'error'}`);
      }
    }
    if (!progressed || jobs.length < batchSize) break;
  }
  const resets = await db.deleteExpiredPasswordResets(now);
  return { expired, failed, resets };
}

async function main() {
  const config = loadConfig();
  const db = createDatabase({ databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl, dataDir: path.join(config.dataDir, 'accounts') });
  const storage = createS3Storage(config.s3);
  try {
    const result = await runCleanup({ db, storage });
    console.log(`cleanup: expired ${result.expired} videos, ${result.failed} failures, ${result.resets} reset tokens removed`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`cleanup failed: ${error.code || error.message}`);
    process.exit(1);
  });
}

module.exports = { runCleanup };
