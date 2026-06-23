// server/src/startup/productionPosture.js
//
// One place that surfaces production-hardening posture at boot, so a misconfig is
// visible in the startup logs (and alertable) instead of only failing later at
// the point of use. It NEVER throws and NEVER exits — fail-fast belongs to the
// secret gate (config/env.validateEnv); this is the "loud warning" tier for
// operational settings that are valid-but-risky.
//
// Covers three P1 concerns:
//   • durable upload storage (P1 #2) — local disk is not durable in prod.
//   • distributed rate limiting (P1 #3) — per-process counts × N workers.
//   • SSO / MFA / break-glass posture (P1 #6) — surfaces identity-config
//     errors/warnings and the SSO-off-in-prod stance.

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getIdentityConfig, validateIdentityConfig, isSsoEnabled } from '../config/identity.js';
import { remoteStorageConfigured, localUploadsAllowed } from '../lib/uploadStorage.js';
import { rateLimitStoreEnabled } from '../lib/rateLimitStore.js';

// Multi-instance/cluster signals: the app's own cluster flag (ecosystem.config.cjs
// sets POOL_WATCHDOG_CLUSTER=1), PM2's per-worker NODE_APP_INSTANCE, or a
// platform WEB_CONCURRENCY > 1.
export function inClusterMode(e = process.env) {
  return e.POOL_WATCHDOG_CLUSTER === '1'
    || e.NODE_APP_INSTANCE != null
    || Number(e.WEB_CONCURRENCY) > 1;
}

/**
 * Evaluate and log the production posture. Returns { warnings, errors } (the
 * messages, for tests) — logging is the primary effect.
 * @param {{ log?: typeof logger }} [opts]
 */
export function checkProductionPosture({ log = logger } = {}) {
  const warnings = [];
  const errors = [];
  const warn = (m, meta) => { warnings.push(m); log.warn(m, meta); };
  const err = (m, meta) => { errors.push(m); log.error(m, meta); };

  // ── Identity / SSO / MFA / break-glass (P1 #6) ──
  const idCfg = getIdentityConfig();
  const idCheck = validateIdentityConfig(idCfg);
  for (const e of idCheck.errors) err(`[posture] identity config: ${e}`);
  for (const w of idCheck.warnings) warn(`[posture] identity config: ${w}`);
  if (env.isProduction && !isSsoEnabled(idCfg)) {
    warn('[posture] SSO is OFF in production — local passwords are the only login path. '
      + 'Enterprise rollouts should enable IDENTITY_SSO_ENABLED with in-app MFA '
      + '(IDENTITY_REQUIRED_ACR/AMR) and a break-glass list (IDENTITY_BREAK_GLASS_USERS). '
      + 'See docs/runbooks/sso-mfa-break-glass.md.');
  }

  // ── Durable upload storage (P1 #2) ──
  if (env.isProduction && !remoteStorageConfigured()) {
    if (localUploadsAllowed()) {
      warn('[posture] uploads use EPHEMERAL local disk in production (ALLOW_LOCAL_UPLOADS=true) — '
        + 'files are lost on every deploy/restart and are not shared across instances. '
        + 'Configure object storage (CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET).');
    } else {
      err('[posture] no durable upload storage in production — document uploads will FAIL '
        + '(503 STORAGE_NOT_DURABLE) until Cloudinary is configured, or ALLOW_LOCAL_UPLOADS=true '
        + 'to explicitly accept ephemeral disk. See SECURITY.md / DEPLOYMENT.md.');
    }
  }

  // ── Distributed rate limiting (P1 #3) ──
  if (env.isProduction && !rateLimitStoreEnabled()) {
    if (inClusterMode()) {
      err('[posture] multi-instance/cluster WITHOUT REDIS_URL — rate limits are PER-PROCESS, so '
        + 'N workers allow N× the intended ceiling (most dangerous on auth/login). Set REDIS_URL '
        + 'for a shared store. See lib/rateLimitStore.js and docs/scaling.md.');
    } else {
      warn('[posture] REDIS_URL not set — rate limits are per-process (fine for a single instance), '
        + 'but REQUIRED before scaling to PM2 cluster mode or multiple replicas. See docs/scaling.md.');
    }
  }

  if (!warnings.length && !errors.length) {
    log.info('[posture] production posture checks passed');
  }
  return { warnings, errors };
}
