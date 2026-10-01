'use strict';

// npm run db:migrate — applies src/db/schema.sql and upserts the content
// library into library_items. Idempotent; also run automatically at startup
// unless DB_AUTO_MIGRATE=false.

const { createDatabase } = require('./index.js');
const { createLibrary } = require('../library/index.js');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set; nothing to migrate.');
    process.exit(1);
  }
  const library = createLibrary();
  const db = createDatabase({ databaseUrl: process.env.DATABASE_URL, databaseSsl: process.env.DATABASE_SSL, libraryItems: library.items });
  try {
    const result = await db.migrate();
    console.log(`schema applied; library items upserted: ${result.libraryItems}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`migration failed: ${error.code || error.message}`);
  process.exit(1);
});
