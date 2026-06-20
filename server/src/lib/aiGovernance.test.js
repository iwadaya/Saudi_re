// server/src/lib/aiGovernance.test.js
// Unit tests for the AI/data-governance controls: fail-closed gate, tenant
// opt-out, boot validation, pluggable redaction, and per-call audit.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable env mock so each test sets the AI posture it needs.
const { envMock } = vi.hoisted(() => ({ envMock: {} }));
vi.mock('../config/env.js', () => ({ env: envMock }));

const logAuditMock = vi.fn(async () => undefined);
vi.mock('../services/audit.js', () => ({
  logAudit: (...a) => logAuditMock(...a),
  SYSTEM_ACTOR: { id: null, name: 'SYSTEM', system: true },
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const {
  assertAiEnabled, isAiEnabled, AiDisabledError, requireAiEnabled,
  validateAiProviderConfig, redactForLlm, registerRedactor, resetRedactors,
  recordAiCall, aiConfigStatus,
} = await import('./aiGovernance.js');

function setEnv(over = {}) {
  Object.keys(envMock).forEach((k) => delete envMock[k]);
  Object.assign(envMock, {
    aiFeaturesEnabled: false, aiCustomerOptOut: false, aiRedactionEnabled: true,
    geminiApiKey: '', openaiApiKey: '', anthropicApiKey: '',
  }, over);
}

beforeEach(() => { setEnv(); resetRedactors(); logAuditMock.mockClear(); });

describe('gate (fail-closed)', () => {
  it('is disabled when AI_FEATURES_ENABLED is unset', () => {
    setEnv({ aiFeaturesEnabled: false, geminiApiKey: 'k' });
    expect(isAiEnabled()).toBe(false);
    expect(() => assertAiEnabled()).toThrow(AiDisabledError);
    try { assertAiEnabled(); } catch (e) { expect(e.code).toBe('AI_DISABLED'); expect(e.status).toBe(403); }
  });

  it('is disabled (fail-closed) when enabled but no provider is configured', () => {
    setEnv({ aiFeaturesEnabled: true });
    expect(isAiEnabled()).toBe(false);
    try { assertAiEnabled(); } catch (e) { expect(e.code).toBe('AI_NOT_CONFIGURED'); }
  });

  it('is enabled when on and a provider is configured', () => {
    setEnv({ aiFeaturesEnabled: true, openaiApiKey: 'sk' });
    expect(isAiEnabled()).toBe(true);
    expect(() => assertAiEnabled()).not.toThrow();
  });

  it('honours the global tenant opt-out', () => {
    setEnv({ aiFeaturesEnabled: true, openaiApiKey: 'sk', aiCustomerOptOut: true });
    expect(isAiEnabled()).toBe(false);
    try { assertAiEnabled(); } catch (e) { expect(e.code).toBe('AI_OPTED_OUT'); }
  });

  it('honours a per-request customer opt-out', () => {
    setEnv({ aiFeaturesEnabled: true, openaiApiKey: 'sk' });
    expect(isAiEnabled({ customerOptedOut: true })).toBe(false);
    expect(() => assertAiEnabled({ customerOptedOut: true })).toThrow(/opted out/i);
  });

  it('requireAiEnabled middleware 403s without calling next when disabled', () => {
    setEnv({ aiFeaturesEnabled: false });
    const next = vi.fn();
    const res = { status: vi.fn(function s() { return res; }), json: vi.fn() };
    requireAiEnabled({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe('AI_DISABLED');
  });
});

describe('validateAiProviderConfig (boot)', () => {
  it('reports disabled posture and never throws', () => {
    setEnv({ aiFeaturesEnabled: false });
    expect(() => validateAiProviderConfig()).not.toThrow();
    expect(validateAiProviderConfig().enabled).toBe(false);
  });
  it('flags enabled-but-unconfigured without throwing', () => {
    setEnv({ aiFeaturesEnabled: true });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const s = validateAiProviderConfig({ log });
    expect(s.hasProvider).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('redaction (pluggable)', () => {
  it('redacts emails, phones and long identifiers', () => {
    setEnv({ aiRedactionEnabled: true });
    const out = redactForLlm('mail a@b.com call +1 415 555 0100 card 4111 1111 1111 1111');
    expect(out.text).not.toContain('a@b.com');
    expect(out.text).toContain('[REDACTED_EMAIL]');
    expect(out.redactionCount).toBeGreaterThanOrEqual(2);
    expect(out.applied).toContain('email');
  });

  it('is a no-op when redaction is disabled', () => {
    setEnv({ aiRedactionEnabled: false });
    const out = redactForLlm('a@b.com');
    expect(out.text).toBe('a@b.com');
    expect(out.redactionCount).toBe(0);
  });

  it('supports a custom registered redactor (configurable rules)', () => {
    setEnv({ aiRedactionEnabled: true });
    registerRedactor({ name: 'policy', pattern: /POL-\d+/g, replacement: '[REDACTED_POLICY]' });
    const out = redactForLlm('see POL-12345');
    expect(out.text).toBe('see [REDACTED_POLICY]');
    expect(out.applied).toContain('policy');
  });

  it('returns empty for non-strings', () => {
    expect(redactForLlm(null).text).toBe('');
    expect(redactForLlm(undefined).redactionCount).toBe(0);
  });
});

describe('recordAiCall (audit)', () => {
  it('writes an AI_CALL audit row with provider/document/purpose in the payload', async () => {
    setEnv({ aiFeaturesEnabled: true, openaiApiKey: 'sk' });
    await recordAiCall({
      actor: { id: 'u1' }, entityType: 'FAC_RISK', entityId: 'r1',
      provider: 'openai', documentId: 'd1', purpose: 'fac-document-analysis', redactionCount: 3,
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const [, event] = logAuditMock.mock.calls[0];
    expect(event.entityType).toBe('AI_CALL');
    expect(event.eventType).toBe('AI_CALL');
    expect(event.payload).toMatchObject({
      subjectType: 'FAC_RISK', subjectId: 'r1', provider: 'openai',
      documentId: 'd1', purpose: 'fac-document-analysis', redactionCount: 3,
    });
  });

  it('never throws when the audit write fails', async () => {
    setEnv({ aiFeaturesEnabled: true, openaiApiKey: 'sk' });
    logAuditMock.mockRejectedValueOnce(new Error('db down'));
    await expect(recordAiCall({ provider: 'gemini', purpose: 'x' })).resolves.toBeUndefined();
  });
});

describe('aiConfigStatus', () => {
  it('lists configured providers', () => {
    setEnv({ aiFeaturesEnabled: true, geminiApiKey: 'g', anthropicApiKey: 'a' });
    const s = aiConfigStatus();
    expect(s.providers).toEqual(['gemini', 'anthropic']);
    expect(s.hasProvider).toBe(true);
  });
});
