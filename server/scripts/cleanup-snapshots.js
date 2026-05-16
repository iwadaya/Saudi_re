// Cleans up import_snapshots rows past the 30-day retention window.
//
// TODO(scheduling): There is no scheduling infrastructure in this
// codebase (no cron, no pg_cron, no setInterval on boot). Run this
// manually for now — `npm run cleanup:snapshots` from server/ — or
// wire it into whatever the team adopts later. The deletion is
// idempotent and cheap; running it daily is plenty.
//
// Render's "Cron Jobs" feature would be the lowest-friction path,
// but we don't pick that unilaterally — see services/renewalPack/snapshots.js
// for the retention constant.

import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { cleanupExpiredSnapshots } from '../src/services/renewalPack/snapshots.js';

(async () => {
  try {
    const removed = await cleanupExpiredSnapshots(pool);
    logger.info('[cleanup-snapshots] done', { removed });
    process.exitCode = 0;
  } catch (err) {
    logger.error('[cleanup-snapshots] failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  } finally {
    await closePools().catch(() => {});
  }
})();
