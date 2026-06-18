// server/src/services/permissions.js
// Edit-locking / ownership enforcement. Reads stay open to everyone by default;
// sensitive routes can opt into read checks. Writes are gated so only the current
// assignee can mutate a treaty/quote/fac risk.
//
// computeEditPermission is pure (unit-tested directly). assertCanEdit is the
// route guard: it loads ownership + the owner's hierarchy level, resolves the
// requester from req, and throws 403 READ_ONLY when editing isn't allowed.

import { pool } from '../db/pool.js';

const ENTITY = {
  CONTRACT: { table: 'public.contract',  idCol: 'contract_id' },
  QUOTE:    { table: 'public.quote',     idCol: 'quote_id' },
  FAC_RISK: { table: 'public.fac_risk',  idCol: 'fac_risk_id' },
};

function entityMeta(entityType) {
  const m = ENTITY[entityType];
  if (!m) throw Object.assign(new Error(`Invalid entity type: ${entityType}`), { status: 400 });
  return m;
}

/**
 * Pure edit-permission rule: editing is allowed ONLY for the current assignee.
 * Hierarchy level does NOT grant edit rights — it only governs who may
 * allocate/reassign (see assignments.js). An unassigned treaty is read-only
 * until someone claims it (self-assign/allocate sets assigned_to_user_id and
 * thereby grants edit).
 *
 * @returns {{ canEdit: boolean, isOwner: boolean, reason: string|null }}
 */
export function computeEditPermission({ requesterId, assignedToUserId }) {
  const canEdit = !!requesterId && requesterId === assignedToUserId;
  return { canEdit, isOwner: canEdit, reason: canEdit ? null : 'READ_ONLY_NOT_ASSIGNEE' };
}

/** Load assigned_to + the owner's hierarchy level (and display name) for an entity. */
async function loadOwnership(entityType, entityId) {
  const { table, idCol } = entityMeta(entityType);
  const { rows } = await pool.query(
    `SELECT e.assigned_to_user_id,
            r.hierarchy_level AS owner_level,
            ou.display_name   AS assigned_to_name
       FROM ${table} e
       LEFT JOIN public.uw_user ou ON ou.user_id = e.assigned_to_user_id
       LEFT JOIN public.uw_role r  ON r.role_id  = ou.role_id
      WHERE e.${idCol} = $1`,
    [entityId]
  );
  return rows[0] || null;
}

/**
 * Non-throwing edit-permission lookup for the client to lock its editor UI.
 * Reads stay open, so this never 403s — it just reports whether the requester
 * may edit. Returns { found, canEdit, isOwner, assignedToUserId, assignedToName, reason }.
 */
export async function getEditPermission(req, entityType, entityId) {
  const own = await loadOwnership(entityType, entityId);
  if (!own) return { found: false, canEdit: false, isOwner: false, assignedToUserId: null, assignedToName: null, reason: 'NOT_FOUND' };
  const requesterId = req?.user?.userId || null; // verified token identity only
  const assignedToUserId = own.assigned_to_user_id || null;
  const perm = computeEditPermission({ requesterId, assignedToUserId });
  return { found: true, ...perm, assignedToUserId, assignedToName: own.assigned_to_name || null };
}

/**
 * Route guard for MUTATING endpoints. Throws 403 READ_ONLY whenever the
 * requester is not the current assignee — regardless of seniority. CREATE
 * endpoints are exempt (the creator becomes the assignee via assignOnCreation),
 * and seniors change ownership through the allocate/reassign endpoints, not by
 * editing directly.
 */
export async function assertCanEdit(req, entityType, entityId) {
  const own = await loadOwnership(entityType, entityId);
  if (!own) throw Object.assign(new Error('Not found'), { status: 404 });

  const requesterId = req?.user?.userId || null; // verified token identity only
  const assignedToUserId = own.assigned_to_user_id || null;

  const perm = computeEditPermission({ requesterId, assignedToUserId });
  if (!perm.canEdit) {
    throw Object.assign(
      new Error('This treaty is read-only. Claim it (if unassigned) or have it allocated to you to edit.'),
      { status: 403, code: 'READ_ONLY' }
    );
  }
  return { ...perm, assignedToUserId, assignedToName: own.assigned_to_name || null };
}

// ── Comprehensive mutation guard ────────────────────────────────────────────
// A single app-level choke point so EVERY mutating route under quotes /
// treaties / facultative / pricing passes assertCanEdit on its owning entity.
// Reads pass through. Two groups deliberately do NOT take the assignee edit-lock,
// because the actor is an approver/signer/originator — not necessarily the
// assignee — and the edit-lock would reject the legitimate actor:
//
//   WORKFLOW — approval + terminal lifecycle actions. These are NOT unguarded:
//   each enforces its OWN explicit authority + legal state in the approval engine
//   (services/approvals.js). There is no blanket sign/NTU exemption anymore —
//     • peer/arbiter/mark-approved → recordDecision (eligibility + four-eyes)
//     • sign/ntu/return/recall     → assertWorkflowTransition per-action authority
//     • decline                    → statusMachine legal-transition guard
//
//   CREATE — bare creates (and renew/amend/bind): there is no prior entity to
//   edit-lock; the creator becomes the assignee via assignOnCreation.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Approval-engine + terminal lifecycle actions — authority lives in approvals.js.
const WORKFLOW_SUFFIXES = [
  '/decline',
  '/offer/peer-decision', '/offer/arbiter-decision', '/offer/mark-approved',
  '/offer/return-to-underwriter', '/offer/recall', '/offer/mark-signed', '/offer/ntu',
];
// Create-style actions: the creator becomes the assignee (or the route is disabled).
const CREATE_SUFFIXES = ['/renew', '/amend', '/bind'];
// Ownership-management actions enforce hierarchy/claim rules in assignments.js.
const ASSIGNMENT_SUFFIXES = ['/assign', '/reassign', '/allocate'];

function isWorkflowMutation(path) {
  return WORKFLOW_SUFFIXES.some((s) => path.endsWith(s));
}
function isCreateMutation(path) {
  return CREATE_SUFFIXES.some((s) => path.endsWith(s));
}
function isAssignmentMutation(path) {
  return ASSIGNMENT_SUFFIXES.some((s) => path.endsWith(s));
}

// Out-of-tree resources whose owning entity needs a DB lookup.
const PARENT_RESOLVERS = {
  facDocument:       { sql: 'SELECT fac_risk_id AS id FROM public.fac_document WHERE document_id=$1',            entityType: 'FAC_RISK' },
  facRecommendation: { sql: 'SELECT fac_risk_id AS id FROM public.fac_ai_recommendation WHERE recommendation_id=$1', entityType: 'FAC_RISK' },
  pricingSnapshot:   { sql: 'SELECT contract_id AS id FROM public.pricing_component_snapshots WHERE id=$1',      entityType: 'CONTRACT' },
  contractDocument:  {
    sql: `SELECT COALESCE(contract_id, quote_id) AS id,
                 CASE
                   WHEN contract_id IS NOT NULL THEN 'CONTRACT'
                   WHEN quote_id    IS NOT NULL THEN 'QUOTE'
                 END AS entity_type
            FROM public.contract_document
           WHERE document_id=$1`,
  },
};

/** Map a nested resource to its owning {entityType, entityId} via a DB lookup. */
export async function resolveParentEntity(resourceType, id) {
  const r = PARENT_RESOLVERS[resourceType];
  if (!r || !id) return null;
  try {
    const { rows } = await pool.query(r.sql, [id]);
    if (!rows.length || !rows[0].id) return null;
    const entityType = rows[0].entity_type || r.entityType;
    if (!entityType) return null;
    return { entityType, entityId: rows[0].id };
  } catch (error) {
    throw Object.assign(new Error('Could not resolve parent entity for mutation guard'), {
      status: 500,
      code: 'PARENT_RESOLUTION_FAILED',
      cause: error,
    });
  }
}

/**
 * Classify a mutating sub-path (the path AFTER the /api mount) for the registry
 * test and the runtime guard. Returns one of:
 *   'workflow' — approval/terminal action; authority enforced by the approval
 *                engine (NOT the assignee edit-lock — see approvals.js)
 *   'create'   — bare entity create / renew / amend / bind (no assignee guard)
 *   { entityType, entityId } — guard against this entity (entityId may be a route ':id')
 *   { resolve, id } — guard against a DB-resolved parent
 *   null — not an in-scope path
 */
export function classifyMutationPath(path) {
  if (isWorkflowMutation(path)) return 'workflow';
  if (isCreateMutation(path)) return 'create';
  if (isAssignmentMutation(path)) return 'workflow';
  let m;
  if ((m = /^\/quotes\/([^/]+)/.exec(path))) return { entityType: 'QUOTE', entityId: m[1] };
  if ((m = /^\/treaties\/([^/]+)/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1] };
  if ((m = /^\/fac\/risks\/([^/]+)/.exec(path))) return { entityType: 'FAC_RISK', entityId: m[1] };
  if ((m = /^\/fac\/documents\/([^/]+)/.exec(path))) return { resolve: 'facDocument', id: m[1] };
  if ((m = /^\/fac\/recommendation\/([^/]+)/.exec(path))) return { resolve: 'facRecommendation', id: m[1] };
  if ((m = /^\/documents\/([^/]+)/.exec(path))) return { resolve: 'contractDocument', id: m[1] };
  if ((m = /^\/contracts\/([^/]+)\/ldf-blend\/[^/]+$/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1] };
  if (/^\/pricing\/save$/.test(path) || /^\/straight-stats\/save$/.test(path)) return { entityType: 'CONTRACT', entityId: '@body' };
  if ((m = /^\/pricing\/component-snapshot\/([^/]+)/.exec(path))) return { resolve: 'pricingSnapshot', id: m[1] };
  if ((m = /^\/pricing\/([^/]+)\/component-snapshot$/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1] };
  if (path === '/quotes' || path === '/treaties' || path === '/fac/risks') return 'create';
  return null;
}

/** App-level guard: assertCanEdit on the owning entity for every in-scope mutator. */
export async function guardApiMutations(req, res, next) {
  try {
    if (READ_METHODS.has(req.method)) return next();
    const cls = classifyMutationPath(req.path);
    // 'workflow' (engine-authorized) and 'create' carry their own authority; only
    // entity-scoped classifications take the assignee edit-lock.
    if (cls === 'workflow' || cls === 'create' || cls === null) return next();

    let target = cls;
    if (cls.resolve) target = await resolveParentEntity(cls.resolve, cls.id);
    else if (cls.entityId === '@body') target = { entityType: cls.entityType, entityId: req.body?.contractId || req.body?.contract_id };
    if (cls.resolve && (!target || !target.entityId)) {
      throw Object.assign(new Error('Parent entity not found'), { status: 404, code: 'PARENT_NOT_FOUND' });
    }
    if (!target || !target.entityId) return next(); // unresolved/create → nothing to guard

    await assertCanEdit(req, target.entityType, target.entityId);
    return next();
  } catch (e) { return next(e); }
}
