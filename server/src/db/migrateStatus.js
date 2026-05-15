// server/src/db/migrateStatus.js
// `npm run migrate:status` — print applied vs. pending migrations
// without running anything. Useful before a deploy to confirm the
// pending set matches what code review expected.

import { migrationStatus } from '../startup/runMigrations.js';
import { closePools } from './pool.js';
import { logger } from '../lib/logger.js';

(async () => {
  try {
    const { applied, pending } = await migrationStatus();
    process.stdout.write(`Applied (${applied.length}):\n`);
    for (const f of applied) process.stdout.write(`  ✓ ${f}\n`);
    process.stdout.write(`\nPending (${pending.length}):\n`);
    for (const f of pending) process.stdout.write(`  • ${f}\n`);
    if (!applied.length && !pending.length) {
      process.stdout.write('No migrations found.\n');
    }
  } catch (err) {
    logger.error('migration status failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  } finally {
    await closePools().catch(() => {});
  }
})();
