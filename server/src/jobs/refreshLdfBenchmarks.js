// Refreshes the LDF benchmark materialized views.
//
// TODO(scheduling): There is no in-process scheduler in this codebase
// (see startup/bootstrap.js for the standing TODO). Run this nightly
// via the platform's cron facility (Render Cron / Kubernetes CronJob /
// pg_cron / GH Actions) — `node src/jobs/refreshLdfBenchmarks.js`
// from server/. CONCURRENTLY refresh won't block readers.
//
// The same refresh fires opportunistically after each contract reaches
// a terminal state (SIGNED / DECLINED / NTU) via the
// modules/pricing/repositories/pricingOfferRepository.js hook; the
// nightly job is the safety net for views that drift if the in-process
// refresh fails or the server restarts mid-transition.

import { pool, closePools } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { refreshBenchmarks } from '../services/ldf/benchmark.js';

export async function runRefreshLdfBenchmarks(client = pool) {
  await refreshBenchmarks(client);
}

// When invoked directly via `node src/jobs/refreshLdfBenchmarks.js`,
// run once and exit. When imported as a module (tests, future scheduler
// wiring), only the exported function is used.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  (async () => {
    try {
      await runRefreshLdfBenchmarks(pool);
      logger.info('[refresh-ldf-benchmarks] done');
      process.exitCode = 0;
    } catch (err) {
      logger.error('[refresh-ldf-benchmarks] failed', { error: err?.message, stack: err?.stack });
      process.exitCode = 1;
    } finally {
      await closePools().catch(() => {});
    }
  })();
}
