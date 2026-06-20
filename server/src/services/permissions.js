// server/src/services/permissions.js
// Edit-locking / ownership enforcement. Reads stay open to everyone; writes are
// gated so only the owner (assigned_to), a claimer of an unassigned item, or
// someone AT/ABOVE the owner in the hierarchy can mutate a treaty/quote/fac risk.
//
// computeEditPermission is pure (unit-tested directly). assertCanEdit is the
// route guard: it loads ownership + the owner's hierarchy level, resolves the
// requester from req, and throws 403 READ_ONLY when editing isn't allowed.

import { pool } from '../db/pool.js';
import { resolveReadScope, rowInReadScope } from './readPolicy.js';

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

/**
 * Entity READ authorization — the single policy choke point for who may VIEW a
 * contract / quote / fac risk (and, by inheritance, its documents). The active
 * read policy (assigned / team / office / all) is owned by services/readPolicy.js
 * and selected by the READ_POLICY env var; it defaults to 'all' (open to every
 * authenticated user). It is centralized HERE on purpose: when read visibility is
 * tightened, every read path that routes through this helper — documents
 * included — tightens at once.
 *
 * Throws 401 when anonymous, 404 when the entity does not exist, 403
 * READ_FORBIDDEN when the active policy hides this entity from the requester.
 */
export async function assertCanReadEntity(req, entityType, entityId) {
  const { table, idCol } = entityMeta(entityType);
  if (!req?.user?.userId) {
    throw Object.assign(new Error('Authentication required.'), { status: 401, code: 'UNAUTHORIZED' });
  }
  if (!entityId) throw Object.assign(new Error('Not found'), { status: 404 });
  const { rows } = await pool.query(
    `SELECT assigned_to_user_id, created_by_user_id FROM ${table} WHERE ${idCol} = $1`,
    [entityId]
  );
  if (!rows.length) throw Object.assign(new Error('Not found'), { status: 404 });

  // Apply the formal read policy. Under the default 'all' level resolveReadScope
  // short-circuits and rowInReadScope is always true, so reads stay open.
  const scope = await resolveReadScope(req);
  const allowed = rowInReadScope(scope, {
    ownerId: rows[0].assigned_to_user_id || null,
    creatorId: rows[0].created_by_user_id || null,
  });
  if (!allowed) {
    // 404, not 403: the read policy hides the row's existence (no IDOR oracle).
    throw Object.assign(new Error('Not found'), { status: 404, code: 'READ_FORBIDDEN' });
  }
}

/**
 * Resolve a document to its owning entity (contract_document is shared: a row is
 * owned by EITHER a contract OR a quote — migration 072 single-owner check) and
 * enforce that the requester may perform `action` on it. A document must NEVER be
 * more accessible than its parent:
 *   • 'read'   (view / download / text) → inherits the parent READ policy
 *                                         (assertCanReadEntity).
 *   • 'delete' (and any future mutation) → takes the assignee edit-lock
 *                                         (assertCanEdit).
 * A missing OR orphaned (no parent) document throws 404 — so probing a foreign/
 * deleted document UUID never serves a file, closing the load-by-id IDOR.
 *
 * Returns the resolved owner + the document row so the caller can serve/delete it
 * without a second lookup. P0-2 reuses this owner-scope resolution.
 *
 * @param {object} req         Express request (verified identity in req.user).
 * @param {string} documentId  contract_document.document_id (UUID).
 * @param {'read'|'delete'} [action]
 * @returns {Promise<{ entityType: 'CONTRACT'|'QUOTE', entityId: string, doc: object }>}
 */
export async function assertCanAccessDocument(req, documentId, action = 'read') {
  if (!documentId) throw Object.assign(new Error('Document not found'), { status: 404, code: 'NOT_FOUND' });
  const { rows } = await pool.query('SELECT * FROM public.contract_document WHERE document_id = $1', [documentId]);
  const doc = rows[0];
  if (!doc) throw Object.assign(new Error('Document not found'), { status: 404, code: 'NOT_FOUND' });

  let entityType = null;
  let entityId = null;
  if (doc.contract_id) { entityType = 'CONTRACT'; entityId = doc.contract_id; }
  else if (doc.quote_id) { entityType = 'QUOTE'; entityId = doc.quote_id; }
  // Orphaned document (no parent contract or quote) → never serve; treat as 404.
  if (!entityId) throw Object.assign(new Error('Document not found'), { status: 404, code: 'NOT_FOUND' });

  if (action === 'delete') {
    await assertCanEdit(req, entityType, entityId);
  } else {
    await assertCanReadEntity(req, entityType, entityId);
  }
  return { entityType, entityId, doc };
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

function isWorkflowMutation(path) {
  return WORKFLOW_SUFFIXES.some((s) => path.endsWith(s));
}
function isCreateMutation(path) {
  return CREATE_SUFFIXES.some((s) => path.endsWith(s));
}

// Out-of-tree resources whose owning entity needs a DB lookup.
const PARENT_RESOLVERS = {
  facDocument:       { sql: 'SELECT fac_risk_id AS id FROM public.fac_document WHERE document_id=$1',            entityType: 'FAC_RISK' },
  facRecommendation: { sql: 'SELECT fac_risk_id AS id FROM public.fac_ai_recommendation WHERE recommendation_id=$1', entityType: 'FAC_RISK' },
  pricingSnapshot:   { sql: 'SELECT contract_id AS id FROM public.pricing_component_snapshots WHERE id=$1',      entityType: 'CONTRACT' },
};

/** Map a nested resource to its owning {entityType, entityId} via a DB lookup. */
export async function resolveParentEntity(resourceType, id) {
  const r = PARENT_RESOLVERS[resourceType];
  if (!r || !id) return null;
  try {
    const { rows } = await pool.query(r.sql, [id]);
    if (!rows.length || !rows[0].id) return null;
    return { entityType: r.entityType, entityId: rows[0].id };
  } catch { return null; }
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
  let m;
  if ((m = /^\/quotes\/([^/]+)/.exec(path))) return { entityType: 'QUOTE', entityId: m[1] };
  if ((m = /^\/treaties\/([^/]+)/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1] };
  if ((m = /^\/fac\/risks\/([^/]+)/.exec(path))) return { entityType: 'FAC_RISK', entityId: m[1] };
  if ((m = /^\/fac\/documents\/([^/]+)/.exec(path))) return { resolve: 'facDocument', id: m[1] };
  if ((m = /^\/fac\/recommendation\/([^/]+)/.exec(path))) return { resolve: 'facRecommendation', id: m[1] };
  if (/^\/pricing\/save$/.test(path) || /^\/straight-stats\/save$/.test(path)) return { entityType: 'CONTRACT', entityId: '@body' };
  if ((m = /^\/pricing\/component-snapshot\/([^/]+)/.exec(path))) return { resolve: 'pricingSnapshot', id: m[1] };
  if ((m = /^\/pricing\/([^/]+)\/component-snapshot$/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1] };
  // GEM EQ compute persists a contract scenario only when persist=true; the
  // runtime guard skips the edit-lock for preview (persist falsy) calls.
  if ((m = /^\/pricing\/gem\/([^/]+)\/compute$/.exec(path))) return { entityType: 'CONTRACT', entityId: m[1], onlyWhenPersist: true };
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
    // Some entity-scoped routes only mutate conditionally (e.g. GEM compute
    // persists a scenario only when persist=true); a pure preview is read-like.
    if (cls.onlyWhenPersist && !req.body?.persist) return next();

    let target = cls;
    if (cls.resolve) target = await resolveParentEntity(cls.resolve, cls.id);
    else if (cls.entityId === '@body') target = { entityType: cls.entityType, entityId: req.body?.contractId || req.body?.contract_id };
    if (!target || !target.entityId) return next(); // unresolved/create → nothing to guard

    await assertCanEdit(req, target.entityType, target.entityId);
    return next();
  } catch (e) { return next(e); }
}
