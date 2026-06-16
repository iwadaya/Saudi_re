// server/src/services/approvals.js
// Full approval workflow engine — 5-tier role hierarchy
//
// RULES:
// Within mandate:  UW picks any peer (TM+). Needs 2 approvals.
// Limit breach:    Routes up hierarchy (TUW→TM→TD→CU). Still 2 approvals.
// Class breach:    Goes to CU by default, option to escalate to CE.
// Split decision:  If neither approver is CU/CE → dispute → arbiter (TD+) required.
//                  If one IS CU/CE → their decision is FINAL immediately.
// Arbiter:         TD, CU, or CE. Decision always final.

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { logAudit } from './audit.js';
import { withTransaction as withTxn } from '../db/withTransaction.js';
import { assertLegalTransition, InvalidTransitionError } from '../lib/statusMachine.js';
import { refreshBenchmarks } from './ldf/benchmark.js';

const LEVEL = { CE:1, CU:2, CA:2, TD:3, UM:3, TM:4, TUW:5, UW:5, AN:6 };
const ROLE_NAME = { CE:'Chief Executive', CU:'Chief Underwriter', CA:'Chief Actuary', TD:'Treaty Director', UM:'Underwriting Manager', TM:'Treaty Manager', TUW:'Treaty Underwriter', UW:'Underwriter', AN:'Analyst' };
const FINAL_AUTH = new Set([1,2]); // CE, CU have override power

// ── Mandate limit basis ──────────────────────────────────────────────────────
// The gated amount is WRITTEN-LINE EXPOSURE by default: the reinsurer's
// written-line share of the 100% programme limit being placed. A title may
// override its basis (e.g. a premium-income mandate) via uw_role.limit_basis.
export const LIMIT_BASIS = Object.freeze({
  SIGNED_EXPOSURE: 'SIGNED_EXPOSURE', // (writtenLinePct/100) * programLimit100Usd  [default]
  EPI: 'EPI',                         // gated on premium income, not exposure
  EXPOSURE_100PCT: 'EXPOSURE_100PCT', // gated on the full 100% limit regardless of line
});

const CANONICAL_BASES = new Set(Object.values(LIMIT_BASIS));

/**
 * Canonical limit basis for a mandate. On a missing/unknown value, warn and
 * fall back to the EXPLICIT seeded default (SIGNED_EXPOSURE) — never a silent
 * guess. (Migration 121 canonicalizes the enum and exposes limit_basis on
 * v_user_mandate; this guards against rows/views that predate it.)
 */
export function resolveLimitBasis(raw) {
  if (raw && CANONICAL_BASES.has(raw)) return raw;
  logger.warn('limit_basis missing/unknown — falling back to SIGNED_EXPOSURE', { value: raw ?? null });
  return LIMIT_BASIS.SIGNED_EXPOSURE;
}

// ── Normal routing legs (mirrors migration 118 approval_route seed) ──────────
// Used as the in-memory default when no DB-backed route is supplied. AN is a
// capture that always hands to the Underwriter first; the Underwriter then
// escalates on its own written line.
export const DEFAULT_APPROVAL_ROUTE = Object.freeze({
  AN: ['UW'],
  UW: ['CU'],
  UM: ['CU'],
  CU: ['CA', 'CE'],
  CA: ['CU', 'CE'],
  CE: [],
});

const CAPTURE_ROLES = new Set(['AN']);

/** An Analyst submission is a capture: it routes to the Underwriter, who owns
 *  the escalation decision on submit-to-bind. */
export function isCaptureSubmission(roleCode) {
  return CAPTURE_ROLES.has(String(roleCode || '').toUpperCase());
}

/** The normal next-leg approver role codes for an originator (no breach). */
export function normalRoute(roleCode, routes = DEFAULT_APPROVAL_ROUTE) {
  return routes[String(roleCode || '').toUpperCase()] || [];
}

/**
 * The gated USD amount for a submission. Default basis SIGNED_EXPOSURE caps the
 * reinsurer's written-line share of the 100% limit; EPI / EXPOSURE_100PCT honor
 * a title-level override.
 *
 * @param {{ writtenLinePct?: number, programLimit100Usd?: number,
 *           limitBasis?: string, epiUsd?: number|null }} args
 * @returns {number} exposure USD (0 when inputs are missing/non-numeric)
 */
export function computeWrittenExposure({ writtenLinePct, programLimit100Usd, limitBasis = LIMIT_BASIS.SIGNED_EXPOSURE, epiUsd = null } = {}) {
  const pct  = Number(writtenLinePct);
  const base = Number(programLimit100Usd);
  const signed = (Number.isFinite(pct) && Number.isFinite(base)) ? (pct / 100) * base : 0;
  switch (limitBasis) {
    case LIMIT_BASIS.EPI:
      return epiUsd != null && Number.isFinite(Number(epiUsd)) ? Number(epiUsd) : signed;
    case LIMIT_BASIS.EXPOSURE_100PCT:
      return Number.isFinite(base) ? base : 0;
    case LIMIT_BASIS.SIGNED_EXPOSURE:
    default:
      return signed;
  }
}

/** Coerce a mandate's excluded-COB list, tolerating the legacy
 *  user_mandate.restricted_cob_ids column name. */
function excludedCobs(mandate) {
  if (Array.isArray(mandate?.excluded_cob_ids)) return mandate.excluded_cob_ids;
  if (Array.isArray(mandate?.restricted_cob_ids)) return mandate.restricted_cob_ids;
  return [];
}

const DEMO_USER_MANDATES = {
  '00000000-0000-0000-0000-000000000001': { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo',         display_name:'Chief Underwriting Officer', role_code:'CU', role_name:'Chief Underwriter',   hierarchy_level:2, authority_limit_usd:null,     treaty_type_scope:'BOTH', is_active:true },
  '00000000-0000-0000-0000-000000000002': { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', display_name:'Treaty Underwriter',         role_code:'TUW',role_name:'Treaty Underwriter',  hierarchy_level:5, authority_limit_usd:10000000, treaty_type_scope:'BOTH', is_active:true },
  '00000000-0000-0000-0000-000000000003': { user_id:'00000000-0000-0000-0000-000000000003', username:'ce',          display_name:'Chief Executive',             role_code:'CE', role_name:'Chief Executive',      hierarchy_level:1, authority_limit_usd:null,     treaty_type_scope:'BOTH', is_active:true },
  '00000000-0000-0000-0000-000000000004': { user_id:'00000000-0000-0000-0000-000000000004', username:'td',          display_name:'Treaty Director',             role_code:'TD', role_name:'Treaty Director',      hierarchy_level:3, authority_limit_usd:null,     treaty_type_scope:'BOTH', is_active:true },
  '00000000-0000-0000-0000-000000000005': { user_id:'00000000-0000-0000-0000-000000000005', username:'tm',          display_name:'Treaty Manager',              role_code:'TM', role_name:'Treaty Manager',       hierarchy_level:4, authority_limit_usd:5000000,  treaty_type_scope:'BOTH', is_active:true },
};

export async function getUserMandate(userId) {
  // Try v_user_mandate view first
  try {
    const { rows } = await pool.query(`SELECT * FROM public.v_user_mandate WHERE user_id=$1 LIMIT 1`,[userId]);
    if (rows[0]) return rows[0];
  } catch {}
  // Fall back to uw_user + uw_role join
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.username, u.display_name, u.email, u.office, u.is_active,
              r.role_code, r.role_name, r.hierarchy_level,
              r.authority_limit_usd AS effective_limit_usd,
              r.authority_limit_usd, 'BOTH' AS treaty_type_scope
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id = u.role_id
       WHERE u.user_id = $1 AND u.is_active = true LIMIT 1`, [userId]
    );
    if (rows[0]) return rows[0];
  } catch {}
  // Final fallback: demo user map (for environments where uw_user is not yet seeded)
  return DEMO_USER_MANDATES[String(userId)] || null;
}

/**
 * Sort comparator: NEAREST-SUFFICIENT first.
 * Ascending effective_limit_usd with null (unlimited) last; tie-break ascending
 * hierarchy_level. So the picker surfaces the lowest title that clears the gate,
 * then higher fallbacks, with the unlimited CE as the last resort.
 */
function nearestSufficient(a, b) {
  const la = a.effective_limit_usd, lb = b.effective_limit_usd;
  const aUnlimited = la == null, bUnlimited = lb == null;
  if (aUnlimited && bUnlimited) return (a.hierarchy_level || 0) - (b.hierarchy_level || 0);
  if (aUnlimited) return 1;   // unlimited sorts last
  if (bUnlimited) return -1;
  if (Number(la) !== Number(lb)) return Number(la) - Number(lb);
  return (a.hierarchy_level || 0) - (b.hierarchy_level || 0);
}

/**
 * Eligible approvers for a (possibly breaching) submission.
 *
 * On ANY breach (or when called for normal escalation), returns the titles
 * where ALL of the following hold, ordered nearest-sufficient:
 *   • effective_limit_usd >= writtenExposureUsd   (null/unlimited always qualifies)
 *   • none of cobIds appear in that title's excluded_cob_ids   ("including cob")
 *   • can_approve === true
 *   • user_id !== submitter                       (four-eyes)
 *
 * @param {{
 *   submitter?: object, submitterUserId?: string,
 *   cobIds?: Array<string>,
 *   writtenLinePct?: number, programLimit100Usd?: number, writtenExposureUsd?: number,
 *   epiUsd?: number, candidates?: Array<object>,
 * }} params  `candidates` may be injected (unit tests / pre-fetched); otherwise
 *            they are loaded from the DB. Legacy callers pass
 *            `{ submitterUserId, breachType, epiUsd }` and still get a list.
 */
export async function getEligibleApprovers(params = {}) {
  const {
    submitter, submitterUserId, cobIds = [], candidates,
    writtenLinePct, programLimit100Usd, writtenExposureUsd: weIn, epiUsd,
  } = params;

  const submitterId = (submitter && submitter.user_id) || submitterUserId || null;
  const limitBasis = resolveLimitBasis(submitter && submitter.limit_basis);

  let writtenExposureUsd = weIn;
  if (writtenExposureUsd == null) {
    writtenExposureUsd = (writtenLinePct != null || programLimit100Usd != null)
      ? computeWrittenExposure({ writtenLinePct, programLimit100Usd, limitBasis, epiUsd })
      : (Number(epiUsd) || 0);
  }

  const candidatePool = Array.isArray(candidates) ? candidates : await fetchApproverCandidates();
  const cobSet = new Set((cobIds || []).map(String));

  const eligible = candidatePool.filter((c) => {
    if (c.can_approve === false) return false;                                  // can_approve gate
    if (submitterId && String(c.user_id) === String(submitterId)) return false; // four-eyes
    const lim = c.effective_limit_usd;
    if (lim != null && Number(lim) < Number(writtenExposureUsd)) return false;   // limit gate (null = unlimited)
    const excl = excludedCobs(c);
    if (excl.some((x) => cobSet.has(String(x)))) return false;                    // "including cob" gate
    return true;
  });

  eligible.sort(nearestSufficient);
  return eligible;
}

/**
 * Load the pool of possible approver titles from the DB and map them to the
 * candidate shape getEligibleApprovers expects. Best-effort: returns the demo
 * roster when the DB is unavailable so the picker is never empty in dev.
 */
export async function fetchApproverCandidates() {
  const mapRow = (r) => ({
    user_id: r.user_id,
    display_name: r.display_name,
    email: r.email,
    office: r.office,
    role_code: r.role_code,
    role_name: r.role_name,
    hierarchy_level: r.hierarchy_level,
    effective_limit_usd: r.effective_limit_usd ?? null,
    excluded_cob_ids: Array.isArray(r.restricted_cob_ids) ? r.restricted_cob_ids
      : (Array.isArray(r.excluded_cob_ids) ? r.excluded_cob_ids : []),
    can_approve: r.can_approve ?? true,
  });

  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.display_name, u.email, u.office,
              r.role_code, r.role_name, r.hierarchy_level,
              m.effective_limit_usd, m.restricted_cob_ids
       FROM public.v_user_mandate m
       JOIN public.uw_user u ON u.user_id=m.user_id
       JOIN public.uw_role r ON r.role_code=m.role_code
       WHERE u.is_active=true`
    );
    if (rows.length) return rows.map(mapRow);
  } catch (e) {
    logger.warn('fetchApproverCandidates via v_user_mandate failed, falling back', { error: e.message });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.display_name, u.email, u.office,
              r.role_code, r.role_name, r.hierarchy_level,
              r.authority_limit_usd AS effective_limit_usd
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id=u.role_id
       WHERE u.is_active=true`
    );
    if (rows.length) return rows.map(mapRow);
  } catch (e) {
    logger.warn('fetchApproverCandidates fallback failed', { error: e.message });
  }
  // Demo roster — used only when uw_user is not yet seeded.
  return [
    { user_id: '00000000-0000-0000-0000-000000000003', display_name: 'Chief Executive',            email: 'ce@universe3.app',  office: 'Riyadh', role_code: 'CE', role_name: 'Chief Executive',    hierarchy_level: 1, effective_limit_usd: null,     excluded_cob_ids: [], can_approve: true },
    { user_id: '00000000-0000-0000-0000-000000000001', display_name: 'Chief Underwriting Officer', email: 'cuo@universe3.app', office: 'Riyadh', role_code: 'CU', role_name: 'Chief Underwriter',  hierarchy_level: 2, effective_limit_usd: null,     excluded_cob_ids: [], can_approve: true },
    { user_id: '00000000-0000-0000-0000-000000000004', display_name: 'Treaty Director',            email: 'td@universe3.app',  office: 'Riyadh', role_code: 'TD', role_name: 'Treaty Director',    hierarchy_level: 3, effective_limit_usd: 50000000, excluded_cob_ids: [], can_approve: true },
    { user_id: '00000000-0000-0000-0000-000000000005', display_name: 'Treaty Manager',             email: 'tm@universe3.app',  office: 'Riyadh', role_code: 'TM', role_name: 'Treaty Manager',     hierarchy_level: 4, effective_limit_usd: 25000000, excluded_cob_ids: [], can_approve: true },
  ];
}

/**
 * Detect whether a submission breaches the submitter's own mandate.
 *
 *   • LIMIT  — written-line exposure (computeWrittenExposure) exceeds the
 *              submitter's effective_limit_usd (null = unlimited).
 *   • CLASS  — any cobId appears in the submitter's excluded_cob_ids
 *              (or an NP submission under a PROP_ONLY mandate).
 *
 * The written line must NOT breach the mandate; if it does, the breach drives
 * escalation (getEligibleApprovers).
 *
 * @param {object|string} submitter  Resolved mandate object (preferred) or a
 *                                    user_id string (resolved via getUserMandate).
 * @param {{ writtenLinePct?: number, programLimit100Usd?: number,
 *           cobIds?: Array<string>, isNp?: boolean, epiUsd?: number }} opts
 * @returns {{ type:'NONE'|'LIMIT'|'CLASS'|'BOTH', reasons:string[],
 *             writtenExposureUsd:number, limitBreach:boolean, classBreach:boolean }}
 */
export async function detectBreach(submitter, opts = {}) {
  // Back-compat: a user_id string resolves to its mandate.
  const mandate = typeof submitter === 'string' ? await getUserMandate(submitter) : submitter;
  if (!mandate) return { type: 'NONE', reasons: [], writtenExposureUsd: 0, limitBreach: false, classBreach: false };

  const { writtenLinePct, programLimit100Usd, cobIds = [], isNp = false, epiUsd } = opts;
  const limitBasis = resolveLimitBasis(mandate.limit_basis);
  const writtenExposureUsd = (writtenLinePct != null || programLimit100Usd != null)
    ? computeWrittenExposure({ writtenLinePct, programLimit100Usd, limitBasis, epiUsd })
    : (Number(epiUsd) || 0); // legacy callers supply epiUsd directly

  const reasons = [];
  let limitBreach = false, classBreach = false;

  const limit = mandate.effective_limit_usd;
  if (limit != null && writtenExposureUsd > Number(limit)) {
    limitBreach = true;
    reasons.push(`Written-line exposure USD${(writtenExposureUsd / 1e6).toFixed(1)}M exceeds your authority USD${(Number(limit) / 1e6).toFixed(1)}M`);
  }

  const excludedSet = new Set(excludedCobs(mandate).map(String));
  for (const cob of (cobIds || [])) {
    if (excludedSet.has(String(cob))) { classBreach = true; reasons.push(`Class "${cob}" is excluded from your mandate`); }
  }
  if (isNp && mandate.treaty_type_scope === 'PROP_ONLY') { classBreach = true; reasons.push('Your mandate covers proportional treaties only'); }

  const type = limitBreach && classBreach ? 'BOTH' : limitBreach ? 'LIMIT' : classBreach ? 'CLASS' : 'NONE';
  return { type, reasons, writtenExposureUsd, limitBreach, classBreach };
}

export function getRequiredApproverRole(submitterLevel, breachType) {
  if (breachType==='CLASS'||breachType==='BOTH') return 'CU';
  if (breachType==='LIMIT') {
    if (submitterLevel>=5) return 'TM';
    if (submitterLevel>=4) return 'TD';
    if (submitterLevel>=3) return 'CU';
    return 'CE';
  }
  return 'TM';
}

export async function getArbiterOptions(_contractId, _quoteId) {
  // TD, CU, CE can arbitrate
  const { rows } = await pool.query(
    `SELECT u.user_id,u.display_name,r.role_code,r.role_name,r.hierarchy_level
     FROM public.uw_user u JOIN public.uw_role r ON r.role_id=u.role_id
     WHERE u.is_active=true AND r.hierarchy_level<=3
     ORDER BY r.hierarchy_level,u.display_name`
  );
  return rows;
}

/**
 * Decide how a submission routes. Pure given `submitter` (+ optional injected
 * `candidates`/`routes`) — exercised directly by the unit tests and reused by
 * submitForApproval. Three outcomes:
 *   • CAPTURE        — Analyst: hands to {UW}; no breach/escalation yet.
 *   • WITHIN_MANDATE — no breach: normal next leg (e.g. UW→CU).
 *   • ESCALATE       — any breach: nearest-sufficient eligible titles.
 *
 * @returns {Promise<{ kind:string, breach:object, writtenExposureUsd:number,
 *                     routeRoleCodes:string[]|null, approverOptions:object[] }>}
 */
export async function planSubmission({
  submitter, submittedByRole,
  writtenLinePct, programLimit100Usd, epiUsd,
  cobIds = [], isNp = false,
  candidates, routes = DEFAULT_APPROVAL_ROUTE,
}) {
  const roleCode = (submitter && submitter.role_code) || submittedByRole;

  if (isCaptureSubmission(roleCode)) {
    return { kind: 'CAPTURE', breach: { type: 'NONE', reasons: [] }, writtenExposureUsd: 0, routeRoleCodes: normalRoute('AN', routes), approverOptions: [] };
  }

  const breach = await detectBreach(submitter, { writtenLinePct, programLimit100Usd, cobIds, isNp, epiUsd });
  const { writtenExposureUsd } = breach;

  if (breach.type === 'NONE') {
    const routeRoleCodes = normalRoute(roleCode, routes);
    const all = await getEligibleApprovers({ submitter, writtenExposureUsd, cobIds, candidates });
    const routeSet = new Set(routeRoleCodes.map(String));
    return { kind: 'WITHIN_MANDATE', breach, writtenExposureUsd, routeRoleCodes, approverOptions: all.filter((c) => routeSet.has(String(c.role_code))) };
  }

  const approverOptions = await getEligibleApprovers({ submitter, writtenExposureUsd, cobIds, candidates });
  return { kind: 'ESCALATE', breach, writtenExposureUsd, routeRoleCodes: null, approverOptions };
}

export async function submitForApproval({ contractId, quoteId, submittedByUserId, submittedByName, submittedByRole, epiUsd, cobIds, isNp, peer1UserId, breachType, writtenLinePct, programLimit100Usd, comment }) {
  const submitter=await getUserMandate(submittedByUserId);

  // Plan the route: capture (Analyst→UW), within-mandate, or breach-escalation.
  // Best-effort — a planning failure must not block the submit.
  let plan=null;
  try {
    plan=await planSubmission({ submitter, submittedByRole, writtenLinePct, programLimit100Usd, epiUsd, cobIds, isNp });
  } catch (e) { logger.warn('planSubmission failed, falling back to legacy routing', { error: e.message }); }

  const resolvedBreachType=breachType || plan?.breach?.type || 'NONE';
  const submitterLevel=submitter?.hierarchy_level||5;
  // Analyst capture hands to the Underwriter; everyone else uses the breach-tier role.
  const requiredRole=plan?.kind==='CAPTURE' ? 'UW' : getRequiredApproverRole(submitterLevel,resolvedBreachType);
  const approverOptions=Array.isArray(plan?.approverOptions)?plan.approverOptions:[];

  if (peer1UserId) {
    // getUserMandate now has fallbacks — only hard-fail if truly unknown
    const peer1 = await getUserMandate(peer1UserId);
    if (!peer1) throw Object.assign(new Error('Approver not found — user does not exist in the system'), {status:400});
    const peer1Level = LEVEL[peer1.role_code] || 5;
    if (peer1Level > (LEVEL[requiredRole] || 5))
      throw Object.assign(new Error(`Requires ${ROLE_NAME[requiredRole]||requiredRole} or above`), {status:400});
    if (peer1UserId === submittedByUserId)
      throw Object.assign(new Error('Cannot approve own submission'), {status:403});
  }

  // Upsert offer — approver_options carries the ordered nearest-sufficient list.
  // peer1_user_id is left NULL on purpose: it is the RECORD of who actually
  // claimed peer1, written atomically at decision time by recordDecision. The
  // submitter's nominated approver is kept as next_approver_id (advisory), so
  // any eligible approver — not just the nominee — can take the open slot.
  const offerId = await withTxn(async (client) => {
    const res = await client.query(
      `INSERT INTO public.contract_offer (contract_id,quote_id,status,breach_type,approval_step,submitted_by_id,submitted_at,written_line_pct,epi_usd,next_approver_id,next_approver_role,peer1_user_id,approver_options)
       VALUES ($1,$2,'AWAITING_APPROVAL',$3,1,$4,now(),$5,$6,$7,$8,NULL,$9)
       ON CONFLICT (contract_id) DO UPDATE SET
         status='AWAITING_APPROVAL',breach_type=$3,approval_step=1,submitted_by_id=$4,submitted_at=now(),
         written_line_pct=$5,epi_usd=$6,next_approver_id=$7,next_approver_role=$8,peer1_user_id=NULL,approver_options=$9,
         peer1_decision=NULL,peer1_comment=NULL,peer1_at=NULL,peer2_user_id=NULL,peer2_decision=NULL,
         peer2_at=NULL,arbiter_required=false,arbiter_user_id=NULL,arbiter_decision=NULL,updated_at=now()
       RETURNING offer_id`,
      [contractId||null,quoteId||null,resolvedBreachType,submittedByUserId,writtenLinePct||null,
       epiUsd||null,peer1UserId||null,requiredRole,JSON.stringify(approverOptions)]
    );
    if (contractId) await client.query(`UPDATE public.contract SET uw_status='AWAITING_APPROVAL',status='AWAITING_APPROVAL',updated_at=now() WHERE contract_id=$1`,[contractId]);
    await logOfferEvent({contractId,quoteId,eventType:'SUBMITTED',actorUserId:submittedByUserId,actorName:submittedByName,actorRole:submittedByRole,payload:{breachType:resolvedBreachType,requiredRole,epiUsd,peer1UserId},comment,client});
    return res.rows[0]?.offer_id;
  });
  return { offerId, breachType:resolvedBreachType, requiredRole, requiredRoleName:ROLE_NAME[requiredRole]||requiredRole };
}

// ── Decision chokepoint ──────────────────────────────────────────────────────
// EVERY approval write (peer1, peer2, arbiter) funnels through recordDecision.
// Storing approver_options at submit time is NOT enough — eligibility is
// re-derived from LIVE data here, at decision time, and the slot is claimed with
// a conditional UPDATE so two racing approvers can never both win.

const httpError = (status, message, code) =>
  Object.assign(new Error(message), code ? { status, code } : { status });

// ── Workflow-transition gate ─────────────────────────────────────────────────
// A privileged state (APPROVED / AWAITING_SIGNED_LINE / SIGNED / BOUND) may be
// reached ONLY through assertWorkflowTransition. The module-private ENGINE_TOKEN
// is the "decision record": only this module (recordDecision and the approval
// entrypoints below) can hand it to assertWorkflowTransition, so a route can
// never flip an item to approved/bound without first clearing the engine's
// eligibility checks. The token is never exported — external code cannot forge it.
const ENGINE_TOKEN = Symbol('approval-engine-decision');
const GUARDED_TARGETS = new Set(['APPROVED', 'AWAITING_SIGNED_LINE', 'SIGNED', 'BOUND']);
const APPROVE_TARGETS = new Set(['APPROVED', 'AWAITING_SIGNED_LINE']); // need an engine token

// ── Terminal workflow actions ────────────────────────────────────────────────
// SIGN / NTU / RETURN / RECALL each funnel through assertWorkflowTransition with
// an `action`. Each action fixes its target state AND the set of legal prior
// states (its own mini status-machine) AND selects a per-action authority rule
// (authorizeTerminalAction). No terminal state change may bypass this — the
// routes used to be exempted from the guard entirely; now each one carries its
// OWN explicit authorization. The actor is ALWAYS the verified req.user.userId,
// never a body/param/header value.
//
// The prior-state sets live here rather than in the canonical statusMachine
// because RETURN/RECALL also accept DISPUTE_PENDING — a transient offer state
// the lifecycle graph deliberately omits. An unresolved split is still "pending
// with" the approvers (returnable) and not yet bound (recallable by the UW).
const TERMINAL_ACTIONS = Object.freeze({
  SIGN:   { to: 'SIGNED', from: ['AWAITING_SIGNED_LINE'] },
  NTU:    { to: 'NTU',    from: ['AWAITING_SIGNED_LINE'] },
  RETURN: { to: 'DRAFT',  from: ['AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'DISPUTE_PENDING'] },
  RECALL: { to: 'DRAFT',  from: ['AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'DISPUTE_PENDING'] },
});

/** Live workflow status for a contract (uw_status) or quote (status). */
async function loadEntityStatus(entityType, entityId) {
  const et = String(entityType || '').toUpperCase();
  if (et === 'CONTRACT') {
    const { rows } = await pool.query(`SELECT uw_status AS status FROM public.contract WHERE contract_id=$1`, [entityId]);
    return rows[0] ? rows[0].status : null;
  }
  if (et === 'QUOTE') {
    const { rows } = await pool.query(`SELECT status FROM public.quote WHERE quote_id=$1`, [entityId]);
    return rows[0] ? rows[0].status : null;
  }
  throw httpError(400, `Unknown entityType: ${entityType}`);
}

/**
 * The ONLY sanctioned gate into a privileged workflow state. It:
 *   • loads the live current state (404 if the entity is gone),
 *   • rejects illegal jumps via the uw_status machine (422 INVALID_TRANSITION) —
 *     so DRAFT → SIGNED / DRAFT → AWAITING_SIGNED_LINE etc. are blocked,
 *   • for an APPROVE move requires the module-private ENGINE_TOKEN as proof the
 *     decision came from recordDecision (or an approval-service entrypoint that
 *     already enforced eligibility) — without it, 403 NOT_FROM_ENGINE.
 * Verify-only: it never writes. The caller performs the write immediately after.
 *
 * When `action` (SIGN/NTU/RETURN/RECALL) is supplied it fixes the target state
 * and additionally enforces that action's authority rule against the LIVE
 * offer/owner/submitter (authorizeTerminalAction) — a 403 when the verified
 * actor lacks authority. State legality is checked BEFORE authority so an
 * illegal jump is a clean 422 regardless of who the actor is.
 *
 * @param {{ entityType:'CONTRACT'|'QUOTE', entityId:string, from?:string,
 *           to?:string, actorUserId?:string, actorRole?:string,
 *           decision?:symbol, action?:'SIGN'|'NTU'|'RETURN'|'RECALL' }} args
 */
export async function assertWorkflowTransition({ entityType, entityId, from, to, actorUserId, actorRole, decision, action } = {}) {
  const et = String(entityType || '').toUpperCase();
  const act = action ? String(action).toUpperCase() : null;
  const cfg = act ? TERMINAL_ACTIONS[act] : null;
  if (act && !cfg) throw httpError(400, `Unknown workflow action: ${action}`);
  const target = String(cfg ? cfg.to : (to || '')).toUpperCase();
  // Outside a recognised terminal action, this gate only guards the privileged
  // approve/sign targets (callers wanting a pure state check).
  if (!cfg && !GUARDED_TARGETS.has(target)) {
    throw httpError(400, `assertWorkflowTransition only guards ${[...GUARDED_TARGETS].join('/')} (got ${to})`);
  }
  const current = await loadEntityStatus(et, entityId);
  if (current == null) throw httpError(404, `${et === 'QUOTE' ? 'Quote' : 'Contract'} not found`, `${et}_NOT_FOUND`);
  const fromState = from != null ? String(from).toUpperCase() : String(current).toUpperCase();
  if (fromState !== String(current).toUpperCase()) {
    throw httpError(409, 'Workflow state changed since read — re-fetch and retry', 'STATE_CHANGED');
  }
  // Legal-edge check. Terminal actions use their own explicit prior-state set;
  // everything else uses the canonical uw_status machine. Either way an illegal
  // jump is a 422 INVALID_TRANSITION (with { from, to }) BEFORE any authority check.
  if (cfg) {
    if (!cfg.from.includes(String(current).toUpperCase())) throw new InvalidTransitionError(current, target);
  } else {
    assertLegalTransition(current, target);
  }
  // Provenance: an approve move must originate from the decision engine.
  if (APPROVE_TARGETS.has(target) && decision !== ENGINE_TOKEN) {
    throw httpError(403, 'Approval must be recorded through the decision engine', 'NOT_FROM_ENGINE');
  }
  // Per-action authority for the terminal transitions (SIGN/NTU/RETURN/RECALL).
  if (cfg) {
    await authorizeTerminalAction({ action: act, entityType: et, entityId, actorUserId, actorRole });
  }
  return { entityType: et, entityId, from: current, to: target, actorUserId: actorUserId ?? null };
}

// ── Terminal-action authority ────────────────────────────────────────────────
// Each terminal action's authority is resolved against LIVE data (the offer, the
// assignee/owner, the originator). Eligibility for an approver reuses exactly the
// same nearest-sufficient / four-eyes / including-COB logic the decision engine
// uses (deriveLiveApproverOptions), so "can approve" and "can sign" stay in lock-step.

/**
 * Load the authority context for a terminal transition: the assignee (owner),
 * the originator (submitter), the live offer, and the nominated next approver.
 * Works for both contracts (rich contract_offer) and quotes (lighter model).
 */
async function loadTerminalContext(entityType, entityId) {
  if (entityType === 'QUOTE') {
    const { rows } = await pool.query(
      `SELECT created_by_user_id, assigned_to_user_id, next_approver FROM public.quote WHERE quote_id=$1`,
      [entityId]
    );
    const q = rows[0] || {};
    return {
      entityType,
      ownerId: q.assigned_to_user_id || null,
      submitterId: q.created_by_user_id || null,
      nextApproverId: q.next_approver || null,
      offer: null,
    };
  }
  const [{ rows: cRows }, { rows: oRows }] = await Promise.all([
    pool.query(`SELECT assigned_to_user_id FROM public.contract WHERE contract_id=$1`, [entityId]),
    pool.query(`SELECT * FROM public.contract_offer WHERE contract_id=$1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [entityId]),
  ]);
  const offer = oRows[0] || null;
  return {
    entityType,
    ownerId: cRows[0]?.assigned_to_user_id || null,
    submitterId: offer?.submitted_by_id || null,
    nextApproverId: offer?.next_approver_id || offer?.next_approver || null,
    offer,
  };
}

/** True iff the actor is in the offer's LIVE eligible-approver set (mandate covers
 *  the written-line exposure, COB not excluded, role in the route, not the submitter). */
async function isEligibleContractApprover(offer, actorUserId) {
  if (!offer || !actorUserId) return false;
  const options = await deriveLiveApproverOptions(offer);
  return options.some((c) => String(c.user_id) === String(actorUserId));
}

/** Quote eligibility mirrors approveQuote: the nominated approver, or any senior
 *  (Treaty Manager and above), and never the submitter (four-eyes). */
function isEligibleQuoteApprover(ctx, { actorUserId, actorRole }) {
  if (!actorUserId) return false;
  if (ctx.submitterId && String(ctx.submitterId) === String(actorUserId)) return false;
  if (ctx.nextApproverId && String(ctx.nextApproverId) === String(actorUserId)) return true;
  return (LEVEL[actorRole] || 5) <= 4;
}

/**
 * Enforce the per-action authority rule. Throws httpError(403) when the verified
 * actor lacks authority. The legal prior-state set (incl. "still pending" for a
 * recall) is already enforced by assertWorkflowTransition before this runs. The
 * actor is always the verified req.user.userId threaded down from the route.
 */
async function authorizeTerminalAction({ action, entityType, entityId, actorUserId, actorRole }) {
  if (!actorUserId) throw httpError(403, 'A verified user is required for this action', 'NOT_AUTHORIZED');
  const ctx = await loadTerminalContext(entityType, entityId);
  const isActor = (id) => id != null && String(id) === String(actorUserId);
  const isEligibleApprover = () => (entityType === 'CONTRACT'
    ? isEligibleContractApprover(ctx.offer, actorUserId)
    : Promise.resolve(isEligibleQuoteApprover(ctx, { actorUserId, actorRole })));

  switch (action) {
    case 'SIGN':
      // An eligible approver/authoriser for THIS offer; four-eyes is built into
      // the eligible set, so the submitter is excluded.
      if (!(await isEligibleApprover())) throw httpError(403, 'Not authorised to sign this offer', 'SIGN_FORBIDDEN');
      return;
    case 'NTU':
      // The assignee (owner) OR an eligible senior may mark not-taken-up.
      if (isActor(ctx.ownerId)) return;
      if (!(await isEligibleApprover())) throw httpError(403, 'Not authorised to mark this offer not-taken-up', 'NTU_FORBIDDEN');
      return;
    case 'RETURN':
      // The approver it is pending with — or a senior in the route — may return it.
      if (!(await isEligibleApprover())) throw httpError(403, 'Not authorised to return this offer for rework', 'RETURN_FORBIDDEN');
      return;
    case 'RECALL':
      // Only the originator may recall (the still-pending prior state is already
      // enforced by the action's legal-from set in assertWorkflowTransition).
      if (!isActor(ctx.submitterId)) throw httpError(403, 'Only the submitter can recall this offer', 'RECALL_FORBIDDEN');
      return;
    default:
      throw httpError(400, `Unknown workflow action: ${action}`);
  }
}

/**
 * Normalize a persisted approver_options value to a list of user_id strings.
 * Tolerates the canonical shape (jsonb array of candidate objects) as well as a
 * bare array of user_id strings or a JSON-encoded string of either.
 */
export function approverOptionIds(approverOptions) {
  let arr = approverOptions;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((o) => (o && typeof o === 'object') ? o.user_id : o)
    .filter((x) => x != null)
    .map(String);
}

function sameIdSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Re-run the submit-time routing plan against the LIVE mandates/roster, returning
 * the currently-eligible approver candidate objects. Mirrors submitForApproval's
 * planSubmission call exactly (same inputs, same defaults) so the live set is
 * derived identically to the stored snapshot — any divergence therefore means
 * the routing genuinely changed since submission.
 */
async function deriveLiveApproverOptions(offer) {
  const submitter = await getUserMandate(offer.submitted_by_id);
  if (!submitter) return [];
  const candidates = await fetchApproverCandidates();
  const plan = await planSubmission({
    submitter,
    submittedByRole: submitter.role_code,
    writtenLinePct: offer.written_line_pct,
    epiUsd: offer.epi_usd,
    candidates,
  });
  return Array.isArray(plan.approverOptions) ? plan.approverOptions : [];
}

/** Load an offer by id, enriched with peer/submitter role codes from
 *  v_offer_approval; falls back to the base table when the view is absent. */
async function loadOfferById(offerId) {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, v.peer1_role_code, v.peer2_role_code, v.submitted_by_role, v.approval_stage
         FROM public.contract_offer o
         LEFT JOIN public.v_offer_approval v ON v.offer_id=o.offer_id
        WHERE o.offer_id=$1 LIMIT 1`, [offerId]
    );
    if (rows.length) return rows[0];
  } catch {
    const { rows } = await pool.query(`SELECT * FROM public.contract_offer WHERE offer_id=$1 LIMIT 1`, [offerId]);
    return rows[0] || null;
  }
  return null;
}

/** Resolve the latest offer for a contract/quote (slot determination only). */
async function resolveOfferByEntity({ contractId, quoteId }) {
  const field = contractId ? 'contract_id' : 'quote_id';
  const { rows } = await pool.query(
    `SELECT offer_id, status, peer1_decision, peer2_decision
       FROM public.contract_offer WHERE ${field}=$1 ORDER BY updated_at DESC LIMIT 1`,
    [contractId || quoteId]
  );
  return rows[0] || null;
}

/**
 * Atomically claim a peer slot. The conditional WHERE is the real concurrency
 * guard: a racing claimant who lost (or who is not in the persisted
 * approver_options) updates 0 rows. The jsonb membership test is the
 * column-level equivalent of `$actor = ANY(approver_options)` for our
 * object-array storage. Returns true iff this caller won the slot.
 */
async function claimPeerSlot({ offerId, slot, actorUserId, decision, comment, client }) {
  const db = client || pool;
  const membership = `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(approver_options,'[]'::jsonb)) ao
                             WHERE COALESCE(ao->>'user_id', ao#>>'{}') = $2::text)`;
  if (slot === 'peer1') {
    const { rows } = await db.query(
      `UPDATE public.contract_offer
          SET peer1_user_id=$2, peer1_decision=$3, peer1_comment=$4, peer1_at=now(), updated_at=now()
        WHERE offer_id=$1
          AND status='AWAITING_APPROVAL'
          AND peer1_user_id IS NULL
          AND peer1_decision IS NULL
          AND ${membership}
        RETURNING offer_id`,
      [offerId, actorUserId, decision, comment || null]
    );
    return rows.length > 0;
  }
  // peer2 — also enforces, atomically, that the second approver ≠ the first.
  const { rows } = await db.query(
    `UPDATE public.contract_offer
        SET peer2_user_id=$2, peer2_decision=$3, peer2_comment=$4, peer2_at=now(), updated_at=now()
      WHERE offer_id=$1
        AND status='AWAITING_APPROVAL'
        AND peer2_user_id IS NULL
        AND peer2_decision IS NULL
        AND peer1_decision IS NOT NULL
        AND peer1_user_id IS DISTINCT FROM $2
        AND ${membership}
      RETURNING offer_id`,
    [offerId, actorUserId, decision, comment || null]
  );
  return rows.length > 0;
}

/** Apply the status transition + event after a peer slot has been claimed.
 *  Ports the 5-tier final-authority / split-decision rules verbatim. */
async function applyPeerOutcome({ offer, slot, actorUserId, actorName, actorRole, decision, comment, contractId, quoteId, client }) {
  const db = client || pool;
  const actorLevel = LEVEL[actorRole] || 5;
  const isFinalAuth = FINAL_AUTH.has(actorLevel);
  let nextStatus = 'AWAITING_APPROVAL', finalDecision = null, arbiterRequired = false, eventType;

  if (slot === 'peer1') {
    eventType = decision === 'APPROVED' ? 'PEER1_APPROVED' : 'PEER1_DECLINED';
    // CU/CE decision in the peer1 slot is immediately final — no second approver.
    if (isFinalAuth) {
      finalDecision = decision;
      nextStatus = decision === 'APPROVED' ? 'AWAITING_SIGNED_LINE' : 'DECLINED';
      eventType = decision === 'APPROVED' ? 'FINAL_APPROVED_BY_AUTHORITY' : 'FINAL_DECLINED_BY_AUTHORITY';
    }
  } else {
    eventType = decision === 'APPROVED' ? 'PEER2_APPROVED' : 'PEER2_DECLINED';
    const p1d = offer.peer1_decision;
    if (p1d === decision) {
      finalDecision = decision;
      nextStatus = decision === 'APPROVED' ? 'AWAITING_SIGNED_LINE' : 'DECLINED';
    } else {
      // Split decision: a CU/CE on either side decides; otherwise → arbiter.
      const p1Level = LEVEL[offer.peer1_role_code] || 5;
      const higherLevel = Math.min(p1Level, actorLevel);
      if (FINAL_AUTH.has(higherLevel)) {
        const cuDecision = p1Level <= 2 ? p1d : decision;
        finalDecision = cuDecision;
        nextStatus = cuDecision === 'APPROVED' ? 'AWAITING_SIGNED_LINE' : 'DECLINED';
        eventType = cuDecision === 'APPROVED' ? 'FINAL_APPROVED_BY_AUTHORITY' : 'FINAL_DECLINED_BY_AUTHORITY';
      } else {
        arbiterRequired = true; nextStatus = 'DISPUTE_PENDING';
        await db.query(`UPDATE public.contract_offer SET arbiter_required=true,updated_at=now() WHERE offer_id=$1`, [offer.offer_id]);
        eventType = 'DISPUTE_RAISED';
      }
    }
  }

  await db.query(`UPDATE public.contract_offer SET status=$2,updated_at=now() WHERE offer_id=$1`, [offer.offer_id, nextStatus]);
  if (contractId) {
    await db.query(`UPDATE public.contract SET uw_status=$2::public.uw_workflow_status,updated_at=now() WHERE contract_id=$1`, [contractId, nextStatus]);
  }
  await logOfferEvent({ contractId, quoteId, eventType, actorUserId, actorName, actorRole, payload: { decision, slot, finalDecision, arbiterRequired }, comment, client: db });
  return { nextStatus, finalDecision, arbiterRequired, eventType, complete: !!finalDecision };
}

/** Arbiter (dispute-resolution) slot — TD/CU/CE only, claimed atomically. */
async function recordArbiterSlot({ offer, contractId, quoteId, actorUserId, actorName, actorRole, decision, comment, client }) {
  const db = client || pool;
  if (offer.status !== 'DISPUTE_PENDING') throw httpError(400, 'No active dispute');
  if (String(offer.submitted_by_id) === String(actorUserId)) throw httpError(403, 'Cannot arbitrate own submission');
  const level = LEVEL[actorRole] || 5;
  if (level > 3) throw httpError(403, 'Only Treaty Director, Chief Underwriter or Chief Executive can resolve disputes');
  const nextStatus = decision === 'APPROVED' ? 'AWAITING_SIGNED_LINE' : 'DECLINED';
  const { rows } = await db.query(
    `UPDATE public.contract_offer
        SET arbiter_user_id=$2, arbiter_decision=$3, arbiter_comment=$4, arbiter_at=now(), status=$5, updated_at=now()
      WHERE offer_id=$1 AND arbiter_user_id IS NULL AND status='DISPUTE_PENDING'
      RETURNING offer_id`,
    [offer.offer_id, actorUserId, decision, comment || null, nextStatus]
  );
  if (!rows.length) throw httpError(409, 'That dispute was already resolved', 'DISPUTE_RESOLVED');
  if (contractId) await db.query(`UPDATE public.contract SET uw_status=$2,updated_at=now() WHERE contract_id=$1`, [contractId, nextStatus]);
  await logOfferEvent({ contractId, quoteId, eventType: decision === 'APPROVED' ? 'ARBITER_APPROVED' : 'ARBITER_DECLINED', actorUserId, actorName, actorRole, payload: { decision }, comment, client: db });
  return { nextStatus, decision, complete: true };
}

/**
 * The single approval-write chokepoint. For peer1/peer2 it enforces, at decision
 * time and against LIVE data:
 *   • the offer is still AWAITING_APPROVAL
 *   • the actor is not the submitter (four-eyes)
 *   • for peer2, the actor is not whoever took peer1
 *   • the actor is in the live eligible set (re-derived from current mandates)
 *   • the live eligible set still matches the persisted approver_options snapshot
 *     — otherwise it fails CLOSED with 409 (routing changed; re-submit) rather
 *     than guessing which set to trust
 * then claims the slot with a conditional UPDATE (concurrency-safe) and applies
 * the resulting status transition. For arbiter it requires an open dispute and
 * TD/CU/CE authority.
 *
 * @param {{ offerId:string, actorUserId:string, actorName?:string,
 *           actorRole?:string, slot:'peer1'|'peer2'|'arbiter',
 *           decision:'APPROVED'|'DECLINED', comment?:string }} args
 */
export async function recordDecision({ offerId, actorUserId, actorName, actorRole, slot, decision, comment }) {
  if (!offerId) throw httpError(400, 'offerId required');
  if (!actorUserId) throw httpError(403, 'Not an eligible approver for this offer');
  if (!['APPROVED', 'DECLINED'].includes(decision)) throw httpError(400, 'decision must be APPROVED or DECLINED');
  if (!['peer1', 'peer2', 'arbiter'].includes(slot)) throw httpError(400, `Unknown approval slot: ${slot}`);

  const offer = await loadOfferById(offerId);
  if (!offer) throw httpError(404, 'Offer not found');
  const contractId = offer.contract_id || null;
  const quoteId = offer.quote_id || null;

  if (slot === 'arbiter') {
    return withTxn((client) => recordArbiterSlot({ offer, contractId, quoteId, actorUserId, actorName, actorRole, decision, comment, client }));
  }

  // ── peer1 / peer2 ──────────────────────────────────────────────────────────
  if (offer.status !== 'AWAITING_APPROVAL') throw httpError(400, `Offer already in status ${offer.status}`);
  if (String(offer.submitted_by_id) === String(actorUserId)) throw httpError(403, 'Cannot approve own submission');
  if (slot === 'peer1' && offer.peer1_decision) throw httpError(400, 'No open peer slot');
  if (slot === 'peer2' && !offer.peer1_decision) throw httpError(400, 'No open peer slot');
  if (slot === 'peer2' && offer.peer1_user_id && String(offer.peer1_user_id) === String(actorUserId)) {
    throw httpError(403, 'The second approver must be different from the first');
  }

  // Re-derive eligibility from LIVE data; cross-check the stored snapshot. If the
  // two disagree, fail closed — the routing changed since submission.
  const liveOptions = await deriveLiveApproverOptions(offer);
  const liveIds = new Set(liveOptions.map((c) => String(c.user_id)));
  const storedIds = new Set(approverOptionIds(offer.approver_options));
  if (!sameIdSet(liveIds, storedIds)) {
    throw httpError(409, 'Approval routing changed — re-submit', 'ROUTING_STALE');
  }
  if (!liveIds.has(String(actorUserId))) throw httpError(403, 'Not an eligible approver for this offer');

  // Atomic slot claim + outcome in ONE transaction: the claim, the status
  // transition, the event and the critical audit commit together or roll back.
  return withTxn(async (client) => {
    const claimed = await claimPeerSlot({ offerId, slot, actorUserId, decision, comment, client });
    if (!claimed) throw httpError(409, 'That approval slot was just taken', 'SLOT_TAKEN');
    return applyPeerOutcome({ offer, slot, actorUserId, actorName, actorRole, decision, comment, contractId, quoteId, client });
  });
}

/**
 * Peer-decision entrypoint (HTTP path). Resolves the offer + which peer slot is
 * open, then routes through the recordDecision chokepoint. Kept as a thin
 * adapter so existing callers/signatures are unchanged.
 */
export async function recordPeerDecision({ contractId, quoteId, decidedByUserId, decidedByName, decidedByRole, decision, comment }) {
  const offer = await resolveOfferByEntity({ contractId, quoteId });
  if (!offer) throw httpError(404, 'Offer not found');
  if (offer.status !== 'AWAITING_APPROVAL') throw httpError(400, `Offer already in status ${offer.status}`);
  const slot = !offer.peer1_decision ? 'peer1' : (!offer.peer2_decision ? 'peer2' : null);
  if (!slot) throw httpError(400, 'No open peer slot');
  return recordDecision({
    offerId: offer.offer_id, actorUserId: decidedByUserId, actorName: decidedByName,
    actorRole: decidedByRole, slot, decision, comment,
  });
}

/**
 * Arbiter-decision entrypoint (HTTP path). Resolves the offer then routes
 * through the recordDecision chokepoint with the arbiter slot.
 */
export async function recordArbiterDecision({ contractId, quoteId, decidedByUserId, decidedByName, decidedByRole, decision, comment }) {
  const offer = await resolveOfferByEntity({ contractId, quoteId });
  if (!offer) throw httpError(404, 'Offer not found');
  return recordDecision({
    offerId: offer.offer_id, actorUserId: decidedByUserId, actorName: decidedByName,
    actorRole: decidedByRole, slot: 'arbiter', decision, comment,
  });
}

// ── Privileged-state entrypoints (the only writers of approved/signed/bound) ──

/**
 * Approve a contract offer. Replaces the old one-shot markApproved write: an
 * illegal pre-state (e.g. DRAFT) is a clean 422 BEFORE any decision, then the
 * approver's decision is recorded through the chokepoint (eligibility +
 * four-eyes + atomic finalize). The approved-state write happens inside the
 * engine — never directly from a route.
 */
export async function approveContract({ contractId, actorUserId, actorName, actorRole, comment, linePct }) {
  const current = await loadEntityStatus('CONTRACT', contractId);
  if (current == null) throw httpError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  assertLegalTransition(current, 'AWAITING_SIGNED_LINE'); // 422 on an illegal jump
  const result = await recordPeerDecision({
    contractId, decidedByUserId: actorUserId, decidedByName: actorName,
    decidedByRole: actorRole, decision: 'APPROVED', comment,
  });
  if (linePct != null && result?.finalDecision === 'APPROVED') {
    await pool.query(
      `UPDATE public.contract_pricing_outputs SET offer_line=$2, updated_at=now() WHERE contract_id=$1`,
      [contractId, String(linePct)]
    ).catch(() => {});
  }
  return result;
}

/**
 * Sign a contract (AWAITING_SIGNED_LINE → SIGNED). Gated by
 * assertWorkflowTransition with the SIGN action: the prior AWAITING_SIGNED_LINE
 * state is only reachable through the engine, AND the signer must be a verified
 * eligible approver/authoriser for this offer (mandate covers the written-line
 * exposure, role in the route, not the submitter). Wrong state → 422; wrong
 * authority → 403.
 */
export async function markContractSigned({ contractId, actorUserId, actorName, actorRole, signedLinePct }) {
  await assertWorkflowTransition({ entityType: 'CONTRACT', entityId: contractId, to: 'SIGNED', action: 'SIGN', actorUserId, actorRole });
  await withTxn(async (client) => {
    await client.query(
      `UPDATE public.contract SET uw_status='SIGNED',status='SIGNED',signed_line_pct=$2,signed_at=now(),updated_at=now() WHERE contract_id=$1`,
      [contractId, signedLinePct ?? null]
    );
    await client.query(
      `UPDATE public.contract_offer SET status='SIGNED',signed_at=now(),written_line_pct=COALESCE(written_line_pct,$2) WHERE contract_id=$1`,
      [contractId, signedLinePct ?? null]
    );
    await logOfferEvent({ contractId, eventType: 'SIGNED', actorUserId, actorName, actorRole, payload: { signedLinePct: signedLinePct ?? null }, client });
  });
  refreshBenchmarks(pool).catch(() => {});
  return { nextStatus: 'SIGNED' };
}

/**
 * Mark an offer NOT-TAKEN-UP (… → NTU) for a treaty OR a quote. Gated by
 * assertWorkflowTransition with the NTU action: legal only from the permitted
 * prior state, and only the assignee (owner) or an eligible senior approver may
 * do it. Writes the NTU state + an immutable NTU event.
 */
export async function markNotTakenUp({ contractId, quoteId, actorUserId, actorName, actorRole, reason }) {
  const entityType = contractId ? 'CONTRACT' : 'QUOTE';
  const entityId = contractId || quoteId;
  await assertWorkflowTransition({ entityType, entityId, action: 'NTU', actorUserId, actorRole });
  await withTxn(async (client) => {
    if (contractId) {
      await client.query(
        `UPDATE public.contract SET uw_status='NTU',status='NTU',ntu_reason=$2,ntu_at=now(),updated_at=now() WHERE contract_id=$1`,
        [contractId, reason ?? null]
      );
    } else {
      await client.query(
        `UPDATE public.quote SET status='NTU',ntu_reason=$2,ntu_at=now(),updated_at=now() WHERE quote_id=$1`,
        [quoteId, reason ?? null]
      );
    }
    await logOfferEvent({ contractId, quoteId, eventType: 'NTU', actorUserId, actorName, actorRole, payload: { reason: reason ?? null }, comment: reason ?? null, client });
  });
  // Best-effort denormalised mirror on the offer table — never blocks the action.
  if (contractId) {
    await pool.query(
      `UPDATE public.contract_offer SET status='NTU',ntu_at=now(),ntu_reason=$2 WHERE contract_id=$1`,
      [contractId, reason ?? null]
    ).catch(() => {});
  } else {
    await pool.query(
      `INSERT INTO public.quote_offer (quote_id, status, updated_at) VALUES ($1,'NTU',now())
       ON CONFLICT (quote_id) DO UPDATE SET status='NTU', updated_at=now()`,
      [quoteId]
    ).catch(() => {});
  }
  refreshBenchmarks(pool).catch(() => {});
  return { nextStatus: 'NTU' };
}

/**
 * Approve a quote. Quotes run a lighter single-approver model (no peer engine),
 * so eligibility is enforced here — four-eyes plus approval authority (or the
 * nominated approver) — and the approved-state write goes through the
 * assertWorkflowTransition gate with an engine token.
 */
export async function approveQuote({ quoteId, actorUserId, actorName, actorRole, comment }) {
  const { rows } = await pool.query(
    `SELECT q.created_by_user_id, qo.next_approver
       FROM public.quote q
       LEFT JOIN public.quote_offer qo ON qo.quote_id=q.quote_id
      WHERE q.quote_id=$1 ORDER BY qo.updated_at DESC NULLS LAST LIMIT 1`,
    [quoteId]
  );
  if (!rows.length) throw httpError(404, 'Quote not found', 'QUOTE_NOT_FOUND');
  const submitterId = rows[0].created_by_user_id;
  if (actorUserId && submitterId && String(actorUserId) === String(submitterId)) {
    throw httpError(403, 'Cannot approve own submission');
  }
  const actorLevel = LEVEL[actorRole] || 5;
  const isNominee = rows[0].next_approver && actorUserId && String(rows[0].next_approver) === String(actorUserId);
  if (actorLevel > 4 && !isNominee) {
    throw httpError(403, 'Not an eligible approver for this quote');
  }
  await assertWorkflowTransition({ entityType: 'QUOTE', entityId: quoteId, to: 'AWAITING_SIGNED_LINE', actorUserId, decision: ENGINE_TOKEN });
  await withTxn(async (client) => {
    await client.query(`UPDATE public.quote SET status='AWAITING_SIGNED_LINE', updated_at=now() WHERE quote_id=$1`, [quoteId]);
    await logOfferEvent({ quoteId, eventType: 'APPROVED', actorUserId, actorName, actorRole, payload: { decision: 'APPROVED' }, comment, client });
  });
  // Best-effort denormalised mirror on the quote_offer table — never blocks the action.
  await pool.query(
    `INSERT INTO public.quote_offer (quote_id, status, updated_at)
     VALUES ($1, 'AWAITING_SIGNED_LINE', now())
     ON CONFLICT (quote_id) DO UPDATE SET status='AWAITING_SIGNED_LINE', updated_at=now()`,
    [quoteId]
  ).catch(() => {});
  return { nextStatus: 'AWAITING_SIGNED_LINE' };
}

export async function getApprovalState(contractId, quoteId) {
  const field = contractId ? 'contract_id' : 'quote_id';
  // Try the view first, fall back to base table
  try {
    const { rows } = await pool.query(
      `SELECT * FROM public.v_offer_approval WHERE ${field}=$1 ORDER BY updated_at DESC LIMIT 1`,
      [contractId||quoteId]
    );
    if (rows.length) return rows[0];
  } catch {}
  try {
    const { rows } = await pool.query(
      `SELECT * FROM public.contract_offer WHERE ${field}=$1 ORDER BY updated_at DESC LIMIT 1`,
      [contractId||quoteId]
    );
    return rows[0] || null;
  } catch { return null; }
}

export async function getOfferEvents(contractId, quoteId) {
  const conds=[]; const params=[];
  if (contractId) { conds.push(`contract_id=$${params.length+1}`); params.push(contractId); }
  if (quoteId)    { conds.push(`quote_id=$${params.length+1}`);    params.push(quoteId); }
  if (!conds.length) return [];
  const { rows } = await pool.query(`SELECT * FROM public.offer_approval_event WHERE ${conds.join(' OR ')} ORDER BY created_at ASC`,params);
  return rows;
}

/** SQL fragment that clears every peer/arbiter decision on a contract offer so
 *  it can be re-submitted cleanly after a return/recall. */
const RESET_CONTRACT_OFFER = `
  status='RETURNED',
  peer1_decision=NULL, peer1_at=NULL, peer1_comment=NULL, peer1_user_id=NULL,
  peer2_user_id=NULL, peer2_decision=NULL, peer2_at=NULL, peer2_comment=NULL,
  arbiter_required=false, arbiter_user_id=NULL, arbiter_decision=NULL, arbiter_at=NULL,
  approval_step=0, next_approver_id=NULL, updated_at=now()`;

/**
 * Return an offer to the underwriter for rework (… → DRAFT) for a treaty OR a
 * quote. Gated by assertWorkflowTransition with the RETURN action: only an
 * eligible approver (the person it is pending with) or a senior in the route may
 * send it back. Resets the offer, drops the entity to DRAFT, logs who returned it.
 */
export async function returnToUnderwriter({ contractId, quoteId, actorUserId, actorName, actorRole, reason }) {
  const entityType = contractId ? 'CONTRACT' : 'QUOTE';
  const entityId = contractId || quoteId;
  await assertWorkflowTransition({ entityType, entityId, action: 'RETURN', actorUserId, actorRole });
  await withTxn(async (client) => {
    if (contractId) {
      await client.query(`UPDATE public.contract_offer SET ${RESET_CONTRACT_OFFER} WHERE contract_id=$1`, [contractId]);
      await client.query(`UPDATE public.contract SET uw_status='DRAFT', status='DRAFT', updated_at=now() WHERE contract_id=$1`, [contractId]);
    } else {
      await client.query(`UPDATE public.quote SET status='DRAFT', updated_at=now() WHERE quote_id=$1`, [quoteId]);
    }
    await logOfferEvent({ contractId, quoteId, eventType: 'RETURNED_TO_UW', actorUserId, actorName, actorRole, payload: { reason: reason ?? null }, comment: reason ?? null, client });
  });
  // Best-effort denormalised quote_offer mirror — never blocks the action.
  if (!contractId) {
    await pool.query(
      `INSERT INTO public.quote_offer (quote_id, status, updated_at) VALUES ($1,'RETURNED',now())
       ON CONFLICT (quote_id) DO UPDATE SET status='RETURNED', updated_at=now()`,
      [quoteId]
    ).catch(() => {});
  }
  return { nextStatus: 'DRAFT' };
}

/**
 * Recall a still-pending offer (… → DRAFT) for a treaty OR a quote. Gated by
 * assertWorkflowTransition with the RECALL action: only the originator
 * (submitter) may withdraw it, and only while it is still pending (not yet
 * signed/bound). Returns it to the submitter's editable DRAFT state + an event.
 */
export async function recallOffer({ contractId, quoteId, actorUserId, actorName, actorRole, reason }) {
  const entityType = contractId ? 'CONTRACT' : 'QUOTE';
  const entityId = contractId || quoteId;
  await assertWorkflowTransition({ entityType, entityId, action: 'RECALL', actorUserId, actorRole });
  await withTxn(async (client) => {
    if (contractId) {
      await client.query(`UPDATE public.contract_offer SET ${RESET_CONTRACT_OFFER} WHERE contract_id=$1`, [contractId]);
      await client.query(`UPDATE public.contract SET uw_status='DRAFT', status='DRAFT', updated_at=now() WHERE contract_id=$1`, [contractId]);
    } else {
      await client.query(`UPDATE public.quote SET status='DRAFT', updated_at=now() WHERE quote_id=$1`, [quoteId]);
    }
    await logOfferEvent({ contractId, quoteId, eventType: 'RECALLED', actorUserId, actorName, actorRole, payload: { reason: reason ?? null }, comment: reason ?? null, client });
  });
  // Best-effort denormalised quote_offer mirror — never blocks the action.
  if (!contractId) {
    await pool.query(
      `INSERT INTO public.quote_offer (quote_id, status, updated_at) VALUES ($1,'RECALLED',now())
       ON CONFLICT (quote_id) DO UPDATE SET status='RECALLED', updated_at=now()`,
      [quoteId]
    ).catch(() => {});
  }
  return { nextStatus: 'DRAFT' };
}

async function logOfferEvent({contractId,quoteId,eventType,actorUserId,actorName,actorRole,payload,comment,client}) {
  const db = client || pool;
  await db.query(
    `INSERT INTO public.offer_approval_event (contract_id,quote_id,event_type,actor_user_id,actor_name,actor_role,payload,comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [contractId||null,quoteId||null,eventType,actorUserId||null,actorName||'SYSTEM',actorRole||null,payload?JSON.stringify(payload):null,comment||null]
  );
  // Critical: a failed audit write throws so the surrounding transaction rolls
  // back (status change + event + audit are atomic). Runs on the same client.
  if (contractId) await logAudit(db,{entityType:'CONTRACT',entityId:contractId,eventType,actor:{id:actorUserId,name:actorName,role:actorRole},payload,comment}, { critical: true });
}
