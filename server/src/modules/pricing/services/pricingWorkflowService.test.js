// Tests for the treaty submit-for-approval wiring (pricingWorkflowService →
// approvals.submitForApproval) — the mandate authority-limit / excluded-class
// gates must fire from the PRODUCTION call path, not only when a caller
// hand-feeds programLimit100Usd. The pg pool is mocked with an SQL-text (+
// params) dispatcher, so each test stands up the contract derivation row, the
// submitter/nominee mandates and the approver roster with no real DB.
//
// Acceptance scenario (reviewer): a $25M-authority underwriter writing 30% of a
// $200M programme MUST classify as a LIMIT breach — the 100% programme limit and
// the COB set are derived server-side from the stored contract (FX-converted to
// USD), and the computed breach beats any client-supplied breach_type.
import { describe, it, expect, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => {
  const poolMock = { query: vi.fn() };
  poolMock.connect = async () => ({ query: (...a) => poolMock.query(...a), release: () => {} });
  return { poolMock };
});
vi.mock('../../../db/pool.js', () => ({ pool: poolMock }));

const { submitForApprovalAction, getEligibleApproversAction, declineTreatyAction } = await import('./pricingWorkflowService.js');

const M = 1_000_000;

// v_user_mandate rows keyed by user_id (getUserMandate's user_id=$1 lookup).
const uwMandate = (user_id, over = {}) => ({
  user_id, role_code: 'UW', role_name: 'Underwriter', hierarchy_level: 4,
  effective_limit_usd: 25 * M, limit_basis: 'SIGNED_EXPOSURE', restricted_cob_ids: [],
  treaty_type_scope: 'BOTH', display_name: 'Underwriter', is_active: true, ...over,
});
const cuMandate = (user_id) => uwMandate(user_id, { role_code: 'CU', role_name: 'Chief Underwriter', hierarchy_level: 2, effective_limit_usd: null });
const tmMandate = (user_id) => uwMandate(user_id, { role_code: 'TM', role_name: 'Treaty Manager', hierarchy_level: 4, effective_limit_usd: 25 * M });

// Raw candidate rows for fetchApproverCandidates (v_user_mandate ⋈ uw_user).
const cand = (user_id, role_code, hierarchy_level, effective_limit_usd) => ({
  user_id, display_name: role_code, email: `${user_id}@x`, office: 'R',
  role_code, role_name: role_code, hierarchy_level, effective_limit_usd, restricted_cob_ids: [],
});

/** SQL-text dispatcher. `derivationRow` feeds deriveContractSubmissionInputs. */
function mockDb(cfg = {}) {
  return vi.fn(async (sql, params = []) => {
    const s = String(sql);
    const isSelect = /^\s*SELECT/i.test(s);
    if (isSelect && s.includes('contract_class_of_business')) {
      return { rows: cfg.derivationRow ? [cfg.derivationRow] : [] };
    }
    if (isSelect && s.includes('FROM public.uw_role') && s.includes('hierarchy_level')) {
      return { rows: cfg.roleRows || [] }; // [] → seeded fallback hierarchy
    }
    if (isSelect && s.includes('v_user_mandate') && s.includes('user_id=$1')) {
      const m = cfg.mandates?.[String(params[0])];
      return { rows: m ? [m] : [] };
    }
    if (isSelect && s.includes('v_user_mandate')) return { rows: cfg.candidates || [] };
    if (isSelect && s.includes('SELECT uw_status FROM public.contract')) return { rows: [{ uw_status: 'DRAFT' }] };
    // loadTerminalContext (decline/NTU authority): the contract's assignee and
    // its latest offer row.
    if (isSelect && s.includes('SELECT assigned_to_user_id FROM public.contract')) {
      return { rows: [{ assigned_to_user_id: cfg.assignedTo ?? null }] };
    }
    if (isSelect && s.includes('FROM public.contract_offer')) {
      return { rows: cfg.offerRow ? [cfg.offerRow] : [] };
    }
    if (s.includes('INSERT INTO public.contract_offer')) return { rows: [{ offer_id: 'o-1' }] };
    return { rows: [] };
  });
}

/** The params of the recorded contract_offer upsert (breach_type is $3). */
function offerInsertParams() {
  const call = poolMock.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO public.contract_offer'));
  return call ? call[1] : null;
}

const actor = { actorUserId: 'u-uw', actorName: 'Underwriter', actorRole: 'UW' };

// Contract derivation row: PROP, USD, $200M programme limit, $10M EPI.
const bigProgramme = { is_np: false, rate_to_usd: 1, program_limit_100: 200 * M, epi_100: 10 * M, cob_ids: [] };

describe('submitForApprovalAction — server-derived mandate gates', () => {
  it('a $25M-authority underwriter writing 30% of a $200M programme classifies LIMIT breach', async () => {
    poolMock.query = mockDb({
      derivationRow: bigProgramme,
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 25 * M), cand('u-uw2', 'UW', 4, 25 * M)],
    });
    const r = await submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-cu' });
    expect(r.breachType).toBe('LIMIT');            // 30% × $200M = $60M > $25M authority
    expect(r.requiredRole).toBe('TD');             // level-4 submitter escalates to Treaty Director tier
    const params = offerInsertParams();
    expect(params?.[2]).toBe('LIMIT');             // breach persisted on the offer
    // Only titles clearing the $60M exposure are stored as approver options —
    // the $25M TM/UW peers are out, the unlimited CU is in.
    const options = JSON.parse(params[8]);
    expect(options.map((o) => o.role_code)).toEqual(['CU']);
  });

  it('the same line on a $50M programme stays within mandate (NONE)', async () => {
    poolMock.query = mockDb({
      derivationRow: { ...bigProgramme, program_limit_100: 50 * M },
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-cu' });
    expect(r.breachType).toBe('NONE');             // 30% × $50M = $15M ≤ $25M
    expect(offerInsertParams()?.[2]).toBe('NONE');
  });

  it('ignores the client-supplied breach_type — the computed breach wins', async () => {
    poolMock.query = mockDb({
      derivationRow: bigProgramme,
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    // The client's hardcoded $50M check said NONE; the derived gate says LIMIT.
    const r = await submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-cu', breach_type: 'NONE' });
    expect(r.breachType).toBe('LIMIT');
    expect(offerInsertParams()?.[2]).toBe('LIMIT');
  });

  it('FX-converts the programme limit to USD before gating', async () => {
    poolMock.query = mockDb({
      // 200M in a 0.25-to-USD currency → $50M programme → $15M exposure → NONE.
      derivationRow: { ...bigProgramme, rate_to_usd: 0.25 },
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-cu' });
    expect(r.breachType).toBe('NONE');
  });

  it('classifies a CLASS breach from the contract COB set vs the mandate exclusions', async () => {
    poolMock.query = mockDb({
      derivationRow: { ...bigProgramme, program_limit_100: 50 * M, cob_ids: ['cob-agri'] },
      mandates: { 'u-uw': uwMandate('u-uw', { restricted_cob_ids: ['cob-agri'] }), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-cu' });
    expect(r.breachType).toBe('CLASS');
    expect(r.requiredRole).toBe('CU');
  });

  it('rejects a nominee below the breach-tier role who is not in the eligible set', async () => {
    poolMock.query = mockDb({
      derivationRow: bigProgramme,
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-tm': tmMandate('u-tm') },
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 25 * M)],
    });
    // LIMIT breach needs TD-or-above; the $25M TM is neither in the eligible
    // set (insufficient limit for $60M) nor senior enough.
    await expect(submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-tm' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects a nominee that does not exist', async () => {
    poolMock.query = mockDb({
      derivationRow: bigProgramme,
      mandates: { 'u-uw': uwMandate('u-uw') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expect(submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-ghost' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects self-nomination (four-eyes at submit)', async () => {
    poolMock.query = mockDb({
      derivationRow: bigProgramme,
      mandates: { 'u-uw': uwMandate('u-uw') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expect(submitForApprovalAction('c1', actor, { line_pct: 30, peer1_user_id: 'u-uw' }))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('declineTreatyAction — authority (F22/F29): assignee OR eligible approver, mirroring NTU', () => {
  it('403s a stranger — not assignee, not approver — and writes nothing', async () => {
    poolMock.query = mockDb({ assignedTo: 'u-owner', offerRow: null });
    await expect(declineTreatyAction('c1', { actorUserId: 'u-stranger', actorName: 'X', actorRole: 'UW' }, 'I felt like it'))
      .rejects.toMatchObject({ status: 403, code: 'DECLINE_FORBIDDEN' });
    const writes = poolMock.query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(String(sql)));
    expect(writes).toHaveLength(0);
  });

  it('403s an anonymous actor', async () => {
    poolMock.query = mockDb({ assignedTo: 'u-owner' });
    await expect(declineTreatyAction('c1', { actorUserId: null, actorName: 'SYSTEM', actorRole: null }, 'r'))
      .rejects.toMatchObject({ status: 403 });
  });

  it('lets the assignee decline', async () => {
    poolMock.query = mockDb({ assignedTo: 'u-owner', offerRow: null });
    await expect(declineTreatyAction('c1', { actorUserId: 'u-owner', actorName: 'Owner', actorRole: 'UW' }, 'dup submission'))
      .resolves.toBeUndefined();
    // The DECLINED transition actually ran (uw_status write through changeUwStatus).
    const statusWrite = poolMock.query.mock.calls.find(([sql, params]) =>
      String(sql).includes('UPDATE public.contract') && Array.isArray(params) && params.includes('DECLINED'));
    expect(statusWrite).toBeTruthy();
  });

  it('lets a live eligible approver decline (not the assignee)', async () => {
    poolMock.query = mockDb({
      assignedTo: 'u-owner',
      // A submitted offer by u-uw; the live re-plan must find u-cu eligible.
      offerRow: {
        offer_id: 'o-1', contract_id: 'c1', submitted_by_id: 'u-uw',
        written_line_pct: 10, epi_usd: 1 * M, status: 'AWAITING_APPROVAL', approval_step: 1,
      },
      derivationRow: { is_np: false, rate_to_usd: 1, program_limit_100: 10 * M, epi_100: 1 * M, cob_ids: [] },
      mandates: { 'u-uw': uwMandate('u-uw'), 'u-cu': cuMandate('u-cu') },
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expect(declineTreatyAction('c1', { actorUserId: 'u-cu', actorName: 'Chief', actorRole: 'CU' }, 'declined on review'))
      .resolves.toBeUndefined();
  });
});

describe('getEligibleApproversAction — the picker only offers nominees submit will accept', () => {
  it('filters out titles below the breach-tier approver role for this submitter', async () => {
    poolMock.query = mockDb({
      mandates: { 'u-uw': uwMandate('u-uw') },
      // Both clear the (legacy epi-based) limit gate; only CU clears the
      // LIMIT-breach tier (TD or above) the submit validation enforces.
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, null)],
    });
    const list = await getEligibleApproversAction({ submitterUserId: 'u-uw', breachType: 'LIMIT', epiUsd: 30 * M });
    expect(list.map((c) => c.role_code)).toEqual(['CU']);
  });

  it('within mandate (NONE) the underwriting TM/UW tier and above are offerable — RM is not', async () => {
    poolMock.query = mockDb({
      mandates: { 'u-uw': uwMandate('u-uw') },
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-rm', 'RM', 3, null), cand('u-uw2', 'UW', 4, 25 * M), cand('u-an', 'AN', 5, null)],
    });
    const list = await getEligibleApproversAction({ submitterUserId: 'u-uw', breachType: null, epiUsd: 5 * M });
    // UW peers are level 4 (approver tier) per the DB hierarchy; AN (5) is not.
    // F80: the Retro Manager is excluded — its mandate covers retrocession
    // programmes, not inward treaty business, so the picker never offers it
    // (the same UNDERWRITING_APPROVER_ROLES filter the decision engine applies).
    expect(list.map((c) => c.role_code).sort()).toEqual(['CU', 'UW']);
    expect(list.map((c) => c.user_id)).not.toContain('u-uw'); // four-eyes
  });
});
