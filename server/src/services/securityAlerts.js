// server/src/services/securityAlerts.js
// P1-identity Phase 0c — security alert hook (integration point, not a delivery
// channel yet). Certain events (break-glass local login, repeated SSO-required
// denials, future back-channel-logout anomalies) deserve an out-of-band signal
// to on-call, not just an audit row. This is the ONE seam those events flow
// through so the real channel (PagerDuty / Slack / SIEM webhook) can be wired in
// one place later without hunting call sites.
//
// Today it emits a structured, high-severity log line tagged `securityAlert:true`
// so log-based alerting can match on it immediately. It is intentionally
// fire-and-forget and NEVER throws: a failing alert must not break the action
// that raised it (a break-glass login during an incident must still succeed).

import { logger } from '../lib/logger.js';

/**
 * Raise a security alert. Best-effort: logs at warn with a stable, matchable
 * shape and swallows any failure.
 * @param {string} type    stable event key, e.g. 'BREAK_GLASS_LOGIN'.
 * @param {object} [detail] structured context (ids, ip, reason) — no secrets.
 */
export function emitSecurityAlert(type, detail = {}) {
  try {
    logger.warn(`[security-alert] ${type}`, { securityAlert: true, alertType: type, ...detail });
  } catch {
    // An alert must never become the reason an action fails.
  }
}
