// server/src/services/assignments.js
// Contract/Quote assignment service with hierarchy enforcement and audit trail.
//
// RULES:
// - Each user sees only their own work by default
// - Any user can VIEW another person's profile (read-only browse)
// - ALLOCATE: take ownership of a DRAFT from someone at same level or below
//   e.g. Treaty Director (level 3) can take from TM (4) or TUW (5), NOT from CU (2)
// - All changes tracked in contract_assignment_history

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { logAudit } from './audit.js';
import { computeEditPermission } from './permissions.js';

function entityTable(t) {
  if (t==='CONTRACT') return 'public.contract';
  if (t==='QUOTE')    return 'public.quote';
  throw Object.assign(new Error(`Invalid entity type: ${t}`),{status:400});
}
function entityIdCol(t) {
  if (t==='CONTRACT') return 'contract_id';
  if (t==='QUOTE')    return 'quote_id';
  throw Object.assign(new Error(`Invalid entity type: ${t}`),{status:400});
}

export async function getHierarchyLevel(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT r.hierarchy_level FROM public.uw_user u JOIN public.uw_role r ON r.role_id=u.role_id WHERE u.user_id=$1`,
      [userId]
    );
    return rows[0]?.hierarchy_level ?? 99;
  } catch { return 99; }
}

async function logHistory({ entityType, entityId, fromUserId, toUserId, assignedBy, action, comment }) {
  try {
    await pool.query(
      `INSERT INTO public.contract_assignment_history (entity_type,entity_id,from_user_id,to_user_id,assigned_by,action,comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entityType, entityId, fromUserId||null, toUserId, assignedBy||toUserId, action, comment||null]
    );
  } catch {
    await logAudit(pool,{entityType,entityId,eventType:action,actor:{id:assignedBy||toUserId},payload:{fromUserId,toUserId,comment}}).catch(()=>{});
  }
}

export async function assignOnCreation(client, { entityType, entityId, creatorUserId }) {
  if (!creatorUserId) return;
  try {
    const table=entityTable(entityType); const idCol=entityIdCol(entityType);
    await client.query(`UPDATE ${table} SET created_by_user_id=$2, assigned_to_user_id=$2 WHERE ${idCol}=$1`,[entityId,creatorUserId]);
    await logHistory({entityType,entityId,fromUserId:null,toUserId:creatorUserId,assignedBy:creatorUserId,action:'ASSIGNED'});
  } catch(e) { logger.warn('assignOnCreation skipped', { error: e.message }); }
}

export async function allocate({ entityType, entityId, requestingUserId, comment }) {
  const table=entityTable(entityType); const idCol=entityIdCol(entityType);
  const { rows } = await pool.query(`SELECT assigned_to_user_id, uw_status FROM ${table} WHERE ${idCol}=$1`,[entityId]);
  if (!rows.length) throw Object.assign(new Error('Not found'),{status:404});
  const currentOwnerId=rows[0].assigned_to_user_id;
  const status=(rows[0].uw_status||'DRAFT').toUpperCase();
  if (status !== 'DRAFT') {
    throw Object.assign(new Error(`Cannot allocate: item is ${status}. Only DRAFT items can be reallocated.`),{status:403});
  }
  if (currentOwnerId===requestingUserId) return { allocated:false, message:'Already assigned to you' };
  const requesterLevel=await getHierarchyLevel(requestingUserId);
  if (currentOwnerId) {
    const ownerLevel=await getHierarchyLevel(currentOwnerId);
    if (requesterLevel>ownerLevel) throw Object.assign(new Error('You can only take work from colleagues at your level or below in the hierarchy.'),{status:403});
  }
  await pool.query(`UPDATE ${table} SET assigned_to_user_id=$2, updated_at=now() WHERE ${idCol}=$1`,[entityId,requestingUserId]);
  await logHistory({entityType,entityId,fromUserId:currentOwnerId,toUserId:requestingUserId,assignedBy:requestingUserId,action:'ALLOCATED',comment});
  return { allocated:true, previousOwnerId:currentOwnerId };
}

export async function reassign({ entityType, entityId, reassignedBy, newOwnerId, comment }) {
  const table=entityTable(entityType); const idCol=entityIdCol(entityType);
  const { rows } = await pool.query(`SELECT assigned_to_user_id FROM ${table} WHERE ${idCol}=$1`,[entityId]);
  if (!rows.length) throw Object.assign(new Error('Not found'),{status:404});
  const fromUserId=rows[0].assigned_to_user_id;
  const reassignerLevel=await getHierarchyLevel(reassignedBy);
  if (fromUserId) {
    const ownerLevel=await getHierarchyLevel(fromUserId);
    if (reassignerLevel>ownerLevel) throw Object.assign(new Error('You can only reassign work from colleagues at your level or below.'),{status:403});
  }
  await pool.query(`UPDATE ${table} SET assigned_to_user_id=$2, updated_at=now() WHERE ${idCol}=$1`,[entityId,newOwnerId]);
  await logHistory({entityType,entityId,fromUserId,toUserId:newOwnerId,assignedBy:reassignedBy,action:'ASSIGNED',comment});
  return { assigned:true, from:fromUserId, to:newOwnerId };
}

export async function selfAssign({ entityType, entityId, userId }) {
  const table=entityTable(entityType); const idCol=entityIdCol(entityType);
  const { rows } = await pool.query(`SELECT assigned_to_user_id FROM ${table} WHERE ${idCol}=$1`,[entityId]);
  if (!rows.length) throw Object.assign(new Error('Not found'),{status:404});
  const currentOwner=rows[0].assigned_to_user_id;
  if (currentOwner===userId) return { assignedTo:userId, changed:false };
  await pool.query(`UPDATE ${table} SET assigned_to_user_id=$2, updated_at=now() WHERE ${idCol}=$1`,[entityId,userId]);
  await logHistory({entityType,entityId,fromUserId:currentOwner,toUserId:userId,assignedBy:userId,action:'SELF_ASSIGNED'});
  return { assignedTo:userId, changed:true };
}

export async function getAssignmentHistory(entityType, entityId) {
  try {
    const { rows } = await pool.query(
      `SELECT h.*,
         tu.display_name AS to_name, fu.display_name AS from_name, bu.display_name AS by_name,
         tr.role_code AS to_role, fr.role_code AS from_role
       FROM public.contract_assignment_history h
       LEFT JOIN public.uw_user tu ON tu.user_id=h.to_user_id
       LEFT JOIN public.uw_user fu ON fu.user_id=h.from_user_id
       LEFT JOIN public.uw_user bu ON bu.user_id=h.assigned_by
       LEFT JOIN public.uw_role tr ON tr.role_id=tu.role_id
       LEFT JOIN public.uw_role fr ON fr.role_id=fu.role_id
       WHERE h.entity_type=$1 AND h.entity_id=$2 ORDER BY h.assigned_at DESC`,
      [entityType, entityId]
    );
    return rows;
  } catch { return []; }
}

// requesterLevel is accepted for API symmetry with the assignment routes but the
// per-row canEdit is derived in SQL, so it is intentionally unused here.
export async function listContractsWithOwnership({ assignedTo, status, uwYear, limit=200, requesterId=null, requesterLevel: _requesterLevel=null, scope='mine' }={}) {
  const params=[]; const where=[]; let i=1;
  if (assignedTo) { where.push(`c.assigned_to_user_id=$${i++}`); params.push(assignedTo); }
  if (status)     { where.push(`c.uw_status=$${i++}`); params.push(status); }
  if (uwYear)     { where.push(`c.uw_year=$${i++}`); params.push(Number(uwYear)); }
  // scope='mine' (default): my work + anything unclaimed. scope='all': everyone
  // (rows still carry per-row canEdit so the client can lock other people's work).
  if (scope !== 'all' && requesterId) {
    where.push(`(c.assigned_to_user_id=$${i} OR c.created_by_user_id=$${i} OR c.assigned_to_user_id IS NULL)`);
    params.push(requesterId); i++;
  }
  params.push(limit);
  const whereSql=where.length?`WHERE ${where.join(' AND ')}`:''
  try {
    const { rows } = await pool.query(`
      SELECT c.contract_id AS id,'CONTRACT' AS record_type,
        c.uw_year AS "uwYear",c.status,c.uw_status AS "uwStatus",c.updated_at AS "updatedAt",
        c.assigned_to_user_id,c.created_by_user_id,
        co.company_name AS "cedantName",tt.treaty_type AS "treatyType",tt.category AS "treatyCategory",
        cnt.country_name AS country,
        au.display_name AS "assignedToName",ar.role_code AS "assignedToRole",ar.hierarchy_level AS "ownerLevel"
      FROM public.contract c
      LEFT JOIN public.companies co ON c.cedant_id=co.company_id
      LEFT JOIN public.treaty_type tt ON c.treaty_type_id=tt.treaty_type_id
      LEFT JOIN public.country cnt ON c.country_id=cnt.country_id
      LEFT JOIN public.uw_user au ON au.user_id=c.assigned_to_user_id
      LEFT JOIN public.uw_role ar ON ar.role_id=au.role_id
      ${whereSql} ORDER BY c.updated_at DESC LIMIT $${i}`,params);
    return rows.map((r) => {
      // Edit = current assignee only (hierarchy governs allocate/reassign, not edit).
      const { canEdit, isOwner } = computeEditPermission({
        requesterId,
        assignedToUserId: r.assigned_to_user_id || null,
      });
      return {
        ...r,
        assignedToUserId: r.assigned_to_user_id || null,
        isOwner,
        canEdit,
      };
    });
  } catch { return []; }
}

export async function listViewableUsers(requestingUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id,u.display_name,u.email,u.office,r.role_code,r.role_name,r.hierarchy_level
       FROM public.uw_user u JOIN public.uw_role r ON r.role_id=u.role_id
       WHERE u.is_active=true AND u.user_id!=$1 ORDER BY r.hierarchy_level,u.display_name`,
      [requestingUserId]
    );
    return rows;
  } catch { return []; }
}
