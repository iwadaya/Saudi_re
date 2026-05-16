// seed_1000_test_contracts.js
//
// Bulk-seed ~1000 contracts plus matching quotes, renewals, pricing,
// and workflow state so QA can exercise every proportional /
// non-proportional / commission / treaty-structure combination.
//
// Run with:
//   DATABASE_URL=... node server/src/db/seeds/seed_1000_test_contracts.js
//
// Idempotency: rows are tagged with alt_contract_id='SEED-T1000-...' so
// re-running first wipes the previous batch before reinserting.

import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://universe:universe@localhost:5432/universe';

const TOTAL = Number(process.env.SEED_TOTAL || 1000);
const SEED_TAG = 'SEED-T1000';

const pool = new Pool({ connectionString: DATABASE_URL, max: 12 });

// ─── Determinism ────────────────────────────────────────────────────────────
// Tiny seeded RNG (mulberry32). Allows the dataset to be reproducible.
function rngFactory(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rngFactory(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickN = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
};
const between = (lo, hi) => lo + rand() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));
const roundTo = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

const COMMISSION_VARIANTS = [
  'FIXED_SIMPLE',          // 20-30% fixed pct
  'FIXED_QS_SURPLUS',      // separate qs/surplus fixed pcts
  'SLIDING_BASIC',         // sliding scale only
  'SLIDING_PROFIT',        // sliding + profit commission
  'FIXED_PROFIT',          // fixed + profit commission
  'FIXED_WITH_LCF',        // fixed + loss carry forward
  'SLIDING_LCF_EXT',       // sliding + LCF with extinction
];

const STATUS_DISTRIBUTION = [
  // uw_status, contract_status, weight
  ['DRAFT',                 'DRAFT',              25],
  ['WAITING_APPROVAL',      'AWAITING_APPROVAL',  15],
  ['APPROVED',              'QUOTED',              5],
  ['AWAITING_SIGNED_LINE',  'OFFERED',            10],
  ['SIGNED',                'BOUND',              30],
  ['NTU',                   'NTU',                 7],
  ['DECLINED',              'DECLINED',            8],
];

function statusBucket() {
  const total = STATUS_DISTRIBUTION.reduce((s, [,, w]) => s + w, 0);
  let r = rand() * total;
  for (const row of STATUS_DISTRIBUTION) {
    r -= row[2];
    if (r <= 0) return row;
  }
  return STATUS_DISTRIBUTION[STATUS_DISTRIBUTION.length - 1];
}

// ─── Pure helpers (mirroring shared/pricingMath where possible) ──────────────
function buildSlidingTable(min, max, minComm, maxComm, steps = 8) {
  const span = max - min;
  const commSpan = maxComm - minComm;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      row_no: i,
      loss_ratio_pct: roundTo(min + t * span, 2),
      commission_pct: roundTo(maxComm - t * commSpan, 2),
    });
  }
  return out;
}

function commissionPayload(variant) {
  switch (variant) {
    case 'FIXED_SIMPLE':
      return {
        mode: 'FIXED',
        fixed_commission_pct: roundTo(between(20, 32), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        sliding_table: [],
      };
    case 'FIXED_QS_SURPLUS':
      return {
        mode: 'FIXED',
        fixed_commission_qs_pct: roundTo(between(25, 32), 2),
        fixed_commission_surplus_pct: roundTo(between(20, 28), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        sliding_table: [],
      };
    case 'FIXED_PROFIT':
      return {
        mode: 'FIXED',
        fixed_commission_pct: roundTo(between(20, 30), 2),
        profit_commission_pct: roundTo(between(10, 25), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        sliding_table: [],
      };
    case 'SLIDING_BASIC': {
      const minLR = roundTo(between(40, 50), 2);
      const maxLR = roundTo(between(65, 80), 2);
      const minC = roundTo(between(15, 22), 2);
      const maxC = roundTo(between(30, 38), 2);
      return {
        mode: 'SLIDING',
        provisional_commission_pct: roundTo((minC + maxC) / 2, 2),
        sliding_min_loss_ratio: minLR,
        sliding_max_loss_ratio: maxLR,
        sliding_min_commission: minC,
        sliding_max_commission: maxC,
        sliding_table: buildSlidingTable(minLR, maxLR, minC, maxC),
      };
    }
    case 'SLIDING_PROFIT': {
      const minLR = roundTo(between(38, 50), 2);
      const maxLR = roundTo(between(60, 78), 2);
      const minC = roundTo(between(15, 22), 2);
      const maxC = roundTo(between(28, 36), 2);
      return {
        mode: 'SLIDING',
        provisional_commission_pct: roundTo((minC + maxC) / 2, 2),
        sliding_min_loss_ratio: minLR,
        sliding_max_loss_ratio: maxLR,
        sliding_min_commission: minC,
        sliding_max_commission: maxC,
        profit_commission_pct: roundTo(between(10, 22), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        sliding_table: buildSlidingTable(minLR, maxLR, minC, maxC),
      };
    }
    case 'FIXED_WITH_LCF':
      return {
        mode: 'FIXED',
        fixed_commission_pct: roundTo(between(20, 30), 2),
        profit_commission_pct: roundTo(between(10, 22), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        lcf_years: intBetween(2, 5),
        lcf_extinction: false,
        sliding_table: [],
      };
    case 'SLIDING_LCF_EXT': {
      const minLR = roundTo(between(38, 52), 2);
      const maxLR = roundTo(between(58, 78), 2);
      const minC = roundTo(between(15, 22), 2);
      const maxC = roundTo(between(28, 36), 2);
      return {
        mode: 'SLIDING',
        provisional_commission_pct: roundTo((minC + maxC) / 2, 2),
        sliding_min_loss_ratio: minLR,
        sliding_max_loss_ratio: maxLR,
        sliding_min_commission: minC,
        sliding_max_commission: maxC,
        profit_commission_pct: roundTo(between(8, 18), 2),
        mgmt_expenses_pct: roundTo(between(1, 4), 2),
        lcf_years: intBetween(2, 5),
        lcf_extinction: true,
        sliding_table: buildSlidingTable(minLR, maxLR, minC, maxC),
      };
    }
    default:
      return { mode: 'FIXED', fixed_commission_pct: 25, sliding_table: [] };
  }
}

function propDetail(treatyTypeName) {
  const epi = roundTo(between(2_000_000, 80_000_000), 2);
  const base = {
    triangulations_available: rand() < 0.85,
    brokerage_pct: roundTo(between(1, 5), 2),
    taxes_pct: roundTo(between(0, 3.5), 2),
    loss_cap_pct: roundTo(between(150, 400), 2),
    quota_share_epi: 0,
    surplus_epi: 0,
  };
  if (treatyTypeName === 'Quota Share') {
    return {
      ...base,
      cession_pct: roundTo(between(20, 80), 2),
      retention_pct: 100 - roundTo(between(20, 80), 2),
      quota_share_epi: epi,
      qs_limit: roundTo(epi * between(0.5, 2), 2),
    };
  }
  if (treatyTypeName === 'First Surplus' || treatyTypeName === 'Second Surplus' || treatyTypeName === 'Third Surplus') {
    const retention = roundTo(between(500_000, 5_000_000), 2);
    const lines = intBetween(5, 20);
    return {
      ...base,
      retention_amt: retention,
      surplus_max_retention: retention,
      num_lines: lines,
      total_capacity: retention * lines,
      surplus_epi: epi,
    };
  }
  if (treatyTypeName === 'Quota Share & Surplus') {
    const retention = roundTo(between(750_000, 4_000_000), 2);
    const lines = intBetween(5, 15);
    return {
      ...base,
      cession_pct: roundTo(between(20, 50), 2),
      retention_amt: retention,
      surplus_max_retention: retention,
      num_lines: lines,
      total_capacity: retention * lines,
      quota_share_epi: epi * 0.4,
      surplus_epi: epi * 0.6,
    };
  }
  // Fac Oblig / default
  return {
    ...base,
    cession_pct: roundTo(between(30, 100), 2),
    quota_share_epi: epi,
    qs_limit: roundTo(epi * between(0.8, 2.5), 2),
  };
}

function npLayers(treatyTypeName) {
  // peril_scope CHECK constraint allows only RISK / CAT / BOTH.
  // Aggregate-style treaties (Stop Loss, Aggregate XL) are modelled as
  // a single layer with peril_scope=BOTH and an annual_agg_deductible.
  const treatyToScopeCount = {
    'Risk XL':        { perils: ['RISK'],         min: 2, max: 5 },
    'CAT XL':         { perils: ['CAT'],          min: 2, max: 5 },
    'Risk & CAT XL':  { perils: ['RISK', 'CAT'],  min: 3, max: 6 },
    'Stop Loss':      { perils: ['BOTH'],         min: 1, max: 1 },
    'Aggregate XL':   { perils: ['BOTH'],         min: 1, max: 2 },
  };
  const cfg = treatyToScopeCount[treatyTypeName] || { perils: ['RISK'], min: 2, max: 4 };
  const count = intBetween(cfg.min, cfg.max);
  // Start each layer ladder at a different base
  let attach = roundTo(between(500_000, 5_000_000), 0);
  const layers = [];
  for (let i = 0; i < count; i++) {
    const limit = roundTo(between(1_000_000, 25_000_000), 0);
    const peril = cfg.perils[i % cfg.perils.length];
    const rol = roundTo(between(0.02, 0.18), 6);
    const egnpi = roundTo(between(3_000_000, 60_000_000), 2);
    const earned = roundTo(egnpi * (0.9 + rand() * 0.2), 2);
    layers.push({
      layer_number: i + 1,
      attachment: attach,
      layer_limit: limit,
      aggregate_limit: peril === 'BOTH' ? roundTo(limit * 1.5, 0) : null,
      egnpi,
      earned_premium: earned,
      rate: roundTo(rol * (0.9 + rand() * 0.2), 8),
      rol,
      num_reinstatements: peril === 'CAT' ? intBetween(0, 2) : intBetween(1, 3),
      reinstatement_pct: roundTo(100, 2),
      annual_agg_deductible: peril === 'BOTH' ? roundTo(between(0, 2_000_000), 2) : null,
      peril_scope: peril,
      hist_margin: roundTo(between(0.05, 0.35), 6),
      modelled_margin: roundTo(between(0.05, 0.35), 6),
      tech_ratio: roundTo(between(0.55, 0.85), 6),
      uw_price: roundTo(rol, 8),
      expiring_price: roundTo(rol * (0.9 + rand() * 0.2), 8),
      lead_price: roundTo(rol, 8),
    });
    attach += limit;
  }
  return layers;
}

function npDetailHeader(treatyTypeName, layers) {
  const xlTypeMap = {
    'Risk XL': 'PER_RISK',
    'CAT XL': 'PER_EVENT',
    'Risk & CAT XL': 'PER_RISK_AND_EVENT',
    'Stop Loss': 'AGGREGATE',
    'Aggregate XL': 'AGGREGATE',
  };
  return {
    number_of_layers: layers.length,
    deductible: layers[0]?.attachment ?? 0,
    max_retention: layers[layers.length - 1]?.attachment ?? 0,
    accounting_method: pick(['UNDERWRITING_YEAR', 'CLEAN_CUT', 'LOSSES_OCCURRING']),
    xl_type: xlTypeMap[treatyTypeName] || 'PER_RISK',
    accounts: pick(['ANNUAL', 'QUARTERLY']),
    brokerage_pct: roundTo(between(1, 4), 2),
    no_claims_bonus_pct: rand() < 0.4 ? roundTo(between(3, 10), 2) : null,
    profit_commission_pct: rand() < 0.5 ? roundTo(between(10, 25), 2) : null,
    est_gnpi: layers.reduce((s, l) => s + Number(l.egnpi || 0), 0),
    adjustment_rate: roundTo(between(0.05, 0.18), 6),
    deposit_premium: roundTo(layers.reduce((s, l) => s + Number(l.earned_premium || 0), 0) * 0.9, 2),
    expiring_number_of_layers: layers.length,
    experience_start_year: 2026 - intBetween(5, 10),
    taxes_pct: roundTo(between(0, 3.5), 4),
  };
}

// ─── Loading reference data ────────────────────────────────────────────────
async function loadReference() {
  const [treaty, country, currency, broker, cob, company, users] = await Promise.all([
    pool.query('SELECT treaty_type_id, treaty_type, category FROM treaty_type WHERE is_active'),
    pool.query('SELECT country_id, country_code, country_name FROM country'),
    pool.query('SELECT currency_id, currency_code FROM currency'),
    pool.query('SELECT broker_id, broker_name FROM brokers'),
    pool.query('SELECT class_of_business_id, class_of_business FROM class_of_business'),
    pool.query('SELECT company_id, company_name, country_id FROM companies'),
    pool.query('SELECT user_id, display_name FROM uw_user WHERE is_active'),
  ]);
  return {
    treaty: treaty.rows,
    country: country.rows,
    currency: currency.rows,
    broker: broker.rows,
    cob: cob.rows,
    company: company.rows,
    users: users.rows,
  };
}

// ─── Wipe previous seed batch (idempotent rerun) ──────────────────────────
async function wipePrevious() {
  const { rows } = await pool.query(
    `SELECT contract_id FROM contract WHERE alt_contract_id LIKE $1`,
    [`${SEED_TAG}-%`],
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.contract_id);
  // Children are wiped via ON DELETE CASCADE on most FK pairs; the few
  // that are NOT VALID still respect cascade behaviour for cascade-typed
  // FK rows present in this dataset. Drop the parent rows now.
  await pool.query(`DELETE FROM contract WHERE contract_id = ANY($1::uuid[])`, [ids]);
  // Drop quotes tagged the same way
  await pool.query(`DELETE FROM quote WHERE alt_contract_id LIKE $1`, [`${SEED_TAG}-%`]);
  return rows.length;
}

// ─── Per-contract insert plan ─────────────────────────────────────────────
async function insertOne(ref, idx, parentContractId = null) {
  const treaty = pick(ref.treaty);
  const country = pick(ref.country);
  const currency = pick(ref.currency);
  const broker = pick(ref.broker);
  // Try to pick a cedant that matches the chosen country; fall back to random
  let cedantPool = ref.company.filter((c) => c.country_id === country.country_id);
  if (!cedantPool.length) cedantPool = ref.company;
  const cedant = pick(cedantPool);
  const cobs = pickN(ref.cob, intBetween(1, 4));
  const primaryCob = cobs[0];
  const uwYear = 2026 - intBetween(0, 2);
  const [uwStatus, contractStatus] = statusBucket();
  const variant = pick(COMMISSION_VARIANTS);
  const owner = pick(ref.users);

  // Avoid CAT-XL + Marine combos because the seed CRESTA assumptions are property only.
  const primaryCobId = primaryCob.class_of_business_id;
  const altContractId = `${SEED_TAG}-${String(idx).padStart(5, '0')}`;

  const inception = new Date(uwYear, 0, 1);
  const renewal = new Date(uwYear + 1, 0, 1);

  // Header insert
  const contractIdRow = await pool.query(
    `INSERT INTO contract (
        cedant_id, broker_id, country_id, currency_id, treaty_type_id,
        uw_year, status, uw_status, experience_source,
        primary_class_of_business_id, created_by_user_id, assigned_to_user_id,
        inception_date, renewal_date, contract_description,
        signed_line_pct, signed_at, ntu_reason, ntu_at, declined_at,
        decline_reason, parent_contract_id, alt_contract_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7::contract_status, $8::uw_workflow_status, $9,
        $10, $11, $11,
        $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22
      ) RETURNING contract_id`,
    [
      cedant.company_id, broker.broker_id, country.country_id, currency.currency_id, treaty.treaty_type_id,
      uwYear, contractStatus, uwStatus, pick(['TRIANGLE', 'STRAIGHT']),
      primaryCobId, owner.user_id,
      inception, renewal,
      `${treaty.treaty_type} – ${cedant.company_name} – UW ${uwYear}`,
      uwStatus === 'SIGNED' ? roundTo(between(2.5, 17.5), 4) : null,
      uwStatus === 'SIGNED' ? new Date() : null,
      uwStatus === 'NTU' ? 'Out of appetite — risk-adjusted ROL below target' : null,
      uwStatus === 'NTU' ? new Date() : null,
      uwStatus === 'DECLINED' ? new Date() : null,
      uwStatus === 'DECLINED' ? 'Cedant performance below acceptance threshold' : null,
      parentContractId,
      altContractId,
    ],
  );
  const contractId = contractIdRow.rows[0].contract_id;

  // COBs
  await pool.query(
    `INSERT INTO contract_class_of_business (contract_id, class_of_business_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [contractId, cobs.map((c) => c.class_of_business_id)],
  );

  // Branch by category
  if (treaty.category === 'PROPORTIONAL') {
    const detail = propDetail(treaty.treaty_type);
    await pool.query(
      `INSERT INTO contract_prop_details (
          contract_id, triangulations_available, inception_date, renewal_date,
          qs_limit, retention_pct, retention_amt, cession_pct, cession_amt,
          surplus_max_retention, num_lines, total_capacity, event_limit, aal,
          quota_share_epi, surplus_epi, brokerage_pct, taxes_pct, loss_cap_pct,
          experience_start_year
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19,
          $20
        )`,
      [
        contractId, detail.triangulations_available, inception, renewal,
        detail.qs_limit ?? null, detail.retention_pct ?? null, detail.retention_amt ?? null,
        detail.cession_pct ?? null, detail.cession_amt ?? null,
        detail.surplus_max_retention ?? null, detail.num_lines ?? null, detail.total_capacity ?? null,
        roundTo(between(15_000_000, 100_000_000), 0), null,
        detail.quota_share_epi, detail.surplus_epi,
        detail.brokerage_pct, detail.taxes_pct, detail.loss_cap_pct,
        uwYear - intBetween(5, 8),
      ],
    );

    const comm = commissionPayload(variant);
    await pool.query(
      `INSERT INTO contract_commissions (
          contract_id, mode, fixed_commission_pct,
          fixed_commission_qs_pct, fixed_commission_surplus_pct,
          sliding_min_loss_ratio, sliding_max_loss_ratio,
          sliding_min_commission, sliding_max_commission,
          provisional_commission_pct, mgmt_expenses_pct, profit_commission_pct,
          lcf_years, lcf_extinction
        ) VALUES ($1, $2::commission_mode, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        contractId, comm.mode,
        comm.fixed_commission_pct ?? null,
        comm.fixed_commission_qs_pct ?? null,
        comm.fixed_commission_surplus_pct ?? null,
        comm.sliding_min_loss_ratio ?? null, comm.sliding_max_loss_ratio ?? null,
        comm.sliding_min_commission ?? null, comm.sliding_max_commission ?? null,
        comm.provisional_commission_pct ?? null,
        comm.mgmt_expenses_pct ?? null, comm.profit_commission_pct ?? null,
        comm.lcf_years ?? null, comm.lcf_extinction ?? false,
      ],
    );

    if (comm.sliding_table?.length) {
      const values = [];
      const params = [contractId];
      let p = 2;
      for (const row of comm.sliding_table) {
        values.push(`($1, $${p++}, $${p++}, $${p++})`);
        params.push(row.row_no, row.loss_ratio_pct, row.commission_pct);
      }
      await pool.query(
        `INSERT INTO contract_commission_slides (contract_id, row_no, loss_ratio_pct, commission_pct)
         VALUES ${values.join(',')}`,
        params,
      );
    }

    // EPI split across COBs
    const epiBudget = Number(detail.quota_share_epi || 0) + Number(detail.surplus_epi || 0)
      || roundTo(between(5_000_000, 40_000_000), 2);
    const weights = cobs.map(() => between(0.1, 1));
    const weightSum = weights.reduce((s, w) => s + w, 0);
    const epiValues = [];
    const epiParams = [contractId];
    let pp = 2;
    cobs.forEach((c, i) => {
      epiValues.push(`($1, $${pp++}, $${pp++})`);
      epiParams.push(c.class_of_business_id, roundTo(epiBudget * weights[i] / weightSum, 2));
    });
    await pool.query(
      `INSERT INTO contract_epi_split (contract_id, class_of_business_id, premium)
       VALUES ${epiValues.join(',')}
       ON CONFLICT (contract_id, class_of_business_id) DO NOTHING`,
      epiParams,
    );

    // Loss participation (random for ~30%)
    if (rand() < 0.3) {
      await pool.query(
        `INSERT INTO contract_loss_participation
           (contract_id, enabled, min_loss_ratio_pct, max_loss_ratio_pct, reinsurer_share_pct, slides)
         VALUES ($1, true, $2, $3, $4, $5::jsonb)`,
        [contractId, roundTo(between(70, 80), 2), roundTo(between(100, 130), 2), roundTo(between(50, 100), 2), '[]'],
      );
    }

    // Pricing outputs (closes the actuarial picture)
    await insertPropPricing(contractId, detail, comm, epiBudget);
  } else {
    // NON_PROPORTIONAL
    const layers = npLayers(treaty.treaty_type);
    const header = npDetailHeader(treaty.treaty_type, layers);
    await pool.query(
      `INSERT INTO contract_np_details (
          contract_id, number_of_layers, deductible, max_retention,
          accounting_method, xl_type, accounts, brokerage_pct,
          no_claims_bonus_pct, profit_commission_pct, est_gnpi,
          adjustment_rate, deposit_premium, expiring_number_of_layers,
          experience_start_year, taxes_pct
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        contractId, header.number_of_layers, header.deductible, header.max_retention,
        header.accounting_method, header.xl_type, header.accounts, header.brokerage_pct,
        header.no_claims_bonus_pct, header.profit_commission_pct, header.est_gnpi,
        header.adjustment_rate, header.deposit_premium, header.expiring_number_of_layers,
        header.experience_start_year, header.taxes_pct,
      ],
    );

    const layerValues = [];
    const layerParams = [contractId];
    let lp = 2;
    for (const l of layers) {
      layerValues.push(`($1, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++})`);
      layerParams.push(
        l.layer_number, l.attachment, l.layer_limit, l.aggregate_limit,
        l.egnpi, l.earned_premium, l.rate, l.rol,
        l.num_reinstatements, l.reinstatement_pct, l.annual_agg_deductible, l.peril_scope,
        l.hist_margin, l.modelled_margin, l.tech_ratio, l.uw_price, l.expiring_price,
      );
    }
    await pool.query(
      `INSERT INTO contract_np_layers (
          contract_id, layer_number, attachment, layer_limit, aggregate_limit,
          egnpi, earned_premium, rate, rol,
          num_reinstatements, reinstatement_pct, annual_agg_deductible, peril_scope,
          hist_margin, modelled_margin, tech_ratio, uw_price, expiring_price
        ) VALUES ${layerValues.join(',')}`,
      layerParams,
    );

    // Commission for NP — usually FIXED; sometimes SLIDING for Stop Loss
    const npVariantPool = treaty.treaty_type === 'Stop Loss'
      ? ['SLIDING_BASIC', 'SLIDING_PROFIT', 'FIXED_PROFIT']
      : ['FIXED_SIMPLE', 'FIXED_PROFIT', 'FIXED_WITH_LCF'];
    const comm = commissionPayload(pick(npVariantPool));
    await pool.query(
      `INSERT INTO contract_commissions (
          contract_id, mode, fixed_commission_pct,
          sliding_min_loss_ratio, sliding_max_loss_ratio,
          sliding_min_commission, sliding_max_commission,
          provisional_commission_pct, mgmt_expenses_pct, profit_commission_pct,
          lcf_years, lcf_extinction
        ) VALUES ($1,$2::commission_mode,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        contractId, comm.mode, comm.fixed_commission_pct ?? null,
        comm.sliding_min_loss_ratio ?? null, comm.sliding_max_loss_ratio ?? null,
        comm.sliding_min_commission ?? null, comm.sliding_max_commission ?? null,
        comm.provisional_commission_pct ?? null,
        comm.mgmt_expenses_pct ?? null, comm.profit_commission_pct ?? null,
        comm.lcf_years ?? null, comm.lcf_extinction ?? false,
      ],
    );

    await insertNpPricing(contractId, layers);
  }

  // Approval/offer record for non-DRAFT statuses
  if (uwStatus !== 'DRAFT') {
    await insertOffer(contractId, uwStatus);
  }

  return { contractId, uwStatus, category: treaty.category, treatyName: treaty.treaty_type, variant };
}

async function insertPropPricing(contractId, detail, comm, epi) {
  const attritional = roundTo(between(0.45, 0.7), 6);
  const large = roundTo(between(0.03, 0.12), 6);
  const cat = roundTo(between(0.02, 0.1), 6);
  const commissionRatio = roundTo(
    (Number(comm.fixed_commission_pct ?? comm.sliding_max_commission ?? 25) / 100), 6,
  );
  const brokerage = roundTo((Number(detail.brokerage_pct) || 2) / 100, 6);
  const tax = roundTo((Number(detail.taxes_pct) || 0) / 100, 6);
  const total = attritional + large + cat + commissionRatio + brokerage + tax;
  const technical = roundTo(1 - total, 6);
  await pool.query(
    `INSERT INTO contract_pricing_outputs (
        contract_id, epi, attritional_ratio, large_loss_load, cat_loss_load,
        commission_ratio, brokerage_ratio, tax_ratio, technical_result,
        max_commission, target_margin, actuarial_margin, actual_margin, uw_margin
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      contractId, epi, attritional, large, cat,
      commissionRatio, brokerage, tax, technical,
      commissionRatio + 0.03, 0.12,
      roundTo(technical - 0.02, 6),
      technical,
      roundTo(technical + 0.01, 6),
    ],
  );

  // Pricing yearly: 8 historical years (HISTORICAL) + 1 projected
  const startYear = 2026 - 8;
  const yearValues = [];
  const yearParams = [contractId];
  let p = 2;
  for (let y = 0; y < 8; y++) {
    const year = startYear + y;
    const grossPrem = roundTo(epi * (0.7 + rand() * 0.6), 2);
    const ultLoss = roundTo(grossPrem * between(0.4, 0.95), 2);
    const commAmt = roundTo(grossPrem * (commissionRatio), 2);
    const brokAmt = roundTo(grossPrem * brokerage, 2);
    const techResult = roundTo(grossPrem - ultLoss - commAmt - brokAmt, 2);
    yearValues.push(`($1, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, 'HISTORICAL')`);
    yearParams.push(year, grossPrem, ultLoss, roundTo(ultLoss / grossPrem, 6), commAmt, brokAmt, techResult);
  }
  // One projection row for next UW year
  const projPrem = roundTo(epi * (1.0 + rand() * 0.15), 2);
  const projLoss = roundTo(projPrem * 0.65, 2);
  const projComm = roundTo(projPrem * commissionRatio, 2);
  const projBrok = roundTo(projPrem * brokerage, 2);
  yearValues.push(`($1, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, 'PROJECTED')`);
  yearParams.push(2026, projPrem, projLoss, roundTo(projLoss / projPrem, 6), projComm, projBrok, roundTo(projPrem - projLoss - projComm - projBrok, 2));

  await pool.query(
    `INSERT INTO contract_pricing_yearly (
        contract_id, uw_year, ultimate_premium, ultimate_loss, loss_ratio,
        commission_amt, brokerage_amt, technical_result, record_type
      ) VALUES ${yearValues.join(',')}
      ON CONFLICT (contract_id, uw_year, record_type) DO NOTHING`,
    yearParams,
  );
}

async function insertNpPricing(contractId, layers) {
  // Inputs row (one per contract) — schema matches contract_np_pricing_inputs
  const burnW = 40, paretoW = 30, exposureW = 30;
  const loading = roundTo(between(10, 25), 2);
  await pool.query(
    `INSERT INTO contract_np_pricing_inputs (
        contract_id, burn_weight_pct, exposure_weight_pct, pricing_loading_pct,
        swiss_re_curve_name, pareto_weight_pct
      ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contract_id) DO NOTHING`,
    [contractId, burnW, exposureW, loading, pick(['Property', 'Liability', 'Marine', 'Motor']), paretoW],
  );

  // Layer inputs row per layer
  const liValues = [];
  const liParams = [contractId];
  let p = 2;
  for (const l of layers) {
    liValues.push(`($1, $${p++}, $${p++})`);
    liParams.push(l.layer_number, roundTo(Number(l.expiring_price) * 100, 6));
  }
  if (liValues.length) {
    await pool.query(
      `INSERT INTO contract_np_pricing_layer_inputs (contract_id, layer_number, expiring_pricing_pct)
       VALUES ${liValues.join(',')}
       ON CONFLICT (contract_id, layer_number) DO NOTHING`,
      liParams,
    );
  }

  // Per-layer outputs split by section RISK / CAT depending on peril scope
  const outValues = [];
  const outParams = [contractId];
  let q = 2;
  const buildOut = (l, section) => {
    const pureBurn = roundTo(between(0.01, 0.12), 6);
    const paretoRate = roundTo(pureBurn * between(0.85, 1.25), 6);
    const exposureRate = roundTo(pureBurn * between(0.85, 1.25), 6);
    const burnPlusPareto = roundTo((burnW * pureBurn + paretoW * paretoRate) / (burnW + paretoW), 6);
    const blended = (burnW * pureBurn + paretoW * paretoRate + exposureW * exposureRate) / (burnW + paretoW + exposureW);
    const totalPrice = roundTo(blended / (1 - loading / 100), 8);
    return [
      l.layer_number, section, pureBurn, paretoRate, burnPlusPareto, exposureRate,
      burnW, exposureW, loading, totalPrice,
      roundTo(between(0.01, 0.2), 6), roundTo(between(0.001, 0.05), 6),
      paretoW,
    ];
  };
  for (const l of layers) {
    const sections = [];
    if (l.peril_scope === 'RISK') sections.push('RISK');
    else if (l.peril_scope === 'CAT') sections.push('CAT');
    else sections.push('RISK', 'CAT');
    for (const section of sections) {
      const cols = buildOut(l, section);
      outValues.push(`($1, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++}, $${q++})`);
      outParams.push(...cols);
    }
  }
  if (outValues.length) {
    await pool.query(
      `INSERT INTO contract_np_pricing_outputs (
          contract_id, layer_number, section, pure_burning_cost, pareto_pricing,
          burn_plus_pareto, exposure_rating,
          burn_weight_pct, exposure_weight_pct, pricing_loading_pct, total_price,
          prob_attach, prob_exhaust, pareto_weight_pct
        ) VALUES ${outValues.join(',')}
       ON CONFLICT (contract_id, layer_number, section) DO NOTHING`,
      outParams,
    );
  }
}

async function insertOffer(contractId, uwStatus) {
  const writtenLine = roundTo(between(2.5, 17.5), 4);
  let status = 'PENDING';
  let signedAt = null;
  let ntuAt = null;
  let declinedAt = null;
  switch (uwStatus) {
    case 'SIGNED':
      status = 'SIGNED';
      signedAt = new Date();
      break;
    case 'NTU':
      status = 'NTU';
      ntuAt = new Date();
      break;
    case 'DECLINED':
      status = 'DECLINED';
      declinedAt = new Date();
      break;
    case 'APPROVED':
      status = 'APPROVED';
      break;
    case 'AWAITING_SIGNED_LINE':
      status = 'OFFERED';
      break;
    case 'WAITING_APPROVAL':
      status = 'PENDING_APPROVAL';
      break;
  }
  await pool.query(
    `INSERT INTO contract_offer (
        contract_id, written_line_pct, premium_driver, profit_driver,
        strategic_rationale, tactical_rationale, status,
        approved_at, sent_to_market_at, signed_at, ntu_at, declined_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      contractId, writtenLine,
      'Diversification', 'Margin uplift',
      'Strategic cedant relationship; longstanding programme.',
      'Layer reattachment opportunity; competitive ROL.',
      status,
      status !== 'PENDING' && status !== 'PENDING_APPROVAL' ? new Date() : null,
      status === 'OFFERED' || status === 'SIGNED' || status === 'NTU' ? new Date() : null,
      signedAt, ntuAt, declinedAt,
    ],
  );
}

// ─── Quote insertion (linked to a subset of contracts) ────────────────────
async function insertQuoteFor(contract, idx) {
  const altQ = `${SEED_TAG}-Q-${String(idx).padStart(5, '0')}`;
  const ref = await pool.query(
    `SELECT cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year,
            primary_class_of_business_id, inception_date, renewal_date,
            created_by_user_id, contract_description
     FROM contract WHERE contract_id = $1`,
    [contract.contractId],
  );
  if (!ref.rows.length) return null;
  const r = ref.rows[0];
  const quoteRef = `QT-${r.uw_year}-${String(idx).padStart(4, '0')}`;
  const { rows } = await pool.query(
    `INSERT INTO quote (
        cedant_id, broker_id, country_id, currency_id, treaty_type_id,
        uw_year, status, uw_status, experience_source,
        primary_class_of_business_id, contract_description,
        inception_date, renewal_date, created_by_user_id, assigned_to_user_id,
        quote_ref, quote_version, bound_contract_id, bound_at, alt_contract_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11,
        $12, $13, $14, $14,
        $15, 1, $16, $17, $18
      ) RETURNING quote_id`,
    [
      r.cedant_id, r.broker_id, r.country_id, r.currency_id, r.treaty_type_id,
      r.uw_year, 'BOUND', 'SIGNED', 'TRIANGLE',
      r.primary_class_of_business_id, `QUOTE: ${r.contract_description}`,
      r.inception_date, r.renewal_date, r.created_by_user_id,
      quoteRef, contract.contractId, new Date(), altQ,
    ],
  );
  const quoteId = rows[0].quote_id;
  // Link back to source quote
  await pool.query(`UPDATE contract SET source_quote_id = $1 WHERE contract_id = $2`, [quoteId, contract.contractId]);
  return quoteId;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${TOTAL} contracts (DATABASE_URL=${DATABASE_URL.replace(/:[^@]+@/, ':***@')})`);
  const wiped = await wipePrevious();
  if (wiped) console.log(`Removed ${wiped} previously-seeded contracts (idempotent rerun).`);

  const ref = await loadReference();
  console.log(`Reference: ${ref.treaty.length} treaty types, ${ref.country.length} countries, `
    + `${ref.currency.length} currencies, ${ref.broker.length} brokers, ${ref.company.length} cedants, `
    + `${ref.cob.length} COBs.`);

  const created = [];
  const failures = [];
  const t0 = Date.now();

  // 70% standalone contracts, 20% renewals (parent within set), 10% quote→contract
  const targetRenewals = Math.floor(TOTAL * 0.2);
  const targetQuoteLinks = Math.floor(TOTAL * 0.3);

  // Phase 1: insert primary contracts
  for (let i = 0; i < TOTAL; i++) {
    try {
      const c = await insertOne(ref, i);
      created.push(c);
      if ((i + 1) % 100 === 0) {
        console.log(`  ${i + 1}/${TOTAL} inserted… (${Math.round((Date.now() - t0) / 1000)}s elapsed)`);
      }
    } catch (err) {
      failures.push({ i, err: err.message });
    }
  }

  // Phase 2: renewals — pick prior-year contracts, create their UW+1 child
  let renewalCount = 0;
  for (let i = 0; i < targetRenewals && i < created.length; i++) {
    const parent = created[i];
    try {
      const renewed = await insertOne(ref, TOTAL + i, parent.contractId);
      // Same cedant, prior contract group
      await pool.query(
        `UPDATE contract SET parent_contract_id = $1, uw_year = (SELECT uw_year FROM contract WHERE contract_id = $1) + 1 WHERE contract_id = $2`,
        [parent.contractId, renewed.contractId],
      );
      renewalCount++;
    } catch (err) {
      failures.push({ i: `renewal-${i}`, err: err.message });
    }
  }

  // Phase 3: quote-bind links — link a subset back to a bound quote
  let quoteLinks = 0;
  for (let i = 0; i < targetQuoteLinks && i < created.length; i++) {
    const c = created[i];
    try {
      const qid = await insertQuoteFor(c, i);
      if (qid) quoteLinks++;
    } catch (err) {
      failures.push({ i: `quote-${i}`, err: err.message });
    }
  }

  // Phase 4: standalone draft quotes (working/offered, not yet bound)
  const standaloneQuotes = Math.floor(TOTAL * 0.1);
  let draftQuotes = 0;
  for (let i = 0; i < standaloneQuotes; i++) {
    try {
      const treaty = pick(ref.treaty);
      const country = pick(ref.country);
      const currency = pick(ref.currency);
      const broker = pick(ref.broker);
      const cedant = pick(ref.company);
      const cob = pick(ref.cob);
      const user = pick(ref.users);
      const uwYear = 2026 - intBetween(0, 1);
      const statuses = ['DRAFT', 'DRAFT', 'WAITING_APPROVAL', 'AWAITING_SIGNED_LINE'];
      const qStatus = pick(statuses);
      const altQ = `${SEED_TAG}-DQ-${String(i).padStart(5, '0')}`;
      const quoteRef = `QT-${uwYear}-D${String(i).padStart(4, '0')}`;
      await pool.query(
        `INSERT INTO quote (
            cedant_id, broker_id, country_id, currency_id, treaty_type_id,
            uw_year, status, uw_status, experience_source,
            primary_class_of_business_id, created_by_user_id, assigned_to_user_id,
            inception_date, renewal_date, contract_description,
            quote_ref, alt_contract_id
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $11,
            $12, $13, $14,
            $15, $16
          )`,
        [
          cedant.company_id, broker.broker_id, country.country_id, currency.currency_id, treaty.treaty_type_id,
          uwYear, qStatus, qStatus, 'TRIANGLE',
          cob.class_of_business_id, user.user_id,
          new Date(uwYear, 0, 1), new Date(uwYear + 1, 0, 1),
          `DRAFT QUOTE: ${treaty.treaty_type} – ${cedant.company_name}`,
          quoteRef, altQ,
        ],
      );
      draftQuotes++;
    } catch (err) {
      failures.push({ i: `dquote-${i}`, err: err.message });
    }
  }

  const duration = Math.round((Date.now() - t0) / 1000);
  console.log('');
  console.log(`────────── Seed complete in ${duration}s ──────────`);
  console.log(`Contracts inserted: ${created.length}`);
  console.log(`Renewals inserted:  ${renewalCount}`);
  console.log(`Quote→contract:     ${quoteLinks}`);
  console.log(`Standalone quotes:  ${draftQuotes}`);
  console.log(`Failures:           ${failures.length}`);
  if (failures.length) {
    console.log('Sample errors:');
    failures.slice(0, 10).forEach((f) => console.log(`  [${f.i}] ${f.err}`));
  }

  // Stats breakdown
  const stats = await pool.query(`
    SELECT tt.category,
           tt.treaty_type,
           c.uw_status::text                AS uw_status,
           cm.mode::text                    AS commission_mode,
           COUNT(*)::int                    AS n
      FROM contract c
      JOIN treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN contract_commissions cm ON cm.contract_id = c.contract_id
     WHERE c.alt_contract_id LIKE $1
     GROUP BY tt.category, tt.treaty_type, c.uw_status, cm.mode
     ORDER BY tt.category, tt.treaty_type, c.uw_status, cm.mode
  `, [`${SEED_TAG}-%`]);

  console.log('\nBreakdown by treaty type / status / commission mode:');
  console.table(stats.rows);

  await pool.end();
}

main().catch(async (err) => {
  console.error('SEED FAILED', err);
  await pool.end();
  process.exit(1);
});
