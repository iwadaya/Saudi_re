// server/src/routes/quoteLifecycle.js
// Quote lifecycle: amendment versioning + binding to contract
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ── GET /api/quotes/:id/versions ─────────────────────────────────────────
// Returns the full version chain for a quote
router.get('/quotes/:id/versions', asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Find the root quote (walk up the chain)
  const { rows: self } = await pool.query(
    `SELECT quote_id, quote_version_of FROM public.quote WHERE quote_id=$1`, [id]
  );
  if (!self.length) return res.status(404).json({ error: 'Quote not found' });

  const rootId = self[0].quote_version_of || id;

  // Get all versions in the chain
  const { rows } = await pool.query(
    `SELECT q.quote_id, q.quote_ref, q.quote_version, q.status, q.quote_version_of,
            q.amendment_reason, q.amended_at, q.bound_contract_id, q.bound_at,
            q.uw_year, q.created_at, q.updated_at,
            ced.company_name AS cedant_name
     FROM public.quote q
     LEFT JOIN public.companies ced ON ced.company_id = q.cedant_id
     WHERE q.quote_id = $1 OR q.quote_version_of = $1
     ORDER BY q.quote_version ASC`,
    [rootId]
  );

  res.json({ root_id: rootId, versions: rows });
}));

// ── POST /api/quotes/:id/amend ────────────────────────────────────────────
// Creates a new amendment version. The current quote is marked SUPERSEDED.
// All relational data is copied to the new version.
// Status flow: APPROVED / AWAITING_SIGNED_LINE / SIGNED → SUPERSEDED
router.post('/quotes/:id/amend', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason, _actor } = req.body;
  const actorName = req.user?.displayName || req.headers['x-user-name'] || _actor || 'Underwriter';
  const actorRole = req.user?.role || req.headers['x-user-role'];
  const creatorId = req.user?.userId || req.headers['x-user-id'] || null;

  // Existence + status preconditions are checked OUTSIDE the transaction so
  // we never return an early-exit response with an open BEGIN on a pool
  // connection. (Previously a 404/400 here released the client mid-txn,
  // returning a dirty connection to the pool.)
  const { rows: origRows } = await pool.query(
    `SELECT quote_id, status, quote_version_of, quote_version, quote_ref
       FROM public.quote WHERE quote_id=$1`,
    [id]
  );
  if (!origRows.length) return res.status(404).json({ error: 'Quote not found' });
  const orig = origRows[0];

  const amendableStatuses = ['APPROVED','AWAITING_SIGNED_LINE','SIGNED','AWAITING_APPROVAL','DRAFT'];
  if (!amendableStatuses.includes(String(orig.status).toUpperCase())) {
    return res.status(400).json({ error: `Cannot amend a quote in status ${orig.status}` });
  }

  // Determine root and next version number
  const rootId   = orig.quote_version_of || id;
  const nextVer  = (orig.quote_version || 1) + 1;
  const quoteRef = orig.quote_ref; // same reference, new version number

  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');

    // Mark the original as SUPERSEDED and stamp the amendment metadata.
    // Both writes use the transaction client — the earlier version sent
    // the amended_at write through `pool.query`, which silently bypassed
    // the txn and could leave amended_at set on a row whose status update
    // had rolled back. Now both succeed together or both roll back.
    await cl.query(
      `UPDATE public.quote
          SET status='SUPERSEDED',
              amended_at=now(),
              amendment_reason=$2,
              updated_at=now()
        WHERE quote_id=$1`,
      [id, reason || null]
    );

    // Create new quote version (copy header). Lifecycle columns
    // (quote_ref/quote_version/quote_version_of) shipped in migration 044;
    // production runs migrations on boot so the previous try/catch
    // fallback is dead code.
    const { rows: newRows } = await cl.query(
      `INSERT INTO public.quote
         (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year,
          status, experience_source, renewal_date, inception_date, contract_description,
          primary_class_of_business_id, parent_contract_id, alt_contract_id,
          created_by_user_id, assigned_to_user_id,
          quote_ref, quote_version, quote_version_of)
       SELECT cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year,
              'DRAFT', experience_source, renewal_date, inception_date, contract_description,
              primary_class_of_business_id, parent_contract_id, alt_contract_id,
              $2, $2,
              quote_ref, $3, $4
       FROM public.quote WHERE quote_id=$1
       RETURNING *`,
      [id, creatorId, nextVer, rootId]
    );
    const newQuoteId = newRows[0].quote_id;

    // Copy all relational data to new quote
    const copyTables = [
      { src: 'quote_np_details',            pk: 'quote_id', cols: 'number_of_layers,expiring_number_of_layers,deductible,max_retention,accounting_method,xl_type,accounts,brokerage_pct,taxes_pct,no_claims_bonus_pct,profit_commission_pct,est_gnpi,experience_start_year,structures_to_quote' },
      { src: 'quote_np_layers',             pk: 'quote_id', cols: 'layer_number,attachment,layer_limit,aggregate_limit,egnpi,earned_premium,rate,rol,num_reinstatements,reinstatement_pct,annual_agg_deductible,peril_scope,mdp,mdp_pct' },
      { src: 'quote_np_terms',              pk: 'quote_id', cols: 'terms' },
      { src: 'quote_np_egnpi_year',         pk: 'quote_id', cols: 'uw_year,gnpi,inflation_pct' },
      { src: 'quote_np_expiring_layers',    pk: 'quote_id', cols: 'layer_number,attachment,layer_limit,aggregate_limit,egnpi,earned_premium,rate,rol,num_reinstatements,reinstatement_pct,annual_agg_deductible,peril_scope,mdp,mdp_pct' },
      { src: 'quote_np_expiring_terms',     pk: 'quote_id', cols: 'terms' },
      { src: 'quote_np_pricing_inputs',     pk: 'quote_id', cols: 'burn_weight_pct,exposure_weight_pct,pareto_weight_pct,pricing_loading_pct,swiss_re_curve_name' },
      { src: 'quote_np_pricing_layer_inputs', pk: 'quote_id', cols: 'layer_number,expiring_pricing_pct' },
      { src: 'quote_np_pricing_outputs',    pk: 'quote_id', cols: 'layer_number,section,pure_burning_cost,pareto_pricing,burn_plus_pareto,exposure_rating,burn_weight_pct,exposure_weight_pct,pareto_weight_pct,pricing_loading_pct,total_price,prob_attach,prob_exhaust' },
      { src: 'quote_np_final_structure',    pk: 'quote_id', cols: 'structure_no,structure_key,structure_label,selected_for_approval,raw_structure' },
      { src: 'quote_np_final_structure_layer', pk: 'quote_id', cols: 'structure_no,layer_number,layer_key,layer_limit,attachment,egnpi,earned_premium,rate,rol,risk,cat,pure_burn_pct,pareto_pct,burn_plus_pareto_pct,exposure_pct,burn_weight_pct,pareto_weight_pct,exposure_weight_pct,loading_pct,uw_price_pct,risk_pure_burn_pct,risk_pareto_pct,risk_burn_plus_pareto_pct,risk_exposure_pct,risk_burn_weight_pct,risk_pareto_weight_pct,risk_exposure_weight_pct,risk_loading_pct,risk_uw_price_pct,risk_prob_attach_pct,risk_prob_exhaust_pct,cat_pure_burn_pct,cat_pareto_pct,cat_burn_plus_pareto_pct,cat_exposure_pct,cat_burn_weight_pct,cat_pareto_weight_pct,cat_exposure_weight_pct,cat_loading_pct,cat_uw_price_pct,cat_prob_attach_pct,cat_prob_exhaust_pct,raw_layer' },
      { src: 'quote_np_final_structure_cob', pk: 'quote_id', cols: 'structure_no,scope_key,class_of_business_id,limit_amount,layer_flags,manual_flags' },
      { src: 'quote_np_final_expiring_probability', pk: 'quote_id', cols: 'layer_number,prob_attach_pct,prob_exhaust_pct,raw_layer' },
      { src: 'quote_prop_details',          pk: 'quote_id', cols: 'triangulations_available,inception_date,renewal_date,experience_start_year,qs_limit,retention_pct,retention_amt,cession_pct,cession_amt,surplus_max_retention,num_lines,total_capacity,event_limit,aal,quota_share_epi,surplus_epi,brokerage_pct,taxes_pct,loss_cap_pct' },
      { src: 'quote_commissions',           pk: 'quote_id', cols: 'mode,fixed_commission_pct,fixed_commission_qs_pct,fixed_commission_surplus_pct,provisional_commission_pct,sliding_min_loss_ratio,sliding_max_loss_ratio,sliding_min_commission,sliding_max_commission,mgmt_expenses_pct,profit_commission_pct' },
      { src: 'quote_commission_slides',     pk: 'quote_id', cols: 'row_no,loss_ratio_pct,commission_pct' },
      { src: 'quote_loss_participation',    pk: 'quote_id', cols: 'enabled,min_loss_ratio_pct,max_loss_ratio_pct,reinsurer_share_pct' },
      { src: 'quote_class_of_business',     pk: 'quote_id', cols: 'class_of_business_id' },
      { src: 'quote_epi_split',             pk: 'quote_id', cols: 'class_id,premium' },
      { src: 'quote_underwriting_limit',    pk: 'quote_id', cols: 'class_of_business_id,limit_amount,basis' },
      { src: 'quote_cresta_data',           pk: 'quote_id', cols: 'country_id,zone_id,zone_name,eq_agg,ws_agg,flood_agg,srcc_agg,others_agg,residential_bldg_pct,commercial_bldg_pct,commercial_cont_pct,industrial_bldg_pct,industrial_cont_pct,cob_id,treaty_type' },
      { src: 'quote_pricing_outputs',       pk: 'quote_id', cols: 'pricing_json,outputs_json,offer_status,offer_line,offer_comment,offer_approver' },
      { src: 'quote_pricing_yearly',        pk: 'quote_id', cols: 'year_data' },
      { src: 'quote_large_loss_report',     pk: 'quote_id', cols: 'report_date,losses' },
      { src: 'quote_cat_loss_report',       pk: 'quote_id', cols: 'report_date,losses' },
    ];

    for (const { src, cols } of copyTables) {
      const colList = cols.split(',').map(c => c.trim());
      // No silent .catch() here — a failed copy means the amended version
      // is missing data the underwriter expected to inherit. The whole
      // txn rolls back instead of producing a half-copied version.
      await cl.query(
        `INSERT INTO public.${src} (quote_id,${colList.join(',')})
         SELECT $2,${colList.join(',')} FROM public.${src} WHERE quote_id=$1
         ON CONFLICT DO NOTHING`,
        [id, newQuoteId]
      );
    }

    // Copy triangle cells
    await cl.query(
      `INSERT INTO public.quote_triangle_cells (quote_id,tri_type,row_idx,col_idx,val)
       SELECT $2,tri_type,row_idx,col_idx,val FROM public.quote_triangle_cells WHERE quote_id=$1`,
      [id, newQuoteId]
    );

    // Copy dev factors
    await cl.query(
      `INSERT INTO public.quote_dev_factor (quote_id,dev_type,dev_month,chosen_ldf,chosen_cdf,selection_method,tail_factor,bf_ielr,selected_factors_json)
       SELECT $2,dev_type,dev_month,chosen_ldf,chosen_cdf,selection_method,tail_factor,bf_ielr,selected_factors_json
       FROM public.quote_dev_factor WHERE quote_id=$1`,
      [id, newQuoteId]
    );

    // Copy risk/claims profiles
    for (const profileTable of ['quote_risk_profile','quote_claims_profile']) {
      await cl.query(
        `INSERT INTO public.${profileTable} (quote_id,class_of_business_id,c_value,pml_percentage,selected_curve,custom_b,custom_g)
         SELECT $2,class_of_business_id,c_value,pml_percentage,selected_curve,custom_b,custom_g
         FROM public.${profileTable} WHERE quote_id=$1`,
        [id, newQuoteId]
      );
      await cl.query(
        `INSERT INTO public.${profileTable}_band (quote_id,class_of_business_id,from_amt,to_amt,no_of_risks,no_of_claims,total_sum_insured,aggregate_incurred,gross_premium)
         SELECT $2,class_of_business_id,from_amt,to_amt,no_of_risks,no_of_claims,total_sum_insured,aggregate_incurred,gross_premium
         FROM public.${profileTable}_band WHERE quote_id=$1`,
        [id, newQuoteId]
      );
    }

    // Log audit event. Audit-event tables are best-effort: a transient
    // failure here shouldn't roll back a valid business operation. But
    // we DO want to see those failures in logs (the previous `.catch(()
    // => {})` made them invisible), so a missing audit row prompts an
    // investigation instead of silently breaking compliance trails.
    try {
      await cl.query(
        `INSERT INTO public.offer_approval_event (quote_id,event_type,actor_name,actor_role,comment,payload)
         VALUES ($1,'AMENDED',$2,$3,$4,$5)`,
        [newQuoteId, actorName, actorRole||null, reason||null,
         JSON.stringify({ original_quote_id: id, version: nextVer })]
      );
    } catch (err) {
      logger.warn('amend: offer_approval_event insert failed', {
        message: err.message, quote_id: newQuoteId,
      });
    }
    try {
      await cl.query(
        `INSERT INTO public.quote_negotiation_event
           (quote_id, quote_version, event_type, actor_name, actor_role, reason, changed_keys, after_snapshot)
         VALUES ($1,$2,'QUOTE_AMENDED',$3,$4,$5,$6,$7::jsonb)`,
        [
          newQuoteId,
          nextVer,
          actorName,
          actorRole || null,
          reason || null,
          ['quote_version'],
          JSON.stringify({ original_quote_id: id, quote_version: nextVer, reason: reason || null }),
        ]
      );
    } catch (err) {
      logger.warn('amend: quote_negotiation_event insert failed', {
        message: err.message, quote_id: newQuoteId,
      });
    }

    await cl.query('COMMIT');

    res.status(201).json({
      ok: true,
      new_quote_id: newQuoteId,
      quote_ref: quoteRef,
      version: nextVer,
      original_quote_id: id,
    });

  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}));

// ── POST /api/quotes/:id/bind ─────────────────────────────────────────────
// Quote → contract binding is intentionally disabled while quotes run as a
// standalone artefact. The previous implementation (transactional copy of
// the quote into a new SIGNED contract row, with all sub-tables) is
// preserved in git history and can be restored when this is re-wired.
router.post('/quotes/:id/bind', asyncHandler(async (_req, res) => {
  return res.status(410).json({
    error: 'Quote-to-contract binding is disabled in this build.',
    code: 'QUOTE_BIND_DISABLED',
    detail: 'Quotes run standalone — they do not produce contracts. This endpoint will be re-wired in a later release.',
  });
}));

export default router;
