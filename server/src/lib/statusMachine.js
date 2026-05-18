// server/src/lib/statusMachine.js
//
// The single source of truth for the uw_status (and mirror `status`)
// lifecycle. Today this knowledge is spread across six different SQL
// statements in pricingOfferRepository + approvals.js — each one
// assumes the caller knows the correct pre-state, and nothing guards
// against a direct PUT that jumps DRAFT → SIGNED.
//
// We declare the legal graph once and expose:
//   - UW_STATUSES          : the canonical enum (matches common.js)
//   - LEGAL_TRANSITIONS    : map of current-state → Set<legal next>
//   - isLegalTransition()  : predicate for programmatic checks
//   - assertLegalTransition(): throws a typed InvalidTransitionError
//                              the route handlers can translate to 422
//
// Why the shape it is:
//   Every approval action the app already performs (submitForApproval,
//   markApproved, markSigned, markNtu, returnToUnderwriter, decline)
//   was reverse-engineered from the actual UPDATE statements. If the
//   real workflow grows a new transition, add it here — every route
//   guard inherits automatically.

/** Canonical uw_status enum. Matches the Postgres uw_workflow_status type. */
export const UW_STATUSES = Object.freeze([
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'AWAITING_SIGNED_LINE',
  'SIGNED',
  'NTU',
  'DECLINED',
]);

const TERMINAL = new Set(['SIGNED', 'NTU', 'DECLINED']);

/**
 * Legal transitions. Read as: from → allowed next states.
 *
 * Deliberate choices:
 *   - DRAFT → AWAITING_APPROVAL              : submitForApproval
 *   - DRAFT → DECLINED                       : operator can kill a draft outright
 *   - AWAITING_APPROVAL → APPROVED            : multi-step approval engine only;
 *                                              markApproved skips this and goes
 *                                              straight to AWAITING_SIGNED_LINE
 *   - AWAITING_APPROVAL → AWAITING_SIGNED_LINE: markApproved (the one-shot CU
 *                                              approve-to-offer used by PropPricing
 *                                              + NpFinalPricing). Reality: there
 *                                              is usually no persisted APPROVED
 *                                              state — the UPDATE sets
 *                                              uw_status='AWAITING_SIGNED_LINE'
 *                                              directly.
 *   - AWAITING_APPROVAL → DECLINED            : approver rejection
 *   - AWAITING_APPROVAL → DRAFT               : returnToUnderwriter
 *   - APPROVED → AWAITING_SIGNED_LINE        : legacy path (kept for approval
 *                                              engines that do land on APPROVED)
 *   - APPROVED → DECLINED                    : late decline path
 *   - AWAITING_SIGNED_LINE → SIGNED          : markSigned
 *   - AWAITING_SIGNED_LINE → NTU             : markNtu (treaty fell through)
 *   - AWAITING_SIGNED_LINE → DRAFT           : recallOffer (back to the desk)
 *   - AWAITING_SIGNED_LINE → DECLINED        : last-chance kill before bind
 *   - SIGNED / NTU / DECLINED                : terminal — no outbound edges
 *
 * Self-transitions are always allowed (a re-save of the same status
 * is a no-op, not a contract violation).
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  DRAFT:                new Set(['DRAFT', 'AWAITING_APPROVAL', 'DECLINED']),
  AWAITING_APPROVAL:     new Set(['AWAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE', 'DRAFT', 'DECLINED']),
  APPROVED:             new Set(['APPROVED', 'AWAITING_SIGNED_LINE', 'DECLINED']),
  AWAITING_SIGNED_LINE: new Set(['AWAITING_SIGNED_LINE', 'SIGNED', 'NTU', 'DRAFT', 'DECLINED']),
  SIGNED:               new Set(['SIGNED']),    // terminal
  NTU:                  new Set(['NTU']),       // terminal
  DECLINED:             new Set(['DECLINED']),  // terminal
});

/** True when `from → to` is an allowed edge. Unknown states are rejected. */
export function isLegalTransition(from, to) {
  const f = String(from || '').toUpperCase();
  const t = String(to   || '').toUpperCase();
  if (!UW_STATUSES.includes(f) || !UW_STATUSES.includes(t)) return false;
  const allowed = LEGAL_TRANSITIONS[f];
  return !!allowed && allowed.has(t);
}

/** True when `from` is a terminal state (no outbound edges). */
export function isTerminal(status) {
  return TERMINAL.has(String(status || '').toUpperCase());
}

/**
 * Typed error thrown by assertLegalTransition. Carries the attempted
 * edge so the route handler can surface a clean 422 body.
 */
export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal uw_status transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.code = 'INVALID_TRANSITION';
    this.status = 422;  // errorHandler picks this up automatically
  }
}

/**
 * Throw if the transition is illegal. Handlers catch and translate
 * to `422 INVALID_TRANSITION` with the attempted edge in the body.
 *
 * @param {string} from
 * @param {string} to
 * @throws {InvalidTransitionError}
 */
export function assertLegalTransition(from, to) {
  if (!isLegalTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
