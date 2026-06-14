// Tests for the workflow-transition gate (approvals.js):
//   1. A static regression scan: NO source file outside the approval service
//      writes a privileged uw_status (or a quote status) literal directly.
//   2. Behavioural unit tests for assertWorkflowTransition + the approval-service
//      entrypoints (approveContract / markContractSigned / approveQuote), with
//      the pg pool mocked.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 1. Regression scan ───────────────────────────────────────────────────────
describe('no privileged workflow-state write lives outside the approval service', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(here, '..');                 // server/src
  const APPROVAL_SERVICE = path.join('services', 'approvals.js');

  // Strip comments so prose like the statusMachine JSDoc (which spells out
  // uw_status='AWAITING_SIGNED_LINE') and the disabled-route comments don't
  // register as code.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')         // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');    // line comments (keep http://)

  const sourceFiles = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !f.endsWith('.test.js'))
    .filter((f) => !f.startsWith(path.join('db', 'migrations')))
    .filter((f) => !f.startsWith(path.join('db', 'seeds')))
    .filter((f) => f !== APPROVAL_SERVICE);

  // A *write* of uw_status to a privileged OR terminal state. The negative
  // lookbehind skips qualified reads like `c.uw_status = 'SIGNED'` in WHERE
  // clauses. SIGNED and NTU are both terminal underwriting outcomes — neither
  // may be written outside the approval service.
  const UW_PRIVILEGED_WRITE = /(?<![\w.])uw_status\s*=\s*'(APPROVED|AWAITING_SIGNED_LINE|SIGNED|NTU|BOUND)'/;

  it('no file writes uw_status into APPROVED / AWAITING_SIGNED_LINE / SIGNED / NTU / BOUND', () => {
    const offenders = [];
    for (const rel of sourceFiles) {
      const body = stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
      body.split('\n').forEach((line, i) => {
        if (UW_PRIVILEGED_WRITE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Privileged/terminal uw_status writes must go through approvals.js:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the quote routes no longer write an approved/signed/ntu quote status directly', () => {
    const QUOTE_PRIVILEGED_WRITE = /status\s*=\s*'(AWAITING_SIGNED_LINE|SIGNED|NTU|BOUND)'/;
    const offenders = [];
    for (const rel of ['routes/quotes.js', 'routes/quoteLifecycle.js']) {
      const body = stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
      body.split('\n').forEach((line, i) => {
        if (QUOTE_PRIVILEGED_WRITE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Quote sign/NTU must go through approveQuote / markNotTakenUp:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the approval service itself is where these writes now live (sanity)', () => {
    const body = readFileSync(path.join(SRC, APPROVAL_SERVICE), 'utf8');
    expect(body).toMatch(/uw_status='SIGNED'/);                 // markContractSigned
    expect(body).toMatch(/uw_status='NTU'/);                    // markNotTakenUp (treaty)
    expect(body).toMatch(/status='NTU'/);                       // markNotTakenUp (quote)
    expect(body).toMatch(/status='AWAITING_SIGNED_LINE'/);      // approveQuote
    expect(body).toMatch(/assertWorkflowTransition/);
  });
});

// ── 2. Behavioural tests (pool mocked) ───────────────────────────────────────
const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));
vi.mock('./ldf/benchmark.js', () => ({ refreshBenchmarks: vi.fn(() => Promise.resolve()) }));

const {
  assertWorkflowTransition, approveContract, markContractSigned, approveQuote,
  markNotTakenUp, returnToUnderwriter, recallOffer,
} = await import('./approvals.js');

const M = 1_000_000;
const submitter = (over = {}) => ({
  user_id: 'u-sub', role_code: 'UW', hierarchy_level: 4, effective_limit_usd: 25 * M,
  limit_basis: 'SIGNED_EXPOSURE', restricted_cob_ids: [], treaty_type_scope: 'BOTH', ...over,
});
const cand = (user_id, role_code, lvl, lim) => ({
  user_id, display_name: role_code, email: `${user_id}@x`, office: 'R',
  role_code, role_name: role_code, hierarchy_level: lvl, effective_limit_usd: lim, restricted_cob_ids: [],
});
const offer = (over = {}) => ({
  offer_id: 'o1', contract_id: 'c1', quote_id: null, status: 'AWAITING_APPROVAL',
  submitted_by_id: 'u-sub', written_line_pct: null, epi_usd: null,
  peer1_user_id: null, peer1_decision: null, peer1_role_code: null,
  peer2_user_id: null, peer2_decision: null, approver_options: [], ...over,
});

function mockDb(cfg = {}) {
  const won = (h) => (typeof h === 'function' ? h() : h !== false);
  return vi.fn(async (sql) => {
    const s = String(sql);
    const isSelect = /^\s*SELECT/i.test(s);
    if (isSelect && s.includes('created_by_user_id')) return { rows: cfg.quoteRow ? [cfg.quoteRow] : [] };
    if (isSelect && s.includes('assigned_to_user_id') && /FROM\s+public\.contract\s+WHERE/i.test(s)) return { rows: cfg.contractRow ? [cfg.contractRow] : [] };
    if (isSelect && s.includes('uw_status AS status')) return { rows: cfg.contractStatus ? [{ status: cfg.contractStatus }] : [] };
    if (isSelect && /SELECT\s+status\s+FROM\s+public\.quote/i.test(s)) return { rows: cfg.quoteStatus ? [{ status: cfg.quoteStatus }] : [] };
    if (isSelect && s.includes('v_offer_approval')) return { rows: cfg.offer ? [cfg.offer] : [] };
    if (isSelect && s.includes('v_user_mandate') && s.includes('user_id=$1')) return { rows: cfg.submitter ? [cfg.submitter] : [] };
    if (isSelect && s.includes('v_user_mandate')) return { rows: cfg.candidates || [] };
    if (isSelect && s.includes('contract_offer')) return { rows: cfg.offer ? [cfg.offer] : [] };
    if (s.includes('SET peer1_user_id=$2')) return { rows: won(cfg.peer1Claim) ? [{ offer_id: cfg.offer?.offer_id }] : [] };
    if (s.includes('SET peer2_user_id=$2')) return { rows: won(cfg.peer2Claim) ? [{ offer_id: cfg.offer?.offer_id }] : [] };
    return { rows: [] };
  });
}
const expectStatus = (p, status, code) => expect(p).rejects.toMatchObject(code ? { status, code } : { status });

describe('assertWorkflowTransition', () => {
  it('rejects a non-privileged target (this gate is only for approve/sign/bind)', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT' });
    await expectStatus(assertWorkflowTransition({ entityType: 'CONTRACT', entityId: 'c1', to: 'DRAFT' }), 400);
  });
  it('404s when the entity is gone', async () => {
    poolMock.query = mockDb({ contractStatus: null });
    await expectStatus(assertWorkflowTransition({ entityType: 'CONTRACT', entityId: 'c1', to: 'SIGNED' }), 404, 'CONTRACT_NOT_FOUND');
  });
  it('422s an illegal jump (DRAFT → SIGNED)', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT' });
    await expectStatus(assertWorkflowTransition({ entityType: 'CONTRACT', entityId: 'c1', to: 'SIGNED' }), 422);
  });
  it('rejects an approve move with no engine token (external caller cannot approve)', async () => {
    poolMock.query = mockDb({ contractStatus: 'AWAITING_APPROVAL' });
    await expectStatus(
      assertWorkflowTransition({ entityType: 'CONTRACT', entityId: 'c1', to: 'AWAITING_SIGNED_LINE' }),
      403, 'NOT_FROM_ENGINE',
    );
  });
  it('allows SIGN from the engine-produced AWAITING_SIGNED_LINE state (no token needed)', async () => {
    poolMock.query = mockDb({ contractStatus: 'AWAITING_SIGNED_LINE' });
    const ctx = await assertWorkflowTransition({ entityType: 'CONTRACT', entityId: 'c1', to: 'SIGNED' });
    expect(ctx).toMatchObject({ from: 'AWAITING_SIGNED_LINE', to: 'SIGNED' });
  });
});

describe('approveContract (markApprovedAction path)', () => {
  it('422s an illegal approve from DRAFT — before any decision', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT' });
    await expectStatus(approveContract({ contractId: 'c1', actorUserId: 'u-cu', actorRole: 'CU' }), 422);
  });
  it('404s a missing contract', async () => {
    poolMock.query = mockDb({ contractStatus: null });
    await expectStatus(approveContract({ contractId: 'c1', actorUserId: 'u-cu', actorRole: 'CU' }), 404, 'CONTRACT_NOT_FOUND');
  });
  it('an eligible CU approves → routes through the engine and finalizes', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await approveContract({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU' });
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
    expect(r.complete).toBe(true);
  });
  it('rejects an ineligible approver via the engine (eligibility enforced)', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 5 * M)],
    });
    await expectStatus(approveContract({ contractId: 'c1', actorUserId: 'u-tm', actorRole: 'TM' }), 403);
  });
  it('rejects the submitter approving their own contract (four-eyes via engine)', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(),
      candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(approveContract({ contractId: 'c1', actorUserId: 'u-sub', actorRole: 'UW' }), 403);
  });
});

describe('markContractSigned (markSignedAction path) — state AND signer authority', () => {
  // Within-mandate UW submission → route is CU only, so the eligible signer set is {u-cu}.
  const signable = (over = {}) => ({
    contractStatus: 'AWAITING_SIGNED_LINE',
    offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
    submitter: submitter(),
    candidates: [cand('u-cu', 'CU', 2, null), cand('u-tm', 'TM', 4, 5 * M)],
    ...over,
  });

  it('an eligible approver signs from AWAITING_SIGNED_LINE', async () => {
    poolMock.query = mockDb(signable());
    const r = await markContractSigned({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', signedLinePct: 12 });
    expect(r.nextStatus).toBe('SIGNED');
  });

  it('422s signing a DRAFT (wrong prior state) — before any authority check', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT' });
    await expectStatus(markContractSigned({ contractId: 'c1', actorUserId: 'u-cu', actorRole: 'CU', signedLinePct: 12 }), 422);
  });

  it('403s a signer who is not an eligible approver for this offer', async () => {
    poolMock.query = mockDb(signable());
    // u-tm is senior but the within-mandate route is CU only — TM is not eligible.
    await expectStatus(markContractSigned({ contractId: 'c1', actorUserId: 'u-tm', actorRole: 'TM', signedLinePct: 12 }), 403, 'SIGN_FORBIDDEN');
  });

  it('403s a signer whose mandate does NOT cover the written-line exposure', async () => {
    // 30M exposure breaches the UW; the TM (5M limit) cannot clear the gate, the CU can.
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_SIGNED_LINE',
      offer: offer({ epi_usd: 30 * M }),
      submitter: submitter(),
      candidates: [cand('u-tm', 'TM', 4, 5 * M), cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(markContractSigned({ contractId: 'c1', actorUserId: 'u-tm', actorRole: 'TM', signedLinePct: 12 }), 403, 'SIGN_FORBIDDEN');
    // …and the sufficient CU may sign the same offer.
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_SIGNED_LINE',
      offer: offer({ epi_usd: 30 * M }),
      submitter: submitter(),
      candidates: [cand('u-tm', 'TM', 4, 5 * M), cand('u-cu', 'CU', 2, null)],
    });
    const r = await markContractSigned({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', signedLinePct: 12 });
    expect(r.nextStatus).toBe('SIGNED');
  });

  it('403s the submitter signing their own offer (four-eyes built into the eligible set)', async () => {
    poolMock.query = mockDb(signable());
    await expectStatus(markContractSigned({ contractId: 'c1', actorUserId: 'u-sub', actorRole: 'UW', signedLinePct: 12 }), 403, 'SIGN_FORBIDDEN');
  });
});

describe('markNotTakenUp (NTU) — assignee OR eligible senior, treaty + quote', () => {
  it('the assignee (owner) may NTU a treaty from AWAITING_SIGNED_LINE', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_SIGNED_LINE',
      contractRow: { assigned_to_user_id: 'u-owner' },
      offer: offer(), submitter: submitter(), candidates: [],
    });
    const r = await markNotTakenUp({ contractId: 'c1', actorUserId: 'u-owner', actorName: 'Owner', actorRole: 'UW', reason: 'fell through' });
    expect(r.nextStatus).toBe('NTU');
  });

  it('an eligible senior (not the owner) may NTU a treaty', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_SIGNED_LINE',
      contractRow: { assigned_to_user_id: 'u-owner' },
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await markNotTakenUp({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', reason: 'x' });
    expect(r.nextStatus).toBe('NTU');
  });

  it('403s a user who is neither the assignee nor an eligible senior', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_SIGNED_LINE',
      contractRow: { assigned_to_user_id: 'u-owner' },
      offer: offer({ approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(markNotTakenUp({ contractId: 'c1', actorUserId: 'u-rando', actorRole: 'UW', reason: 'x' }), 403, 'NTU_FORBIDDEN');
  });

  it('422s NTU on a DRAFT treaty (wrong prior state)', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT', contractRow: { assigned_to_user_id: 'u-owner' } });
    await expectStatus(markNotTakenUp({ contractId: 'c1', actorUserId: 'u-owner', actorRole: 'UW', reason: 'x' }), 422);
  });

  it('the assignee may NTU a quote; routes through the gate', async () => {
    poolMock.query = mockDb({
      quoteStatus: 'AWAITING_SIGNED_LINE',
      quoteRow: { created_by_user_id: 'u-sub', assigned_to_user_id: 'u-owner', next_approver: null },
    });
    const r = await markNotTakenUp({ quoteId: 'q1', actorUserId: 'u-owner', actorName: 'Owner', actorRole: 'UW', reason: 'x' });
    expect(r.nextStatus).toBe('NTU');
  });

  it('403s a junior non-assignee on a quote NTU', async () => {
    poolMock.query = mockDb({
      quoteStatus: 'AWAITING_SIGNED_LINE',
      quoteRow: { created_by_user_id: 'u-sub', assigned_to_user_id: 'u-owner', next_approver: null },
    });
    await expectStatus(markNotTakenUp({ quoteId: 'q1', actorUserId: 'u-rando', actorRole: 'UW', reason: 'x' }), 403, 'NTU_FORBIDDEN');
  });
});

describe('returnToUnderwriter (RETURN) — eligible approver / senior', () => {
  it('an eligible approver returns a pending treaty to DRAFT', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ status: 'AWAITING_APPROVAL', approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await returnToUnderwriter({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', reason: 'redo' });
    expect(r.nextStatus).toBe('DRAFT');
  });

  it('403s a non-eligible user trying to return a treaty', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ status: 'AWAITING_APPROVAL', approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(returnToUnderwriter({ contractId: 'c1', actorUserId: 'u-rando', actorRole: 'UW', reason: 'x' }), 403, 'RETURN_FORBIDDEN');
  });

  it('a senior may return a pending quote to DRAFT', async () => {
    poolMock.query = mockDb({
      quoteStatus: 'AWAITING_APPROVAL',
      quoteRow: { created_by_user_id: 'u-sub', assigned_to_user_id: 'u-sub', next_approver: null },
    });
    const r = await returnToUnderwriter({ quoteId: 'q1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', reason: 'redo' });
    expect(r.nextStatus).toBe('DRAFT');
  });

  it('an eligible approver may return a DISPUTE_PENDING treaty (no regression for disputed items)', async () => {
    poolMock.query = mockDb({
      contractStatus: 'DISPUTE_PENDING',
      offer: offer({ status: 'DISPUTE_PENDING', approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    const r = await returnToUnderwriter({ contractId: 'c1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU', reason: 'rethink' });
    expect(r.nextStatus).toBe('DRAFT');
  });
});

describe('recallOffer (RECALL) — submitter only, while still pending', () => {
  it('the submitter recalls a pending treaty', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ status: 'AWAITING_APPROVAL' }), submitter: submitter(), candidates: [],
    });
    const r = await recallOffer({ contractId: 'c1', actorUserId: 'u-sub', actorName: 'Sub', actorRole: 'UW', reason: 'oops' });
    expect(r.nextStatus).toBe('DRAFT');
  });

  it('403s a non-submitter (even an approver) trying to recall', async () => {
    poolMock.query = mockDb({
      contractStatus: 'AWAITING_APPROVAL',
      offer: offer({ status: 'AWAITING_APPROVAL', approver_options: [{ user_id: 'u-cu', role_code: 'CU' }] }),
      submitter: submitter(), candidates: [cand('u-cu', 'CU', 2, null)],
    });
    await expectStatus(recallOffer({ contractId: 'c1', actorUserId: 'u-cu', actorRole: 'CU', reason: 'x' }), 403, 'RECALL_FORBIDDEN');
  });

  it('422s a recall once the item is no longer pending (DRAFT is not a recallable prior state)', async () => {
    poolMock.query = mockDb({ contractStatus: 'DRAFT', offer: offer({ status: 'DRAFT' }), submitter: submitter() });
    await expectStatus(recallOffer({ contractId: 'c1', actorUserId: 'u-sub', actorRole: 'UW' }), 422, 'INVALID_TRANSITION');
  });

  it('the submitter recalls a DISPUTE_PENDING treaty (an unresolved split is still recallable)', async () => {
    poolMock.query = mockDb({
      contractStatus: 'DISPUTE_PENDING',
      offer: offer({ status: 'DISPUTE_PENDING' }), submitter: submitter(), candidates: [],
    });
    const r = await recallOffer({ contractId: 'c1', actorUserId: 'u-sub', actorName: 'Sub', actorRole: 'UW', reason: 'oops' });
    expect(r.nextStatus).toBe('DRAFT');
  });

  it('the submitter recalls a pending quote', async () => {
    poolMock.query = mockDb({
      quoteStatus: 'AWAITING_APPROVAL',
      quoteRow: { created_by_user_id: 'u-sub', assigned_to_user_id: 'u-sub', next_approver: null },
    });
    const r = await recallOffer({ quoteId: 'q1', actorUserId: 'u-sub', actorName: 'Sub', actorRole: 'UW', reason: 'oops' });
    expect(r.nextStatus).toBe('DRAFT');
  });
});

describe('approveQuote (quotes mark-approved path)', () => {
  const quoteRow = (over = {}) => ({ created_by_user_id: 'u-sub', next_approver: null, ...over });

  it('rejects the submitter approving their own quote (four-eyes)', async () => {
    poolMock.query = mockDb({ quoteRow: quoteRow(), quoteStatus: 'AWAITING_APPROVAL' });
    await expectStatus(approveQuote({ quoteId: 'q1', actorUserId: 'u-sub', actorRole: 'CU' }), 403);
  });
  it('rejects an approver without authority who is not the nominee', async () => {
    poolMock.query = mockDb({ quoteRow: quoteRow(), quoteStatus: 'AWAITING_APPROVAL' });
    await expectStatus(approveQuote({ quoteId: 'q1', actorUserId: 'u-junior', actorRole: 'TUW' }), 403);
  });
  it('404s a missing quote', async () => {
    poolMock.query = mockDb({ quoteRow: null });
    await expectStatus(approveQuote({ quoteId: 'q1', actorUserId: 'u-cu', actorRole: 'CU' }), 404, 'QUOTE_NOT_FOUND');
  });
  it('422s an illegal approve (quote not awaiting approval)', async () => {
    poolMock.query = mockDb({ quoteRow: quoteRow(), quoteStatus: 'DRAFT' });
    await expectStatus(approveQuote({ quoteId: 'q1', actorUserId: 'u-cu', actorRole: 'CU' }), 422);
  });
  it('an eligible approver approves an AWAITING_APPROVAL quote', async () => {
    poolMock.query = mockDb({ quoteRow: quoteRow(), quoteStatus: 'AWAITING_APPROVAL' });
    const r = await approveQuote({ quoteId: 'q1', actorUserId: 'u-cu', actorName: 'CU', actorRole: 'CU' });
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
  });
  it('allows the nominated approver even without a senior role', async () => {
    poolMock.query = mockDb({ quoteRow: quoteRow({ next_approver: 'u-nom' }), quoteStatus: 'AWAITING_APPROVAL' });
    const r = await approveQuote({ quoteId: 'q1', actorUserId: 'u-nom', actorName: 'Nom', actorRole: 'TUW' });
    expect(r.nextStatus).toBe('AWAITING_SIGNED_LINE');
  });
});
