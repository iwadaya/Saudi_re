// server/src/db/poolWatchdog.js
// Periodic pool-health check. When requests start queuing for a
// connection (waitingCount > 0) we want to know *immediately*, not
// hours later when a user reports slowness. The watchdog logs a
// warning the first time the queue grows and a recovery line when it
// clears — one entry per transition, not a flood per tick.
//
// Production tuning: once you see these warnings fire, bump
// DB_POOL_MAX. The recovery line tells you whether the bump worked.

import { logger } from '../lib/logger.js';
import { getPoolStats } from './pool.js';

const DEFAULT_INTERVAL_MS = Number(process.env.POOL_WATCHDOG_MS) || 10_000;

let timer = null;
let wasQueuing = false;
let peakWaiting = 0;

export function startPoolWatchdog(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return; // idempotent
  timer = setInterval(() => {
    const stats = getPoolStats();
    if (stats.waitingCount > 0) {
      peakWaiting = Math.max(peakWaiting, stats.waitingCount);
      if (!wasQueuing) {
        wasQueuing = true;
        logger.warn('db pool queue forming — bump DB_POOL_MAX if sustained', stats);
      }
    } else if (wasQueuing) {
      wasQueuing = false;
      logger.info('db pool queue cleared', { ...stats, peakWaiting });
      peakWaiting = 0;
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopPoolWatchdog() {
  if (timer) { clearInterval(timer); timer = null; }
  wasQueuing = false;
  peakWaiting = 0;
}
