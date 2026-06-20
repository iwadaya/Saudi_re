// server/tests/integration/quoteNpValidationAudit.integration.test.js
//
// P1-validation — non-prop route group, slice 1 (the quote NP subresource saves
// in routes/quotes.js, whose treaty twins in routes/nonProp.js were already
// validated). Each now: validates its body with Zod, runs the opt-in
// If-Unmodified-Since lock inside its transaction, and writes a `critical` audit
// event on its own client.
//
// Endpoints: POST /quotes/:id/non-prop/save, PUT /quotes/:id/np/egnpi-year,
// PUT /quotes/:id/np-pricing.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: quote NP saves — validation + locking + audit', () => {
  let harness;
  let refs;
  const created = [];

  async function newQuote() {
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    created.push(q.quote_id);
    return q.quote_id;
  }

  async function updatedAt(id) {
    return (await harness.fetchApp('GET', `/api/quotes/${id}`).then((r) => r.json())).updated_at;
  }

  async function audit(id, eventType) {
    const { rows } = await pool.query(
      `SELECT actor, payload FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type=$2`,
      [id, eventType],
    );
    return rows;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'NON_PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

  // ── Validation (400) ──────────────────────────────────────────────────────

  it('non-prop/save rejects a non-array `layers` with 400 VALIDATION_FAILED', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/non-prop/save`, { body: { layers: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('egnpi-year rejects an out-of-range uw_year with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/np/egnpi-year`, { body: { rows: [{ uw_year: 99999, egnpi: 1 }] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('np-pricing rejects a layer_number above the cap with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/np-pricing`, { body: { outputs: [{ layer_number: 999, section: 'RISK' }] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it("np-pricing still accepts the non-RISK/CAT section labels quotes use (e.g. 'AS_IF')", async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/np-pricing`, {
      body: { outputs: [{ layer_number: 1, section: 'AS_IF', total_price: 10 }] },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Optimistic locking (409) ─────────────────────────────────────────────

  it('egnpi-year honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { losses: [] } });
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/np/egnpi-year`, {
      body: { rows: [{ uw_year: 2024, egnpi: 1 }] }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('egnpi-year against a non-existent quote → 404', async () => {
    const res = await harness.fetchApp('PUT', '/api/quotes/00000000-0000-0000-0000-0000000000ff/np/egnpi-year', { body: { rows: [] } });
    expect(res.status).toBe(404);
  });

  // ── In-transaction audit ─────────────────────────────────────────────────

  it('each NP save writes one audit event attributed to the verified actor', async () => {
    const id = await newQuote();
    await harness.fetchApp('POST', `/api/quotes/${id}/non-prop/save`, { body: { detail: { number_of_layers: 1, est_gnpi: 5_000_000 } } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/np/egnpi-year`, { body: { rows: [{ uw_year: 2024, egnpi: 1_000_000 }] } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/np-pricing`, { body: { outputs: [{ layer_number: 1, section: 'AS_IF', total_price: 10 }] } });

    for (const evt of ['NP_SAVED', 'NP_EGNPI_SAVED', 'NP_PRICING_SAVED']) {
      const rows = await audit(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_USER_ID);
    }
  });
});
