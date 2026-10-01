'use strict';

// Chooses the repository implementation: PostgreSQL when DATABASE_URL is set
// (production), otherwise an in-process store persisted to DATA_DIR/db.json.

const path = require('node:path');
const { createMemoryDatabase } = require('./memory.js');
const { createPostgresDatabase } = require('./postgres.js');

function sslOption(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'disable' || value === 'false') return false;
  if (value === 'no-verify') return { rejectUnauthorized: false };
  if (value === 'require' || value === 'true') return { rejectUnauthorized: true };
  return undefined;
}

function createDatabase({ databaseUrl, databaseSsl, dataDir, persist = true, libraryItems = [], pool } = {}) {
  if (databaseUrl || pool) {
    return createPostgresDatabase({ connectionString: databaseUrl, ssl: sslOption(databaseSsl), pool, libraryItems });
  }
  return createMemoryDatabase({ file: persist && dataDir ? path.join(dataDir, 'db.json') : null });
}

module.exports = { createDatabase, sslOption };
