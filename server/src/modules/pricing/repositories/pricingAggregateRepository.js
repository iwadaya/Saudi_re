import { pool } from '../../../db/pool.js';

let _cobCols = null;

async function getCobCols() {
  if (_cobCols) return _cobCols;
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='class_of_business'
       ORDER BY ordinal_position`
    );
    const names = rows.map(r => r.column_name);
    _cobCols = {
      pk: names.find(n => n === 'class_of_business_id')
        || names.find(n => n === 'class_id')
        || names.find(n => n.endsWith('_id'))
        || names[0]
        || 'class_of_business_id',
      name: names.find(n => n === 'class_of_business')
        || names.find(n => n === 'class_name')
        || names.find(n => n === 'name')
        || names.find(n => !['class_of_business_id', 'class_id', 'code'].includes(n))
        || 'class_of_business',
    };
  } catch {
    _cobCols = { pk: 'class_of_business_id', name: 'class_of_business' };
  }
  return _cobCols;
}

function cobJoin(cols) {
  return `LEFT JOIN public.class_of_business cob ON cob.${cols.pk}::text = cd.cob_id::text`;
}

function cobLabel(cols, fallback = "cd.cob_id::text, 'Unclassified'") {
  return `COALESCE(NULLIF(cd.cob_name,''), cob.${cols.name}, ${fallback})`;
}

export async function getCountryAggregates(countryId, excludeId) {
  const params = [countryId];
  let excludeClause = '';
  if (excludeId) {
    excludeClause = 'AND c.contract_id::text != $2::text';
    params.push(excludeId);
  }

  const sql = `
    SELECT
      COALESCE(SUM(cd_sum.total_agg),0) AS total_country_agg,
      COALESCE(SUM(cd_sum.total_agg * COALESCE(c.signed_line_pct, co_latest.written_line_pct, 0) / 100.0),0) AS weighted_country_agg
    FROM public.contract c
    LEFT JOIN (
      SELECT contract_id,
        SUM(COALESCE(eq_agg,0)+COALESCE(ws_agg,0)+COALESCE(flood_agg,0)+COALESCE(srcc_agg,0)+COALESCE(others_agg,0)) AS total_agg
      FROM public.contract_cresta_data
      WHERE country_id::text=$1::text
      GROUP BY contract_id
    ) cd_sum ON cd_sum.contract_id = c.contract_id
    LEFT JOIN (
      SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
      FROM public.contract_offer
      ORDER BY contract_id, offer_id DESC
    ) co_latest ON co_latest.contract_id = c.contract_id
    WHERE c.country_id::text=$1::text
      AND c.uw_status NOT IN ('DECLINED','NTU')
      ${excludeClause}
  `;
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

export async function getAggCobBreakdown(contractId) {
  const cols = await getCobCols();
  const labelWithId = cobLabel(cols);
  const contractCountry = await pool.query('SELECT country_id FROM public.contract WHERE contract_id=$1', [contractId]);
  const countryId = contractCountry.rows[0]?.country_id;

  const contractRows = await pool.query(
    `SELECT
      ${labelWithId} AS cob,
      COALESCE(SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)),0) AS total_agg,
      COALESCE(SUM(COALESCE(cd.eq_agg,0)),0) AS eq_agg,
      COALESCE(SUM(COALESCE(cd.ws_agg,0)),0) AS ws_agg,
      COALESCE(SUM(COALESCE(cd.flood_agg,0)),0) AS flood_agg,
      COALESCE(SUM(COALESCE(cd.srcc_agg,0)),0) AS srcc_agg,
      COALESCE(SUM(COALESCE(cd.others_agg,0)),0) AS others_agg
     FROM public.contract_cresta_data cd
     ${cobJoin(cols)}
     WHERE cd.contract_id=$1
     GROUP BY ${labelWithId}
     ORDER BY total_agg DESC`,
    [contractId]
  );

  let countryOtherRows = [];
  if (countryId) {
    const result = await pool.query(
      `SELECT
        ${labelWithId} AS cob,
        COALESCE(SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)),0) AS total_agg,
        COALESCE(SUM(COALESCE(cd.eq_agg,0)),0) AS eq_agg,
        COALESCE(SUM(COALESCE(cd.ws_agg,0)),0) AS ws_agg,
        COALESCE(SUM(COALESCE(cd.flood_agg,0)),0) AS flood_agg,
        COALESCE(SUM(COALESCE(cd.srcc_agg,0)),0) AS srcc_agg,
        COALESCE(SUM(COALESCE(cd.others_agg,0)),0) AS others_agg
       FROM public.contract_cresta_data cd
       JOIN public.contract c ON c.contract_id = cd.contract_id
       ${cobJoin(cols)}
       WHERE c.country_id = $1
         AND c.contract_id != $2
         AND c.uw_status NOT IN ('DECLINED','NTU')
       GROUP BY ${labelWithId}
       ORDER BY total_agg DESC`,
      [countryId, contractId]
    );
    countryOtherRows = result.rows;
  }

  return {
    contract: contractRows.rows,
    country_others: countryOtherRows,
  };
}

export async function getAggDrilldown(contractId) {
  const cols = await getCobCols();
  const label = cobLabel(cols, "'Unclassified'");
  const contractResult = await pool.query(
    `SELECT c.contract_id, c.country_id, cnt.country_name, cnt.country_code,
            c.signed_line_pct, c.uw_year
     FROM public.contract c
     LEFT JOIN public.country cnt ON cnt.country_id::text = c.country_id::text
     WHERE c.contract_id=$1`,
    [contractId]
  );
  if (!contractResult.rows.length) return null;
  const contract = contractResult.rows[0];
  const countryId = contract.country_id;

  const zonesRes = await pool.query(
    `SELECT
      zone_id, zone_name,
      COALESCE(eq_agg,0) AS eq_agg, COALESCE(ws_agg,0) AS ws_agg,
      COALESCE(flood_agg,0) AS flood_agg, COALESCE(srcc_agg,0) AS srcc_agg,
      COALESCE(others_agg,0) AS others_agg,
      COALESCE(eq_agg,0)+COALESCE(ws_agg,0)+COALESCE(flood_agg,0)+COALESCE(srcc_agg,0)+COALESCE(others_agg,0) AS total_agg,
      COALESCE(NULLIF(cob_name,''),'All Classes') AS cob_name
     FROM public.contract_cresta_data
     WHERE contract_id=$1
     ORDER BY total_agg DESC`,
    [contractId]
  );

  const cobRes = await pool.query(
    `SELECT
      ${label} AS cob,
      SUM(COALESCE(cd.eq_agg,0)) AS eq_agg, SUM(COALESCE(cd.ws_agg,0)) AS ws_agg,
      SUM(COALESCE(cd.flood_agg,0)) AS flood_agg, SUM(COALESCE(cd.srcc_agg,0)) AS srcc_agg,
      SUM(COALESCE(cd.others_agg,0)) AS others_agg,
      SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)) AS total_agg
     FROM public.contract_cresta_data cd
     ${cobJoin(cols)}
     WHERE cd.contract_id=$1
     GROUP BY ${label}
     ORDER BY total_agg DESC`,
    [contractId]
  );

  let portfolioZones = [];
  let portfolioCob = [];
  let portfolioContracts = [];
  if (countryId) {
    const pzRes = await pool.query(
      `SELECT
        cd.zone_id, cd.zone_name,
        SUM(COALESCE(cd.eq_agg,0)) AS eq_agg, SUM(COALESCE(cd.ws_agg,0)) AS ws_agg,
        SUM(COALESCE(cd.flood_agg,0)) AS flood_agg, SUM(COALESCE(cd.srcc_agg,0)) AS srcc_agg,
        SUM(COALESCE(cd.others_agg,0)) AS others_agg,
        SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)) AS total_agg,
        COUNT(DISTINCT cd.contract_id) AS contract_count
       FROM public.contract_cresta_data cd
       JOIN public.contract c ON c.contract_id = cd.contract_id
       WHERE c.country_id::text = $1::text
         AND c.uw_status NOT IN ('DECLINED','NTU')
       GROUP BY cd.zone_id, cd.zone_name
       ORDER BY total_agg DESC`,
      [countryId]
    );
    portfolioZones = pzRes.rows;

    const pcRes = await pool.query(
      `SELECT
        ${label} AS cob,
        SUM(COALESCE(cd.eq_agg,0)) AS eq_agg, SUM(COALESCE(cd.ws_agg,0)) AS ws_agg,
        SUM(COALESCE(cd.flood_agg,0)) AS flood_agg, SUM(COALESCE(cd.srcc_agg,0)) AS srcc_agg,
        SUM(COALESCE(cd.others_agg,0)) AS others_agg,
        SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)) AS total_agg
       FROM public.contract_cresta_data cd
       JOIN public.contract c ON c.contract_id = cd.contract_id
       ${cobJoin(cols)}
       WHERE c.country_id::text = $1::text
         AND c.uw_status NOT IN ('DECLINED','NTU')
       GROUP BY ${label}
       ORDER BY total_agg DESC`,
      [countryId]
    );
    portfolioCob = pcRes.rows;

    const contractPortfolioRes = await pool.query(
      `SELECT
        c.contract_id, c.uw_year,
        co.company_name AS cedant_name,
        COALESCE(c.signed_line_pct, 0) AS signed_line_pct,
        SUM(COALESCE(cd.eq_agg,0)+COALESCE(cd.ws_agg,0)+COALESCE(cd.flood_agg,0)+COALESCE(cd.srcc_agg,0)+COALESCE(cd.others_agg,0)) AS total_agg
       FROM public.contract c
       LEFT JOIN public.contract_cresta_data cd ON cd.contract_id = c.contract_id
       LEFT JOIN public.companies co ON co.company_id = c.cedant_id
       WHERE c.country_id::text = $1::text
         AND c.uw_status NOT IN ('DECLINED','NTU')
       GROUP BY c.contract_id, c.uw_year, co.company_name, c.signed_line_pct
       ORDER BY total_agg DESC
       LIMIT 15`,
      [countryId]
    );
    portfolioContracts = contractPortfolioRes.rows;
  }

  return {
    contract: {
      contract_id: contractId,
      country_name: contract.country_name,
      country_code: contract.country_code,
      uw_year: contract.uw_year,
      signed_line_pct: contract.signed_line_pct,
    },
    zones: zonesRes.rows,
    cob: cobRes.rows,
    portfolio: {
      zones: portfolioZones,
      cob: portfolioCob,
      contracts: portfolioContracts,
    },
  };
}

const MIN_CONTRACTS = 3;

const TREATY_TYPE_JOIN = `JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id`;

// Proportional treaty types. The schema uses treaty_type.category
// ('PROPORTIONAL' | 'NON_PROPORTIONAL'); there is no product_line column,
// so we match category plus name fallbacks (Quota Share, surpluses, etc.).
const PROP_FILTER = `AND (
        tt.category = 'PROPORTIONAL'
        OR tt.treaty_type ILIKE '%quota%'
        OR tt.treaty_type ILIKE '%surplus%'
        OR tt.treaty_type ILIKE '%proportional%'
      )`;

// Same CTE structure / weighted-average formula as the original query; each
// tier injects its own JOIN and WHERE fragments while the contract set is
// resolved once in the `eligible` CTE so the filter isn't duplicated.
function buildAvgQuery(joinClause, whereClause) {
  return `
    WITH eligible AS (
      SELECT DISTINCT c.contract_id
      FROM public.contract c
      ${joinClause}
      WHERE COALESCE(c.status::text, '') <> 'QUOTED'
        ${whereClause}
    ),
    parsed AS (
      SELECT pc.contract_id,
             pc.component_name,
             NULLIF(replace(replace(pc.actuarial_value, '%', ''), ',', ''), '')::numeric / 100.0 AS value_decimal
      FROM public.pricing_components pc
      JOIN eligible e ON e.contract_id = pc.contract_id
      WHERE pc.actuarial_value IS NOT NULL
        AND pc.actuarial_value <> ''
    ),
    weights AS (
      SELECT c.contract_id,
             GREATEST(0,
               COALESCE(pd.quota_share_epi, 0)
               + COALESCE(pd.surplus_epi, 0)
               + COALESCE(nd.est_gnpi, 0)
             ) AS total_premium
      FROM public.contract c
      JOIN eligible e ON e.contract_id = c.contract_id
      LEFT JOIN public.contract_prop_details pd ON pd.contract_id = c.contract_id
      LEFT JOIN public.contract_np_details   nd ON nd.contract_id = c.contract_id
    )
    SELECT parsed.component_name,
           CASE
             WHEN SUM(CASE WHEN w.total_premium > 0 THEN w.total_premium ELSE 0 END) > 0
               THEN SUM(parsed.value_decimal * w.total_premium)
                    / SUM(CASE WHEN w.total_premium > 0 THEN w.total_premium ELSE 0 END)
             ELSE AVG(parsed.value_decimal)
           END AS avg_value,
           COUNT(DISTINCT parsed.contract_id) AS contract_count
    FROM parsed
    JOIN weights w ON w.contract_id = parsed.contract_id
    WHERE parsed.value_decimal IS NOT NULL
    GROUP BY parsed.component_name`;
}

function toComponents(rows) {
  return Object.fromEntries(
    rows.map(r => [r.component_name, r.avg_value != null ? Number(r.avg_value) : null]),
  );
}

function maxContractCount(rows) {
  return rows.reduce((m, r) => Math.max(m, Number(r.contract_count) || 0), 0);
}

export async function getMarketAverage(countryId, exclude, {
  treatyTypeId = null,
  cobIds = [],
  region = null,
} = {}) {
  // Tiered market average: filter by treaty type + COB, falling back through
  // progressively broader geographic / type scopes until a tier has enough
  // (≥ MIN_CONTRACTS distinct) contracts. The weighted-average formula, the
  // QUOTED-status exclusion, and the component names are unchanged from the
  // original single-tier query. avg_value is a decimal (0.0062 = 0.62%).
  const currentId = exclude; // the current contract is also the one excluded
  // Appends the current-contract exclusion, allocating the next param slot.
  const excludeClause = (params) => {
    if (!exclude) return '';
    params.push(exclude);
    return ` AND c.contract_id <> $${params.length}`;
  };

  const tiers = [];

  // Tier 1: same country + same treaty type + COB overlap with current contract.
  // Overlap = candidate shares ≥ 1 class_of_business_id with the current contract.
  if (countryId && treatyTypeId && currentId && cobIds.length > 0) {
    tiers.push({
      tier: 1,
      join: `
        JOIN public.contract_class_of_business ccob
          ON ccob.contract_id = c.contract_id
        JOIN public.contract_class_of_business ccob_curr
          ON ccob_curr.class_of_business_id = ccob.class_of_business_id
         AND ccob_curr.contract_id = $3`,
      where: `AND c.country_id = $1 AND c.treaty_type_id = $2 AND c.contract_id <> $3`,
      params: [countryId, treatyTypeId, currentId],
    });
  }

  // Tier 2: same country + same treaty type (ignore COB).
  if (countryId && treatyTypeId) {
    const params = [countryId, treatyTypeId];
    const where = `AND c.country_id = $1 AND c.treaty_type_id = $2${excludeClause(params)}`;
    tiers.push({ tier: 2, join: '', where, params });
  }

  // Tier 3: same country + any proportional treaty type.
  if (countryId) {
    const params = [countryId];
    const where = `AND c.country_id = $1 ${PROP_FILTER}${excludeClause(params)}`;
    tiers.push({ tier: 3, join: TREATY_TYPE_JOIN, where, params });
  }

  // Tier 4: same region + any proportional.
  if (region) {
    const params = [region];
    const where = `${PROP_FILTER}${excludeClause(params)}`;
    tiers.push({
      tier: 4,
      join: `${TREATY_TYPE_JOIN}
        JOIN public.country co ON co.country_id = c.country_id AND co.region = $1`,
      where,
      params,
    });
  }

  // Tier 5: global + any proportional.
  {
    const params = [];
    const where = `${PROP_FILTER}${excludeClause(params)}`;
    tiers.push({ tier: 5, join: TREATY_TYPE_JOIN, where, params });
  }

  let fallback = { components: {}, tier: null, contractCount: 0 };
  for (const t of tiers) {
    let rows;
    try {
      ({ rows } = await pool.query(buildAvgQuery(t.join, t.where), t.params));
    } catch {
      continue; // a tier whose optional inputs don't fit the schema is skipped
    }
    const count = maxContractCount(rows);
    // Broadest tier doubles as the fallback when nothing meets the threshold.
    if (t.tier === 5) {
      fallback = { components: toComponents(rows), tier: rows.length ? 5 : null, contractCount: count };
    }
    if (count >= MIN_CONTRACTS) {
      return { components: toComponents(rows), tier: t.tier, contractCount: count };
    }
  }
  return fallback;
}
