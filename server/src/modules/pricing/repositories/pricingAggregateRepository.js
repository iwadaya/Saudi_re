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

export async function getMarketAverage(countryId, exclude) {
  const baseQuery = `
    SELECT pc.component_name,
           AVG(NULLIF(replace(replace(pc.actuarial_value, '%', ''), ',', ''), '')::numeric) AS avg_value,
           COUNT(DISTINCT pc.contract_id) AS contract_count
    FROM public.pricing_components pc
    JOIN public.contract c ON c.contract_id = pc.contract_id
    WHERE c.country_id = $1
      AND pc.actuarial_value IS NOT NULL
      AND pc.actuarial_value != ''
      ${exclude ? 'AND pc.contract_id != $2' : ''}
    GROUP BY pc.component_name`;
  const params = exclude ? [countryId, exclude] : [countryId];
  const { rows } = await pool.query(baseQuery, params);
  return rows;
}
