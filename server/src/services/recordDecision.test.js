// Security tests for the recordDecision approval chokepoint (approvals.js).
//
// These exercise the DB-touching enforcement path, so the pg pool is mocked:
// pool.query is dispatched on the SQL text to canned fixtures, letting each test
// stand up an offer + live mandate roster + slot-claim outcome with no real DB.
//
// Coverage maps 1:1 to the acceptance criteria:
//   • a non-eligible authenticated user is rejected from peer1 even when empty
//   • two concurrent eligible claimants → exactly one wins, the other 409s
//   • peer2 cannot equal peer1; neither can equal the submitter
//   • stored approver_options disagreeing with live eligibility → fail-closed 409
import { describe, it, expect, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { recordDecision, recordPeerDecision, approverOptionIds } = await import('./approvals.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const M = 1_000_000;

// A v_user_mandate row for the submitter (an Underwriter, 25M authority).
const submitter = (over = {}) => ({
  user_id: 'u-sub', role_code: 'UW', role_name: 'Underwriter', hierarchy_level: 4,
  effective_limit_usd: 25 * M, limit_basis: 'SIGNED_EXPOSURE', restricted_cob_ids: [],
  treaty_type_scope: 'BOTH', display_name: 'Submitter', is_active: true, ...over,
});

// A raw v_user_mandate⋈uw_user candidate row (fetchApproverCandidates maps it).
const cand = (user_id, role_code, hierarchy_level, effective_limit_usd, restricted_cob_ids = []) => ({
  user_id, display_name: role_code, email: `${user_id}@x`, office: 'R',
  role_code, role_name: role_code, hierarchy_level, effective_limit_usd, restricted_cob_ids,
});

const offer = (over = {}) => ({
  offer_id: 'o1', contract_id: 'c1', quote_id: null, status: 'AWAITING_APPROVAL',
  submitted_by_id: 'u-sub', written_line_pct: null, epi_usd: null,
  peer1_user_id: null, peer1_decision: null, peer1_role_code: null,
  peer2_user_id: null, peer2_decision: null, peer2_role_code: null,
  arbiter_required: false, arbiter_user_id: null, approver_options: [], ...over,
});

/**
 * Build a pool.query mock that dispatches on SQL text. `*Claim` hooks return a
 * boolean for whether that conditional UPDATE wins its row (default: wins).
 */
function mockDb({ offer: off, submitter: sub, candidates = [], peer1Claim, peer2Claim, arbiterClaim }) {
  const won = (hook) => (typeof hook === 'function' ? hook() : hook !== false);
  return vi.fn(async (sql) => {
    const s = String(sql);
    const isSelect = /^\s*SELECT/i.test(s);
    const offerRows = { rows: off ? [off] : [] };
    if (isSelect && s.includes('v_offer_approval')) return offerRows;                      // loadOfferById
    if (isSelect && s.includes('v_user_mandate') && s.includes('user_id=$1')) return { rows: sub ? [sub] : [] };
    if (isSelect && s.includes('v_user_mandate')) return { rows: candidates };             // fetchApproverCandidates
    if (isSelect && s.includes('contract_offer')) return offerRows;                        // resolveOfferByEntity
    if (s.includes('SET peer1_user_id=$2')) return { rows: won(peer1Claim) ? [{ offer_id: off.offer_id }] : [] };
    if (s.includes('SET peer2_user_id=$2')) return { rows: won(peer2Claim) ? [{ offer_id: off.offer_id }] : [] };
    if (s.includes('SET arbiter_user_id=$2')) return { rows: won(arbiterClaim) ? [{ offer_id: off.offer_id }] : [] };
    return { rows: [] };
  });
}

async function expectStatus(promise, status, code) {
  await expect(promise).rejects.toMatchObject(code ? { status, code } : { status });
}

const claimedPeer1 = () => poolMock.query.mock.calls.some(([sql]) => String(sql).includes('SET peer1_user_id=$2'));

// The escalation roster: a 30M EPI line over the UW's 25M authority breaches the
// limit, so eligibility opens up to UM/CU/CE (nearest-sufficient).
const ESCALATE_OPTIONS = [
  { user_id: 'u-um', role_code: 'UM' }, { user_id: 'u-cu', role_code: 'CU' }, { user_id: 'u-ce', role_code: 'CE' },
];
const ESCALATE_CANDIDATES = [cand('u-um', 'UM', 3, 50 * M), cand('u-cu', 'CU', 2, null), cand('u-ce', 'CE', 1, null)];

describe('recordDecision — peer1 eligibility (the core fix)', () => {
  it('rejects a non-eligible authenticated user from peer1 even when the slot is empty', async () => {
    poolMock.query = mockDb({
      offer: offer({ peer1_user_id: null, approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 5 * M)],
    });
    // u-tm is authenticated and senior, but routing for a within-mandate UW
    // submission goes to CU only — TM is not in the eligible set.
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-tm', actorRole: 'TM', slot: 'peer1', decision: 'APPROVED' }),
      403,
    );
    expect(claimedPeer1()).toBe(false); // never reached the slot-claim UPDATE
  });

  it('lets an eligible approver claim peer1 (CU is final authority → complete)', async () => {
    poolMock.query = mockDb({
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await recordDecision({ offerId: 'o1', actorUserId: 'u-cu', actorRole: 'CU', slot: 'peer1', decision: 'APPROVED' });
    expect(claimedPeer1()).toBe(true);
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
    expect(r.complete).toBe(true);
  });
});

describe('recordDecision — concurrency (conditional UPDATE)', () => {
  it('two concurrent eligible claimants → exactly one wins, the other gets 409 SLOT_TAKEN', async () => {
    let claimAttempts = 0;
    poolMock.query = mockDb({
      offer: offer({ approver_options: [{ user_id: 'u-cu1', role_code: 'CU' }, { user_id: 'u-cu2', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu1', 'CU', 2, null), cand('u-cu2', 'CU', 2, null)],
      peer1Claim: () => (++claimAttempts === 1), // only the first UPDATE matches a row
    });
    const winner = await recordDecision({ offerId: 'o1', actorUserId: 'u-cu1', actorRole: 'CU', slot: 'peer1', decision: 'APPROVED' });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-cu2', actorRole: 'CU', slot: 'peer1', decision: 'APPROVED' }),
      409, 'SLOT_TAKEN',
    );
    expect(winner.complete).toBe(true);
    expect(claimAttempts).toBe(2); // both reached the atomic claim; the guard split them
  });
});

describe('recordDecision — four-eyes (peer2 ≠ peer1 ≠ submitter)', () => {
  it('rejects the submitter from approving their own submission', async () => {
    poolMock.query = mockDb({
      offer: offer({ epi_usd: 30 * M, approver_options: ESCALATE_OPTIONS }),
      submitter: submitter(), candidates: ESCALATE_CANDIDATES,
    });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-sub', actorRole: 'UW', slot: 'peer1', decision: 'APPROVED' }),
      403,
    );
  });

  it('rejects peer2 when it is the same user who took peer1', async () => {
    poolMock.query = mockDb({
      offer: offer({ epi_usd: 30 * M, approver_options: ESCALATE_OPTIONS, peer1_user_id: 'u-um', peer1_decision: 'APPROVED', peer1_role_code: 'UM' }),
      submitter: submitter(), candidates: ESCALATE_CANDIDATES,
    });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-um', actorRole: 'UM', slot: 'peer2', decision: 'APPROVED' }),
      403,
    );
  });

  it('accepts a distinct eligible peer2 → two matching approvals finalize the offer', async () => {
    poolMock.query = mockDb({
      offer: offer({ epi_usd: 30 * M, approver_options: ESCALATE_OPTIONS, peer1_user_id: 'u-um', peer1_decision: 'APPROVED', peer1_role_code: 'UM' }),
      submitter: submitter(), candidates: ESCALATE_CANDIDATES,
    });
    const r = await recordDecision({ offerId: 'o1', actorUserId: 'u-cu', actorRole: 'CU', slot: 'peer2', decision: 'APPROVED' });
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
    expect(r.complete).toBe(true);
  });
});

describe('recordDecision — fail closed when stored options ≠ live eligibility', () => {
  it('returns 409 ROUTING_CHANGED when approver_options is tampered to include a non-eligible user', async () => {
    poolMock.query = mockDb({
      // Stored snapshot has been tampered to add u-attacker; live routing (UW
      // within-mandate → CU only) does NOT include them.
      offer: offer({ approver_options: [{ user_id: 'u-attacker', role_code: 'CU' }, { user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-attacker', actorRole: 'CU', slot: 'peer1', decision: 'APPROVED' }),
      409, 'ROUTING_CHANGED',
    );
    expect(claimedPeer1()).toBe(false);
  });
});

describe('recordDecision — arbiter slot', () => {
  const disputed = (over = {}) => offer({ status: 'DISPUTE_PENDING', arbiter_required: true, ...over });

  it('rejects an arbiter below Treaty Director authority', async () => {
    poolMock.query = mockDb({ offer: disputed(), submitter: submitter(), candidates: [] });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-tm', actorRole: 'TM', slot: 'arbiter', decision: 'APPROVED' }),
      403,
    );
  });

  it('rejects the submitter from arbitrating their own dispute', async () => {
    poolMock.query = mockDb({ offer: disputed(), submitter: submitter(), candidates: [] });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-sub', actorRole: 'CU', slot: 'arbiter', decision: 'APPROVED' }),
      403,
    );
  });

  it('lets a Chief Underwriter resolve the dispute', async () => {
    poolMock.query = mockDb({ offer: disputed(), submitter: submitter(), candidates: [] });
    const r = await recordDecision({ offerId: 'o1', actorUserId: 'u-cu', actorRole: 'CU', slot: 'arbiter', decision: 'APPROVED' });
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
    expect(r.complete).toBe(true);
  });

  it('409s when the dispute was already resolved (lost the claim race)', async () => {
    poolMock.query = mockDb({ offer: disputed(), submitter: submitter(), candidates: [], arbiterClaim: false });
    await expectStatus(
      recordDecision({ offerId: 'o1', actorUserId: 'u-cu', actorRole: 'CU', slot: 'arbiter', decision: 'DECLINED' }),
      409, 'DISPUTE_RESOLVED',
    );
  });
});

describe('recordPeerDecision — thin resolver routes through the chokepoint', () => {
  it('resolves the open peer slot and enforces eligibility', async () => {
    poolMock.query = mockDb({
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await recordPeerDecision({ contractId: 'c1', decidedByUserId: 'u-cu', decidedByName: 'CU', decidedByRole: 'CU', decision: 'APPROVED' });
    expect(r.complete).toBe(true);
    expect(claimedPeer1()).toBe(true);
  });

  it('rejects a non-eligible decider routed through the resolver', async () => {
    poolMock.query = mockDb({
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 5 * M)],
    });
    await expectStatus(
      recordPeerDecision({ contractId: 'c1', decidedByUserId: 'u-tm', decidedByName: 'TM', decidedByRole: 'TM', decision: 'APPROVED' }),
      403,
    );
  });
});

describe('approverOptionIds — tolerant snapshot parsing', () => {
  it('extracts user_ids from object arrays, string arrays, and JSON strings', () => {
    expect(approverOptionIds([{ user_id: 'a' }, { user_id: 'b' }])).toEqual(['a', 'b']);
    expect(approverOptionIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(approverOptionIds('[{"user_id":"a"}]')).toEqual(['a']);
    expect(approverOptionIds(null)).toEqual([]);
    expect(approverOptionIds('garbage')).toEqual([]);
  });
});
