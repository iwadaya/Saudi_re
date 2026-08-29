// server/tests/integration/quoteWorkflow.integration.test.js
//
// Quote workflow parity with treaties (priority item 3). Covers the two quote
// transitions that used to bypass the workflow discipline — decline and
// submit-for-approval — now routed through quoteWorkflow.js:
//   • legal-transition guard (422 INVALID_TRANSITION on an illegal pre-state),
//   • atomic status + quote_offer + offer_approval_event + critical audit row,
//   • authority — submit takes assertCanEdit (assignee-only); decline takes the
//     terminal NTU rule (F78): the assignee OR a live eligible approver, so a
//     reviewing approver can decline the quote they are reviewing while a user
//     with no approval authority still gets 403 DECLINE_FORBIDDEN,
//   • 404 for a missing quote.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const OTHER_USER = '00000000-0000-0000-0000-0000000000ff';

describe.skipIf(shouldSkipDb)('integration: quote workflow parity (decline / submit-for-approval)', () => {
  let harness;
  let refs;
  const created = [];

  async function newDraftQuote() {
    const q = await harness
      .fetchApp('POST', '/api/quotes', {
        body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
      })
      .then((r) => r.json());
    created.push(q.quote_id);
    return q.quote_id;
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

  it('submit-for-approval from DRAFT → 200, status AWAITING_APPROVAL, event + audit written', async () => {
    const id = await newDraftQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, {
      body: { written_line_pct: 25, comment: 'please review' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('AWAITING_APPROVAL');

    const { rows: q } = await pool.query(`SELECT status FROM public.quote WHERE quote_id=$1`, [id]);
    expect(q[0].status).toBe('AWAITING_APPROVAL');

    const { rows: ev } = await pool.query(
      `SELECT event_type FROM public.offer_approval_event WHERE quote_id=$1 AND event_type='SUBMITTED_FOR_APPROVAL'`, [id]);
    expect(ev.length).toBe(1);

    const { rows: audit } = await pool.query(
      `SELECT event_type FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='SUBMITTED_FOR_APPROVAL'`, [id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('decline from AWAITING_APPROVAL → 200, status DECLINED, event + audit written', async () => {
    const id = await newDraftQuote();
    await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, { body: { written_line_pct: 10 } });

    const res = await harness.fetchApp('POST', `/api/quotes/${id}/decline`, { body: { reason: 'pricing too thin' } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('DECLINED');

    const { rows: q } = await pool.query(`SELECT status, decline_reason FROM public.quote WHERE quote_id=$1`, [id]);
    expect(q[0].status).toBe('DECLINED');
    expect(q[0].decline_reason).toBe('pricing too thin');

    const { rows: audit } = await pool.query(
      `SELECT event_type FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='DECLINED'`, [id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('submit-for-approval on a DECLINED quote → 422 INVALID_TRANSITION', async () => {
    const id = await newDraftQuote();
    await harness.fetchApp('POST', `/api/quotes/${id}/decline`, { body: { reason: 'kill' } });

    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, { body: { written_line_pct: 5 } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_TRANSITION');
    expect(body.from).toBe('DECLINED');
    expect(body.to).toBe('AWAITING_APPROVAL');
  });

  it('decline is atomic — a rejected transition leaves no DECLINED event behind', async () => {
    const id = await newDraftQuote();
    // Drive to a terminal DECLINED, then a second decline is a self-transition
    // (allowed). To prove the guard, attempt a SUBMIT from DECLINED (illegal):
    await harness.fetchApp('POST', `/api/quotes/${id}/decline`, { body: { reason: 'first' } });
    const before = await pool.query(`SELECT count(*)::int AS n FROM public.offer_approval_event WHERE quote_id=$1`, [id]);
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, { body: {} });
    expect(res.status).toBe(422);
    const after = await pool.query(`SELECT count(*)::int AS n FROM public.offer_approval_event WHERE quote_id=$1`, [id]);
    // No SUBMITTED event written, no status change persisted.
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows: q } = await pool.query(`SELECT status FROM public.quote WHERE quote_id=$1`, [id]);
    expect(q[0].status).toBe('DECLINED');
  });

  it('authority: a non-assignee with no approval authority cannot decline → 403 DECLINE_FORBIDDEN (F78)', async () => {
    const id = await newDraftQuote(); // assigned to the default demo user
    // OTHER_USER has no uw_user profile, so it resolves to no role — neither
    // the assignee nor an eligible approver. Decline now takes the terminal
    // NTU authority rule (assignee OR eligible approver), so the code is
    // DECLINE_FORBIDDEN, not the edit-lock's READ_ONLY.
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/decline`, {
      body: { reason: 'nope' },
      headers: { 'x-user-id': OTHER_USER },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('DECLINE_FORBIDDEN');
    const { rows: q } = await pool.query(`SELECT status FROM public.quote WHERE quote_id=$1`, [id]);
    expect(q[0].status).toBe('DRAFT'); // untouched
  });

  it('authority: a reviewing approver (not the assignee) CAN decline a pending quote (F78)', async () => {
    // The quote is created + submitted by the default demo CU (the assignee &
    // submitter). The seeded underwriter1 (UW, level 4) is neither — exactly
    // the reviewing-approver position four-eyes puts every reviewer in. Before
    // F78 this 403'd READ_ONLY while the same reviewer could APPROVE the quote.
    const REVIEWER = '00000000-0000-0000-0000-000000000002';
    const id = await newDraftQuote();
    await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, { body: { written_line_pct: 15 } });

    const res = await harness.fetchApp('POST', `/api/quotes/${id}/decline`, {
      body: { reason: 'pricing insufficient on review' },
      headers: { 'x-user-id': REVIEWER, 'x-user-role': 'UW' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('DECLINED');

    const { rows: q } = await pool.query(`SELECT status, decline_reason FROM public.quote WHERE quote_id=$1`, [id]);
    expect(q[0].status).toBe('DECLINED');
    expect(q[0].decline_reason).toBe('pricing insufficient on review');

    // The decision is attributed to the reviewer in the audit trail.
    const { rows: audit } = await pool.query(
      `SELECT actor FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='DECLINED' ORDER BY created_at DESC LIMIT 1`, [id]);
    expect(String(audit[0].actor)).toBe(REVIEWER);
  });

  it('404 when the quote does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const dec = await harness.fetchApp('POST', `/api/quotes/${missing}/decline`, { body: { reason: 'x' } });
    expect(dec.status).toBe(404);
    const sub = await harness.fetchApp('POST', `/api/quotes/${missing}/offer/submit-for-approval`, { body: {} });
    expect(sub.status).toBe(404);
  });
});
