// Refreshes the facultative committed-exposure view.
//
// Same arrangement as refreshLdfBenchmarks.js: the refresh fires
// opportunistically when a fac risk is bound (routes/facultative.js), and
// this is the nightly safety net for the cases the in-process refresh cannot
// cover — a treaty's CRESTA aggregates changing, a bound risk being corrected,
// or the server restarting mid-bind.
//
// TODO(scheduling): there is no in-process scheduler in this codebase. Run
// nightly via the platform's cron facility —
// `node src/jobs/refreshFacAccumulation.js` from server/.
//
// It matters that this runs. Every quote's capacity check reads this view, and
// a stale view means a carrier is measuring today's risk against last week's
// book — which is a quieter version of the failure (F14) the check was built
// to end.

import { closePools } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { refreshAccumulation } from '../services/facAccumulationService.js';

export async function runRefreshFacAccumulation() {
  return refreshAccumulation();
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  (async () => {
    try {
      const out = await runRefreshFacAccumulation();
      if (out.refreshed) {
        logger.info('[refresh-fac-accumulation] done', { concurrent: out.concurrent });
        process.exitCode = 0;
      } else {
        logger.error('[refresh-fac-accumulation] failed', { error: out.error });
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error('[refresh-fac-accumulation] failed', { error: err?.message, stack: err?.stack });
      process.exitCode = 1;
    } finally {
      await closePools().catch(() => {});
    }
  })();
}
