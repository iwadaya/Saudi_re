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

const LEVEL = { CE:1, CU:2, TD:3, TM:4, TUW:5, UW:5 };
const ROLE_NAME = { CE:'Chief Executive', CU:'Chief Underwriter', TD:'Treaty Director', TM:'Treaty Manager', TUW:'Treaty Underwriter' };
const FINAL_AUTH = new Set([1,2]); // CE, CU have override power

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

export async function getEligibleApprovers({ submitterUserId, breachType }) {
  // Determine submitter level — fall back to TUW (5) if not found in mandate view
  const submitter = await getUserMandate(submitterUserId).catch(()=>null);
  const submitterLevel = submitter?.hierarchy_level || 5;

  const minLevel=1;
  let maxLevel;
  if (!breachType||breachType==='NONE') { maxLevel=4; }         // any TM or above
  else if (breachType==='LIMIT') { maxLevel=Math.min(submitterLevel-1,4); }
  else { maxLevel=2; }  // CLASS or BOTH: CU or CE only

  // Helper to safely parse UUID - returns null if invalid
  const safeUuid = (id) => {
    if (!id) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return id;
    return null;
  };
  const safeId = safeUuid(submitterUserId);

  // Try via v_user_mandate first (full hierarchy info)
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id,u.display_name,u.email,u.office,r.role_code,r.role_name,r.hierarchy_level
       FROM public.v_user_mandate m
       JOIN public.uw_user u ON u.user_id=m.user_id
       JOIN public.uw_role r ON r.role_code=m.role_code
       WHERE u.is_active=true AND m.hierarchy_level BETWEEN $1 AND $2
       ORDER BY m.hierarchy_level,u.display_name`,
      [minLevel, maxLevel]
    );
    // Filter out submitter client-side to avoid UUID type issues
    const filtered = safeId ? rows.filter(r => r.user_id !== safeId) : rows;
    if (filtered.length > 0) return filtered;
  } catch (e) {
    logger.warn('getEligibleApprovers via v_user_mandate failed, falling back', { error: e.message });
  }

  // Fallback: query uw_user + uw_role directly (works even without mandate rows)
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id,u.display_name,u.email,u.office,r.role_code,r.role_name,r.hierarchy_level
       FROM public.uw_user u
       JOIN public.uw_role r ON r.role_id=u.role_id
       WHERE u.is_active=true AND r.hierarchy_level BETWEEN $1 AND $2
       ORDER BY r.hierarchy_level,u.display_name`,
      [minLevel, maxLevel]
    );
    const filtered = safeId ? rows.filter(r => r.user_id !== safeId) : rows;
    // If DB users exist, return them
    if (filtered.length > 0) return filtered;
  } catch (e) {
    logger.warn('getEligibleApprovers fallback failed', { error: e.message });
  }

  // Final fallback: demo users (used when uw_user table is empty / not yet seeded)
  const DEMO_APPROVERS = [
    { user_id: '00000000-0000-0000-0000-000000000001', display_name: 'Chief Underwriting Officer', email: 'cuo@universe3.app', office: 'Riyadh', role_code: 'CU', role_name: 'Chief Underwriter', hierarchy_level: 2 },
    { user_id: '00000000-0000-0000-0000-000000000003', display_name: 'Chief Executive',             email: 'ce@universe3.app',  office: 'Riyadh', role_code: 'CE', role_name: 'Chief Executive',     hierarchy_level: 1 },
    { user_id: '00000000-0000-0000-0000-000000000004', display_name: 'Treaty Director',             email: 'td@universe3.app',  office: 'Riyadh', role_code: 'TD', role_name: 'Treaty Director',     hierarchy_level: 3 },
    { user_id: '00000000-0000-0000-0000-000000000005', display_name: 'Treaty Manager',              email: 'tm@universe3.app',  office: 'Riyadh', role_code: 'TM', role_name: 'Treaty Manager',      hierarchy_level: 4 },
  ];
  const demoFiltered = DEMO_APPROVERS.filter(a =>
    a.hierarchy_level >= minLevel &&
    a.hierarchy_level <= (maxLevel ?? 99) &&
    a.user_id !== submitterUserId
  );
  return demoFiltered;
}

export async function detectBreach(submitterUserId, { epiUsd, cobIds=[], isNp=false }) {
  const mandate = await getUserMandate(submitterUserId);
  if (!mandate) return { type:'NONE', reasons:[] };
  const reasons=[]; let limitBreach=false, classBreach=false;
  if (epiUsd && mandate.effective_limit_usd!==null && Number(epiUsd)>Number(mandate.effective_limit_usd)) {
    limitBreach=true;
    reasons.push(`EPI USD${(epiUsd/1e6).toFixed(1)}M exceeds your authority USD${(mandate.effective_limit_usd/1e6).toFixed(1)}M`);
  }
  if (isNp && mandate.treaty_type_scope==='PROP_ONLY') { classBreach=true; reasons.push('Your mandate covers proportional treaties only'); }
  if (cobIds.length) {
    const { rows } = await pool.query(
      `SELECT c.min_hierarchy_level,cb.class_name FROM public.cob_authority_requirement c
       JOIN public.class_of_business cb ON cb.class_of_business_id=c.class_of_business_id
       WHERE c.class_of_business_id=ANY($1::uuid[]) AND c.min_hierarchy_level<$2`,[cobIds,mandate.hierarchy_level]
    );
    for (const r of rows) { classBreach=true; reasons.push(`Class "${r.class_name}" requires higher authority`); }
  }
  const type=limitBreach&&classBreach?'BOTH':limitBreach?'LIMIT':classBreach?'CLASS':'NONE';
  return { type, reasons };
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

export async function submitForApproval({ contractId, quoteId, submittedByUserId, submittedByName, submittedByRole, epiUsd, cobIds, isNp, peer1UserId, breachType, writtenLinePct, comment }) {
  let resolvedBreachType=breachType;
  if (!resolvedBreachType) {
    const b=await detectBreach(submittedByUserId,{epiUsd,cobIds,isNp});
    resolvedBreachType=b.type;
  }
  const submitter=await getUserMandate(submittedByUserId);
  const submitterLevel=submitter?.hierarchy_level||5;
  const requiredRole=getRequiredApproverRole(submitterLevel,resolvedBreachType);

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

  // Upsert offer
  const res=await pool.query(
    `INSERT INTO public.contract_offer (contract_id,quote_id,status,breach_type,approval_step,submitted_by_id,submitted_at,written_line_pct,epi_usd,next_approver_id,next_approver_role,peer1_user_id)
     VALUES ($1,$2,'AWAITING_APPROVAL',$3,1,$4,now(),$5,$6,$7,$8,$9)
     ON CONFLICT (contract_id) DO UPDATE SET
       status='AWAITING_APPROVAL',breach_type=$3,approval_step=1,submitted_by_id=$4,submitted_at=now(),
       written_line_pct=$5,epi_usd=$6,next_approver_id=$7,next_approver_role=$8,peer1_user_id=$9,
       peer1_decision=NULL,peer1_comment=NULL,peer1_at=NULL,peer2_user_id=NULL,peer2_decision=NULL,
       peer2_at=NULL,arbiter_required=false,arbiter_user_id=NULL,arbiter_decision=NULL,updated_at=now()
     RETURNING offer_id`,
    [contractId||null,quoteId||null,resolvedBreachType,submittedByUserId,writtenLinePct||null,
     epiUsd||null,peer1UserId||null,requiredRole,peer1UserId||null]
  );

  if (contractId) await pool.query(`UPDATE public.contract SET uw_status='AWAITING_APPROVAL',status='AWAITING_APPROVAL',updated_at=now() WHERE contract_id=$1`,[contractId]);

  await logOfferEvent({contractId,quoteId,eventType:'SUBMITTED',actorUserId:submittedByUserId,actorName:submittedByName,actorRole:submittedByRole,payload:{breachType:resolvedBreachType,requiredRole,epiUsd,peer1UserId},comment});
  return { offerId:res.rows[0]?.offer_id, breachType:resolvedBreachType, requiredRole, requiredRoleName:ROLE_NAME[requiredRole]||requiredRole };
}

export async function recordPeerDecision({ contractId, quoteId, decidedByUserId, decidedByName, decidedByRole, decision, comment }) {
  const field=contractId?'contract_id':'quote_id';
  const entityId=contractId||quoteId;
  // Try join with view; fall back to base table if view doesn't exist
  let rows = [];
  try {
    const r = await pool.query(
      `SELECT o.*,v.peer1_role_code,v.peer2_role_code,v.approval_stage FROM public.contract_offer o
       LEFT JOIN public.v_offer_approval v ON v.offer_id=o.offer_id
       WHERE o.${field}=$1 ORDER BY o.updated_at DESC LIMIT 1`,[entityId]
    );
    rows = r.rows;
  } catch {
    const r = await pool.query(
      `SELECT * FROM public.contract_offer WHERE ${field}=$1 ORDER BY updated_at DESC LIMIT 1`,[entityId]
    );
    rows = r.rows;
  }
  if (!rows.length) throw Object.assign(new Error('Offer not found'),{status:404});
  const offer=rows[0];
  if (offer.status!=='AWAITING_APPROVAL') throw Object.assign(new Error(`Offer already in status ${offer.status}`),{status:400});
  if (offer.submitted_by_id===decidedByUserId) throw Object.assign(new Error('Cannot approve own submission'),{status:403});

  const decidedByLevel=LEVEL[decidedByRole]||5;
  const isFinalAuth=FINAL_AUTH.has(decidedByLevel);
  const isPeer1Slot=!offer.peer1_decision&&(offer.peer1_user_id===decidedByUserId||!offer.peer1_user_id);
  const isPeer2Slot=offer.peer1_decision&&!offer.peer2_decision;

  if (!isPeer1Slot&&!isPeer2Slot) throw Object.assign(new Error('No open peer slot'),{status:400});

  let nextStatus='AWAITING_APPROVAL', finalDecision=null, arbiterRequired=false, eventType;

  if (isPeer1Slot) {
    await pool.query(`UPDATE public.contract_offer SET peer1_user_id=$2,peer1_decision=$3,peer1_comment=$4,peer1_at=now(),updated_at=now() WHERE offer_id=$1`,[offer.offer_id,decidedByUserId,decision,comment||null]);
    eventType=decision==='APPROVED'?'PEER1_APPROVED':'PEER1_DECLINED';
    // CU/CE decision in peer1 slot is immediately final — no second approver needed
    if (isFinalAuth) {
      finalDecision=decision;
      nextStatus=decision==='APPROVED'?'AWAITING_SIGNED_LINE':'DECLINED';
      eventType=decision==='APPROVED'?'FINAL_APPROVED_BY_AUTHORITY':'FINAL_DECLINED_BY_AUTHORITY';
    }
  } else {
    await pool.query(`UPDATE public.contract_offer SET peer2_user_id=$2,peer2_decision=$3,peer2_comment=$4,peer2_at=now(),updated_at=now() WHERE offer_id=$1`,[offer.offer_id,decidedByUserId,decision,comment||null]);
    eventType=decision==='APPROVED'?'PEER2_APPROVED':'PEER2_DECLINED';
    const p1d=offer.peer1_decision;
    if (p1d===decision) {
      finalDecision=decision;
      nextStatus=decision==='APPROVED'?'AWAITING_SIGNED_LINE':'DECLINED';
    } else {
      // Split decision
      const p1Level=LEVEL[offer.peer1_role_code]||5;
      const higherLevel=Math.min(p1Level,decidedByLevel);
      if (FINAL_AUTH.has(higherLevel)) {
        const cuDecision=p1Level<=2?p1d:decision;
        finalDecision=cuDecision;
        nextStatus=cuDecision==='APPROVED'?'AWAITING_SIGNED_LINE':'DECLINED';
        eventType=cuDecision==='APPROVED'?'FINAL_APPROVED_BY_AUTHORITY':'FINAL_DECLINED_BY_AUTHORITY';
      } else {
        arbiterRequired=true; nextStatus='DISPUTE_PENDING';
        await pool.query(`UPDATE public.contract_offer SET arbiter_required=true,updated_at=now() WHERE offer_id=$1`,[offer.offer_id]);
        eventType='DISPUTE_RAISED';
      }
    }
  }

  await pool.query(`UPDATE public.contract_offer SET status=$2,updated_at=now() WHERE offer_id=$1`,[offer.offer_id,nextStatus]);
  if (contractId) {
    await pool.query(`UPDATE public.contract SET uw_status=$2::public.uw_workflow_status,updated_at=now() WHERE contract_id=$1`,[contractId,nextStatus]);
  }
  await logOfferEvent({contractId,quoteId,eventType,actorUserId:decidedByUserId,actorName:decidedByName,actorRole:decidedByRole,payload:{decision,isPeer1Slot,finalDecision,arbiterRequired},comment});
  return { nextStatus, finalDecision, arbiterRequired, eventType, complete:!!finalDecision };
}

export async function recordArbiterDecision({ contractId, quoteId, decidedByUserId, decidedByName, decidedByRole, decision, comment }) {
  const field=contractId?'contract_id':'quote_id';
  const { rows } = await pool.query(`SELECT * FROM public.contract_offer WHERE ${field}=$1 ORDER BY updated_at DESC LIMIT 1`,[contractId||quoteId]);
  if (!rows.length) throw Object.assign(new Error('Offer not found'),{status:404});
  const offer=rows[0];
  if (offer.status!=='DISPUTE_PENDING') throw Object.assign(new Error('No active dispute'),{status:400});
  const level=LEVEL[decidedByRole]||5;
  if (level>3) throw Object.assign(new Error('Only Treaty Director, Chief Underwriter or Chief Executive can resolve disputes'),{status:403});
  const nextStatus=decision==='APPROVED'?'AWAITING_SIGNED_LINE':'DECLINED';
  await pool.query(`UPDATE public.contract_offer SET arbiter_user_id=$2,arbiter_decision=$3,arbiter_comment=$4,arbiter_at=now(),status=$5,updated_at=now() WHERE offer_id=$1`,[offer.offer_id,decidedByUserId,decision,comment||null,nextStatus]);
  if (contractId) await pool.query(`UPDATE public.contract SET uw_status=$2,updated_at=now() WHERE contract_id=$1`,[contractId,nextStatus]);
  await logOfferEvent({contractId,quoteId,eventType:decision==='APPROVED'?'ARBITER_APPROVED':'ARBITER_DECLINED',actorUserId:decidedByUserId,actorName:decidedByName,actorRole:decidedByRole,payload:{decision},comment});
  return { nextStatus, decision, complete:true };
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

export async function returnToUnderwriter({ contractId, quoteId, actorUserId, actorName, actorRole, reason }) {
  const field=contractId?'contract_id':'quote_id';
  // Reset offer — clear all peer/arbiter decisions so it can be re-submitted cleanly
  await pool.query(
    `UPDATE public.contract_offer SET
       status='RETURNED',
       peer1_decision=NULL, peer1_at=NULL, peer1_comment=NULL, peer1_user_id=NULL,
       peer2_user_id=NULL, peer2_decision=NULL, peer2_at=NULL, peer2_comment=NULL,
       arbiter_required=false, arbiter_user_id=NULL, arbiter_decision=NULL, arbiter_at=NULL,
       approval_step=0, next_approver_id=NULL, updated_at=now()
     WHERE ${field}=$1`,
    [contractId||quoteId]
  );
  // Reset contract back to DRAFT — both status columns
  if (contractId) {
    await pool.query(
      `UPDATE public.contract SET uw_status='DRAFT', status='DRAFT', updated_at=now() WHERE contract_id=$1`,
      [contractId]
    );
  }
  await logOfferEvent({contractId,quoteId,eventType:'RETURNED_TO_UW',actorUserId,actorName,actorRole,payload:{reason},comment:reason});
}

async function logOfferEvent({contractId,quoteId,eventType,actorUserId,actorName,actorRole,payload,comment}) {
  await pool.query(
    `INSERT INTO public.offer_approval_event (contract_id,quote_id,event_type,actor_user_id,actor_name,actor_role,payload,comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [contractId||null,quoteId||null,eventType,actorUserId||null,actorName||'SYSTEM',actorRole||null,payload?JSON.stringify(payload):null,comment||null]
  );
  if (contractId) await logAudit(pool,{entityType:'CONTRACT',entityId:contractId,eventType,actor:actorName||'SYSTEM',payload,comment}).catch(()=>{});
}
