// server/src/routes/lookups.js — Reference data endpoints aligned to actual schema
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
import { invalidateJsonCache, jsonCache, sendCached } from "../middleware/httpCache.js";
const router = Router();

const REF_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function sendRef(req, res, key, loader) {
  const cached = await jsonCache({ key: `ref:${key}`, ttlMs: REF_TTL_MS, loader });
  sendCached(req, res, cached);
}

async function tryQuery(sql, params = [], fallbackSql, fallbackParams) {
  try { const {rows}=await pool.query(sql,params); return rows; }
  catch(e) { if(fallbackSql){try{const{rows}=await pool.query(fallbackSql,fallbackParams||params);return rows;}catch{}} return []; }
}

// Allow cache busting on demand (e.g. after admin creates a new cedant)
router.delete('/ref/cache', (_req, res) => { invalidateJsonCache('ref:'); res.json({ ok: true, cleared: true }); });

// Cedants (companies table in actual schema)
router.get("/cedants", asyncHandler(async (req, res) => {
  const {country_id}=req.query;
  await sendRef(req, res, `cedants:${country_id || 'all'}`, async () => {
    const sql=country_id
      ? "SELECT company_id AS id, company_name AS name, country_id FROM public.companies WHERE country_id=$1 ORDER BY company_name"
      : "SELECT company_id AS id, company_name AS name, country_id FROM public.companies ORDER BY company_name";
    return tryQuery(sql,country_id?[country_id]:[]);
  });
}));

router.get("/cedants/:cedantId/cedant-summary", asyncHandler(async (req, res) => {
  const { cedantId } = req.params;

  // Introspect class_of_business name column (live DB may use class_name or class_of_business)
  const cobCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='class_of_business' ORDER BY ordinal_position`
  );
  const cobColNames = cobCols.rows.map(r => r.column_name);
  const cobIdCol   = cobColNames.find(c => c === 'class_of_business_id') || cobColNames.find(c => c === 'class_id') || cobColNames[0];
  const cobNameCol = cobColNames.find(c => c === 'class_of_business') || cobColNames.find(c => c === 'class_name') || cobColNames[1] || cobColNames[0];

  // Check which optional margin columns exist
  const hasMargCols = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_pricing_outputs' AND column_name='actuarial_margin' LIMIT 1`
  );
  const hasMarg = hasMargCols.rows.length > 0;
  const margCols = hasMarg
    ? 'po.actuarial_margin, po.actual_margin, po.uw_margin, po.technical_result,'
    : 'NULL::numeric AS actuarial_margin, NULL::numeric AS actual_margin, NULL::numeric AS uw_margin, NULL::numeric AS technical_result,';

  // COB subquery using introspected column names
  const cobSubquery = (alias) => `(
    SELECT string_agg(cob.${cobNameCol}, ', ')
    FROM public.contract_class_of_business ccb
    JOIN public.class_of_business cob ON cob.${cobIdCol} = ccb.class_of_business_id
    WHERE ccb.contract_id = ${alias}.contract_id
  )`;

  // Loss ratio from triangles: sum latest diagonal across all origin years
  const lrSubquery = (alias) => `(
    SELECT
      CASE WHEN SUM(prem_val) > 0
        THEN ROUND((SUM(loss_val) / SUM(prem_val) * 100)::numeric, 2)
        ELSE NULL END
    FROM (
      SELECT
        p.origin_year,
        MAX(CASE WHEN p.type = 'PREMIUM'    THEN p.cum_value ELSE 0 END) AS prem_val,
        MAX(CASE WHEN p.type IN ('CLAIMS_PAID','CLAIMS_OS') THEN p.cum_value ELSE 0 END) AS loss_val
      FROM public.contract_triangle_cells p
      WHERE p.contract_id = ${alias}.contract_id
        AND p.type IN ('PREMIUM','CLAIMS_PAID','CLAIMS_OS')
        AND p.dev_months = (
          SELECT MAX(p2.dev_months)
          FROM public.contract_triangle_cells p2
          WHERE p2.contract_id = p.contract_id
            AND p2.type = p.type
            AND p2.origin_year = p.origin_year
        )
      GROUP BY p.origin_year
    ) diag
  )`;

  // ── 1. Prop contracts ──
  const propRows = await tryQuery(`
    SELECT
      c.contract_id,
      c.uw_year,
      c.status,
      c.uw_status,
      c.inception_date,
      c.signed_line_pct,
      c.contract_description,
      'PROP'                                                          AS entity_type,
      tt.treaty_type                                                  AS treaty_type,
      tt.category                                                     AS treaty_category,
      ${cobSubquery('c')}                                             AS cob,
      COALESCE(d.quota_share_epi, 0) + COALESCE(d.surplus_epi, 0)   AS premium,
      COALESCE(d.qs_limit, d.total_capacity, 0)                      AS "limit",
      d.retention_pct,
      d.cession_pct,
      d.brokerage_pct,
      d.event_limit                                                  AS event_limit,
      d.aal                                                          AS aal,
      ${margCols}
      COALESCE(
        po.technical_result,
        (COALESCE(d.quota_share_epi,0) + COALESCE(d.surplus_epi,0))
          * COALESCE(po.actuarial_margin, 0)
      )::numeric                                                     AS net_technical_result,
      co.written_line_pct,
      COALESCE(c.signed_line_pct, co.written_line_pct)               AS effective_line_pct,
      ${lrSubquery('c')}                                             AS triangle_loss_ratio
    FROM public.contract c
    LEFT JOIN public.treaty_type             tt ON c.treaty_type_id = tt.treaty_type_id
    LEFT JOIN public.contract_prop_details    d  ON c.contract_id   = d.contract_id
    LEFT JOIN public.contract_pricing_outputs po ON c.contract_id   = po.contract_id
    LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
               FROM public.contract_offer ORDER BY contract_id, offer_id DESC) co
           ON co.contract_id = c.contract_id
    WHERE c.cedant_id = $1
      AND EXISTS (SELECT 1 FROM public.contract_prop_details pd WHERE pd.contract_id = c.contract_id)
    ORDER BY c.uw_year DESC, c.updated_at DESC
  `, [cedantId]);

  // ── 2. NP contracts ──
  // Weighted margin = SUMPRODUCT(earned_premium * hist_margin) / SUM(earned_premium)
  // Falls back to 1 - weighted_avg_rol if hist_margin not yet saved (pre-migration 052)
  const npRows = await tryQuery(`
    SELECT
      c.contract_id,
      c.uw_year,
      c.status,
      c.uw_status,
      c.inception_date,
      c.signed_line_pct,
      c.contract_description,
      'NP'                                                            AS entity_type,
      tt.treaty_type                                                  AS treaty_type,
      tt.category                                                     AS treaty_category,
      ${cobSubquery('c')}                                             AS cob,
      COALESCE(nl.total_earned_premium, nl.total_rate_premium, 0)    AS premium,
      COALESCE(nl.total_limit, 0)                                    AS "limit",
      NULL::numeric                                                   AS retention_pct,
      NULL::numeric                                                   AS cession_pct,
      NULL::numeric                                                   AS brokerage_pct,
      -- Weighted margins via SUMPRODUCT(ep * margin) / SUM(ep):
      --   actuarial_margin = modelled margin (MARGIN col: (expiring-reinsurer)/expiring)
      --   actual_margin    = historical margin (HIST. MARGIN col: burn-cost based)
      -- Fallback: if modelled_margin not yet saved, approximate from uw_price (reinsurer ROL)
      CASE
        WHEN nl.total_earned_premium > 0 AND nl.weighted_modelled IS NOT NULL
          THEN nl.weighted_modelled / nl.total_earned_premium
        WHEN nl.total_earned_premium > 0 AND nl.weighted_uw_price IS NOT NULL
          THEN 1.0 - (nl.weighted_uw_price / nl.total_earned_premium / 100.0)
        ELSE NULL
      END                                                             AS actuarial_margin,
      CASE
        WHEN nl.total_earned_premium > 0 AND nl.weighted_hist IS NOT NULL
          THEN nl.weighted_hist / nl.total_earned_premium
        ELSE NULL
      END                                                             AS actual_margin,
      NULL::numeric                                                   AS uw_margin,
      NULL::numeric                                                   AS technical_result,
      NULL::numeric                                                   AS event_limit,
      NULL::numeric                                                   AS aal,
      COALESCE(
        nl.total_earned_premium * (
          CASE
            WHEN nl.total_earned_premium > 0 AND nl.weighted_modelled IS NOT NULL
              THEN nl.weighted_modelled / nl.total_earned_premium
            WHEN nl.total_earned_premium > 0 AND nl.weighted_uw_price IS NOT NULL
              THEN 1.0 - (nl.weighted_uw_price / nl.total_earned_premium / 100.0)
            ELSE 0
          END
        ),
        0
      )::numeric                                                      AS net_technical_result,
      co.written_line_pct,
      COALESCE(c.signed_line_pct, co.written_line_pct)               AS effective_line_pct,
      ${lrSubquery('c')}                                             AS triangle_loss_ratio
    FROM public.contract c
    LEFT JOIN public.treaty_type tt ON c.treaty_type_id = tt.treaty_type_id
    LEFT JOIN (
      SELECT contract_id,
             SUM(COALESCE(earned_premium, 0))                                            AS total_earned_premium,
             SUM(COALESCE(rate, 0) / 100.0 * COALESCE(egnpi, 0))                        AS total_rate_premium,
             SUM(COALESCE(layer_limit, 0))                                               AS total_limit,
             -- SUMPRODUCT(ep * modelled_margin) — numerator for actuarial_margin
             -- modelled_margin = MARGIN col = (expiring - reinsurer) / expiring
             SUM(CASE WHEN modelled_margin IS NOT NULL AND earned_premium > 0
                      THEN earned_premium * modelled_margin ELSE NULL END)               AS weighted_modelled,
             -- SUMPRODUCT(ep * hist_margin) — numerator for actual_margin
             -- hist_margin = HIST. MARGIN col = burn-cost historical margin
             SUM(CASE WHEN hist_margin IS NOT NULL AND earned_premium > 0
                      THEN earned_premium * hist_margin ELSE NULL END)                   AS weighted_hist,
             -- Fallback: SUMPRODUCT(ep * uw_price) for pre-052 contracts
             SUM(CASE WHEN uw_price IS NOT NULL AND earned_premium > 0
                      THEN earned_premium * uw_price ELSE NULL END)                      AS weighted_uw_price
        FROM public.contract_np_layers GROUP BY contract_id
    ) nl ON nl.contract_id = c.contract_id
    LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
               FROM public.contract_offer ORDER BY contract_id, offer_id DESC) co
           ON co.contract_id = c.contract_id
    WHERE c.cedant_id = $1
      AND EXISTS (SELECT 1 FROM public.contract_np_details nd WHERE nd.contract_id = c.contract_id)
    ORDER BY c.uw_year DESC, c.updated_at DESC
  `, [cedantId]);

  // Merge, deduplicate, sort
  const seen = new Set();
  const merged = [];
  for (const r of [...propRows, ...npRows]) {
    const key = String(r.contract_id);
    if (!seen.has(key)) { seen.add(key); merged.push(r); }
  }
  merged.sort((a, b) => (b.uw_year || 0) - (a.uw_year || 0));
  res.json(merged);
}));


// Brokers
router.get("/brokers", asyncHandler(async (req, res) => {
  await sendRef(req, res, 'brokers', async () => {
    for (const sql of [
      "SELECT broker_id AS id, broker_name AS name FROM public.brokers ORDER BY broker_name",
      "SELECT broker_id AS id, name FROM public.brokers ORDER BY name",
      "SELECT id, name FROM public.brokers ORDER BY name",
    ]) { try { const {rows}=await pool.query(sql); return rows; } catch{} }
    return [];
  });
}));

// Reinsurers — cached + ETag'd like every other ref list
router.get("/reinsurers", asyncHandler(async (req, res) => {
  await sendRef(req, res, 'reinsurers', async () => {
    const rows = await tryQuery("SELECT reinsurer_id AS id, reinsurer_name AS name FROM public.reinsurers ORDER BY reinsurer_name");
    return rows.length ? rows : [
      {id:1,name:"Munich Re"},{id:2,name:"Swiss Re"},{id:3,name:"Hannover Re"},{id:4,name:"SCOR"},{id:5,name:"RenaissanceRe"},
    ];
  });
}));

// Treaty Types — canonical table (treaty_type singular, has FK constraints)
router.get("/treaty-types", asyncHandler(async (req, res) => {
  await sendRef(req, res, 'treaty-types', async () => {
    const {rows} = await pool.query(
      "SELECT treaty_type_id AS id, treaty_type AS name, category FROM public.treaty_type ORDER BY category, treaty_type"
    );
    return rows;
  });
}));

// Class of Business
router.get("/class-of-business", asyncHandler(async (req, res) => {
  await sendRef(req, res, 'class-of-business', async () => {
    const colRes = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='class_of_business'
        ORDER BY ordinal_position`
    );

    const cols = colRes.rows.map(r => r.column_name);

    // Prefer explicit known columns. Never use an _id column as the display name.
    const idCol =
      cols.find(c => c === 'class_of_business_id') ||
      cols.find(c => c === 'class_id') ||
      cols.find(c => c.endsWith('_id')) ||
      cols[0];

    const nameCol =
      cols.find(c => c === 'class_of_business') ||
      cols.find(c => c === 'class_name') ||
      cols.find(c => c === 'name') ||
      cols.find(c => !c.endsWith('_id') && (c.includes('class') || c.includes('business') || c.includes('name'))) ||
      cols.find(c => !c.endsWith('_id')) ||
      cols[1] ||
      cols[0];

    const codeCol = cols.find(c => c === 'code') || null;
    const selectCode = codeCol ? `, ${codeCol} AS code` : '';

    const { rows } = await pool.query(
      `SELECT ${idCol} AS id, ${nameCol} AS name${selectCode}
         FROM public.class_of_business
        ORDER BY ${nameCol}`
    );
    return rows;
  });
}));

// Generic ref lists
router.get("/ref/lists/:key/items", asyncHandler(async (req, res) => {
  const {key}=req.params;
  await sendRef(req, res, `list:${key}`, async () => {
    // Try ref_list table first (may not exist or may be empty)
    try{
      const{rows:listRows}=await pool.query("SELECT list_id FROM public.ref_list WHERE list_key=$1 LIMIT 1",[key]);
      if(listRows.length){
        const{rows}=await pool.query("SELECT item_id AS id,name,code FROM public.ref_list_item WHERE list_id=$1 AND is_active=true ORDER BY sort_order,name",[listRows[0].list_id]);
        if(rows.length) return rows;
      }
    }catch(e){}

    // Direct table fallback
    if(key==="country"){
      try{
        const{rows}=await pool.query("SELECT country_id AS id, country_name AS name, country_code AS code FROM public.country ORDER BY country_name");
        return rows;
      }catch(e){}
      return [];
    }
    if(key==="currency"){
      try{
        const{rows}=await pool.query("SELECT currency_id AS id, currency_code AS name, currency_code AS code FROM public.currency ORDER BY currency_code");
        return rows;
      }catch(e){}
      return [];
    }
    return [];
  });
}));

// CRESTA zones
router.get("/ref/cresta-zones/:countryId", asyncHandler(async (req, res) => {
  await sendRef(req, res, `cresta-zones:${req.params.countryId}`, () =>
    tryQuery("SELECT zone_id,zone_name FROM public.ref_cresta_zone WHERE country_id=$1 ORDER BY sort_order,zone_id",[req.params.countryId])
  );
}));

// Inflation
router.get("/ref/inflation/:countryId", asyncHandler(async (req, res) => {
  const {countryId}=req.params;const startYear=req.query.start_year?parseInt(req.query.start_year,10):null;const endYear=req.query.end_year?parseInt(req.query.end_year,10):null;
  await sendRef(req, res, `inflation:${countryId}:${startYear || ''}:${endYear || ''}`, async () => {
    const params=[countryId];let where="WHERE country_id=$1";
    if(Number.isFinite(startYear)){params.push(startYear);where+=` AND uw_year>=$${params.length}`;}
    if(Number.isFinite(endYear)){params.push(endYear);where+=` AND uw_year<=$${params.length}`;}
    return tryQuery(`SELECT uw_year AS "uwYear",inflation_pct AS "inflationPct" FROM public.ref_country_inflation ${where} ORDER BY uw_year`,params);
  });
}));

// Benchmark LDFs
router.get("/ref/benchmark-ldf/:countryId", asyncHandler(async (req, res) => {
  const {countryId}=req.params;const {tail_type}=req.query;
  await sendRef(req, res, `benchmark-ldf:${countryId}:${tail_type || ''}`, async () => {
    const params=[countryId];let where="WHERE country_id=$1";
    if(tail_type){params.push(tail_type);where+=` AND tail_type=$${params.length}`;}
    return tryQuery(`SELECT * FROM public.ref_benchmark_ldf ${where} ORDER BY development_month`,params);
  });
}));

// ── Exchange Rates ──
// GET all latest rates (one per currency, most recent effective_date)
router.get("/ref/exchange-rates", asyncHandler(async (req, res) => {
  await sendRef(req, res, 'exchange-rates:latest', () => tryQuery(`
      SELECT DISTINCT ON (currency_code)
        rate_id, currency_code, rate_to_usd, effective_date, source
      FROM public.ref_exchange_rate
      ORDER BY currency_code, effective_date DESC
    `)
  );
}));

// GET rate for a specific currency (latest)
router.get("/ref/exchange-rates/:code", asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  await sendRef(req, res, `exchange-rate:${code}`, async () => {
    const rows = await tryQuery(
      `SELECT * FROM public.ref_exchange_rate WHERE currency_code=$1 ORDER BY effective_date DESC LIMIT 1`, [code]
    );
    return rows[0] || null;
  });
}));

// PUT update/insert a rate — invalidates the ref cache so the next GET
// sees the new value without waiting for the 5-min TTL.
router.put("/ref/exchange-rates/:code", asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { rate_to_usd, effective_date } = req.body;
  const dt = effective_date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO public.ref_exchange_rate (currency_code, rate_to_usd, effective_date, source)
     VALUES ($1, $2, $3, 'MANUAL')
     ON CONFLICT (currency_code, effective_date) DO UPDATE SET
       rate_to_usd = EXCLUDED.rate_to_usd, source = 'MANUAL', updated_at = now()
     RETURNING *`, [code, rate_to_usd, dt]
  );
  // Drop cached exchange-rate reads so clients see the new value promptly
  invalidateJsonCache('ref:exchange-rate');
  res.json(rows[0]);
}));

export default router;
