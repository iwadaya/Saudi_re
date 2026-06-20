// server/tests/integration/facDataValidationAudit.integration.test.js
//
// P1-validation — facultative route group, slice 1 (the fac-risk data-entry
// subresources). cope / losses / uw-factors / clauses-checklist now:
//   • validate their body (Zod for cope + losses; cope/losses previously had
//     none — uw-factors/clauses keep their bespoke 422 reference checks),
//   • run the opt-in If-Unmodified-Since lock on the parent fac_risk INSIDE the
//     transaction (409) and bump fac_risk.updated_at via touchParentEntity,
//   • write a FAC_*_SAVED audit event to contract_audit_event on the mutation's
//     OWN transaction client (writeFacAuditEvent now accepts the client).
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: fac data saves — validation + locking + audit', () => {
  let harness;
  const risks = [];

  async function newRisk() {
    const r = await harness.fetchApp('POST', '/api/fac/risks', { body: { insured_name: 'P1 Fac Risk' } }).then((x) => x.json());
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

  beforeAll(async () => { harness = await bootApp(); });

  afterAll(async () => {
    if (harness) {
      for (const id of risks) { try { await harness.fetchApp('DELETE', `/api/fac/risks/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  // ── Validation (400) ──────────────────────────────────────────────────────

  it('losses rejects a non-array `losses` with 400 VALIDATION_FAILED', async () => {
    const id = await newRisk();
    const res = await harness.fetchApp('PUT', `/api/fac/risks/${id}/losses`, { body: { losses: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  // ── Optimistic locking (409) ─────────────────────────────────────────────

  it('cope honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newRisk();
    // A token a minute in the past is, by definition, older than the risk's
    // current updated_at — a deterministic stale write (no same-millisecond race
    // with the creation timestamp).
    const staleToken = new Date(Date.now() - 60_000).toISOString();
    const stale = await harness.fetchApp('PUT', `/api/fac/risks/${id}/cope`, {
      body: { construction_type: 'STEEL' }, headers: { 'if-unmodified-since': staleToken },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('a fac data save against a non-existent risk → 404 (edit-lock guard)', async () => {
    const res = await harness.fetchApp('PUT', '/api/fac/risks/00000000-0000-0000-0000-0000000000ff/losses', { body: { losses: [] } });
    expect(res.status).toBe(404);
  });

  // ── In-transaction audit ─────────────────────────────────────────────────

  it('each fac data save writes a FAC_*_SAVED event to contract_audit_event', async () => {
    const id = await newRisk();
    const DEMO_NAME = 'Chief Underwriter'; // actorLabel uses the verified display name

    await harness.fetchApp('PUT', `/api/fac/risks/${id}/cope`, { body: { construction_type: 'STEEL', construction_year: 2010, sprinkler_system: true } });
    await harness.fetchApp('PUT', `/api/fac/risks/${id}/losses`, { body: { losses: [{ loss_year: 2022, fgu_paid: 1000 }] } });
    await harness.fetchApp('POST', `/api/fac/risks/${id}/uw-factors`, { body: { selections: {} } });
    await harness.fetchApp('POST', `/api/fac/risks/${id}/clauses-checklist`, { body: { items: [] } });

    for (const evt of ['FAC_COPE_SAVED', 'FAC_LOSSES_SAVED', 'FAC_UW_FACTORS_SAVED', 'FAC_CLAUSES_SAVED']) {
      const rows = await facAudit(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_NAME);
    }
  });

  it('a rolled-back fac save (stale token) leaves NO audit event', async () => {
    const id = await newRisk();
    const staleToken = new Date(Date.now() - 60_000).toISOString();
    const stale = await harness.fetchApp('PUT', `/api/fac/risks/${id}/cope`, {
      body: { construction_type: 'BRICK' }, headers: { 'if-unmodified-since': staleToken },
    });
    expect(stale.status).toBe(409);
    expect((await facAudit(id, 'FAC_COPE_SAVED')).length).toBe(0);
  });
});
