// server/src/lib/aiGovernance.js
//
// AI / data-governance controls for every outbound LLM call. The app sends
// document/treaty content to EXTERNAL providers, so these controls are the
// guard rails around that egress:
//
//   1. A feature gate (AI_FEATURES_ENABLED). Production/test are fail-closed by
//      default; development defaults on for local feature testing. When the gate
//      is off, NO external LLM call is made — assertAiEnabled / requireAiEnabled
//      throw 403 before any provider request. The gate also requires a
//      configured provider; a missing provider key fails closed.
//   2. A tenant/customer opt-out (AI_CUSTOMER_OPTOUT global, plus a per-request
//      hook) honoured by the gate.
//   3. A pluggable redaction/classification hook applied to text BEFORE it leaves
//      the app, with a basic PII/identifier redactor and a configurable registry.
//   4. A per-call audit record (actor, subject entity, provider, document, purpose,
//      ts) for compliance.
//
// IMPORTANT: in production/test this gate is off unless explicitly enabled, so
// a deployment must opt in before sending treaty/document content to external
// providers. Securing customer/legal approval and an enterprise (no-retention /
// zero-data-retention) provider route is still the deployment owner's
// responsibility. AI_CUSTOMER_OPTOUT=true can still hard-block a tenant.
// This module only builds controls — it never hard-codes a provider key.

import { env } from '../config/env.js';
import { logger } from './logger.js';
// NOTE: the DB + audit service are imported LAZILY inside recordAiCall so that
// importing this module (for the gate/redaction) never pulls in the pg pool —
// pure unit tests of the gate/redactor must not require a database.

// audit_log.entity_id is uuid-typed; AI calls are not a single entity, so they
// audit against a fixed sentinel id with the real subject carried in the payload.
export const AI_AUDIT_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

/** Error thrown when the AI gate blocks a call. Carries an HTTP 403. */
export class AiDisabledError extends Error {
  constructor(message, code = 'AI_DISABLED') {
    super(message);
    this.name = 'AiDisabledError';
    this.status = 403;
    this.code = code;
  }
}

/**
 * Snapshot of the current AI configuration (pure read of env). `enabled` is the
 * raw feature flag; `hasProvider` is whether any provider key is present.
 */
export function aiConfigStatus() {
  const providers = [];
  if (env.geminiApiKey) providers.push('gemini');
  if (env.openaiApiKey) providers.push('openai');
  if (env.anthropicApiKey) providers.push('anthropic');
  return {
    enabled: env.aiFeaturesEnabled === true,
    providers,
    hasProvider: providers.length > 0,
    globalOptOut: env.aiCustomerOptOut === true,
  };
}

/**
 * Gate decision. Returns false when AI is not enabled in this environment, when
 * no provider is configured, or when the global/per-request opt-out is set.
 * Never throws — use assertAiEnabled to enforce.
 */
export function isAiEnabled(ctx = {}) {
  const s = aiConfigStatus();
  if (!s.enabled) return false;
  if (!s.hasProvider) return false;
  if (s.globalOptOut) return false;
  if (ctx.customerOptedOut) return false;
  return true;
}

/**
 * Enforce the gate before any LLM call. Throws AiDisabledError (403) when AI is
 * disabled / unconfigured / opted-out. Distinct codes let callers and tests
 * tell the cases apart.
 */
export function assertAiEnabled(ctx = {}) {
  const s = aiConfigStatus();
  if (!s.enabled) {
    throw new AiDisabledError('AI features are disabled (AI_FEATURES_ENABLED is not enabled).', 'AI_DISABLED');
  }
  if (!s.hasProvider) {
    throw new AiDisabledError('AI features are enabled but no provider is configured.', 'AI_NOT_CONFIGURED');
  }
  if (s.globalOptOut || ctx.customerOptedOut) {
    throw new AiDisabledError('AI processing has been opted out for this customer.', 'AI_OPTED_OUT');
  }
}

/** Build the gate context from a request (per-request/customer opt-out hook). */
export function aiContextFromReq(req) {
  // Per-customer opt-out can be populated upstream (e.g. from a cedant/tenant
  // setting) onto req.aiCustomerOptedOut; defaults to the global flag only.
  return { customerOptedOut: req?.aiCustomerOptedOut === true };
}

/**
 * Express middleware: 403 before the handler (so NO provider call is made) when
 * the gate is closed. Responds directly so it never depends on the error handler.
 */
export function requireAiEnabled(req, res, next) {
  try {
    assertAiEnabled(aiContextFromReq(req));
    return next();
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message, code: e.code || 'AI_DISABLED' });
  }
}

/**
 * Boot-time provider-config validation. Logs the gate posture and flags an
 * enabled-but-unconfigured misconfiguration. Returns the config status; never
 * throws (a bad AI config must not take down non-AI APIs).
 */
export function validateAiProviderConfig({ log = logger } = {}) {
  const s = aiConfigStatus();
  if (!s.enabled) {
    log.info('[ai-gov] AI features DISABLED — no external LLM calls will be made.');
    return s;
  }
  if (!s.hasProvider) {
    log.error('[ai-gov] AI features are ON but NO provider key is configured — AI calls will fail closed.');
  } else {
    log.warn(`[ai-gov] AI features ENABLED with providers: ${s.providers.join(', ')}. `
      + 'Confirm customer/legal approval and an enterprise (no-retention) provider route.');
  }
  if (s.globalOptOut) {
    log.warn('[ai-gov] AI_CUSTOMER_OPTOUT is set — all AI calls are blocked by the gate.');
  }
  return s;
}

// ── Redaction / classification ───────────────────────────────────────────────
// A pluggable, ordered registry of redactors applied to text BEFORE it leaves
// the app. The defaults are a BASIC PII/identifier pass — order matters
// (structured identifiers before the broad numeric/phone catch-alls). Rules are
// configurable: registerRedactor to add/override, resetRedactors to restore.
//
// NOTE: this redacts TEXT only. Binary document attachments (PDF base64) bypass
// it — protecting those needs extract-then-redact or an enterprise no-retention
// route, and is tracked as a follow-up.
export const DEFAULT_REDACTORS = Object.freeze([
  { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[REDACTED_EMAIL]' },
  { name: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, replacement: '[REDACTED_IBAN]' },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  { name: 'card_or_account', pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[REDACTED_NUMBER]' },
  { name: 'phone', pattern: /\+?\d[\d\s().-]{8,}\d/g, replacement: '[REDACTED_PHONE]' },
]);

let activeRedactors = DEFAULT_REDACTORS.slice();

/** Add (prepend) a custom redactor so it runs before the defaults. */
export function registerRedactor(redactor) {
  if (!redactor?.pattern) throw new Error('registerRedactor: { name, pattern, replacement } required');
  activeRedactors = [redactor, ...activeRedactors];
}

/** Restore the default redactor set (used by tests / config reloads). */
export function resetRedactors() {
  activeRedactors = DEFAULT_REDACTORS.slice();
}

/**
 * Redact PII/identifiers from text before sending to a provider.
 * @returns {{ text: string, redactionCount: number, applied: string[] }}
 */
export function redactForLlm(text, { enabled = env.aiRedactionEnabled !== false, redactors = activeRedactors } = {}) {
  if (typeof text !== 'string' || text.length === 0 || !enabled) {
    return { text: typeof text === 'string' ? text : '', redactionCount: 0, applied: [] };
  }
  let out = text;
  let total = 0;
  const applied = [];
  for (const r of redactors) {
    let hits = 0;
    out = out.replace(r.pattern, () => { hits += 1; return r.replacement; });
    if (hits > 0) { total += hits; applied.push(r.name); }
  }
  return { text: out, redactionCount: total, applied };
}

// ── Per-call audit ───────────────────────────────────────────────────────────

/**
 * Record one outbound LLM call. Best-effort: an audit failure is logged but never
 * blocks the AI response. Writes to audit_log under an AI_CALL event with the
 * subject entity, provider, document and purpose in the payload.
 *
 * @param {object} fields { actor, entityType, entityId, provider, documentId, purpose, model, redactionCount }
 * @param {{ db?: object }} [opts]
 */
export async function recordAiCall(fields, { db = null } = {}) {
  const {
    actor, entityType = null, entityId = null, provider = null,
    documentId = null, purpose = null, model = null, redactionCount = null,
  } = fields || {};
  try {
    const { logAudit, SYSTEM_ACTOR } = await import('../services/audit.js');
    const client = db || (await import('../db/pool.js')).pool;
    await logAudit(client, {
      entityType: 'AI_CALL',
      entityId: AI_AUDIT_ENTITY_ID,
      eventType: 'AI_CALL',
      actor: actor || SYSTEM_ACTOR,
      payload: {
        subjectType: entityType, subjectId: entityId,
        provider, model, documentId, purpose, redactionCount,
      },
    });
  } catch (e) {
    logger.warn('[ai-gov] audit write failed', { error: e?.message, provider, purpose });
  }
}
