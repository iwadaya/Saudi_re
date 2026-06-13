// server/src/services/permissions.js
// Edit-locking / ownership enforcement. Reads stay open to everyone; writes are
// gated so only the owner (assigned_to), a claimer of an unassigned item, or
// someone AT/ABOVE the owner in the hierarchy can mutate a treaty/quote/fac risk.
//
// computeEditPermission is pure (unit-tested directly). assertCanEdit is the
// route guard: it loads ownership + the owner's hierarchy level, resolves the
// requester from req, and throws 403 READ_ONLY when editing isn't allowed.

import { pool } from '../db/pool.js';
import { getHierarchyLevel } from './assignments.js';

export { getHierarchyLevel };

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
 * Hierarchy level of an entity's owner (its assigned_to user). Returns null when
 * the entity is unassigned (no owner ⇒ claim-to-edit). `ownerUserId` is the
 * assigned_to_user_id resolved by the caller.
 */
export async function getOwnerLevel(ownerUserId) {
  if (!ownerUserId) return null;
  return getHierarchyLevel(ownerUserId);
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
  const requesterId = req?.user?.userId || req?.headers?.['x-user-id'] || null;
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

  const requesterId = req?.user?.userId || req?.headers?.['x-user-id'] || null;
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
