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
 * Pure edit-permission rule.
 *   canEdit when: requester IS the owner, OR the item is unassigned
 *   (claim-to-edit), OR the requester is AT/ABOVE the owner
 *   (requesterLevel <= ownerLevel; lower number = higher authority).
 *
 * @returns {{ canEdit: boolean, isOwner: boolean, reason: string }}
 */
export function computeEditPermission({ requesterId, requesterLevel, assignedToUserId, ownerLevel }) {
  const isOwner = !!requesterId && requesterId === assignedToUserId;
  if (isOwner) return { canEdit: true, isOwner: true, reason: 'OWNER' };
  if (assignedToUserId == null) return { canEdit: true, isOwner: false, reason: 'UNASSIGNED' };
  if (ownerLevel != null && requesterLevel != null && Number(requesterLevel) <= Number(ownerLevel)) {
    return { canEdit: true, isOwner: false, reason: 'AT_OR_ABOVE_OWNER' };
  }
  return { canEdit: false, isOwner: false, reason: 'READ_ONLY_NOT_OWNER' };
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

/** Resolve the requester's id + hierarchy level from the request. */
async function resolveRequester(req) {
  const requesterId = req?.user?.userId || req?.headers?.['x-user-id'] || null;
  let requesterLevel = req?.user?.hierarchyLevel;
  if (requesterLevel == null) {
    const hdr = req?.headers?.['x-user-level'];
    if (hdr != null && hdr !== '') requesterLevel = Number(hdr);
    else requesterLevel = await getHierarchyLevel(requesterId);
  }
  return { requesterId, requesterLevel };
}

/**
 * Route guard for MUTATING endpoints. Throws 403 READ_ONLY when the requester
 * may not edit the entity; returns the permission object otherwise. CREATE
 * endpoints are exempt (the creator becomes owner via assignOnCreation).
 */
export async function assertCanEdit(req, entityType, entityId) {
  const own = await loadOwnership(entityType, entityId);
  if (!own) throw Object.assign(new Error('Not found'), { status: 404 });

  const { requesterId, requesterLevel } = await resolveRequester(req);
  const assignedToUserId = own.assigned_to_user_id || null;
  const ownerLevel = own.owner_level ?? null;

  const perm = computeEditPermission({ requesterId, requesterLevel, assignedToUserId, ownerLevel });
  if (!perm.canEdit) {
    throw Object.assign(
      new Error('This treaty is read-only. Ask the owner to allocate it, or claim it if unassigned.'),
      { status: 403, code: 'READ_ONLY' }
    );
  }
  return { ...perm, assignedToUserId, assignedToName: own.assigned_to_name || null };
}
