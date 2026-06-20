// server/tests/integration/quoteCrudValidationAudit.integration.test.js
//
// P1-validation — quotes route group, slice 3 (CRUD / lifecycle).
// create / delete / documents / renew now validate their bodies with Zod and
// write a `critical` audit event inside the mutation's own transaction:
//   • POST   /quotes              — Zod create body + CREATED audit (txn).
//   • DELETE /quotes/:id          — opt-in optimistic lock + DELETED audit (txn).
//   • POST   /quotes/:id/documents — metadata Zod + existence check + UPLOADED audit.
//   • POST   /quotes/:id/renew     — Zod overrides + RENEWED audit (txn).
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: quote CRUD — validation + locking + audit', () => {
  let harness;
  let refs;
  const created = [];

  async function newQuote() {
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    created.push(q.quote_id);
    return q;
  }

  async function updatedAt(id) {
    const q = await harness.fetchApp('GET', `/api/quotes/${id}`).then((r) => r.json());
    return q.updated_at;
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
    refs = await seedRefs({ category: 'PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of created) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

  // ── create ────────────────────────────────────────────────────────────────

  it('create rejects a non-UUID cedant_id with 400 VALIDATION_FAILED', async () => {
    const res = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, cedant_id: 'not-a-uuid', uw_year: 2026, inception_date: '2026-01-01' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('create still enforces inception_date (handler guard) with 400', async () => {
    const res = await harness.fetchApp('POST', '/api/quotes', { body: { ...refs, uw_year: 2026 } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('a valid create writes a CREATED audit event (verified actor, txn-committed)', async () => {
    const q = await newQuote();
    const rows = await audit(q.quote_id, 'CREATED');
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe(DEMO_USER_ID);
    expect(rows[0].payload.quote_ref).toBe(q.quote_ref);
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  it('delete honours If-Unmodified-Since — a stale token → 409 STALE_WRITE', async () => {
    const q = await newQuote();
    const t0 = await updatedAt(q.quote_id);
    // Bump the quote so t0 is stale.
    await harness.fetchApp('PUT', `/api/quotes/${q.quote_id}/large-losses`, { body: { losses: [] } });
    const stale = await harness.fetchApp('DELETE', `/api/quotes/${q.quote_id}`, { headers: { 'if-unmodified-since': t0 } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('a valid delete removes the quote and leaves a surviving DELETED audit row', async () => {
    const q = await newQuote();
    const res = await harness.fetchApp('DELETE', `/api/quotes/${q.quote_id}`);
    expect(res.status).toBe(200);
    expect((await harness.fetchApp('GET', `/api/quotes/${q.quote_id}`)).status).toBe(404);
    const rows = await audit(q.quote_id, 'DELETED'); // audit_log has no FK → survives
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe(DEMO_USER_ID);
  });

  it('deleting a non-existent quote → 404', async () => {
    const res = await harness.fetchApp('DELETE', '/api/quotes/00000000-0000-0000-0000-0000000000ff');
    expect(res.status).toBe(404);
  });

  // ── documents ────────────────────────────────────────────────────────────

  it('document upload rejects an over-long title with 400 (before storing bytes)', async () => {
    const q = await newQuote();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hi')], { type: 'text/plain' }), 'a.txt');
    fd.append('title', 'x'.repeat(501));
    const res = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/documents`, { body: fd });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('a valid document upload writes a DOCUMENT_UPLOADED audit event', async () => {
    const q = await newQuote();
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hello world')], { type: 'text/plain' }), 'note.txt');
    fd.append('title', 'My note');
    const res = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/documents`, { body: fd });
    expect(res.status).toBe(201);
    const rows = await audit(q.quote_id, 'DOCUMENT_UPLOADED');
    expect(rows.length).toBe(1);
    expect(rows[0].payload.file_name).toBe('note.txt');
  });

  it('document upload to a non-existent quote → 404 (no orphaned blob)', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('hi')], { type: 'text/plain' }), 'a.txt');
    const res = await harness.fetchApp('POST', '/api/quotes/00000000-0000-0000-0000-0000000000ff/documents', { body: fd });
    expect(res.status).toBe(404);
  });

  // ── renew ────────────────────────────────────────────────────────────────

  it('a renew writes a RENEWED audit event on the new quote referencing the source', async () => {
    const q = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/renew`, { body: {} });
    expect(res.status).toBe(201);
    const renewed = await res.json();
    created.push(renewed.quote_id);
    const rows = await audit(renewed.quote_id, 'RENEWED');
    expect(rows.length).toBe(1);
    expect(rows[0].payload.renewed_from).toBe(q.quote_id);
  });

  it('renew rejects an out-of-range uw_year override with 400', async () => {
    const q = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/renew`, { body: { uw_year: 99999 } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('renewing a non-existent quote → 404', async () => {
    const res = await harness.fetchApp('POST', '/api/quotes/00000000-0000-0000-0000-0000000000ff/renew', { body: {} });
    expect(res.status).toBe(404);
  });
});
