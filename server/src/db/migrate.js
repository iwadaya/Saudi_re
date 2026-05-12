// server/src/db/migrate.js
// Standalone migration runner — `npm run migrate` entry point.
//
// Migrations normally apply on app boot via runMigrations() from
// startup/runMigrations.js (gated by RUN_MIGRATIONS_ON_BOOT). CI
// and ops scripts want to run them out-of-band without booting the
// full app, so this file calls the same runner with a clean exit
// code so the shell knows pass / fail.

import { runMigrations } from '../startup/runMigrations.js';
import { closePools } from './pool.js';
import { logger } from '../lib/logger.js';

(async () => {
  try {
    await runMigrations();
    logger.info('migrations complete');
  } catch (err) {
    logger.error('migrations failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  } finally {
    // Drain the pg pool so the process exits instead of hanging on
    // the keepalive connection.
    await closePools().catch(() => {});
  }
})();
