// server/src/routes/portfolioInsights.js
//
// Feature feed for the Portfolio Intelligence module. Emits ONE row per contract
// across the decisioned book — SIGNED / NTU / DECLINED plus in-flight written
// states — reduced to the six components the underwriting team wants tested as
// profitability determinants: country, region, treaty type, class of business,
// balance, ROL. The unsupervised maths (driver ranking, K-means segmentation,
// PCA) run client-side in client/src/logic/portfolioClustering.js, exactly as
// the Reinsurer Analysis curve-fit does — this endpoint is purely the data tap.
//
// Profitability = the platform-canonical UW margin (a fraction): actuarial_margin
// for proportional, premium-weighted modelled_margin across layers for NP. For
// declined / NTU contracts this is the *modelled* (expected-at-decision) margin,
// which is precisely the right lens — they never went on risk, so there is no
// realised result to read. All money is converted to USD and expressed on a
// 100%-treaty basis (not our signed line) so premium and balance are comparable
// across signed vs declined vs NTU; margin is a ratio and so is line-invariant.
//
// The region bucket, NP detection, FX subquery and balance/ROL conventions are
// kept deliberately identical to server/src/routes/dashboard.js so the numbers
// tie out with the portfolio dashboard.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Decisioned book. DRAFT and WAITING_APPROVAL are excluded — they have no settled
// pricing decision and would inject half-priced noise. Edit here to widen/narrow.
const STATUS_SET = ['SIGNED', 'NTU', 'DECLINED', 'APPROVED', 'AWAITING_SIGNED_LINE'];

// Hard cap so a single request can't stream the whole book through a pool
// connection. Truncation is surfaced so the client can warn.
const ROW_LIMIT = 12000;

// GET /api/portfolio-insights
// Returns { rows, meta }. One row per contract.
router.get(
  '/portfolio-insights',
  asyncHandler(async (req, res) => {
    // Optional ?status=SIGNED,NTU,DECLINED override; falls back to STATUS_SET.
    const statusParam = String(req.query.status || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const statuses = statusParam.length ? statusParam : STATUS_SET;

    const sql = `
      WITH fx AS (
        SELECT DISTINCT ON (currency_code)
               currency_code, COALESCE(rate_to_usd, 1.0) AS rate_to_usd
          FROM public.ref_exchange_rate
         ORDER BY currency_code, effective_date DESC
      ),
      -- Latest margin row per contract; DISTINCT ON keeps the join from fanning.
      cpo AS (
        SELECT DISTINCT ON (contract_id) contract_id, actuarial_margin
          FROM public.contract_pricing_outputs
         ORDER BY contract_id, updated_at DESC
      ),
      -- NP layers rolled up to contract grain. Premium weight per layer is the
      -- platform's NP premium = (uw_price%/100) × layer_limit. ROL and modelled
      -- margin are premium-weighted; stored l.rol is already a 0..1 fraction
      -- (uw_price is the percent), matching reinsurerAnalysis / dashboard.
      np_agg AS (
        SELECT
          l.contract_id,
          SUM(COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0))            AS np_prem_local,
          SUM(COALESCE(l.layer_limit,0))                                          AS np_limit_local,
          SUM(COALESCE(l.rol, COALESCE(l.uw_price,0)/100.0)
              * (COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0)))
            / NULLIF(SUM(COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0)),0) AS np_wavg_rol,
          SUM(l.modelled_margin
              * (COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0)))
            FILTER (WHERE l.modelled_margin IS NOT NULL)
            / NULLIF(SUM(COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0))
                     FILTER (WHERE l.modelled_margin IS NOT NULL),0)                AS np_wavg_margin
          FROM public.contract_np_layers l
         GROUP BY l.contract_id
      )
      SELECT
        c.contract_id,
        c.uw_status::text                                       AS status,
        c.uw_year,
        co.country_name,
        -- Region bucket — identical mapping to dashboard.js.
        CASE
          WHEN co.region IN ('GCC','Levant','North Africa')                       THEN 'Middle East'
          WHEN co.region IN ('Sub-Saharan Africa')                                THEN 'Africa'
          WHEN co.region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
          WHEN co.region = 'Europe'   THEN 'Europe'
          WHEN co.region = 'Americas' THEN 'Americas'
          ELSE 'Other'
        END                                                     AS region,
        COALESCE(tt.treaty_type,'Unknown')                      AS treaty_type,
        -- NP detection from the treaty-type category — identical to dashboard.js.
        (COALESCE(tt.category,'') ILIKE '%NP%'
         OR COALESCE(tt.category,'') ILIKE '%NON%')             AS is_np,
        cob.class_of_business                                   AS primary_cob,
        COALESCE(fx.rate_to_usd, 1.0)                           AS rate_to_usd,
        pd.quota_share_epi,
        pd.surplus_epi,
        pd.total_capacity,
        cpo.actuarial_margin,
        na.np_prem_local,
        na.np_limit_local,
        na.np_wavg_rol,
        na.np_wavg_margin
      FROM public.contract c
      LEFT JOIN public.country co            ON co.country_id = c.country_id
      LEFT JOIN public.treaty_type tt        ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN public.class_of_business cob ON cob.class_of_business_id = c.primary_class_of_business_id
      LEFT JOIN public.contract_prop_details pd ON pd.contract_id = c.contract_id
      LEFT JOIN public.currency cur          ON cur.currency_id = c.currency_id
      LEFT JOIN fx                           ON fx.currency_code = cur.currency_code
      LEFT JOIN cpo                          ON cpo.contract_id = c.contract_id
      LEFT JOIN np_agg na                    ON na.contract_id = c.contract_id
      WHERE c.uw_status::text = ANY($1)
      ORDER BY c.uw_year DESC NULLS LAST, c.contract_id
      LIMIT $2
    `;

    let dbRows;
    try {
      const result = await pool.query(sql, [statuses, ROW_LIMIT]);
      dbRows = result.rows;
    } catch (err) {
      logger.error('[portfolio-insights] query failed', { error: err.message });
      throw err;
    }

    const rows = dbRows.map((r) => {
      const isNp = r.is_np === true;
      const ccy = Number(r.rate_to_usd) || 1;

      let premium;
      let exposure;
      let margin;
      let rol;
      let balance;

      if (isNp) {
        premium = (Number(r.np_prem_local) || 0) * ccy;
        exposure = (Number(r.np_limit_local) || 0) * ccy;
        margin = r.np_wavg_margin != null ? Number(r.np_wavg_margin) : null;
        rol = r.np_wavg_rol != null ? Number(r.np_wavg_rol) : null;
        balance = null; // ROL-defined, not balance-defined (matches dashboard)
      } else {
        const epi = (Number(r.quota_share_epi) || 0) + (Number(r.surplus_epi) || 0);
        premium = epi * ccy;
        exposure = (Number(r.total_capacity) || 0) * ccy;
        margin = r.actuarial_margin != null ? Number(r.actuarial_margin) : null;
        rol = null; // balance-defined, not ROL-defined
        balance = premium > 0 ? exposure / premium : null;
      }

      return {
        contractId: r.contract_id,
        status: r.status,
        kind: isNp ? 'NP' : 'PROP',
        country: r.country_name || null,
        region: r.region || null,
        treatyType: r.treaty_type || null,
        cob: r.primary_cob || null,
        uwYear: r.uw_year != null ? Number(r.uw_year) : null,
        premium: Number.isFinite(premium) ? premium : null,
        exposure: Number.isFinite(exposure) ? exposure : null,
        balance: Number.isFinite(balance) ? balance : null,
        rol: Number.isFinite(rol) ? rol : null,
        margin: Number.isFinite(margin) ? margin : null,
      };
    });

    // Drop contracts with neither a usable margin nor any premium signal — they
    // carry no information for either the driver or the clustering pass.
    const usable = rows.filter((r) => r.margin != null || (r.premium != null && r.premium > 0));

    const byStatus = {};
    const byKind = {};
    let scored = 0;
    for (const r of usable) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (r.margin != null) scored += 1;
    }

    res.json({
      rows: usable,
      meta: {
        count: usable.length,
        scored,
        byStatus,
        byKind,
        statuses,
        truncated: dbRows.length >= ROW_LIMIT,
        generatedAt: new Date().toISOString(),
      },
    });
  }),
);

export default router;
