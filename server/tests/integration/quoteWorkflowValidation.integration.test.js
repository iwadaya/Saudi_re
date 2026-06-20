// server/tests/integration/quoteWorkflowValidation.integration.test.js
//
// P1-validation — approvals group. The quote approval-workflow routes (decline,
// offer/submit-for-approval, mark-approved, return-to-underwriter, recall, ntu)
// previously accepted any body and passed it straight to the approval engine.
// They now validate the body with quoteWorkflowActionSchema (a free-text
// comment/reason, passthrough), rejecting a malformed note with 400 before the
// engine runs. Authority + legal-state + critical audit remain owned by the
// engine (services/approvals.js, services/quoteWorkflow.js) — unchanged.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: quote approval-workflow body validation', () => {
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

  // ── Validation (400) — runs before the approval engine ────────────────────

  it('mark-approved rejects a non-string `comment` with 400 VALIDATION_FAILED', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/mark-approved`, { body: { comment: { nested: 'oops' } } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('decline rejects a non-string `reason` with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/decline`, { body: { reason: ['array', 'not', 'string'] } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('ntu rejects an over-long reason with 400', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/ntu`, { body: { reason: 'x'.repeat(2001) } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  // ── Valid bodies still flow through to the engine (no false 400) ──────────

  it('submit-for-approval with a valid comment is NOT rejected by validation', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/submit-for-approval`, { body: { comment: 'Please review this quote.' } });
    // The engine may 200 (submitted) or 422 (illegal prior state), but it must
    // NOT be a 400 validation rejection — the body is well-formed.
    expect(res.status).not.toBe(400);
  });

  it('an empty body is accepted (comment/reason are optional)', async () => {
    const id = await newQuote();
    const res = await harness.fetchApp('POST', `/api/quotes/${id}/offer/recall`, { body: {} });
    expect(res.status).not.toBe(400);
  });
});
