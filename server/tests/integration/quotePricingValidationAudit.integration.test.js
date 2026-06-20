// server/tests/integration/quotePricingValidationAudit.integration.test.js
//
// P1-validation — quotes route group, slice 2 (pricing + triangle subresources).
// Completes the validation / optimistic-locking / in-transaction-audit guarantees
// on the pricing-side saves:
//   • triangles/:type      — gains the opt-in lock + parent touch + standardised audit
//   • dev-factors/:type     — gains the opt-in lock + parent touch + standardised audit
//   • pricing-outputs       — gains Zod validation + audit (already locked)
//   • pricing-yearly        — gains Zod validation + audit (already locked)
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: quote pricing saves — validation + locking + audit', () => {
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
    const q = await harness.fetchApp('GET', `/api/quotes/${id}`).then((r) => r.json());
    return q.updated_at;
  }

  async function bumpParent(id) {
    // A sibling save with no header moves the parent's updated_at forward.
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { losses: [] } });
  }

  async function auditCount(id, eventType) {
    const { rows } = await pool.query(
      `SELECT actor FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type=$2`,
      [id, eventType],
    );
    return rows;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  // ── Validation (400) ──────────────────────────────────────────────────────

  it('pricing-outputs rejects a negative epi with 400 VALIDATION_FAILED', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-outputs`, { body: { epi: -100 } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('pricing-yearly rejects a non-array `rows` with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-yearly`, { body: { rows: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('pricing-yearly rejects an out-of-range uw_year with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-yearly`, { body: { rows: [{ uw_year: 99999, premium: 10 }] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('pricing-yearly still accepts a bare array (legacy wire shape)', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-yearly`, {
      body: [{ uw_year: 2024, premium: 500, incurred_claims: 200 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Optimistic locking (409) ─────────────────────────────────────────────

  it('triangles honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    await bumpParent(id);
    const stale = await harness.fetchApp('POST', `/api/quotes/${id}/triangles/claims_paid`, {
      body: { cells: [{ origin_year: 2024, dev_months: 12, cum_value: 100 }] },
      headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('dev-factors honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    await bumpParent(id);
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/dev-factors/CLAIMS_PAID`, {
      body: { factors: [{ dev_month: 12, selected_ldf: 1.25, selected_cdf: 1.8 }] },
      headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  // ── In-transaction audit ─────────────────────────────────────────────────

  it('each pricing save writes one audit event attributed to the verified actor', async () => {
    const id = await newQuote();
    const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

    await harness.fetchApp('POST', `/api/quotes/${id}/triangles/claims_paid`, {
      body: { cells: [{ origin_year: 2024, dev_months: 12, cum_value: 100 }] },
    });
    await harness.fetchApp('PUT', `/api/quotes/${id}/dev-factors/CLAIMS_PAID`, {
      body: { factors: [{ dev_month: 12, selected_ldf: 1.25, selected_cdf: 1.8 }] },
    });
    await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-outputs`, { body: { epi: 1_000_000, commission_ratio: 25 } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-yearly`, { body: { rows: [{ uw_year: 2024, premium: 500 }] } });

    for (const evt of ['TRIANGLE_SAVED', 'DEV_FACTORS_SAVED', 'PRICING_OUTPUTS_SAVED', 'PRICING_YEARLY_SAVED']) {
      const rows = await auditCount(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_USER_ID);
    }
  });

  it('a rolled-back pricing-outputs save leaves NO audit event', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    await bumpParent(id);
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/pricing-outputs`, {
      body: { epi: 5_000_000 }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await auditCount(id, 'PRICING_OUTPUTS_SAVED')).length).toBe(0);
  });
});
