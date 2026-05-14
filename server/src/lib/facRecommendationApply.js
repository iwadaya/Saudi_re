// server/src/lib/facRecommendationApply.js
//
// Apply-dispatch: takes one fac_ai_recommendation row + the value to
// use, then performs the right write against whichever entity the
// target_field belongs to (fac_underwriting_factors / fac_location /
// fac_loss_history / fac_clauses_checklist / fac_cope / fac_risk).
//
// Each handler runs inside a caller-supplied DB client so the calling
// route can wrap accept + supersede + audit in a single transaction.
// Returns { beforeValue, afterValue } so the audit row can record the
// effective change.

const APPENDABLE = new Set(['location.append', 'loss_history.append']);

// Risk-level simple fields we accept directly into fac_risk.
const FAC_RISK_COLUMNS = new Set([
  'cedant_name',         // ← stored on companies.company_name, not on fac_risk;
                         //   we don't update the cedant name from the AI today,
                         //   so treat as a no-op write to keep the contract honest.
  'original_insured',    // → insured_name
  'inception_date', 'expiry_date',
  'occupancy_code',
]);

const RISK_FIELD_TO_COLUMN = {
  original_insured: 'insured_name',
  inception_date:   'inception_date',
  expiry_date:      'expiry_date',
  occupancy_code:   'occupancy_code',
};

const COPE_COLUMNS = new Set([
  'construction_year', 'fire_walls', 'sprinkler_system', 'sprinkler_type',
  'fire_brigade_distance_km',
]);

async function applyFactor(client, riskId, code, value) {
  // Upsert the JSONB selection on fac_underwriting_factors. The row
  // may not exist yet — the screen creates it on first save.
  const { rows: before } = await client.query(
    `SELECT selections->>$2 AS v FROM public.fac_underwriting_factors WHERE fac_risk_id = $1`,
    [riskId, code],
  );
  const beforeValue = before.length ? before[0].v : null;
  await client.query(
    `INSERT INTO public.fac_underwriting_factors (fac_risk_id, selections)
     VALUES ($1, jsonb_build_object($2::text, $3::text))
     ON CONFLICT (fac_risk_id) DO UPDATE
        SET selections = public.fac_underwriting_factors.selections
                       || jsonb_build_object($2::text, $3::text)`,
    [riskId, code, String(value ?? '')],
  );
  return { beforeValue, afterValue: String(value ?? '') };
}

async function applyClause(client, riskId, code, value) {
  // suggested_value can be either { is_checked, comments } or a bare bool.
  const isChecked = typeof value === 'object' && value !== null
    ? Boolean(value.is_checked) : Boolean(value);
  const comments = typeof value === 'object' && value !== null
    ? (value.comments ?? null) : null;
  const { rows: before } = await client.query(
    `SELECT is_checked FROM public.fac_clauses_checklist
      WHERE fac_risk_id = $1 AND clause_code = $2`,
    [riskId, code],
  );
  await client.query(
    `INSERT INTO public.fac_clauses_checklist (fac_risk_id, clause_code, is_checked, comments)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (fac_risk_id, clause_code) DO UPDATE
       SET is_checked = EXCLUDED.is_checked,
           comments   = EXCLUDED.comments`,
    [riskId, code, isChecked, comments],
  );
  return { beforeValue: before[0]?.is_checked ?? false, afterValue: isChecked };
}

async function applyLocationAppend(client, riskId, value) {
  if (!value || typeof value !== 'object') {
    throw new Error('location.append requires an object suggested_value');
  }
  const v = value;
  await client.query(
    `INSERT INTO public.fac_location (fac_risk_id, location_name, address, cresta_zone,
        occupancy_code, original_ccy, fx_to_sar,
        original_pd_si, original_bi_si, pd_pml_pct, bi_pml_pct,
        carrier_pd_share_pct, carrier_bi_share_pct, pd_si, bi_si)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      riskId, v.location_name || null, v.address || null, v.cresta_zone || null,
      v.occupancy_code ?? null, v.original_ccy ? String(v.original_ccy).toUpperCase() : null,
      v.fx_to_sar ?? null,
      v.original_pd_si ?? null, v.original_bi_si ?? null,
      v.pd_pml_pct ?? null, v.bi_pml_pct ?? null,
      v.carrier_pd_share_pct ?? null, v.carrier_bi_share_pct ?? null,
      v.pd_si ?? null, v.bi_si ?? null,
    ],
  );
  return { beforeValue: null, afterValue: { location_name: v.location_name || null } };
}

async function applyLossAppend(client, riskId, value) {
  if (!value || typeof value !== 'object') {
    throw new Error('loss_history.append requires an object suggested_value');
  }
  const v = value;
  await client.query(
    `INSERT INTO public.fac_loss_history (fac_risk_id, loss_year, loss_date, loss_description,
        cause_of_loss, fgu_paid, fgu_outstanding, ri_paid, ri_outstanding,
        mitigation_measures, is_open)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      riskId,
      v.loss_year ?? null, v.loss_date || null, v.loss_description || null,
      v.cause_of_loss || null,
      v.fgu_paid ?? null, v.fgu_outstanding ?? null,
      v.ri_paid ?? null, v.ri_outstanding ?? null,
      v.mitigation_measures || null,
      v.is_open == null ? true : Boolean(v.is_open),
    ],
  );
  return { beforeValue: null, afterValue: { loss_year: v.loss_year, fgu_paid: v.fgu_paid } };
}

async function applyCope(client, riskId, key, value) {
  if (!COPE_COLUMNS.has(key)) throw new Error(`Unknown COPE column "${key}"`);
  const { rows: before } = await client.query(
    `SELECT ${key} AS v FROM public.fac_cope WHERE fac_risk_id = $1`,
    [riskId],
  );
  const sql = `
    INSERT INTO public.fac_cope (fac_risk_id, ${key})
    VALUES ($1, $2)
    ON CONFLICT (fac_risk_id) DO UPDATE SET ${key} = EXCLUDED.${key}
  `;
  await client.query(sql, [riskId, value ?? null]);
  return { beforeValue: before[0]?.v ?? null, afterValue: value };
}

async function applyRiskColumn(client, riskId, field, value) {
  if (!FAC_RISK_COLUMNS.has(field)) throw new Error(`Unknown risk field "${field}"`);
  if (field === 'cedant_name') {
    // The cedant name isn't a column on fac_risk — it lives on the
    // linked companies row. We accept the recommendation without
    // changing anything so the UI sees an explicit no-op rather than
    // a 400, and emit a flag the caller can use to flag this.
    return { beforeValue: null, afterValue: value, noOp: true };
  }
  const col = RISK_FIELD_TO_COLUMN[field];
  const { rows: before } = await client.query(
    `SELECT ${col} AS v FROM public.fac_risk WHERE fac_risk_id = $1`, [riskId],
  );
  await client.query(
    `UPDATE public.fac_risk SET ${col} = $2, updated_at = now() WHERE fac_risk_id = $1`,
    [riskId, value ?? null],
  );
  return { beforeValue: before[0]?.v ?? null, afterValue: value };
}

/**
 * Apply one recommendation. Caller owns the transaction (so accept +
 * supersede + audit + recommendation-update can all atomically
 * commit together).
 */
export async function applyRecommendation({ client, riskId, targetField, value }) {
  if (APPENDABLE.has(targetField)) {
    if (targetField === 'location.append') return applyLocationAppend(client, riskId, value);
    return applyLossAppend(client, riskId, value);
  }
  if (targetField.startsWith('factor.')) {
    return applyFactor(client, riskId, targetField.replace(/^factor\./, ''), value);
  }
  if (targetField.startsWith('clause.')) {
    return applyClause(client, riskId, targetField.replace(/^clause\./, ''), value);
  }
  if (targetField.startsWith('cope.')) {
    return applyCope(client, riskId, targetField.replace(/^cope\./, ''), value);
  }
  // location.<i>.<field> — the prompt mentions this shape but our
  // current AI prompts only emit location.append. Documented here so
  // a future prompt can be wired in without a route rewrite.
  if (/^location\.\d+\./.test(targetField)) {
    throw new Error('location.<i>.<field> recommendations are not yet supported');
  }
  if (FAC_RISK_COLUMNS.has(targetField)) {
    return applyRiskColumn(client, riskId, targetField, value);
  }
  throw Object.assign(new Error(`Unknown target_field "${targetField}"`), { status: 400 });
}
