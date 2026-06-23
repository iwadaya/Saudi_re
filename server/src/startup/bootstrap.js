import { createApp } from '../app.js';
import { env, validateRuntimeEnv, validateEnv } from '../config/env.js';
import { verifyDatabaseConnection } from '../db/pool.js';
import { startPoolWatchdog } from '../db/poolWatchdog.js';
import { logger } from '../lib/logger.js';
import { ensureReferenceData } from './ensureReferenceData.js';
import { runMigrations } from './runMigrations.js';
import { installGracefulShutdown } from './gracefulShutdown.js';
import { warnIfWarnOnlyInProduction } from '../lib/pricingVerifier.js';
import { checkProductionPosture } from './productionPosture.js';

function logStartupBanner() {
  logger.info('startup configuration loaded', {
    nodeEnv: env.nodeEnv,
    envFile: env.loadedEnvPath || null,
    port: env.port,
    uploadDir: env.uploadDir,
    clientDistDir: env.clientDistDir,
    runMigrationsOnBoot: env.runMigrationsOnBoot,
  });
}

export async function bootstrap() {
  // Fail fast on a missing/weak auth secret before anything mounts — never
  // boot with forgeable tokens in production.
  validateEnv();
  validateRuntimeEnv();
  logStartupBanner();
  warnIfWarnOnlyInProduction();
  // Surface (don't fail on) valid-but-risky production posture: durable upload
  // storage (P1 #2), distributed rate limiting (P1 #3), SSO/MFA/break-glass
  // (P1 #6). Best-effort — a check bug must never block boot.
  try {
    checkProductionPosture();
  } catch (err) {
    logger.warn('[posture] posture check failed to run', { message: err?.message || String(err) });
  }

  await verifyDatabaseConnection();
  logger.info('database connection verified');

  if (env.runMigrationsOnBoot) {
    await runMigrations();
    logger.info('migrations complete');
  } else {
    logger.info('migrations skipped');
  }

  await ensureReferenceData();
  logger.info('reference data ready');

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info('http server listening', { port: env.port, url: `http://localhost:${env.port}` });
  });

  // Tune keep-alive to keep upstream proxy connections warm. Render and
  // most cloud LBs idle TCP at ~60s; Node defaults to 5s, which forces a
  // fresh handshake on every burst gap > 5s. headersTimeout must exceed
  // keepAliveTimeout or Node will 408 the in-flight request the LB just
  // re-used. requestTimeout=0 disables the duplicate idle timer (we
  // already have requestTimeout middleware doing this with a useful
  // 503 message).
  server.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS) || 65_000;
  server.headersTimeout   = Number(process.env.HEADERS_TIMEOUT_MS)   || 66_000;
  server.requestTimeout   = 0;

  // Drain in-flight requests cleanly on SIGTERM/SIGINT; destroys idle
  // keep-alive sockets after a grace window; hard-exits on a deadline
  // so deploys never hang. See startup/gracefulShutdown.js.
  installGracefulShutdown(server);

  // Warn when the pool starts queuing requests — single log line per
  // transition, not a flood. Disable in tests by setting POOL_WATCHDOG_MS=0.
  // In cluster mode, only worker 0 logs so we don't get N duplicate
  // warnings per transition.
  const inClusterMode = process.env.POOL_WATCHDOG_CLUSTER === '1';
  const isClusterLeader = !inClusterMode || process.env.NODE_APP_INSTANCE === '0';
  if (Number(process.env.POOL_WATCHDOG_MS) !== 0 && isClusterLeader) {
    startPoolWatchdog();
  }

  // Scheduling lives OUT of the request-serving process (so a busy/crashed web
  // dyno never skips a job): import_snapshot cleanup and LDF benchmark refresh
  // run as scheduled jobs — .github/workflows/scheduled-jobs.yml (GitHub Actions)
  // and the Render Cron services in render.yaml — alongside the backup +
  // restore-verification drills. See docs/backup-recovery.md.

  return server;
}
