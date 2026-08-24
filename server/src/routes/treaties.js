// server/src/routes/treaties.js — Aligned to actual PostgreSQL schema
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull, dateOrNull, boolOrDefault } from '../helpers.js';
import { logAudit } from "../services/audit.js";
import { changeUwStatus } from "../services/workflow.js";
import { actorFromReq } from "../middleware/requestContext.js";
import { contractContextJoins } from "../db/contractJoins.js";
import { assertEntityUnchanged, optimisticLockOverrideRequested } from "../db/optimisticLock.js";
import { validateBody } from "../lib/validate.js";
import { treatyPutBodySchema } from "../validation/treaty.js";
import { logger } from "../lib/logger.js";
import { buildBatchInsert } from "../db/batchInsert.js";
import { assertCanEdit, computeEditPermission } from "../services/permissions.js";
import { getAssignmentHistory } from "../services/assignments.js";
import { getContractHistory } from "../services/contractHistory.js";
const router = Router();


// ── POST /api/treaties ──
router.post("/treaties", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const uw_year = numOrNull(b.uw_year ?? b.underwriting_year) || new Date().getFullYear();
  const inception_date = dateOrNull(b.inception_date);
  if (!inception_date) {
    return res.status(400).json({ error: 'inception_date is required', code: 'VALIDATION_FAILED' });
  }
  const creatorUserId = req.user?.userId || null;
  const { rows } = await pool.query(
    `INSERT INTO public.contract (uw_year,cedant_id,broker_id,currency_id,country_id,treaty_type_id,status,uw_status,experience_source,primary_class_of_business_id,created_by_user_id,assigned_to_user_id,inception_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7::public.contract_status,$8::public.uw_workflow_status,$9,$10,$11,$11,$12) RETURNING contract_id,uw_year,status,uw_status,created_at`,
    [uw_year, b.cedant_id || null, b.broker_id || null, b.currency_id || null, b.country_id || null, b.treaty_type_id || null,
     b.status || 'DRAFT', b.uw_status || 'DRAFT', b.experience_source || 'TRIANGLE',
     b.primary_class_of_business_id || null, creatorUserId, inception_date]
  );
  const c = rows[0];
  await logAudit(pool, { entityType: "CONTRACT", entityId: c.contract_id, eventType: "CREATED", actor: actorFromReq(req), payload: { uw_year, assignedTo: creatorUserId } });
  res.status(201).json({ id: c.contract_id, contract_id: c.contract_id, ...c });
}));

// ── GET /api/treaties ── paginated list (X-Total-Count / X-Page / X-Page-Size headers)
router.get("/treaties", asyncHandler(async (req, res) => {
  const {status,uw_year,cedant_id,country_id,category,limit,offset,page}=req.query;const conds=[];const params=[];let i=1;
  if(status){
    const VALID_STATUSES = new Set(['DRAFT','AWAITING_APPROVAL','APPROVED','AWAITING_SIGNED_LINE','SIGNED','NTU','DECLINED']);
    const statuses = status.split(',').map(s=>s.trim().toUpperCase()).filter(s=>VALID_STATUSES.has(s));
    if(statuses.length === 1){ conds.push(`c.uw_status=$${i++}`); params.push(statuses[0]); }
    else if(statuses.length > 1){ conds.push(`c.uw_status=ANY($${i++}::public.uw_workflow_status[])`); params.push(statuses); }
  }
  if(uw_year){conds.push(`c.uw_year=$${i++}`);params.push(Number(uw_year));}
  if(cedant_id){conds.push(`c.cedant_id=$${i++}`);params.push(cedant_id);}
  if(country_id){conds.push(`c.country_id=$${i++}`);params.push(country_id);}
  if(category){conds.push(`tt.category ILIKE $${i++}`);params.push(`%${category}%`);}
  const where=conds.length?`WHERE ${conds.join(" AND ")}`:"";
  const lim=Math.max(1, Math.min(Number(limit)||200,500));
  const pageNum = Math.max(1, Number(page) || 1);
  // Honour an explicit offset parameter; otherwise derive from page.
  // `Number(x) != null` is always true (NaN != null → true) so we
  // check the raw input instead.
  const off = (offset != null && offset !== '') ? (Number(offset) || 0) : (pageNum - 1) * lim;

  // Count only the base + filters. The reference joins can never change
  // COUNT(*) (all are LEFT JOINs on unique PKs), so the count query only
  // needs treaty_type — and only when the category filter references it.
  const countSql = `SELECT COUNT(*)::int AS total FROM public.contract c
     ${category ? 'LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id' : ''}
     ${where}`;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query(countSql, params),
    pool.query(
      `SELECT c.contract_id AS id,c.contract_id,c.uw_year,c.status,c.uw_status,
         c.cedant_id,ced.company_name AS cedant_name,c.broker_id,bk.broker_name,
         c.country_id,cnt.country_name,cnt.country_code,c.treaty_type_id,
         tt.treaty_type AS treaty_type_name,tt.category AS treaty_category,
         c.currency_id,cur.currency_code,c.experience_source,c.renewal_date,
         c.contract_group_id,c.signed_line_pct,c.contract_description,c.created_at,c.updated_at,
         EXISTS(SELECT 1 FROM public.contract_np_details nd WHERE nd.contract_id=c.contract_id) AS has_np_details,
         pd.qs_limit,pd.retention_pct,pd.retention_amt,pd.num_lines,pd.total_capacity,
         pd.surplus_max_retention,pd.cession_pct,pd.quota_share_epi,pd.surplus_epi
       FROM public.contract c
       ${contractContextJoins('c')}
       LEFT JOIN public.contract_prop_details pd ON pd.contract_id=c.contract_id
       ${where} ORDER BY c.updated_at DESC LIMIT $${i++} OFFSET $${i++}`,
      [...params, lim, off]
    ),
  ]);
  const total = countRows[0]?.total ?? 0;
  res.setHeader('X-Total-Count', String(total));
  res.setHeader('X-Page-Size', String(lim));
  res.setHeader('X-Page', String(pageNum));
  res.json(rows);
}));

// ── GET /api/treaties/:id ──
router.get("/treaties/:id", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {rows:mainRows}=await pool.query(
    `SELECT c.*,ced.company_name AS cedant_name,bk.broker_name,cnt.country_name,cnt.country_code,
       tt.treaty_type AS treaty_type_name,tt.category AS treaty_category,cur.currency_code
     FROM public.contract c
     ${contractContextJoins('c')}
     WHERE c.contract_id=$1`,[id]);
  if(!mainRows.length) return res.status(404).json({error:"Contract not found"});
  const contract=mainRows[0];
  const [detailR,commR,slidesR,lpR,cobR,epiR,uwLimR]=await Promise.all([
    pool.query(`SELECT * FROM public.contract_prop_details WHERE contract_id=$1`,[id]),
    pool.query(`SELECT * FROM public.contract_commissions WHERE contract_id=$1`,[id]),
    pool.query(`SELECT row_no,loss_ratio_pct,commission_pct FROM public.contract_commission_slides WHERE contract_id=$1 ORDER BY row_no`,[id]),
    pool.query(`SELECT * FROM public.contract_loss_participation WHERE contract_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id FROM public.contract_class_of_business WHERE contract_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id AS class_id,premium FROM public.contract_epi_split WHERE contract_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id,limit_amount,basis FROM public.contract_underwriting_limit WHERE contract_id=$1`,[id]),
  ]);
  const detail=detailR.rows[0]||{};const comm=commR.rows[0]||{};const lp=lpR.rows[0]||{};
  // Ownership / edit-permission for the requester (reads stay open; this just
  // tells the client whether to lock the editor). Edit = current assignee only.
  const requesterId = req.user?.userId || null;
  const assignedToUserId = contract.assigned_to_user_id || null;
  const perm = computeEditPermission({ requesterId, assignedToUserId });
  const ownerHistory = await getAssignmentHistory('CONTRACT', id);
  let assignedToName = null;
  if (assignedToUserId) {
    const { rows: nameRows } = await pool.query(`SELECT display_name FROM public.uw_user WHERE user_id=$1`, [assignedToUserId]);
    assignedToName = nameRows[0]?.display_name || null;
  }
  res.json({
    ownership:{ canEdit:perm.canEdit, isOwner:perm.isOwner, reason:perm.reason,
      assignedToUserId, assignedToName, ownerHistoryCount:ownerHistory.length },
    canEdit:perm.canEdit, isOwner:perm.isOwner,
    contract_id:contract.contract_id,
    updated_at:contract.updated_at,
    created_at:contract.created_at,
    class_ids:cobR.rows.map(r=>r.class_of_business_id),
    header:{cedant_id:contract.cedant_id,broker_id:contract.broker_id,currency_id:contract.currency_id,
      country_id:contract.country_id,treaty_type_id:contract.treaty_type_id,uw_year:contract.uw_year,
      status:contract.status,uw_status:contract.uw_status,experience_source:contract.experience_source,
      cedant_name:contract.cedant_name,broker_name:contract.broker_name,country_name:contract.country_name,
      country_code:contract.country_code,treaty_type_name:contract.treaty_type_name,
      treaty_category:contract.treaty_category,currency_code:contract.currency_code,
      renewal_date:contract.renewal_date,signed_line_pct:contract.signed_line_pct,
      primary_class_of_business_id:contract.primary_class_of_business_id,
      contract_group_id:contract.contract_group_id,parent_contract_id:contract.parent_contract_id,
      inception_date:contract.inception_date,contract_description:contract.contract_description,
      alt_contract_id:contract.alt_contract_id||null},
    detail:{triangulations_available:detail.triangulations_available??true,
      inception_date:contract.inception_date,
      renewal_date:contract.renewal_date,
      experience_start_year:detail.experience_start_year||null,
      qs_limit:detail.qs_limit,retention_pct:detail.retention_pct,retention_amt:detail.retention_amt,
      cession_pct:detail.cession_pct,cession_amt:detail.cession_amt,
      surplus_max_retention:detail.surplus_max_retention,num_lines:detail.num_lines,
      total_capacity:detail.total_capacity,event_limit:detail.event_limit,aal:detail.aal,
      quota_share_epi:detail.quota_share_epi,surplus_epi:detail.surplus_epi,
      brokerage_pct:detail.brokerage_pct,taxes_pct:detail.taxes_pct,loss_cap_pct:detail.loss_cap_pct,
      strip_large_cat_losses:detail.strip_large_cat_losses??false},
    commissions:{mode:comm.mode||"FIXED",fixed_commission_pct:comm.fixed_commission_pct,
      fixed_commission_qs_pct:comm.fixed_commission_qs_pct,
      fixed_commission_surplus_pct:comm.fixed_commission_surplus_pct,
      provisional_commission_pct:comm.provisional_commission_pct,
      sliding_min_loss_ratio:comm.sliding_min_loss_ratio,sliding_max_loss_ratio:comm.sliding_max_loss_ratio,
      sliding_min_commission:comm.sliding_min_commission,sliding_max_commission:comm.sliding_max_commission,
      mgmt_expenses_pct:comm.mgmt_expenses_pct,profit_commission_pct:comm.profit_commission_pct,
      lcf_years:comm.lcf_years||null,lcf_extinction:comm.lcf_extinction||false,
      sliding_table:slidesR.rows},
    lossParticipation:{enabled:lp.enabled??false,min_loss_ratio_pct:lp.min_loss_ratio_pct,
      max_loss_ratio_pct:lp.max_loss_ratio_pct,reinsurer_share_pct:lp.reinsurer_share_pct,slides:lp.slides||[]},
    epi_split:epiR.rows,underwriting_limits:uwLimR.rows,
  });
}));

// ── PUT /api/treaties/:id ──
// PARTIAL-SAVE SAFE: only updates DB sections that are explicitly present
// in the request payload. A call with { terms: { event_loss_tables: {...} } }
// will NOT wipe COBs, commissions, details, loss participation, etc.
router.put("/treaties/:id", validateBody(treatyPutBodySchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const {terms={},save_mode="MANUAL"}=req.body;
  await assertCanEdit(req, 'CONTRACT', id);
  const client=await pool.connect();
  try{
    const ifUnmodifiedSince = req.headers['if-unmodified-since'];
    const staleWriteOverride = optimisticLockOverrideRequested(ifUnmodifiedSince);
    let staleWriteContext = null;
    if (staleWriteOverride) {
      const { rows: entityRows } = await client.query(
        `SELECT updated_at FROM public.contract WHERE contract_id=$1`,
        [id],
      );
      const auditRows = await client.query(
        `SELECT actor,event_type,created_at
           FROM public.contract_audit_event
          WHERE contract_id=$1
          ORDER BY created_at DESC
          LIMIT 1`,
        [id],
      ).then(r => r.rows).catch((err) => {
        logger.warn('treaty.audit_lookup_failed', { contractId: id, error: err.message });
        return [];
      });
      staleWriteContext = {
        overwrittenUpdatedAt: entityRows[0]?.updated_at || null,
        previousActor: auditRows[0]?.actor || null,
        previousEventType: auditRows[0]?.event_type || null,
        previousEventAt: auditRows[0]?.created_at || null,
      };
    }
    await client.query("BEGIN");
    // Optimistic locking — if the caller supplied If-Unmodified-Since with
    // the updated_at they last saw, reject the write when the row has
    // moved on. No header = no check (backwards-compatible).
    // MUST run after BEGIN: the helper's FOR UPDATE row lock only holds
    // inside an open transaction. Pre-BEGIN it ran in an implicit
    // single-statement transaction that released the lock immediately,
    // so two concurrent saves with the same baseline could both pass the
    // check and the second silently overwrote the first (lost update —
    // reproduced 39/40 by the load-test/agents lock-race probe).
    await assertEntityUnchanged(client, { table: 'public.contract', idColumn: 'contract_id', id, ifUnmodifiedSince });
    const actor = actorFromReq(req);

    // ── Header (only if explicitly provided) ──
    const h=terms.header;
    if(h && Object.keys(h).length) {
      const d=terms.detail||{};
      await client.query(
        `UPDATE public.contract SET cedant_id=COALESCE($2,cedant_id),broker_id=COALESCE($3,broker_id),
         currency_id=COALESCE($4,currency_id),country_id=COALESCE($5,country_id),
         treaty_type_id=COALESCE($6,treaty_type_id),uw_year=COALESCE($7,uw_year),
         experience_source=COALESCE($8,experience_source),renewal_date=COALESCE($9,renewal_date),
         inception_date=COALESCE($10,inception_date),primary_class_of_business_id=COALESCE($11,primary_class_of_business_id),
         contract_description=COALESCE($12,contract_description),alt_contract_id=COALESCE($13,alt_contract_id),
         status=COALESCE($14::public.contract_status,status),
         signed_line_pct=COALESCE($15,signed_line_pct),
         updated_at=now() WHERE contract_id=$1`,
        [id,h.cedant_id||null,h.broker_id||null,h.currency_id||null,h.country_id||null,
         h.treaty_type_id||null,numOrNull(h.uw_year??h.underwriting_year??d.start_year),
         h.experience_source||null,dateOrNull(d.renewal_date??h.renewal_date),dateOrNull(d.inception_date??h.inception_date),
         h.primary_class_of_business_id||null,h.contract_description??null,h.alt_contract_id??null,
         h.status||null,numOrNull(h.signed_line_pct)]);
      // uw_status is NOT written by the raw header UPDATE: a workflow-state move
      // must leave a workflow event + STATUS_CHANGED audit and clear the transition
      // guard. Route any requested change through changeUwStatus — a re-save of the
      // same status is a no-op, an illegal jump (e.g. SIGNED→DRAFT) is a clean 422.
      if (h.uw_status) {
        await changeUwStatus(client, { contractId: id, to: h.uw_status, actor, comment: 'treaty header edit' });
      }
    }

    // ── Prop details (only if detail section provided) ──
    // inception_date and renewal_date live on contract (header) — the
    // detail-table columns are deprecated, no longer written here.
    if(terms.detail && Object.keys(terms.detail).length) {
      const d=terms.detail;
      await client.query(
        `INSERT INTO public.contract_prop_details (contract_id,triangulations_available,qs_limit,retention_pct,retention_amt,cession_pct,cession_amt,surplus_max_retention,num_lines,total_capacity,event_limit,aal,quota_share_epi,surplus_epi,brokerage_pct,taxes_pct,loss_cap_pct,experience_start_year,strip_large_cat_losses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (contract_id) DO UPDATE SET triangulations_available=EXCLUDED.triangulations_available,qs_limit=EXCLUDED.qs_limit,retention_pct=EXCLUDED.retention_pct,retention_amt=EXCLUDED.retention_amt,cession_pct=EXCLUDED.cession_pct,cession_amt=EXCLUDED.cession_amt,surplus_max_retention=EXCLUDED.surplus_max_retention,num_lines=EXCLUDED.num_lines,total_capacity=EXCLUDED.total_capacity,event_limit=EXCLUDED.event_limit,aal=EXCLUDED.aal,quota_share_epi=EXCLUDED.quota_share_epi,surplus_epi=EXCLUDED.surplus_epi,brokerage_pct=EXCLUDED.brokerage_pct,taxes_pct=EXCLUDED.taxes_pct,loss_cap_pct=EXCLUDED.loss_cap_pct,experience_start_year=EXCLUDED.experience_start_year,strip_large_cat_losses=EXCLUDED.strip_large_cat_losses,updated_at=now()`,
        [id,boolOrDefault(d.triangulations_available??d.triangulationsAvailable,true),
         numOrNull(d.qs_limit??d.qsLimit),numOrNull(d.retention_pct??d.retentionPct),numOrNull(d.retention_amt??d.retentionAmt),
         numOrNull(d.cession_pct??d.cessionPct),numOrNull(d.cession_amt??d.cessionAmt),
         numOrNull(d.surplus_max_retention??d.surplusMaxRetention),numOrNull(d.num_lines??d.numLines),
         numOrNull(d.total_capacity??d.totalCapacity),numOrNull(d.event_limit??d.eventLimit),numOrNull(d.aal),
         numOrNull(d.quota_share_epi??d.quotaShareEpi),numOrNull(d.surplus_epi??d.surplusEpi),
         numOrNull(d.brokerage_pct??d.brokeragePct),numOrNull(d.taxes_pct??d.taxesPct),numOrNull(d.loss_cap_pct??d.lossCapPct),
         numOrNull(d.experience_start_year??d.experienceStartYear),
         boolOrDefault(d.strip_large_cat_losses??d.stripLargeCatLosses,false)]);
    }

    // ── Commissions (only if commissions section provided) ──
    if(terms.commissions) {
      const cm=terms.commissions;
      await client.query(
        `INSERT INTO public.contract_commissions (contract_id,mode,fixed_commission_pct,fixed_commission_qs_pct,fixed_commission_surplus_pct,sliding_min_loss_ratio,sliding_max_loss_ratio,sliding_min_commission,sliding_max_commission,provisional_commission_pct,mgmt_expenses_pct,profit_commission_pct,lcf_years,lcf_extinction)
         VALUES ($1,$2::public.commission_mode,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (contract_id) DO UPDATE SET mode=EXCLUDED.mode,fixed_commission_pct=EXCLUDED.fixed_commission_pct,fixed_commission_qs_pct=EXCLUDED.fixed_commission_qs_pct,fixed_commission_surplus_pct=EXCLUDED.fixed_commission_surplus_pct,sliding_min_loss_ratio=EXCLUDED.sliding_min_loss_ratio,sliding_max_loss_ratio=EXCLUDED.sliding_max_loss_ratio,sliding_min_commission=EXCLUDED.sliding_min_commission,sliding_max_commission=EXCLUDED.sliding_max_commission,provisional_commission_pct=EXCLUDED.provisional_commission_pct,mgmt_expenses_pct=EXCLUDED.mgmt_expenses_pct,profit_commission_pct=EXCLUDED.profit_commission_pct,lcf_years=EXCLUDED.lcf_years,lcf_extinction=EXCLUDED.lcf_extinction,updated_at=now()`,
        [id,(cm.mode||"FIXED").toUpperCase(),numOrNull(cm.fixed_commission_pct??cm.fixedCommissionPct),
         numOrNull(cm.fixed_commission_qs_pct??cm.fixedCommissionQSPct),numOrNull(cm.fixed_commission_surplus_pct??cm.fixedCommissionSurplusPct),
         numOrNull(cm.sliding_min_loss_ratio??cm.slidingMinLossRatio),numOrNull(cm.sliding_max_loss_ratio??cm.slidingMaxLossRatio),
         numOrNull(cm.sliding_min_commission??cm.slidingMinCommission),numOrNull(cm.sliding_max_commission??cm.slidingMaxCommission),
         numOrNull(cm.provisional_commission_pct??cm.provisionalCommissionPct),numOrNull(cm.mgmt_expenses_pct??cm.mgmtExpensesPct),
         numOrNull(cm.profit_commission_pct??cm.profitCommissionPct),numOrNull(cm.lcf_years||null),cm.lcf_extinction?true:false]);
      // Sliding rows — drop existing then batch-insert any non-empty rows.
      const slideRows=cm.sliding_table??cm.slidingTable??[];
      await client.query(`DELETE FROM public.contract_commission_slides WHERE contract_id=$1`,[id]);
      const slideBatch = slideRows
        .map((r, idx) => [idx, numOrNull(r.loss_ratio_pct??r.lossRatioPct), numOrNull(r.commission_pct??r.commissionPct)])
        .filter(([, lr, cp]) => lr !== null || cp !== null);
      const slideInsert = buildBatchInsert({
        table: 'public.contract_commission_slides',
        columns: ['contract_id','row_no','loss_ratio_pct','commission_pct'],
        rows: slideBatch,
        leadingId: id,
      });
      if (slideInsert) await client.query(slideInsert.sql, slideInsert.params);
    }

    // ── Loss participation (only if LP section provided) ──
    if(terms.lossParticipation !== undefined || terms.loss_participation !== undefined) {
      const lpD=terms.lossParticipation??terms.loss_participation??{};
      await client.query(
        `INSERT INTO public.contract_loss_participation (contract_id,enabled,min_loss_ratio_pct,max_loss_ratio_pct,reinsurer_share_pct,slides)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (contract_id) DO UPDATE SET enabled=EXCLUDED.enabled,min_loss_ratio_pct=EXCLUDED.min_loss_ratio_pct,max_loss_ratio_pct=EXCLUDED.max_loss_ratio_pct,reinsurer_share_pct=EXCLUDED.reinsurer_share_pct,slides=EXCLUDED.slides,updated_at=now()`,
        [id,boolOrDefault(lpD.enabled,false),numOrNull(lpD.min_loss_ratio_pct??lpD.minLossRatioPct),
         numOrNull(lpD.max_loss_ratio_pct??lpD.maxLossRatioPct),numOrNull(lpD.reinsurer_share_pct??lpD.reinsurerSharePct),
         JSON.stringify(lpD.slides||[])]);
    }

    // ── Class of business (only if classIds explicitly provided) ──
    if(terms.classIds !== undefined || terms.class_ids !== undefined) {
      const classIds=terms.classIds??terms.class_ids??[];
      await client.query(`DELETE FROM public.contract_class_of_business WHERE contract_id=$1`,[id]);
      const cobInsert = buildBatchInsert({
        table: 'public.contract_class_of_business',
        columns: ['contract_id','class_of_business_id'],
        rows: classIds.filter((cid) => cid != null).map((cid) => [cid]),
        leadingId: id,
        conflict: 'ON CONFLICT DO NOTHING',
      });
      if (cobInsert) await client.query(cobInsert.sql, cobInsert.params);
    }

    // ── EPI split (only if provided) ──
    if(terms.epi_split !== undefined || terms.epiSplit !== undefined) {
      const epiSplit=terms.epi_split??terms.epiSplit??[];
      await client.query(`DELETE FROM public.contract_epi_split WHERE contract_id=$1`,[id]);
      const epiBatch = [];
      for (const r of epiSplit) {
        const cid = r.class_id ?? r.classId ?? r.class_of_business_id;
        if (cid) epiBatch.push([cid, numOrNull(r.premium)]);
      }
      const epiInsert = buildBatchInsert({
        table: 'public.contract_epi_split',
        columns: ['contract_id','class_of_business_id','premium'],
        rows: epiBatch,
        leadingId: id,
      });
      if (epiInsert) await client.query(epiInsert.sql, epiInsert.params);
    }

    // ── UW limits (only if provided and non-empty) ──
    if((terms.underwriting_limits !== undefined || terms.underwritingLimits !== undefined)
       && (terms.underwriting_limits??terms.underwritingLimits??[]).length){
      const uwL=terms.underwriting_limits??terms.underwritingLimits;
      await client.query(`DELETE FROM public.contract_underwriting_limit WHERE contract_id=$1`,[id]);
      const uwBatch = uwL
        .filter((r) => r.class_of_business_id)
        .map((r) => [r.class_of_business_id, numOrNull(r.limit_amount) ?? 0, r.basis || 'COMBINED']);
      const uwInsert = buildBatchInsert({
        table: 'public.contract_underwriting_limit',
        columns: ['contract_id','class_of_business_id','limit_amount','basis'],
        rows: uwBatch,
        leadingId: id,
      });
      if (uwInsert) await client.query(uwInsert.sql, uwInsert.params);
    }

    // ── Event loss tables (pass-through JSON storage, if provided) ──
    if(terms.event_loss_tables) {
      await client.query(
        `INSERT INTO public.contract_event_loss_tables (contract_id, elt_data, data)
         VALUES ($1, $2::jsonb, $2::jsonb)
         ON CONFLICT (contract_id) DO UPDATE SET
           elt_data = EXCLUDED.elt_data,
           data = EXCLUDED.data,
           updated_at = now()`,
        [id, JSON.stringify(terms.event_loss_tables)]
      ).catch((err) => {
        // The contract_event_loss_tables table may not exist in older
        // schemas. Keep going — losing this slice should not fail the
        // whole save — but emit a warn-level log so silent failures are
        // visible in monitoring.
        logger.warn('treaty.event_loss_tables_upsert_failed', { contractId: id, error: err.message });
      });
    }

    const updatedR = await client.query(
      `UPDATE public.contract SET updated_at=now() WHERE contract_id=$1 RETURNING updated_at`,
      [id],
    );

    // Audit BEFORE COMMIT, on the transaction client, so a failed
    // compliance-critical write rolls the whole save back rather than
    // committing a field-diff with no audit record. (actor resolved above.)
    if (staleWriteOverride) {
      await logAudit(client,{
        entityType:"CONTRACT",
        entityId:id,
        eventType:"STALE_WRITE_OVERRIDE",
        actor,
        payload:{
          overrideHeader:"If-Unmodified-Since: *",
          overwrittenBy:actor.id ?? actor.name ?? "SYSTEM",
          overwrittenAt:new Date().toISOString(),
          ...staleWriteContext,
        },
      }, { critical: true });
    }
    await logAudit(client,{entityType:"CONTRACT",entityId:id,eventType:save_mode==="AUTOSAVE"?"AUTOSAVED":"UPDATED",actor}, { critical: save_mode !== "AUTOSAVE" });
    await client.query("COMMIT");
    res.json({ok:true,contract_id:id,updated_at:updatedR.rows[0]?.updated_at||null});
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}));

// ── POST /api/treaties/:id/renew ──
// Creates a renewal DRAFT linked to the parent via parent_contract_id.
// ONLY copies: contract header fields (cedant, broker, country, currency, treaty type, COBs)
//              + prop/NP detail dates (inception = parent renewal_date, renewal = +1yr)
//              + Final Slip document → re-inserted as 'Expiring Slip' on the new contract.
// Everything else (commissions, triangles, losses, pricing, CRESTA) starts BLANK.
router.post("/treaties/:id/renew", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};

  // ── Fetch parent contract + prop detail + Final Slip document ──
  const [origR, propDetailR, npDetailR, cobRen, finalSlipR] = await Promise.all([
    pool.query(
      `SELECT c.*, tt.treaty_type AS treaty_type_name, tt.category AS treaty_category
       FROM public.contract c
       LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
       WHERE c.contract_id = $1`, [id]
    ),
    pool.query(`SELECT * FROM public.contract_prop_details WHERE contract_id = $1`, [id]),
    pool.query(`SELECT * FROM public.contract_np_details  WHERE contract_id = $1`, [id]),
    pool.query(`SELECT class_of_business_id FROM public.contract_class_of_business WHERE contract_id=$1`, [id]),
    // Find the best slip: Final Slip preferred, then Draft Slip, then Expiring Slip
    pool.query(
      `SELECT * FROM public.contract_document
       WHERE contract_id = $1
         AND doc_type IN ('Final Slip','Draft Slip','Expiring Slip')
       ORDER BY
         CASE doc_type WHEN 'Final Slip' THEN 1 WHEN 'Draft Slip' THEN 2 ELSE 3 END
       LIMIT 1`, [id]
    ),
  ]);

  if (!origR.rows.length) return res.status(404).json({ error: 'Contract not found' });

  const o        = origR.rows[0];
  const propD    = propDetailR.rows[0] || null;
  const npD      = npDetailR.rows[0]   || null;
  const renCobs  = cobRen.rows.map(r => r.class_of_business_id);
  const slipDoc  = finalSlipR.rows[0]  || null;
  const isNp     = String(o.treaty_category || '').toUpperCase().includes('NON')
                 || (npDetailR.rows.length > 0)  // np_details row exists = NP contract

  // Date calculations. Roll the period forward: prefer last term's renewal
  // date, then a caller-supplied inception, then the original inception
  // (NOT NULL since migration 104). Guard with a 400 rather than letting a
  // null reach the NOT NULL inception_date column and surface as a 500.
  const newInception = dateOrNull(o.renewal_date) || dateOrNull(b.inception_date) || dateOrNull(o.inception_date);
  if (!newInception) {
    return res.status(400).json({
      error: 'Cannot renew: original contract has no renewal or inception date to roll forward from',
      code: 'VALIDATION_FAILED',
    });
  }
  const newRenewal   = newInception
    ? new Date(new Date(newInception).setFullYear(new Date(newInception).getFullYear() + 1)).toISOString().slice(0, 10)
    : null;
  const newYear = newInception
    ? new Date(newInception).getFullYear()
    : numOrNull(b.uw_year) || ((o.uw_year || new Date().getFullYear()) + 1);

  const renewedByUserId = req.user?.userId || null;

  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');

    // ── 1. New contract header ──
    const { rows: newRows } = await cl.query(
      `INSERT INTO public.contract
         (parent_contract_id, cedant_id, broker_id, country_id, currency_id, treaty_type_id,
          uw_year, status, uw_status, experience_source, primary_class_of_business_id,
          inception_date, renewal_date, contract_description,
          created_by_user_id, assigned_to_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               'DRAFT'::public.contract_status,
               'DRAFT'::public.uw_workflow_status,
               $8,$9,$10,$11,$12,$13,$13)
       RETURNING contract_id`,
      [id, o.cedant_id, o.broker_id, o.country_id, o.currency_id, o.treaty_type_id,
       newYear, o.experience_source, o.primary_class_of_business_id,
       newInception, newRenewal, o.contract_description, renewedByUserId]
    );
    const newId = newRows[0].contract_id;

    // ── 2. Prop detail — structure skeleton only, no commissions/EPI/financial terms ──
    // Dates live on the contract header (already set above); detail-
    // table inception/renewal columns are deprecated, no longer written.
    if (!isNp && propD) {
      await cl.query(
        `INSERT INTO public.contract_prop_details
           (contract_id, triangulations_available, experience_start_year)
         VALUES ($1,$2,$3)
         ON CONFLICT (contract_id) DO NOTHING`,
        [newId, propD.triangulations_available ?? true,
         propD.experience_start_year || null]
      );
    }

    // ── 3. NP detail — dates only ──
    if (isNp && npD) {
      await cl.query(
        `INSERT INTO public.contract_np_details
           (contract_id, experience_start_year)
         VALUES ($1,$2)
         ON CONFLICT (contract_id) DO NOTHING`,
        [newId, npD.experience_start_year || null]
      );
    }

    // ── 4. Copy COBs (class of business stays the same) ──
    const renCobInsert = buildBatchInsert({
      table: 'public.contract_class_of_business',
      columns: ['contract_id','class_of_business_id'],
      rows: renCobs.filter((cobId) => cobId != null).map((cobId) => [cobId]),
      leadingId: newId,
      conflict: 'ON CONFLICT DO NOTHING',
    });
    if (renCobInsert) await cl.query(renCobInsert.sql, renCobInsert.params);

    // ── 5. Copy best slip as 'Expiring Slip' on the new contract ──
    if (slipDoc) {
      await cl.query(
        `INSERT INTO public.contract_document
           (contract_id, doc_type, title, file_name, mime_type, storage_path, size_bytes, description)
         VALUES ($1, 'Expiring Slip', $2, $3, $4, $5, $6, $7)`,
        [newId,
         `Expiring Slip (${slipDoc.doc_type || 'Slip'} from ${o.uw_year || 'prior year'})`,
         slipDoc.file_name,
         slipDoc.mime_type,
         slipDoc.storage_path,
         slipDoc.size_bytes,
         `Carried forward from ${o.uw_year || 'prior year'} renewal`]
      );
    }

    await logAudit(cl, {
      entityType: 'CONTRACT', entityId: newId, eventType: 'RENEWED',
      actor: actorFromReq(req),
      payload: { parent_contract_id: id, uw_year: newYear, slip_copied: !!slipDoc }
    }, { critical: true });
    await cl.query('COMMIT');

    res.status(201).json({
      id: newId,
      contract_id: newId,
      uw_year: newYear,
      treaty_category: o.treaty_category,
      treaty_type_name: o.treaty_type_name,
      is_np: isNp,
      parent_contract_id: id,
      slip_copied: !!slipDoc,
    });
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}));

// ── DELETE /api/treaties/:id ──
router.delete("/treaties/:id", asyncHandler(async (req, res) => {
  await assertCanEdit(req, 'CONTRACT', req.params.id);
  const {rowCount}=await pool.query(`DELETE FROM public.contract WHERE contract_id=$1`,[req.params.id]);
  if(!rowCount) return res.status(404).json({error:"Contract not found"});
  await logAudit(pool,{entityType:"CONTRACT",entityId:req.params.id,eventType:"DELETED",actor:actorFromReq(req)});
  res.json({ok:true,deleted:req.params.id});
}));

// ── GET /api/contracts/:id/history ──
// Read-only, merged audit/history timeline for a contract: contract_audit_event
// + contract_workflow_event + approval_decision (names resolved via uw_user) +
// any field-diff payloads, newest-first. Powers the treaty "History" tab.
router.get("/contracts/:id/history", asyncHandler(async (req, res) => {
  const items = await getContractHistory(req.params.id, { limit: req.query.limit });
  res.json(items);
}));

export default router;
