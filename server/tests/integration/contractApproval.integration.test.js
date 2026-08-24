// server/tests/integration/contractApproval.integration.test.js
//
// Regression cover for the contract (treaty) peer-approval path.
//
// WHY THIS EXISTS: claimPeerSlot bound the actor id to ONE placeholder that had
// to be a uuid (SET peerN_user_id=$2) *and* text (the jsonb approver_options
// membership test used `$2::text`). Postgres infers a single type per
// parameter, so the text cast won and the UPDATE failed at PARSE time with
// 42804 "column peer1_user_id is of type uuid but expression is of type text".
// Being a parse-time error it was value-independent: EVERY treaty approval 500'd
// for every role, on every offer, while the UI just left the treaty sitting in
// AWAITING_APPROVAL. No unit test caught it because the fault only exists
// against a real Postgres parser.
//
// These tests drive the real HTTP surface end to end, so any future change that
// reintroduces a parameter-type collision in claimPeerSlot fails here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const d = shouldSkipDb ? describe.skip : describe;

async function makeUser(roleCode, label) {
  const { rows: roles } = await pool.query(
    `SELECT role_id FROM public.uw_role WHERE role_code = ANY($1) ORDER BY array_position($1, role_code) LIMIT 1`,
    [roleCode],
  );
  if (!roles.length) return null;
  const s = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const { rows } = await pool.query(
    `INSERT INTO public.uw_user (username, display_name, email, role_id, password_hash)
     VALUES ($1,$2,$3,$4,'x') RETURNING user_id`,
    [`it_${label}_${s}`, `IT ${label} ${s}`, `${label}${s}@example.test`, roles[0].role_id],
  );
  const userId = rows[0].user_id;
  await pool.query(
    `INSERT INTO public.user_mandate (user_id, treaty_limit_usd, treaty_type_scope, approvals_required)
     VALUES ($1, 100000000, 'BOTH', 1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  return userId;
}

d('contract approval — peer slot claim', () => {
  let app, refs, uwId, cuId, strangerId;

  beforeAll(async () => {
    app = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    uwId = await makeUser(['UW', 'TUW'], 'uw');
    cuId = await makeUser(['CU'], 'cu');
    // Created up front, not inside the test: minting a user mid-run changes the
    // live approver candidate pool, which the engine correctly rejects as
    // ROUTING_STALE (409) before it ever reaches the eligibility check.
    strangerId = await makeUser(['CU'], 'cu2');
  }, 60_000);

  afterAll(async () => {
    // The minted users must stay ACTIVE during the run (approver eligibility
    // filters is_active=true), so cleanup lives here. Contracts created by the
    // tests may still reference them (assigned_to/offer FKs), so DELETE can
    // fail — fall back to deactivating, which removes them from every user and
    // approver dropdown (audit F8).
    for (const id of [uwId, cuId, strangerId].filter(Boolean)) {
      try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [id]); }
      catch { try { await pool.query(`UPDATE public.uw_user SET is_active=false WHERE user_id=$1`, [id]); } catch { /* best effort */ } }
    }
    await app?.close();
    await closePools();
  });

  /** Create a contract owned by the underwriter and submit it to `approverId`. */
  async function submittedContract(approverId) {
    const uw = { 'x-user-role': 'UW', 'x-user-id': uwId, 'x-user-name': 'IT UW' };
    const created = await (await app.fetchApp('POST', '/api/treaties', {
      headers: uw,
      body: { contract_name: `IT Approval ${Date.now()}`, uw_year: 2026, inception_date: '2026-01-01', ...refs },
    })).json();
    const contractId = created.contract_id;
    expect(contractId).toBeTruthy();
    // The submitter must be the assignee to pass the edit lock.
    await pool.query(`UPDATE public.contract SET assigned_to_user_id=$2 WHERE contract_id=$1`, [contractId, uwId]);

    const submit = await app.fetchApp('POST', `/api/treaties/${contractId}/offer/submit-for-approval`, {
      headers: uw,
      body: { line_pct: '10', peer1_user_id: approverId, epi_usd: 1_000_000, comment: 'please review' },
    });
    expect(submit.status).toBe(200);
    return contractId;
  }

  it('a Chief Underwriter can approve a submitted treaty offer', async () => {
    const contractId = await submittedContract(cuId);

    const res = await app.fetchApp('POST', `/api/treaties/${contractId}/offer/mark-approved`, {
      headers: { 'x-user-role': 'CU', 'x-user-id': cuId, 'x-user-name': 'IT CU' },
      body: { comment: 'approved', line_pct: '10' },
    });
    const body = await res.json();

    // The regression: this used to be 500 / 42804 rather than a clean approval.
    expect(res.status).toBe(200);
    expect(body.finalDecision).toBe('APPROVED');
    expect(body.nextStatus).toBe('AWAITING_SIGNED_LINE');

    // …and it must actually persist, not just return 200.
    const { rows: offer } = await pool.query(
      `SELECT status, peer1_user_id, peer1_decision FROM public.contract_offer WHERE contract_id=$1`,
      [contractId],
    );
    expect(offer[0].peer1_decision).toBe('APPROVED');
    expect(String(offer[0].peer1_user_id)).toBe(String(cuId));
    expect(offer[0].status).toBe('AWAITING_SIGNED_LINE');

    const { rows: contract } = await pool.query(
      `SELECT uw_status FROM public.contract WHERE contract_id=$1`, [contractId],
    );
    expect(contract[0].uw_status).toBe('AWAITING_SIGNED_LINE');
  }, 60_000);

  it('any eligible approver in the routing can claim the slot, not just the nominee', async () => {
    // Nomination (peer1_user_id at submission) is a routing suggestion, not an
    // exclusive lock: approver_options holds the whole eligible set. This case
    // matters for the regression because the claim runs the jsonb membership
    // test against a uuid that is NOT the nominated one — the exact comparison
    // whose parameter-type collision used to blow up at parse time.
    const contractId = await submittedContract(cuId);

    const res = await app.fetchApp('POST', `/api/treaties/${contractId}/offer/mark-approved`, {
      headers: { 'x-user-role': 'CU', 'x-user-id': strangerId, 'x-user-name': 'IT CU2' },
      body: { comment: 'approved by the other CU' },
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT peer1_user_id, peer1_decision FROM public.contract_offer WHERE contract_id=$1`,
      [contractId],
    );
    expect(rows[0].peer1_decision).toBe('APPROVED');
    expect(String(rows[0].peer1_user_id)).toBe(String(strangerId));
  }, 60_000);

  it('refuses a self-approval by the submitter', async () => {
    const contractId = await submittedContract(cuId);

    const res = await app.fetchApp('POST', `/api/treaties/${contractId}/offer/mark-approved`, {
      headers: { 'x-user-role': 'UW', 'x-user-id': uwId, 'x-user-name': 'IT UW' },
      body: { comment: 'self' },
    });
    expect(res.status).toBe(403);
  }, 60_000);
});
