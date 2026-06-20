// server/tests/integration/facPricingValidationAudit.integration.test.js
//
// P1-validation — facultative route group, slice 2 (the remaining fac-risk data
// subresources). locations + pricing (already validated) gain the opt-in
// optimistic lock + parent touch + in-transaction audit; documents (metadata
// JSON insert) gains Zod validation + audit. All audit events land in
// contract_audit_event via the now client-aware writeFacAuditEvent.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac pricing/locations/documents — locking + audit', () => {
  let harness;
  const risks = [];

  async function newRisk() {
    const r = await harness.fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'P1 Fac Risk 2' } }).then((x) => x.json());
    risks.push(r.fac_risk_id);
    return r.fac_risk_id;
  }

  async function facAudit(id, eventType) {
    const { rows } = await pool.query(
      `SELECT actor, payload FROM public.contract_audit_event WHERE contract_id=$1 AND event_type=$2`,
      [id, eventType],
    );
    return rows;
  }

  // A token a minute in the past is, by definition, older than the risk's
  // current updated_at — a deterministic stale write (no creation-time race).
  const staleToken = () => new Date(Date.now() - 60_000).toISOString();

  beforeAll(async () => { harness = await bootApp(); });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) { try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  const DEMO_NAME = 'Chief Underwriter';

  // ── Optimistic locking (409) ─────────────────────────────────────────────

  it('locations honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newRisk();
    const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, {
      body: { locations: [] }, headers: { 'if-unmodified-since': staleToken() },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE_WRITE');
  });

  it('pricing honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newRisk();
    const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
      body: { final_gross_rate_pm: 2.5 }, headers: { 'if-unmodified-since': staleToken() },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE_WRITE');
  });

  // ── In-transaction audit ─────────────────────────────────────────────────

  it('locations / pricing / documents each write their audit event to contract_audit_event', async () => {
    const id = await newRisk();
    await harness.fetchApp('PUT', `/api/fac/risks/${id}/locations`, { body: { locations: [{ location_name: 'Plant A', pd_si: 1_000_000 }] } });
    await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, { body: { final_gross_rate_pm: 2.5, underwriting_score: 80, capacity_grade: 'C' } });
    await harness.fetchApp('POST', `/api/fac/risks/${id}/documents`, { body: { doc_type: 'SLIP', file_name: 'slip.pdf' } });

    for (const evt of ['FAC_LOCATIONS_SAVED', 'FAC_PRICING_SAVED', 'FAC_DOCUMENT_ADDED']) {
      const rows = await facAudit(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_NAME);
    }
  });

  it('a document POST against a non-existent risk → 404', async () => {
    const res = await harness.fetchApp('POST', '/api/fac/risks/00000000-0000-0000-0000-0000000000ff/documents', { body: { doc_type: 'SLIP' } });
    expect(res.status).toBe(404);
  });

  it('a rolled-back pricing save (stale token) leaves NO audit event', async () => {
    const id = await newRisk();
    const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/pricing`, {
      body: { final_gross_rate_pm: 9.9 }, headers: { 'if-unmodified-since': staleToken() },
    });
    expect(res.status).toBe(409);
    expect((await facAudit(id, 'FAC_PRICING_SAVED')).length).toBe(0);
  });
});
