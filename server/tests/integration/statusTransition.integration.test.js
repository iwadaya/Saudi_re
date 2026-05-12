// server/tests/integration/statusTransition.integration.test.js
//
// The audit flagged that workflow actions (mark-signed, mark-ntu,
// mark-approved, decline) previously accepted any pre-state. These
// tests pin the new machine: attempting an illegal jump returns
// 422 INVALID_TRANSITION with { from, to } on the error body.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: uw_status transition guard', () => {
  let harness;
  const created = [];

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => {
    for (const id of created) {
      try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  async function newDraft() {
    const res = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2026, status: 'DRAFT' },
    });
    const c = await res.json();
    created.push(c.contract_id);
    return c.contract_id;
  }

  it('mark-signed on a DRAFT → 422 INVALID_TRANSITION with { from: DRAFT, to: SIGNED }', async () => {
    const id = await newDraft();

    const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer/mark-signed`, {
      body: { signed_line_pct: 25 },
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_TRANSITION');
    expect(body.from).toBe('DRAFT');
    expect(body.to).toBe('SIGNED');
    expect(body.requestId).toBeTruthy();
  });

  it('mark-ntu on a DRAFT → 422 INVALID_TRANSITION', async () => {
    const id = await newDraft();

    const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer/ntu`, {
      body: { reason: 'test' },
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_TRANSITION');
    expect(body.from).toBe('DRAFT');
    expect(body.to).toBe('NTU');
  });

  it('mark-approved on a DRAFT → 422 INVALID_TRANSITION', async () => {
    const id = await newDraft();

    const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer/mark-approved`, {
      body: {},
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_TRANSITION');
    expect(body.to).toBe('AWAITING_SIGNED_LINE');
  });

  it('decline from a DRAFT is legal — returns 200, not 422', async () => {
    // Decline is the one action that legally works from any non-
    // terminal state. Pinning this so we don't accidentally over-
    // tighten the guard later.
    const id = await newDraft();

    const res = await harness.fetchApp('POST', `/api/treaties/${id}/decline`, {
      body: { reason: 'integration-test' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('404 when contract does not exist (status read happens first)', async () => {
    const res = await harness.fetchApp('POST', '/api/treaties/00000000-0000-0000-0000-000000000000/offer/mark-signed', {
      body: { signed_line_pct: 10 },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('CONTRACT_NOT_FOUND');
  });
});
