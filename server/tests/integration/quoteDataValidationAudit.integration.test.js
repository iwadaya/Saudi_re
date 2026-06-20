// server/tests/integration/quoteDataValidationAudit.integration.test.js
//
// P1-validation — quotes route group, slice 1 (loss + COB/profile data entry).
// Each of these mutating subresource saves now:
//   • validates its body with Zod (400 VALIDATION_FAILED on malformed input),
//   • runs the opt-in optimistic lock INSIDE its transaction (409 STALE_WRITE),
//   • writes a `critical` audit event on the mutation's own client (auditMutation).
//
// Endpoints covered: strip-large-cat, large-losses, cat-losses, cobs,
// risk-profiles/:cobId, claims-profiles/:cobId.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: quote data saves — validation + locking + audit', () => {
  let harness;
  let refs;
  let cobId;
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

  async function auditEvents(id, eventType) {
    const { rows } = await pool.query(
      `SELECT event_type, actor, payload FROM public.audit_log
        WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type=$2
        ORDER BY created_at DESC`,
      [id, eventType],
    );
    return rows;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    const { rows } = await pool.query(
      `INSERT INTO public.class_of_business (class_of_business) VALUES ($1) RETURNING class_of_business_id`,
      [`QDV COB ${Date.now()}-${process.pid}`],
    );
    cobId = rows[0].class_of_business_id;
  });

  afterAll(async () => {
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    try { await pool.query(`DELETE FROM public.class_of_business WHERE class_of_business_id=$1`, [cobId]); } catch {}
    await closePools();
  });

  // ── Validation (400) ──────────────────────────────────────────────────────

  it('large-losses rejects a non-array `losses` with 400 VALIDATION_FAILED', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { losses: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('large-losses rejects a non-UUID loss_id with 400 (before hitting the DB)', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, {
      body: { losses: [{ loss_id: 'not-a-uuid', uw_year: 2024, incurred: 100 }] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields.some((f) => f.path.includes('loss_id'))).toBe(true);
  });

  it('cobs rejects a non-UUID class id with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/cobs`, { body: { class_ids: ['nope'] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('risk-profiles rejects a non-array `bands` with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/risk-profiles/${cobId}`, { body: { bands: {} } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  // ── Optimistic locking (409) ─────────────────────────────────────────────

  it('cobs honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    // Concurrent bump via a sibling save (no header) moves the parent past t0.
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { report_date: '2026-01-01', losses: [] } });
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/cobs`, {
      body: { class_ids: [cobId] }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('strip-large-cat honours the stale-token check and the `*` override', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { losses: [] } });
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/strip-large-cat`, {
      body: { strip_large_cat_losses: true }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    const override = await harness.fetchApp('PUT', `/api/quotes/${id}/strip-large-cat`, {
      body: { strip_large_cat_losses: true }, headers: { 'if-unmodified-since': '*' },
    });
    expect(override.status).toBe(200);
    expect((await override.json()).strip_large_cat_losses).toBe(true);
  });

  it('a non-existent quote → 404 NOT_FOUND (existence checked in-txn)', async () => {
    const res = await harness.fetchApp('PUT', `/api/quotes/00000000-0000-0000-0000-0000000000ff/cobs`, { body: { class_ids: [] } });
    expect(res.status).toBe(404);
  });

  // ── In-transaction audit ─────────────────────────────────────────────────

  it('each save writes exactly one critical audit event, attributed to the verified actor', async () => {
    const id = await newQuote();
    const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, {
      body: { report_date: '2026-01-01', losses: [{ uw_year: 2024, loss_name: 'X', incurred: 100, is_selected: true }] },
    });
    await harness.fetchApp('PUT', `/api/quotes/${id}/cat-losses`, { body: { losses: [] } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/cobs`, { body: { class_ids: [cobId] } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/risk-profiles/${cobId}`, { body: { pml_percentage: 100, bands: [] } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/claims-profiles/${cobId}`, { body: { bands: [] } });
    await harness.fetchApp('PUT', `/api/quotes/${id}/strip-large-cat`, { body: { strip_large_cat_losses: true } });

    for (const evt of ['LARGE_LOSSES_SAVED', 'CAT_LOSSES_SAVED', 'COBS_SAVED', 'RISK_PROFILE_SAVED', 'CLAIMS_PROFILE_SAVED', 'STRIP_LARGE_CAT_SAVED']) {
      const rows = await auditEvents(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_USER_ID);
    }
  });

  it('a rolled-back save leaves NO audit event (audit shares the mutation txn)', async () => {
    const id = await newQuote();
    const t0 = await updatedAt(id);
    // Force a rollback: bump the parent, then send a stale token → 409 before COMMIT.
    await harness.fetchApp('PUT', `/api/quotes/${id}/large-losses`, { body: { losses: [] } });
    const stale = await harness.fetchApp('PUT', `/api/quotes/${id}/cobs`, {
      body: { class_ids: [cobId] }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await auditEvents(id, 'COBS_SAVED')).length).toBe(0);
  });
});
