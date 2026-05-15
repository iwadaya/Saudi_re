// server/src/db/migrate.js
// Standalone migration runner — `npm run migrate:up` entry point.
//
// Migrations no longer run on app boot by default — bootstrap.js gates
// them on RUN_MIGRATIONS_ON_BOOT (default false). Render's predeploy
// hook and the CI pipeline call this script directly so a bad
// migration fails the deploy instead of taking the API down on boot.
// The local docker-compose path still opts back in to boot-time
// migrations for convenience.

import { runMigrations } from '../startup/runMigrations.js';
import { closePools } from './pool.js';
import { logger } from '../lib/logger.js';

(async () => {
  try {
    const results = await runMigrations();
    const ran = results.filter((r) => r.status === 'ran').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    logger.info('migrations complete', { ran, alreadyApplied: skipped });
  } catch (err) {
    logger.error('migrations failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  } finally {
    // Drain the pg pool so the process exits instead of hanging on
    // the keepalive connection.
    await closePools().catch(() => {});
  }
})();
