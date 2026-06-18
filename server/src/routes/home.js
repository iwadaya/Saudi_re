// server/src/routes/home.js — Home summary aligned to actual schema.
// Canonical column names are enforced by migrations 000_core_schema and
// 038_fix_schema_column_gaps:
//   class_of_business (class_of_business_id, class_of_business, code)
//   brokers           (broker_id, broker_name)
//   contract_class_of_business / quote_class_of_business (class_of_business_id)
// Reference them directly — if a deployment ever lacks them, fail loud
// rather than silently dropping COB tags or broker names.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
const router = Router();

// UUID v4-ish format check. We don't need RFC strictness — any non-UUID
// shape is rejected so it can never reach a SQL bind.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/home/summary", asyncHandler(async (req, res) => {
  const qUserId = req.query.user_id;
  const myUserId = req.user?.userId || null;
  // Reject malformed user_id immediately. Without this, an invalid value
  // wouldn't crash (we parameterise below), but quietly returning empty
  // is more useful as a 400 — the client knows it sent garbage.
  if (qUserId && qUserId !== 'all' && !UUID_RE.test(String(qUserId))) {
    return res.status(400).json({ error: 'Invalid user_id', code: 'BAD_REQUEST' });
  }
  // Home lists default to the caller's own work; calculations stay
  // whole-portfolio (statusCounts, region_premiums, portfolio-export below
  // never read filterUserId). The Settings "View treaties" toggle sends
  // scope=all to widen the lists to the whole book.
  const scope = String(req.query.scope || '').toLowerCase();
  // List-filter precedence:
  //   1. an explicit user_id → cross-user "view others" (auth-checked below);
  //   2. scope==='all' (or legacy user_id==='all') → null = portfolio-wide lists;
  //   3. otherwise → the caller's own work.
  const filterUserId = qUserId && qUserId !== 'all'
    ? qUserId
    : (scope === 'all' || qUserId === 'all')
      ? null
      : myUserId;

  // Authorization: a caller may view their own home, OR someone at or below
  // them in the hierarchy. The level header is client-controllable, so we
  // re-derive both sides from the DB whenever a cross-user view is requested.
  if (filterUserId && filterUserId !== myUserId) {
    try {
      const { rows } = await pool.query(
        `SELECT u.user_id, r.hierarchy_level
           FROM public.uw_user u
           JOIN public.uw_role r ON r.role_id = u.role_id
          WHERE u.user_id = ANY($1::uuid[])`,
        [[filterUserId, myUserId].filter(Boolean)]
      );
      const targetLevel = rows.find(r => r.user_id === filterUserId)?.hierarchy_level;
      const callerLevel = rows.find(r => r.user_id === myUserId)?.hierarchy_level
                       ?? req.user?.hierarchyLevel ?? 5;
      if (targetLevel == null) {
        return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      }
      // Lower hierarchy_level = more senior. Caller must be at or above the
      // target's seniority (i.e. callerLevel <= targetLevel).
      if (callerLevel > targetLevel) {
        return res.status(403).json({ error: 'Not allowed to view this user', code: 'FORBIDDEN' });
      }
    } catch {
      // If the auth lookup itself fails, fall back to the safer choice
      // (only let the caller see their own home).
      return res.status(500).json({ error: 'Authorization check failed', code: 'INTERNAL' });
    }
  }

  // Pre-aggregate COB per contract in one query — avoids N correlated subqueries
  const cobAgg = async () => {
    const { rows } = await pool.query(
      `SELECT ccb.contract_id,
              string_agg(cob.class_of_business, ', ' ORDER BY cob.class_of_business) AS cob
         FROM public.contract_class_of_business ccb
         JOIN public.class_of_business cob ON cob.class_of_business_id = ccb.class_of_business_id
        GROUP BY ccb.contract_id`
    );
    return Object.fromEntries(rows.map(r => [r.contract_id, r.cob]));
  };
  const cobAggQuote = async () => {
    const { rows } = await pool.query(
      `SELECT qcb.quote_id,
              string_agg(cob.class_of_business, ', ' ORDER BY cob.class_of_business) AS cob
         FROM public.quote_class_of_business qcb
         JOIN public.class_of_business cob ON cob.class_of_business_id = qcb.class_of_business_id
        GROUP BY qcb.quote_id`
    );
    return Object.fromEntries(rows.map(r => [r.quote_id, r.cob]));
  };

  // Bind the user-filter as $1 in every contract query so the value
  // never enters the SQL string. The IS NULL fork preserves the previous
  // behaviour of also showing unassigned items to the requested user.
  const userFilter = filterUserId
    ? `AND (c.assigned_to_user_id = $1 OR c.assigned_to_user_id IS NULL)`
    : '';
  const cParams = filterUserId ? [filterUserId] : [];

  const contractCols = `
    c.contract_id AS id, c.uw_status AS status, ced.company_name AS name, c.cedant_id,
    cnt.country_name AS country, cnt.country_code, tt.treaty_type AS treaty_type,
    tt.category AS treaty_category, c.uw_year, c.renewal_date, c.updated_at,
    c.contract_description, c.parent_contract_id,
    EXISTS(SELECT 1 FROM public.contract_np_details nd WHERE nd.contract_id=c.contract_id) AS has_np_details,
    bk.broker_name AS broker`;
  const contractJoins = `
    FROM public.contract c
    LEFT JOIN public.companies ced ON ced.company_id=c.cedant_id
    LEFT JOIN public.country cnt ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.brokers bk ON bk.broker_id=c.broker_id`;

  const qParams = [];
  let qWhere = `WHERE q.status NOT IN ('BOUND','SUPERSEDED')`;
  if (filterUserId) {
    qWhere += ` AND (q.assigned_to_user_id=$1 OR q.created_by_user_id=$1 OR q.assigned_to_user_id IS NULL)`;
    qParams.push(filterUserId);
  }

  // Run all queries in parallel
  const [
    { rows: statusCounts },
    { rows: drafts },
    { rows: submitted },
    { rows: renewals },
    cobMap,
    cobMapQ,
    regionResult,
    quotesResult,
  ] = await Promise.all([
    pool.query(`SELECT uw_status, COUNT(*)::int AS count FROM public.contract GROUP BY uw_status`),
    pool.query(`SELECT ${contractCols} ${contractJoins} WHERE c.uw_status='DRAFT' ${userFilter} ORDER BY c.updated_at DESC LIMIT 50`, cParams),
    pool.query(`SELECT ${contractCols} ${contractJoins} WHERE c.uw_status NOT IN ('DRAFT') ${userFilter} ORDER BY c.updated_at DESC LIMIT 50`, cParams),
    // Renewals panel: only treaties that are actually candidates for renewal —
    // active/signed contracts whose date falls inside the window AND that don't
    // already have a child renewal draft (otherwise clicking would create a
    // duplicate). Scoped to the resolved owner like drafts/submitted so the
    // default "mine" view shows only the caller's upcoming renewals; scope=all
    // (filterUserId null) leaves userFilter empty and shows everyone's.
    pool.query(`SELECT ${contractCols} ${contractJoins}
                 WHERE c.renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE+interval '60 days'
                   AND c.uw_status NOT IN ('DRAFT','DECLINED','NTU')
                   AND NOT EXISTS (
                     SELECT 1 FROM public.contract child
                      WHERE child.parent_contract_id = c.contract_id
                        AND child.uw_status = 'DRAFT')
                   ${userFilter}
                 ORDER BY c.renewal_date ASC LIMIT 50`, cParams),
    cobAgg(),
    cobAggQuote(),
    pool.query(`
      SELECT
        CASE
          WHEN cnt.region IN ('GCC','Levant','North Africa') THEN 'Middle East'
          WHEN cnt.region IN ('Sub-Saharan Africa') THEN 'Africa'
          WHEN cnt.region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
          WHEN cnt.region = 'Europe' THEN 'Europe'
          WHEN cnt.region = 'Americas' THEN 'Americas'
          ELSE 'Other'
        END AS region_bucket,
        COALESCE(SUM(
          (COALESCE(c.signed_line_pct,
            (SELECT co.written_line_pct FROM public.contract_offer co
             WHERE co.contract_id = c.contract_id ORDER BY co.updated_at DESC LIMIT 1),
            100.0) / 100.0) *
          CASE
            WHEN COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%' THEN
              COALESCE((SELECT SUM(nl.earned_premium) FROM public.contract_np_layers nl
                        WHERE nl.contract_id = c.contract_id AND nl.earned_premium IS NOT NULL), 0)
            ELSE COALESCE(NULLIF(COALESCE(pd.quota_share_epi,0)+COALESCE(pd.surplus_epi,0),0),0)
          END
        ), 0) AS total_epi
      FROM public.contract c
      LEFT JOIN public.country cnt ON cnt.country_id = c.country_id
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN public.contract_prop_details pd ON pd.contract_id = c.contract_id
      WHERE c.uw_status NOT IN ('DRAFT','DECLINED','NTU')
        AND c.uw_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
        AND cnt.region IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT q.quote_id AS id, q.status, ced.company_name AS name,
        cnt.country_name AS country, tt.treaty_type AS treaty_type,
        tt.treaty_type AS treaty_type_name, tt.category AS treaty_category,
        q.uw_year, q.updated_at, q.parent_contract_id,
        bk.broker_name AS broker
      FROM public.quote q
      LEFT JOIN public.companies ced ON ced.company_id=q.cedant_id
      LEFT JOIN public.country cnt ON cnt.country_id=q.country_id
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id=q.treaty_type_id
      LEFT JOIN public.brokers bk ON bk.broker_id=q.broker_id
      ${qWhere}
      ORDER BY q.updated_at DESC LIMIT 50`, qParams
    ).catch(() => ({ rows: [] })),
  ]);

  // Attach pre-aggregated COB strings in JS — O(1) map lookup per row
  drafts.forEach(r => { r.cob = cobMap[r.id] || null; });
  submitted.forEach(r => { r.cob = cobMap[r.id] || null; });
  renewals.forEach(r => { r.cob = cobMap[r.id] || null; });

  // Enrich quotes with quote_ref/quote_version if available
  let quotes = quotesResult.rows.map(r => ({ ...r, cob: cobMapQ[r.id] || null }));
  try {
    const refRows = await pool.query(
      `SELECT quote_id, quote_ref, quote_version FROM public.quote WHERE quote_id = ANY($1::uuid[])`,
      [quotes.map(r => r.id)]
    );
    const refMap = Object.fromEntries(refRows.rows.map(r => [r.quote_id, r]));
    quotes = quotes.map(r => { const m = refMap[r.id]; return m ? { ...r, quote_ref: m.quote_ref, quote_version: m.quote_version } : r; });
  } catch {}

  const region_premiums = regionResult.rows.filter(r => r.region_bucket !== 'Other');
  const byStatus = Object.fromEntries(statusCounts.map(r => [r.uw_status, r.count]));

  res.json({
    stats: {
      // `total` is what the client renders under the "TREATIES MODELLED" card —
      // treat it as the canonical name and drop the legacy `treaties_modelled`
      // alias which was always APPROVED-only and never read by the UI.
      waiting_approval:    byStatus.AWAITING_APPROVAL   || 0,
      waiting_signed_line: (byStatus.AWAITING_SIGNED_LINE || 0) + (byStatus.APPROVED || 0),
      signed:              byStatus.SIGNED              || 0,
      ntu:                 byStatus.NTU                 || 0,
      declined:            byStatus.DECLINED            || 0,
      drafts:              byStatus.DRAFT               || 0,
      total:               statusCounts.reduce((s, r) => s + r.count, 0),
    },
    drafts, submitted, renewals, quotes, region_premiums,
  });
}));

// ── Portfolio export ──────────────────────────────────────────────────────
// GET /api/home/portfolio-export
// Returns all contracts with key financial fields.
// PROP: one row per contract.
// NP:   one row per layer (layer_number, attachment, limit, earned_premium, rol, rate).
router.get("/home/portfolio-export", asyncHandler(async (req, res) => {
  // Prop contracts — one row each
  const { rows: prop } = await pool.query(`
    SELECT
      c.contract_id,
      'PROP'                                        AS category,
      ced.company_name                              AS cedant,
      cnt.country_name                              AS country,
      cnt.region                                    AS region,
      tt.treaty_type                                AS treaty_type,
      c.uw_year,
      c.uw_status                                   AS status,
      cur.currency_code                             AS currency_code,
      -- Exchange rate to SAR. Stored rates are quoted vs USD, so
      -- ccy → SAR = (ccy → USD) / (SAR → USD). NULL if either rate
      -- is missing. SAR itself returns 1.
      CASE WHEN cur.currency_code = 'SAR' THEN 1
           ELSE (
             (SELECT ccy.rate_to_usd FROM public.ref_exchange_rate ccy
               WHERE ccy.currency_code = cur.currency_code
               ORDER BY ccy.effective_date DESC LIMIT 1)
             / NULLIF((SELECT sar.rate_to_usd FROM public.ref_exchange_rate sar
                        WHERE sar.currency_code = 'SAR'
                        ORDER BY sar.effective_date DESC LIMIT 1), 0)
           )
      END                                           AS fx_to_sar,
      -- 100% premium: prefer detail EPI, fall back to pricing outputs
      COALESCE(
        NULLIF(COALESCE(pd.quota_share_epi,0)+COALESCE(pd.surplus_epi,0), 0),
        po.epi, 0
      )                                             AS premium_100,
      -- commission: fixed or provisional from contract_commissions
      COALESCE(
        cm.provisional_commission_pct,
        cm.fixed_commission_pct,
        cm.fixed_commission_qs_pct,
        0
      )                                             AS commission_pct,
      -- written line (latest offer)
      COALESCE(
        (SELECT o.written_line_pct FROM public.contract_offer o
         WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
        0
      )                                             AS written_line_pct,
      -- signed line
      COALESCE(c.signed_line_pct, 0)                AS signed_line_pct,
      -- 100% limit: total programme capacity
      COALESCE(pd.total_capacity, 0)                AS limit_100,
      -- Pricing ratios — UW-chosen value from pricing_components (the
      -- row × column matrix on the PROP pricing screen). Multiplied by
      -- 100 to match the whole-percent convention used by the other
      -- ratio columns in this export (commission_pct, signed_line_pct).
      ROUND(COALESCE(pcv.attr,       0) * 100, 4)   AS attritional_ratio,
      ROUND(COALESCE(pcv.large_load, 0) * 100, 4)   AS large_loss_load,
      ROUND(COALESCE(pcv.cat_load,   0) * 100, 4)   AS cat_loss_load,
      ROUND((
        COALESCE(pcv.attr, 0) + COALESCE(pcv.large_load, 0) + COALESCE(pcv.cat_load, 0) +
        COALESCE(pcv.comm, 0) + COALESCE(pcv.brok,       0) + COALESCE(pcv.tax,      0)
      ) * 100, 4)                                   AS combined_ratio,
      -- Underwriter (prefer the assignee, fall back to the creator)
      COALESCE(uw_a.display_name, uw_c.display_name) AS underwriter_name,
      -- Latest approver
      (SELECT ca.decided_by FROM public.contract_approval ca
        WHERE ca.contract_id = c.contract_id
          AND ca.decision = 'APPROVED'
        ORDER BY ca.decided_at DESC NULLS LAST
        LIMIT 1)                                    AS approver_name,
      -- COB
      (SELECT string_agg(cob.class_of_business, ', ' ORDER BY cob.class_of_business)
       FROM public.contract_class_of_business ccb
       JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
       WHERE ccb.contract_id=c.contract_id)         AS cob
    FROM public.contract c
    LEFT JOIN public.companies ced            ON ced.company_id=c.cedant_id
    LEFT JOIN public.country cnt              ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt           ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.currency cur             ON cur.currency_id=c.currency_id
    LEFT JOIN public.contract_prop_details pd ON pd.contract_id=c.contract_id
    LEFT JOIN public.contract_commissions cm  ON cm.contract_id=c.contract_id
    LEFT JOIN public.contract_pricing_outputs po ON po.contract_id=c.contract_id
    LEFT JOIN public.uw_user uw_a             ON uw_a.user_id = c.assigned_to_user_id
    LEFT JOIN public.uw_user uw_c             ON uw_c.user_id = c.created_by_user_id
    -- Pivot the per-contract pricing_components into one row (six columns).
    LEFT JOIN LATERAL (
      SELECT
        MAX(CASE WHEN pc.component_name = 'Attritional Loss Ratio'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS attr,
        MAX(CASE WHEN pc.component_name = 'Large Loss Loading'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS large_load,
        MAX(CASE WHEN pc.component_name = 'Cat Loss Loading'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS cat_load,
        MAX(CASE WHEN pc.component_name = 'Commissions'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS comm,
        MAX(CASE WHEN pc.component_name = 'Brokerage'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS brok,
        MAX(CASE WHEN pc.component_name = 'Taxes'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS tax
      FROM public.pricing_components pc
      WHERE pc.contract_id = c.contract_id
        AND pc.component_name IN
          ('Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Commissions','Brokerage','Taxes')
    ) pcv ON true
    WHERE COALESCE(tt.category,'') NOT ILIKE '%NP%'
      AND COALESCE(tt.category,'') NOT ILIKE '%NON%'
    ORDER BY c.uw_year DESC, ced.company_name, c.contract_id
  `);

  // NP contracts — one row per layer
  const { rows: np } = await pool.query(`
    SELECT
      c.contract_id,
      'NP'                                          AS category,
      ced.company_name                              AS cedant,
      cnt.country_name                              AS country,
      cnt.region                                    AS region,
      tt.treaty_type                                AS treaty_type,
      c.uw_year,
      c.uw_status                                   AS status,
      cur.currency_code                             AS currency_code,
      -- Exchange rate to SAR. Stored rates are quoted vs USD, so
      -- ccy → SAR = (ccy → USD) / (SAR → USD). NULL if either rate
      -- is missing. SAR itself returns 1.
      CASE WHEN cur.currency_code = 'SAR' THEN 1
           ELSE (
             (SELECT ccy.rate_to_usd FROM public.ref_exchange_rate ccy
               WHERE ccy.currency_code = cur.currency_code
               ORDER BY ccy.effective_date DESC LIMIT 1)
             / NULLIF((SELECT sar.rate_to_usd FROM public.ref_exchange_rate sar
                        WHERE sar.currency_code = 'SAR'
                        ORDER BY sar.effective_date DESC LIMIT 1), 0)
           )
      END                                           AS fx_to_sar,
      nl.layer_number,
      nl.attachment,
      nl.layer_limit                                AS limit_layer,
      COALESCE(nl.earned_premium, 0)                AS premium_100,
      COALESCE(nl.rol, 0)                           AS rol_pct,
      COALESCE(nl.rate, 0)                          AS rate_pct,
      -- brokerage as proxy for cost (NP treaties store brokerage not commission)
      COALESCE(nd.brokerage_pct, 0)                 AS commission_pct,
      COALESCE(nd.est_gnpi, 0)                      AS egnpi_100,
      COALESCE(
        (SELECT o.written_line_pct FROM public.contract_offer o
         WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
        0
      )                                             AS written_line_pct,
      COALESCE(c.signed_line_pct, 0)                AS signed_line_pct,
      -- Pricing ratios — same pricing_components convention as PROP.
      -- NP screens don't currently populate these but the contract may
      -- still have rows if a UW used the PROP breakdown for comparison.
      -- Values repeat across layers of the same contract.
      ROUND(COALESCE(pcv.attr,       0) * 100, 4)   AS attritional_ratio,
      ROUND(COALESCE(pcv.large_load, 0) * 100, 4)   AS large_loss_load,
      ROUND(COALESCE(pcv.cat_load,   0) * 100, 4)   AS cat_loss_load,
      ROUND((
        COALESCE(pcv.attr, 0) + COALESCE(pcv.large_load, 0) + COALESCE(pcv.cat_load, 0) +
        COALESCE(pcv.comm, 0) + COALESCE(pcv.brok,       0) + COALESCE(pcv.tax,      0)
      ) * 100, 4)                                   AS combined_ratio,
      COALESCE(uw_a.display_name, uw_c.display_name) AS underwriter_name,
      (SELECT ca.decided_by FROM public.contract_approval ca
        WHERE ca.contract_id = c.contract_id
          AND ca.decision = 'APPROVED'
        ORDER BY ca.decided_at DESC NULLS LAST
        LIMIT 1)                                    AS approver_name,
      (SELECT string_agg(cob.class_of_business, ', ' ORDER BY cob.class_of_business)
       FROM public.contract_class_of_business ccb
       JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
       WHERE ccb.contract_id=c.contract_id)         AS cob
    FROM public.contract c
    LEFT JOIN public.companies ced            ON ced.company_id=c.cedant_id
    LEFT JOIN public.country cnt              ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt           ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.currency cur             ON cur.currency_id=c.currency_id
    LEFT JOIN public.contract_np_details nd   ON nd.contract_id=c.contract_id
    LEFT JOIN public.contract_np_layers nl    ON nl.contract_id=c.contract_id
    LEFT JOIN public.uw_user uw_a             ON uw_a.user_id = c.assigned_to_user_id
    LEFT JOIN public.uw_user uw_c             ON uw_c.user_id = c.created_by_user_id
    LEFT JOIN LATERAL (
      SELECT
        MAX(CASE WHEN pc.component_name = 'Attritional Loss Ratio'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS attr,
        MAX(CASE WHEN pc.component_name = 'Large Loss Loading'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS large_load,
        MAX(CASE WHEN pc.component_name = 'Cat Loss Loading'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS cat_load,
        MAX(CASE WHEN pc.component_name = 'Commissions'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS comm,
        MAX(CASE WHEN pc.component_name = 'Brokerage'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS brok,
        MAX(CASE WHEN pc.component_name = 'Taxes'
              THEN public.parse_pct_text(COALESCE(NULLIF(pc.uw_value,''), pc.actuarial_value)) END) AS tax
      FROM public.pricing_components pc
      WHERE pc.contract_id = c.contract_id
        AND pc.component_name IN
          ('Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Commissions','Brokerage','Taxes')
    ) pcv ON true
    WHERE (COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%')
    ORDER BY c.uw_year DESC, ced.company_name, c.contract_id, nl.layer_number
  `);

  res.json({ prop, np });
}));

export default router;
