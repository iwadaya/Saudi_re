// server/src/services/readPolicy.js
// P1-authz — the ONE formal read-visibility policy for the app.
//
// Reads were historically open to every authenticated user (see the module
// header in services/permissions.js). This module is the single place that
// decides WHO may VIEW a contract / quote / fac risk (and, by inheritance, its
// documents, dashboard aggregates, renewal-pack exports and AI portfolio ops).
//
// Four nested levels (narrowest → widest), selected by the READ_POLICY env var:
//
//   assigned — you see only your own work: rows assigned to OR created by you.
//   team     — you + your office-mates at your hierarchy level or below
//              (peers and reports within your office). Seniors above you are
//              NOT in your team, but you are always in theirs.
//   office   — everyone in your office (every level).
//   all      — no row restriction (the legacy behaviour; the default, so that
//              turning the policy on is an explicit, deliberate tightening).
//
// The levels nest: assigned ⊆ team ⊆ office ⊆ all. Hierarchy levels are
// integers where LOWER = more senior (1=CE … 5=junior), so "level or below"
// means `hierarchy_level >= mine`.
//
// Two consumers reuse the SAME resolved scope so every surface tightens at once:
//   • resolveReadScope(req)  — resolve the visible-owner set once per request.
//   • readScopeCondition()   — a SQL predicate for list / aggregate queries.
//   • rowInReadScope()       — a pure in-memory predicate for per-row / per-entity
//                              checks (used by services/permissions.js).
//
// NOTE (defence-in-depth follow-up, deliberately NOT done here): Postgres
// row-level security (RLS) would enforce the same policy at the database tier so
// a missing application guard can't leak rows. That is a separate, later item —
// this module is the application-tier policy.

import { pool } from '../db/pool.js';

/** Valid policy levels, narrowest → widest. */
export const READ_POLICY_LEVELS = ['assigned', 'team', 'office', 'all'];

// Default OFF (= 'all'): reads stay open until an operator explicitly opts into a
// tighter policy. This keeps the rollout a single, auditable config change rather
// than a silent behaviour shift on deploy.
export const DEFAULT_READ_POLICY = 'all';

/**
 * Resolve the ACTIVE policy level. An explicit override (used by tests and by a
 * surface that wants to pin a level) wins; otherwise READ_POLICY from the
 * environment, read LIVE so tests can flip it per-case; otherwise the default.
 * An unrecognised value fails safe to the default ('all').
 */
export function readPolicyLevel(override) {
  const raw = String(override ?? process.env.READ_POLICY ?? DEFAULT_READ_POLICY).trim().toLowerCase();
  return READ_POLICY_LEVELS.includes(raw) ? raw : DEFAULT_READ_POLICY;
}

/** Load the requester's office + hierarchy level (authoritative — from the DB). */
async function loadRequesterContext(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.office, r.hierarchy_level
         FROM public.uw_user u
         LEFT JOIN public.uw_role r ON r.role_id = u.role_id
        WHERE u.user_id = $1`,
      [userId]
    );
    if (!rows.length) return { office: null, hierarchyLevel: null };
    return { office: rows[0].office || null, hierarchyLevel: rows[0].hierarchy_level ?? null };
  } catch {
    return { office: null, hierarchyLevel: null };
  }
}

/**
 * Resolve the visible-owner SET for the requester under the active policy.
 *
 * @param {object} req            Express request (verified identity in req.user).
 * @param {object} [opts]
 * @param {string} [opts.level]   Explicit policy override (else READ_POLICY env).
 * @returns one of:
 *   { level: 'all' }                                  — no row restriction.
 *   { level, userId, visibleUserIds: string[] }       — visible owner/creator ids
 *                                                       (always includes the requester).
 * @throws 401 when the policy restricts and the requester is anonymous.
 */
export async function resolveReadScope(req, { level } = {}) {
  const policy = readPolicyLevel(level);
  if (policy === 'all') return { level: 'all' };

  const userId = req?.user?.userId || null;
  if (!userId) {
    throw Object.assign(new Error('Authentication required.'), { status: 401, code: 'UNAUTHORIZED' });
  }

  // assigned: only the requester's own ids — no DB lookup of the wider org.
  if (policy === 'assigned') {
    return { level: 'assigned', userId, visibleUserIds: [userId] };
  }

  // team / office: derive the visible set from the requester's office (+ level).
  const { office, hierarchyLevel } = await loadRequesterContext(userId);
  const ids = new Set([userId]); // the requester is always visible to themselves
  if (office) {
    let rows;
    if (policy === 'office') {
      ({ rows } = await pool.query(
        `SELECT user_id FROM public.uw_user WHERE office = $1`,
        [office]
      ));
    } else { // team
      ({ rows } = await pool.query(
        `SELECT u.user_id
           FROM public.uw_user u
           LEFT JOIN public.uw_role r ON r.role_id = u.role_id
          WHERE u.office = $1
            AND COALESCE(r.hierarchy_level, 99) >= COALESCE($2, 99)`,
        [office, hierarchyLevel]
      ));
    }
    for (const r of rows) ids.add(r.user_id);
  }
  return { level: policy, userId, visibleUserIds: [...ids] };
}

/**
 * Pure in-memory predicate: may the requester (per `scope`) read a row owned by
 * `ownerId` and/or created by `creatorId`? Visible when EITHER id is in the
 * scope's visible set. The 'all' scope (or a null scope) always returns true.
 */
export function rowInReadScope(scope, { ownerId = null, creatorId = null } = {}) {
  if (!scope || scope.level === 'all') return true;
  const set = new Set(scope.visibleUserIds || []);
  return (ownerId != null && set.has(ownerId)) || (creatorId != null && set.has(creatorId));
}

/**
 * Build a SQL predicate restricting rows to the requester's read scope. Mutates
 * `params` (pushes the visible-user-id array as one parameter) and returns the
 * condition string to AND into a WHERE clause — or null when the policy imposes
 * NO restriction (level 'all'), in which case the caller adds nothing.
 *
 * @param {object} scope                result of resolveReadScope().
 * @param {object} cfg
 * @param {string} cfg.ownerCol         qualified assignee column, e.g. 'c.assigned_to_user_id'.
 * @param {string} [cfg.creatorCol]     qualified creator column, e.g. 'c.created_by_user_id'.
 * @param {Array}  cfg.params           the query's positional-parameter array (mutated).
 * @returns {string|null}
 */
export function readScopeCondition(scope, { ownerCol, creatorCol = null, params }) {
  if (!scope || scope.level === 'all') return null;
  params.push(scope.visibleUserIds);
  const idx = params.length;
  const ors = [`${ownerCol} = ANY($${idx}::uuid[])`];
  if (creatorCol) ors.push(`${creatorCol} = ANY($${idx}::uuid[])`);
  return `(${ors.join(' OR ')})`;
}

/**
 * Resolve the set of contract ids the requester may READ under the active policy
 * — null for the unrestricted 'all' level (no filter), else an array (possibly
 * empty). Used where a row-level WHERE can't be threaded through, e.g. the
 * renewal-pack export which fans many sub-queries off a contract-id list.
 */
export async function readableContractIds(req, { level } = {}) {
  const scope = await resolveReadScope(req, { level });
  if (scope.level === 'all') return null;
  const { rows } = await pool.query(
    `SELECT contract_id FROM public.contract
      WHERE assigned_to_user_id = ANY($1::uuid[]) OR created_by_user_id = ANY($1::uuid[])`,
    [scope.visibleUserIds]
  );
  return rows.map((r) => r.contract_id);
}

/**
 * Intersect two contract-id scopes, where `null` means "unrestricted" (e.g. the
 * renewal-pack mandate scope vs. the read-policy scope). The result is the
 * tighter of the two: null only when BOTH are unrestricted.
 */
export function intersectContractScopes(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const bSet = new Set(b);
  return a.filter((id) => bSet.has(id));
}
