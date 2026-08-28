// Unit tests for the written-line-exposure mandate + breach-driven routing
// logic in approvals.js. All DB-free: detectBreach/getEligibleApprovers/
// planSubmission are exercised with resolved submitter objects and an injected
// `candidates` roster, so nothing touches the pool.
import { describe, it, expect } from 'vitest';
import {
  computeWrittenExposure,
  detectBreach,
  getEligibleApprovers,
  planSubmission,
  normalRoute,
  isCaptureSubmission,
  LIMIT_BASIS,
  resolveLimitBasis,
} from './approvals.js';

const M = 1_000_000;
const PROP = 'cob-property';
const AGRI = 'cob-agriculture';

// The six-title roster (limits per the acceptance scenarios). UW and UM both
// exclude Agriculture; CU/CA/CE carry no class exclusions; CE is unlimited.
const UW = { user_id: 'u-uw', role_code: 'UW', role_name: 'Underwriter',          hierarchy_level: 4, effective_limit_usd: 25 * M,  excluded_cob_ids: [AGRI], can_approve: true, limit_basis: LIMIT_BASIS.SIGNED_EXPOSURE };
const UM = { user_id: 'u-um', role_code: 'UM', role_name: 'Underwriting Manager', hierarchy_level: 3, effective_limit_usd: 50 * M,  excluded_cob_ids: [AGRI], can_approve: true };
const CU = { user_id: 'u-cu', role_code: 'CU', role_name: 'Chief Underwriter',    hierarchy_level: 2, effective_limit_usd: 100 * M, excluded_cob_ids: [],     can_approve: true };
const CA = { user_id: 'u-ca', role_code: 'CA', role_name: 'Chief Actuary',        hierarchy_level: 2, effective_limit_usd: 100 * M, excluded_cob_ids: [],     can_approve: true };
const CE = { user_id: 'u-ce', role_code: 'CE', role_name: 'Chief Executive',      hierarchy_level: 1, effective_limit_usd: null,    excluded_cob_ids: [],     can_approve: true };
const AN = { user_id: 'u-an', role_code: 'AN', role_name: 'Analyst',              hierarchy_level: 6, effective_limit_usd: 0,        excluded_cob_ids: [],     can_approve: false };

const CANDIDATES = [UW, UM, CU, CA, CE];
const codes = (list) => list.map((c) => c.role_code);

// programme being placed: USD 100M at 100%, so writtenLinePct maps 1:1 to $M.
const PROG = 100 * M;

describe('computeWrittenExposure', () => {
  it('defaults to SIGNED_EXPOSURE = (writtenLinePct/100) * programLimit100Usd', () => {
    expect(computeWrittenExposure({ writtenLinePct: 25, programLimit100Usd: 80 * M })).toBe(20 * M);
  });
  it('EXPOSURE_100PCT ignores the written line and gates on the full 100% limit', () => {
    expect(computeWrittenExposure({ writtenLinePct: 10, programLimit100Usd: 80 * M, limitBasis: LIMIT_BASIS.EXPOSURE_100PCT })).toBe(80 * M);
  });
  it('EPI gates on supplied premium income', () => {
    expect(computeWrittenExposure({ writtenLinePct: 25, programLimit100Usd: 80 * M, limitBasis: LIMIT_BASIS.EPI, epiUsd: 6 * M })).toBe(6 * M);
  });
  it('returns 0 on missing/non-numeric inputs', () => {
    expect(computeWrittenExposure({})).toBe(0);
    expect(computeWrittenExposure({ writtenLinePct: 'x', programLimit100Usd: 'y' })).toBe(0);
  });
});

describe('detectBreach (written-line exposure vs mandate)', () => {
  it('within mandate: 20M exposure on an in-scope COB → NONE', async () => {
    const b = await detectBreach(UW, { writtenLinePct: 20, programLimit100Usd: PROG, cobIds: [PROP] });
    expect(b.type).toBe('NONE');
    expect(b.writtenExposureUsd).toBe(20 * M);
  });
  it('LIMIT breach: 30M exposure exceeds the UW 25M authority', async () => {
    const b = await detectBreach(UW, { writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP] });
    expect(b.type).toBe('LIMIT');
    expect(b.writtenExposureUsd).toBe(30 * M);
  });
  it('CLASS breach: Agriculture is excluded for the UW, at any exposure', async () => {
    const b = await detectBreach(UW, { writtenLinePct: 5, programLimit100Usd: PROG, cobIds: [AGRI] });
    expect(b.type).toBe('CLASS');
  });
  it('BOTH when the line breaches the limit AND the COB is excluded', async () => {
    const b = await detectBreach(UW, { writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [AGRI] });
    expect(b.type).toBe('BOTH');
  });
  it('null effective_limit_usd is unlimited — never a LIMIT breach', async () => {
    const b = await detectBreach(CE, { writtenLinePct: 100, programLimit100Usd: 9_999 * M, cobIds: [PROP] });
    expect(b.limitBreach).toBe(false);
    expect(b.type).toBe('NONE');
  });
});

describe('getEligibleApprovers (nearest-sufficient, including-COB, four-eyes)', () => {
  it('LIMIT breach (30M, in-scope COB) → starts at the lowest title clearing 30M: UM (50M)', async () => {
    const list = await getEligibleApprovers({ submitter: UW, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP], candidates: CANDIDATES });
    expect(codes(list)).toEqual(['UM', 'CU', 'CA', 'CE']); // ascending limit, unlimited CE last
    expect(list.map((c) => c.user_id)).not.toContain(UW.user_id); // submitter excluded
  });
  it('CLASS breach on Agriculture → UM is also Agri-excluded, so list starts at CU/CA, CE last', async () => {
    const list = await getEligibleApprovers({ submitter: UW, writtenLinePct: 5, programLimit100Usd: PROG, cobIds: [AGRI], candidates: CANDIDATES });
    expect(codes(list)).toEqual(['CU', 'CA', 'CE']);
    expect(codes(list)).not.toContain('UM');
    expect(codes(list)).not.toContain('UW');
    expect(list.at(-1).role_code).toBe('CE'); // unlimited sorts last as the fallback
  });
  it('four-eyes: the submitter never appears in their own eligible list', async () => {
    const list = await getEligibleApprovers({ submitter: CU, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP], candidates: CANDIDATES });
    expect(list.map((c) => c.user_id)).not.toContain(CU.user_id);
  });
  it('skips titles with can_approve === false', async () => {
    const list = await getEligibleApprovers({ submitter: UW, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP], candidates: [...CANDIDATES, AN] });
    expect(codes(list)).not.toContain('AN');
  });
  it('excludes titles below approval authority (hierarchy level > 4) even when can_approve is unset', async () => {
    // A legacy Treaty Underwriter (level 5) holds no approval authority per the
    // uw_role hierarchy — an unlimited mandate must not make them eligible.
    const TUW = { user_id: 'u-tuw', role_code: 'TUW', role_name: 'Treaty Underwriter', hierarchy_level: 5, effective_limit_usd: null, excluded_cob_ids: [], can_approve: true };
    const list = await getEligibleApprovers({ submitter: UW, writtenLinePct: 5, programLimit100Usd: PROG, cobIds: [PROP], candidates: [...CANDIDATES, TUW] });
    expect(codes(list)).not.toContain('TUW');
  });
});

describe('normalRoute / planSubmission routing', () => {
  it('within mandate (UW, 20M, in-scope) routes to CU normally', async () => {
    expect(normalRoute('UW')).toEqual(['CU']);
    const plan = await planSubmission({ submitter: UW, writtenLinePct: 20, programLimit100Usd: PROG, cobIds: [PROP], candidates: CANDIDATES });
    expect(plan.kind).toBe('WITHIN_MANDATE');
    expect(plan.routeRoleCodes).toEqual(['CU']);
    expect(codes(plan.approverOptions)).toEqual(['CU']);
  });
  it('LIMIT breach escalates to the nearest-sufficient eligible list', async () => {
    const plan = await planSubmission({ submitter: UW, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP], candidates: CANDIDATES });
    expect(plan.kind).toBe('ESCALATE');
    expect(plan.breach.type).toBe('LIMIT');
    expect(codes(plan.approverOptions)).toEqual(['UM', 'CU', 'CA', 'CE']);
  });
});

describe('Analyst hand-off (capture → {UW}, then UW escalates on its own line)', () => {
  it('an Analyst submission is a capture routing to {UW} — no escalation yet', async () => {
    expect(isCaptureSubmission('AN')).toBe(true);
    const plan = await planSubmission({ submitter: AN, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [AGRI], candidates: CANDIDATES });
    expect(plan.kind).toBe('CAPTURE');
    expect(plan.routeRoleCodes).toEqual(['UW']);
    expect(plan.approverOptions).toEqual([]); // breach is the UW's call, not computed here
  });
  it('the underwriter who receives the capture escalates on its OWN written line', async () => {
    // Same 30M line the analyst captured, now evaluated against the UW mandate.
    const plan = await planSubmission({ submitter: UW, writtenLinePct: 30, programLimit100Usd: PROG, cobIds: [PROP], candidates: CANDIDATES });
    expect(plan.kind).toBe('ESCALATE');
    expect(plan.approverOptions[0].role_code).toBe('UM'); // UW->escalates above its 25M cap
  });
});

describe('limit_basis routing (canonical enum, no silent default)', () => {
  const base = { user_id: 'u', effective_limit_usd: 5 * M, excluded_cob_ids: [] };

  it('SIGNED_EXPOSURE gates on the written-line share → breach', async () => {
    const b = await detectBreach({ ...base, limit_basis: LIMIT_BASIS.SIGNED_EXPOSURE },
      { writtenLinePct: 30, programLimit100Usd: 100 * M, epiUsd: 4 * M, cobIds: ['x'] });
    expect(b.writtenExposureUsd).toBe(30 * M);
    expect(b.type).toBe('LIMIT');
  });

  it('EPI gates on premium income → NO breach for the SAME inputs', async () => {
    const b = await detectBreach({ ...base, limit_basis: LIMIT_BASIS.EPI },
      { writtenLinePct: 30, programLimit100Usd: 100 * M, epiUsd: 4 * M, cobIds: ['x'] });
    expect(b.writtenExposureUsd).toBe(4 * M);
    expect(b.type).toBe('NONE');
  });

  it('EXPOSURE_100PCT gates on the full 100% limit', () => {
    expect(computeWrittenExposure({ writtenLinePct: 10, programLimit100Usd: 80 * M, limitBasis: LIMIT_BASIS.EXPOSURE_100PCT })).toBe(80 * M);
  });

  it('missing/unknown basis warns and falls back to SIGNED_EXPOSURE (not a silent guess)', async () => {
    expect(resolveLimitBasis('WEIRD')).toBe(LIMIT_BASIS.SIGNED_EXPOSURE);
    expect(resolveLimitBasis(undefined)).toBe(LIMIT_BASIS.SIGNED_EXPOSURE);
    expect(resolveLimitBasis('PREMIUM')).toBe(LIMIT_BASIS.SIGNED_EXPOSURE); // legacy value no longer canonical
    const b = await detectBreach({ ...base, limit_basis: 'WEIRD' },
      { writtenLinePct: 30, programLimit100Usd: 100 * M, epiUsd: 4 * M, cobIds: ['x'] });
    expect(b.type).toBe('LIMIT'); // fell back to signed exposure
  });

  it('SIGNED_EXPOSURE vs EPI drive DIFFERENT eligible-approver sets for the same submission', async () => {
    // Same submission (30% of a 100M programme, EPI 4M) under a 5M-authority UW.
    const submitterSE  = { ...base, role_code: 'UW', hierarchy_level: 4, limit_basis: LIMIT_BASIS.SIGNED_EXPOSURE };
    const submitterEPI = { ...base, role_code: 'UW', hierarchy_level: 4, limit_basis: LIMIT_BASIS.EPI };
    const inputs = { writtenLinePct: 30, programLimit100Usd: PROG, epiUsd: 4 * M, cobIds: [PROP], candidates: CANDIDATES };

    // SIGNED_EXPOSURE → exposure 30M: only titles clearing 30M qualify (UW's 25M is out).
    const se = await getEligibleApprovers({ submitter: submitterSE, ...inputs });
    // EPI → exposure 4M: the lower UW (25M) title now also clears the gate.
    const epi = await getEligibleApprovers({ submitter: submitterEPI, ...inputs });

    expect(codes(se)).not.toContain('UW');
    expect(codes(epi)).toContain('UW');
    expect(codes(epi)).not.toEqual(codes(se)); // basis changes who is eligible, not just whether it breaches
  });
});
