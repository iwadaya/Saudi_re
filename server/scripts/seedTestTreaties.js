// server/scripts/seedTestTreaties.js
//
// Seeds a complete, fully-populated treaty test set:
//   • 50 PROPORTIONAL contracts
//   • 50 NON_PROPORTIONAL contracts
//   • a handful of Ghanaian cedants (plus the GHS currency, its FX rate and
//     the Ghana CPI series the loss-inflation screens need)
//
// "Fully populated" is the point of this script: every column of every child
// table a seeded treaty owns is written with a plausible value, so no screen
// renders a blank field. See NULL POLICY below for the two documented
// exceptions, and run with --verify for a per-column NULL report.
//
//   node server/scripts/seedTestTreaties.js            # seed
//   node server/scripts/seedTestTreaties.js --reset    # delete prior seed, then reseed
//   node server/scripts/seedTestTreaties.js --reset-only
//   node server/scripts/seedTestTreaties.js --verify   # NULL-coverage report only
//
// Environment:
//   DATABASE_URL       standard (server/src/config/env.js)
//   SEED_PROP_COUNT    default 50
//   SEED_NP_COUNT      default 50
//   SEED_RANDOM_SEED   default 20260820 — the generator is deterministic, so
//                      the same seed reproduces the same portfolio byte for byte.
//
// SENTINEL
//   Every seeded contract carries import_metadata->>'source' = 'seed:test-treaties'.
//   That is the delete key for --reset and it is already indexed
//   (idx_contract_import_metadata_source). contract_description is left free for
//   a realistic treaty name rather than being burned as a marker.
//
// NULL POLICY
//   Two contract columns are deliberately left NULL, because filling them would
//   mean fabricating rows that do not exist:
//     • source_quote_id     — these are direct treaties, not bound from a quote.
//                             Pointing it at a non-existent quote would dangle.
//     • parent_contract_id  — NULL only on the first year of each renewal
//                             lineage; every subsequent year points at its
//                             expiring contract.
//   contract_document is not seeded either: those rows describe uploaded files,
//   and metadata without a blob gives you a documents tab that 404s on download.
//   Everything else is populated. --verify proves it.

import { pool } from '../src/db/pool.js';

const SEED_SOURCE = 'seed:test-treaties';
const PROP_COUNT = Number(process.env.SEED_PROP_COUNT || 50);
const NP_COUNT = Number(process.env.SEED_NP_COUNT || 50);
const RANDOM_SEED = Number(process.env.SEED_RANDOM_SEED || 20260820);

const RESET = process.argv.includes('--reset') || process.argv.includes('--reset-only');
const RESET_ONLY = process.argv.includes('--reset-only');
const VERIFY_ONLY = process.argv.includes('--verify');

const CUR_YEAR = new Date().getFullYear();
const BATCH_DATE = new Date().toISOString().slice(0, 10);

// ── deterministic RNG ───────────────────────────────────────────────────────
// Seeded so a re-run reproduces the identical portfolio; testers can compare
// numbers between two machines and between two runs.
let rngState = RANDOM_SEED >>> 0;
function rnd() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rand = (min, max) => rnd() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const money = (min, max, step = 1000) => Math.round(rand(min, max) / step) * step;
const chance = (p) => rnd() < p;
function shuffle(a) {
  const c = [...a];
  for (let i = c.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  return c;
}
function weighted(items) {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = rnd() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
}
const ymd = (y, m = 0, d = 1) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ts = (y, m = 0, d = 1, h = 10) => `${ymd(y, m, d)} ${String(h).padStart(2, '0')}:00:00+00`;

// ── generic writer ──────────────────────────────────────────────────────────
async function ins(client, table, row, opts = {}) {
  const cols = Object.keys(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  let sql = `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  if (opts.conflict) sql += ` ON CONFLICT ${opts.conflict}`;
  if (opts.returning) sql += ` RETURNING ${opts.returning}`;
  const { rows } = await client.query(sql, cols.map((c) => row[c]));
  return rows[0] || null;
}
const J = (v) => JSON.stringify(v);

// ── reference data ──────────────────────────────────────────────────────────

const GHANA_CEDANTS = [
  'SIC Insurance Company',
  'Enterprise Insurance',
  'Star Assurance',
  'Hollard Insurance Ghana',
  'GLICO General Insurance',
  'Vanguard Assurance',
  'Ghana Union Assurance',
  'Activa International Insurance Ghana',
];

// Ghana CPI, annual average % change. Historic figures are World Bank/IMF WEO
// rounded to one decimal; 2025-26 are projections. Indicative reference data for
// a test environment — not a source of record.
const GHANA_CPI = [
  [2000, 25.2], [2001, 32.9], [2002, 14.8], [2003, 26.7], [2004, 12.6],
  [2005, 15.1], [2006, 10.9], [2007, 10.7], [2008, 16.5], [2009, 19.3],
  [2010, 10.7], [2011, 8.7], [2012, 9.2], [2013, 11.7], [2014, 15.5],
  [2015, 17.2], [2016, 17.5], [2017, 12.4], [2018, 9.8], [2019, 7.1],
  [2020, 9.9], [2021, 10.0], [2022, 31.9], [2023, 39.2], [2024, 22.9],
  [2025, 15.0], [2026, 9.5],
];
const GHANA_CPI_PROJECTED_FROM = 2025;

// country_code → local currency. Used so a Ghanaian treaty can be written in
// cedis and a Gulf treaty in its own currency; the rest fall back to USD.
const LOCAL_CURRENCY = { GH: 'GHS', AE: 'AED', SA: 'SAR', KW: 'KWD', EG: 'EGP', GB: 'GBP' };

const PROP_TYPE_MIX = [
  { name: 'Quota Share & Surplus', w: 30 },
  { name: 'Quota Share', w: 25 },
  { name: 'First Surplus', w: 20 },
  { name: 'Second Surplus', w: 10 },
  { name: 'Third Surplus', w: 5 },
  { name: 'Fac Oblig', w: 10 },
];
const NP_TYPE_MIX = [
  { name: 'Risk XL', w: 30 },
  { name: 'CAT XL', w: 25 },
  { name: 'Risk & CAT XL', w: 25 },
  { name: 'Aggregate XL', w: 10 },
  { name: 'Stop Loss', w: 10 },
];
const CAT_TYPES = new Set(['CAT XL', 'Risk & CAT XL', 'Aggregate XL']);
const RISK_TYPES = new Set(['Risk XL', 'Risk & CAT XL']);

// uw_status == the mirrored contract_status for every value we use, and each
// path below is legal under lib/statusMachine.js.
const STATUS_MIX = [
  { status: 'SIGNED', w: 42 },
  { status: 'AWAITING_SIGNED_LINE', w: 18 },
  { status: 'AWAITING_APPROVAL', w: 15 },
  { status: 'NTU', w: 13 },
  { status: 'DECLINED', w: 12 },
];
const NTU_REASONS = [
  'Cedant placed the layer elsewhere on price',
  'Order not completed — signed line withdrawn',
  'Terms not agreed before inception',
  'Programme restructured after our quote',
];
const DECLINE_REASONS = [
  'Outside current risk appetite for the territory',
  'Exposure data insufficient to rate the layer',
  'Adverse loss history against the offered rate',
  'Country aggregate already committed for the year',
];
const COMPONENT_ROWS = [
  'Attritional Loss Ratio', 'Large Loss Loading', 'Cat Loss Loading',
  'Commissions', 'Brokerage', 'Taxes', 'Result', 'Maximum Commissions (Reinsurer)',
];
const SHARE_ROWS = ['1%', '2.5%', '5%', '100%'];
const TRIANGLE_TYPES = ['PREMIUM', 'CLAIMS_PAID', 'CLAIMS_OS', 'INCURRED'];
const TRIANGLE_VARIANTS = ['ACTUAL', 'MODIFIED'];
const SWISS_RE_CURVES = ['Y1', 'Y2', 'Y3', 'Y4', 'Auto', 'Custom'];
const CRESTA_ZONES = [
  ['01', 'Greater Accra'], ['02', 'Ashanti'], ['03', 'Western'], ['04', 'Central'],
  ['05', 'Eastern'], ['06', 'Northern'], ['07', 'Volta'], ['08', 'Upper East'],
];
const PERILS = ['Windstorm', 'Flood', 'Earthquake', 'Fire following', 'Riot & Strike'];
const INSURED_NAMES = [
  'Tema Oil Refinery', 'Accra Mall Holdings', 'Volta Aluminium', 'Kumasi Brewery',
  'Takoradi Port Terminal', 'Ghana Cocoa Board Warehouse', 'Ridge Hospital Complex',
  'Sunon Asogli Power', 'Golden Star Resources', 'Nestlé Ghana Tema Plant',
  'Unilever Ghana', 'Kosmos Energy FPSO', 'Ghana Grid Company Substation',
];

// ── reset ───────────────────────────────────────────────────────────────────

async function seededContractIds(client) {
  const { rows } = await client.query(
    `SELECT contract_id FROM public.contract WHERE import_metadata->>'source' = $1`, [SEED_SOURCE]);
  return rows.map((r) => r.contract_id);
}

// Child tables in delete order. Anything keyed on contract_id has ON DELETE
// CASCADE declared NOT VALID, so we do not rely on it — we delete explicitly.
const CHILD_TABLES_BY_CONTRACT = [
  'contract_large_losses', 'contract_cat_losses',
  'contract_large_loss_report', 'contract_cat_loss_report',
  'contract_loss_selection_snapshot_item_PLACEHOLDER',
  'contract_loss_selection_snapshot',
  'contract_np_layer_class_of_business_PLACEHOLDER',
  'contract_np_layers', 'contract_np_egnpi_year', 'contract_np_details',
  'contract_np_terms', 'contract_np_expiring_layers', 'contract_np_expiring_terms',
  'contract_np_historical_performance', 'contract_np_pricing_inputs',
  'contract_np_pricing_layer_inputs', 'contract_np_pricing_outputs',
  'contract_np_large_loss_ldf', 'contract_np_cat_loss_ldf', 'contract_np_excess_ldf',
  'contract_np_large_loss_ultimate', 'contract_np_cat_loss_ultimate',
  'contract_np_stop_loss_pricing',
  'contract_prop_details', 'contract_commission_slides', 'contract_commissions',
  'contract_epi_split', 'contract_class_of_business', 'contract_underwriting_limit',
  'contract_risk_profile_band_PLACEHOLDER', 'contract_risk_profile',
  'contract_claims_profile_band_PLACEHOLDER', 'contract_claims_profile',
  'contract_cresta_data', 'contract_dev_factor', 'contract_triangle_cells',
  'contract_pricing_patterns', 'contract_ldf_blend_curve_PLACEHOLDER',
  'contract_ldf_blend_weight_PLACEHOLDER', 'contract_ldf_blend',
  'contract_loss_participation', 'contract_straight_uw_stats', 'contract_straight_experience',
  'contract_event_loss_tables', 'contract_gem_eq_scenario',
  'contract_pricing_outputs', 'contract_pricing_yearly',
  'pricing_components', 'pricing_leads', 'pricing_share_scenarios',
  'contract_offer_layer_PLACEHOLDER', 'contract_offer',
  'contract_approval', 'contract_workflow_event', 'contract_audit_event',
  'contract_wording_checklist', 'contract_wording_checklist_run',
  'contract_terms_snapshot',
];

async function resetSeed(client) {
  const ids = await seededContractIds(client);
  if (!ids.length) { console.log('reset: nothing to delete.'); return 0; }
  await client.query('BEGIN');
  try {
    // Grandchildren keyed via their parent row, deleted before their parents.
    await client.query(
      `DELETE FROM public.contract_loss_selection_snapshot_item WHERE snapshot_id IN
         (SELECT snapshot_id FROM public.contract_loss_selection_snapshot WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_np_layer_class_of_business WHERE layer_id IN
         (SELECT layer_id FROM public.contract_np_layers WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_risk_profile_band WHERE profile_id IN
         (SELECT profile_id FROM public.contract_risk_profile WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_claims_profile_band WHERE profile_id IN
         (SELECT profile_id FROM public.contract_claims_profile WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_ldf_blend_curve WHERE blend_id IN
         (SELECT blend_id FROM public.contract_ldf_blend WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_ldf_blend_weight WHERE blend_id IN
         (SELECT blend_id FROM public.contract_ldf_blend WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.approval_decision WHERE request_id IN
         (SELECT offer_id FROM public.contract_offer WHERE contract_id = ANY($1))`, [ids]);
    await client.query(
      `DELETE FROM public.contract_offer_layer WHERE offer_id IN
         (SELECT offer_id FROM public.contract_offer WHERE contract_id = ANY($1))`, [ids]);

    for (const table of CHILD_TABLES_BY_CONTRACT) {
      if (table.endsWith('_PLACEHOLDER')) continue;
      await client.query(`DELETE FROM public.${table} WHERE contract_id = ANY($1)`, [ids]);
    }
    await client.query(
      `DELETE FROM public.contract_assignment_history WHERE entity_type='contract' AND entity_id = ANY($1)`, [ids]);
    await client.query(`UPDATE public.contract SET parent_contract_id = NULL WHERE parent_contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract WHERE contract_id = ANY($1)`, [ids]);
    await client.query(
      `DELETE FROM public.contract_group WHERE program_name LIKE 'SEED · %'`);
    await client.query('COMMIT');
    console.log(`reset: deleted ${ids.length} seeded contracts and their children.`);
    return ids.length;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}

// ── reference bootstrap ─────────────────────────────────────────────────────

async function ensureReference(client) {
  // Ghana — the country row already ships with the schema; top up its metadata.
  const { rows: ghRows } = await client.query(
    `SELECT country_id, axco_country_code FROM public.country WHERE country_code = 'GH'`);
  let ghanaId;
  if (!ghRows.length) {
    ghanaId = (await ins(client, 'country', {
      country_code: 'GH', country_name: 'Ghana', region: 'Sub-Saharan Africa', axco_country_code: 'GHA',
    }, { returning: 'country_id' })).country_id;
    console.log('  + country GH (Ghana)');
  } else {
    ghanaId = ghRows[0].country_id;
    if (!ghRows[0].axco_country_code) {
      await client.query(`UPDATE public.country SET axco_country_code='GHA' WHERE country_id=$1`, [ghanaId]);
    }
  }

  // GHS currency + its USD rate, so Ghanaian treaties convert on the dashboards.
  let { rows: ghs } = await client.query(`SELECT currency_id FROM public.currency WHERE currency_code='GHS'`);
  if (!ghs.length) {
    ghs = [await ins(client, 'currency', { currency_code: 'GHS', currency_name: 'Ghanaian Cedi' }, { returning: 'currency_id' })];
    console.log('  + currency GHS (Ghanaian Cedi)');
  }
  await ins(client, 'ref_exchange_rate', {
    currency_code: 'GHS', rate_to_usd: 0.09, effective_date: ymd(CUR_YEAR, 0, 1), source: 'SEED',
  }, { conflict: '(currency_code, effective_date) DO UPDATE SET rate_to_usd=EXCLUDED.rate_to_usd, updated_at=now()' });

  // Ghana CPI series — the loss-inflation screens read ref_country_inflation.
  for (const [year, pct] of GHANA_CPI) {
    await ins(client, 'ref_country_inflation', {
      country_id: ghanaId, uw_year: year, inflation_pct: pct,
      source: year >= GHANA_CPI_PROJECTED_FROM ? 'IMF WEO Proj' : 'World Bank',
    }, { conflict: '(country_id, uw_year) DO UPDATE SET inflation_pct=EXCLUDED.inflation_pct, source=EXCLUDED.source' });
  }
  console.log(`  ✓ Ghana CPI ${GHANA_CPI[0][0]}–${GHANA_CPI[GHANA_CPI.length - 1][0]} (${GHANA_CPI.length} years)`);

  // CRESTA zones for Ghana — referenced by name in contract_cresta_data.
  for (let i = 0; i < CRESTA_ZONES.length; i += 1) {
    const [zoneId, zoneName] = CRESTA_ZONES[i];
    const { rows } = await client.query(
      `SELECT 1 FROM public.ref_cresta_zone WHERE country_id=$1 AND zone_id=$2`, [ghanaId, zoneId]);
    if (!rows.length) {
      await ins(client, 'ref_cresta_zone', {
        country_id: ghanaId, zone_id: zoneId, zone_name: zoneName, sort_order: i + 1,
      });
    }
  }

  // Ghanaian cedants.
  let added = 0;
  for (const name of GHANA_CEDANTS) {
    const { rows } = await client.query(`SELECT 1 FROM public.companies WHERE company_name=$1`, [name]);
    if (!rows.length) {
      await ins(client, 'companies', { company_name: name, country_id: ghanaId });
      added += 1;
    }
  }
  console.log(`  ✓ Ghanaian cedants: ${added} inserted, ${GHANA_CEDANTS.length - added} already present`);

  // Everything else already exists in a migrated database; we only read it.
  const { rows: cedants } = await client.query(
    `SELECT co.company_id, co.company_name, co.country_id, c.country_code, c.country_name
       FROM public.companies co JOIN public.country c ON c.country_id = co.country_id`);
  const { rows: currencies } = await client.query(`SELECT currency_id, currency_code FROM public.currency`);
  const { rows: brokers } = await client.query(`SELECT broker_id, broker_name FROM public.brokers WHERE broker_name <> 'Direct'`);
  const { rows: classes } = await client.query(
    `SELECT class_of_business_id AS id, class_of_business AS name FROM public.class_of_business
      WHERE class_of_business NOT IN ('Life','Group Life')`);
  const { rows: types } = await client.query(`SELECT treaty_type_id AS id, treaty_type AS name, category FROM public.treaty_type`);
  const { rows: users } = await client.query(
    `SELECT u.user_id, u.display_name, u.role_id, r.role_code
       FROM public.uw_user u JOIN public.uw_role r USING (role_id) WHERE u.is_active`);
  const { rows: reinsurers } = await client.query(`SELECT reinsurer_name, rating FROM public.reinsurers WHERE is_active`);
  const { rows: checklistItems } = await client.query(
    `SELECT item_key FROM public.wording_checklist_item WHERE is_active ORDER BY display_order`);

  const missing = [];
  if (!cedants.length) missing.push('companies');
  if (!brokers.length) missing.push('brokers');
  if (!classes.length) missing.push('class_of_business');
  if (!types.length) missing.push('treaty_type');
  if (!users.length) missing.push('uw_user');
  if (!reinsurers.length) missing.push('reinsurers');
  if (missing.length) {
    throw new Error(`reference data missing from this database: ${missing.join(', ')}. Run the migrations first.`);
  }

  const currencyByCode = new Map(currencies.map((c) => [c.currency_code, c.currency_id]));
  const usdId = currencyByCode.get('USD');
  if (!usdId) throw new Error('currency USD is missing — run the migrations first.');

  const underwriters = users.filter((u) => u.role_code === 'UW');
  const approvers = users.filter((u) => u.role_code !== 'UW');
  return {
    ghanaId,
    cedants,
    currencyByCode,
    usdId,
    brokers,
    classes,
    npTypes: types.filter((t) => t.category === 'NON_PROPORTIONAL'),
    propTypes: types.filter((t) => t.category === 'PROPORTIONAL'),
    underwriters: underwriters.length ? underwriters : users,
    approvers: approvers.length ? approvers : users,
    reinsurers,
    checklistItems: checklistItems.map((r) => r.item_key),
  };
}

// ── portfolio plan ──────────────────────────────────────────────────────────
//
// Contracts are generated as renewal lineages: a cedant/treaty-type/programme
// written for 2–4 consecutive underwriting years, each year pointing at the
// previous one through parent_contract_id. That gives the renewal-differencing
// and expiring-structure screens something real to compare against.

// Indicative units of local currency per USD, used only to keep the seeded
// amounts readable in the treaty's own currency.
const FX_PER_USD = { USD: 1, GHS: 11, AED: 3.67, SAR: 3.75, KWD: 0.31, EGP: 48, GBP: 0.79 };

function buildPlan(ref, category, count) {
  const typeMix = category === 'PROPORTIONAL' ? PROP_TYPE_MIX : NP_TYPE_MIX;
  const pool = category === 'PROPORTIONAL' ? ref.propTypes : ref.npTypes;
  const typeByName = new Map(pool.map((t) => [t.name, t]));
  const ghana = ref.cedants.filter((c) => c.country_code === 'GH');
  const others = ref.cedants.filter((c) => c.country_code !== 'GH');

  const specs = [];
  let lineage = 0;
  while (specs.length < count) {
    lineage += 1;
    // ~40% of the book sits on the newly-seeded Ghanaian cedants.
    const cedant = (ghana.length && (!others.length || chance(0.4))) ? pick(ghana) : pick(others);
    const type = typeByName.get(weighted(typeMix).name) || pick(pool);
    const code = ref.currencyByCode.has(LOCAL_CURRENCY[cedant.country_code] || '') && chance(0.6)
      ? LOCAL_CURRENCY[cedant.country_code] : 'USD';
    const broker = pick(ref.brokers);
    const owner = pick(ref.underwriters);
    const approver = pick(ref.approvers);
    const classIds = shuffle(ref.classes).slice(0, randInt(2, 4));
    const inceptionMonth = pick([0, 0, 0, 3, 6, 9]); // 1 Jan dominates, as in the real book
    const programName = `SEED · ${type.name} · ${cedant.company_name.split(' ')[0]} ${lineage}`;

    const len = randInt(2, 4);
    const endYear = chance(0.75) ? CUR_YEAR : CUR_YEAR - 1;
    const years = [];
    for (let k = len - 1; k >= 0; k -= 1) years.push(endYear - k);

    for (let k = 0; k < years.length && specs.length < count; k += 1) {
      const isFinalYear = k === years.length - 1;
      const status = isFinalYear
        ? weighted(STATUS_MIX).status
        : weighted([
          { status: 'SIGNED', w: 60 }, { status: 'AWAITING_SIGNED_LINE', w: 10 },
          { status: 'NTU', w: 15 }, { status: 'DECLINED', w: 15 },
        ]).status;
      specs.push({
        category,
        lineage,
        lineageSeq: k,
        parentIndex: k === 0 ? null : specs.length - 1,
        programName,
        cedant,
        type,
        broker,
        owner,
        approver,
        classIds,
        currencyCode: code,
        currencyId: ref.currencyByCode.get(code),
        fx: FX_PER_USD[code] || 1,
        uwYear: years[k],
        inceptionMonth,
        status,
      });
    }
  }
  return specs;
}

// ── shared per-contract economics ───────────────────────────────────────────

function buildEconomics(spec) {
  const { fx } = spec;
  const epiUsd = money(4_000_000, 90_000_000, 100_000);
  const epi = Math.round(epiUsd * fx);
  const expYears = 6;                                // uwYear-6 … uwYear-1
  const firstExpYear = spec.uwYear - expYears;
  const years = Array.from({ length: expYears }, (_, i) => firstExpYear + i);
  const targetLossRatio = round4(rand(0.38, 1.05));
  const commissionPct = round2(rand(20, 34));
  const brokeragePct = round2(rand(2.5, 15));
  const taxesPct = round2(rand(0, 5));
  return { epiUsd, epi, expYears, years, targetLossRatio, commissionPct, brokeragePct, taxesPct };
}

function statusDates(spec) {
  const y = spec.uwYear;
  const m = spec.inceptionMonth;
  const submitted = ts(y, Math.max(0, m - 1), 12, 9);
  const approved = ts(y, Math.max(0, m - 1), 20, 11);
  const terminal = ts(y, m, 5, 14);
  return { submitted, approved, terminal };
}

// The legal path each status reaches, per lib/statusMachine.js.
function workflowPath(status) {
  switch (status) {
    case 'AWAITING_APPROVAL': return ['DRAFT', 'AWAITING_APPROVAL'];
    case 'AWAITING_SIGNED_LINE': return ['DRAFT', 'AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE'];
    case 'SIGNED': return ['DRAFT', 'AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'SIGNED'];
    case 'NTU': return ['DRAFT', 'AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'NTU'];
    case 'DECLINED': return ['DRAFT', 'AWAITING_APPROVAL', 'DECLINED'];
    default: return ['DRAFT'];
  }
}

// ── contract header ─────────────────────────────────────────────────────────

async function insertHeader(client, spec, econ, parentContractId, seq) {
  const { uwYear, inceptionMonth } = spec;
  const inception = ymd(uwYear, inceptionMonth, 1);
  const renewal = ymd(uwYear + 1, inceptionMonth, 1);
  const dates = statusDates(spec);
  const isSigned = spec.status === 'SIGNED';
  const isNtu = spec.status === 'NTU';
  const isDeclined = spec.status === 'DECLINED';

  const group = await ins(client, 'contract_group', {
    cedant_id: spec.cedant.company_id,
    uw_year: uwYear,
    program_name: spec.programName,
    currency_id: spec.currencyId,
    inception_date: inception,
    expiry_date: renewal,
  }, {
    conflict: '(cedant_id, uw_year, program_name) DO UPDATE SET currency_id=EXCLUDED.currency_id, updated_at=now()',
    returning: 'contract_group_id',
  });

  const primaryClass = spec.classIds[0];
  const shortCat = spec.category === 'PROPORTIONAL' ? 'PR' : 'NP';
  const altId = `${spec.cedant.country_code}/${shortCat}/${uwYear}/${String(seq).padStart(3, '0')}`;
  const description = `${spec.cedant.company_name} — ${spec.type.name} ${uwYear} (${primaryClass.name})`;

  const row = await ins(client, 'contract', {
    parent_contract_id: parentContractId,             // NULL on a lineage's first year (see NULL POLICY)
    cedant_id: spec.cedant.company_id,
    broker_id: spec.broker.broker_id,
    country_id: spec.cedant.country_id,
    currency_id: spec.currencyId,
    treaty_type_id: spec.type.id,
    uw_year: uwYear,
    status: spec.status,
    uw_status: spec.status,
    experience_source: chance(0.8) ? 'TRIANGLE' : 'STRAIGHT',
    contract_group_id: group.contract_group_id,
    signed_line_pct: isSigned ? round4(rand(2.5, 30)) : null,
    signed_at: isSigned ? dates.terminal : null,
    ntu_reason: isNtu ? pick(NTU_REASONS) : null,
    ntu_at: isNtu ? dates.terminal : null,
    decline_reason: isDeclined ? pick(DECLINE_REASONS) : null,
    declined_at: isDeclined ? dates.terminal : null,
    renewal_date: renewal,
    inception_date: inception,
    primary_class_of_business_id: primaryClass.id,
    created_by_user_id: spec.owner.user_id,
    assigned_to_user_id: spec.owner.user_id,
    contract_description: description,
    alt_contract_id: altId,
    import_metadata: J({
      source: SEED_SOURCE,
      batch: BATCH_DATE,
      generator: 'server/scripts/seedTestTreaties.js',
      random_seed: RANDOM_SEED,
      lineage: spec.lineage,
      lineage_year: spec.lineageSeq + 1,
      epi_usd: econ.epiUsd,
    }),
    created_at: ts(uwYear, Math.max(0, inceptionMonth - 2), 3, 8),
    updated_at: dates.approved,
  }, { returning: 'contract_id' });

  return { contractId: row.contract_id, inception, renewal, dates, description, altId };
}

// ── writers shared by both treaty categories ────────────────────────────────

async function insertClassesAndLimits(client, cid, spec, econ) {
  const per = Math.round(econ.epi / spec.classIds.length);
  for (let i = 0; i < spec.classIds.length; i += 1) {
    const cls = spec.classIds[i];
    await ins(client, 'contract_class_of_business', {
      contract_id: cid, class_of_business_id: cls.id,
    }, { conflict: 'DO NOTHING' });
    // The split is forced to add back to the EPI exactly — the pricing screens
    // reconcile it against the header premium.
    const premium = i === spec.classIds.length - 1
      ? econ.epi - per * (spec.classIds.length - 1)
      : per;
    await ins(client, 'contract_epi_split', {
      contract_id: cid, class_of_business_id: cls.id, premium,
    }, { conflict: '(contract_id, class_of_business_id) DO UPDATE SET premium=EXCLUDED.premium, updated_at=now()' });
    await ins(client, 'contract_underwriting_limit', {
      contract_id: cid,
      class_of_business_id: cls.id,
      limit_amount: money(2_000_000, 40_000_000, 500_000) * spec.fx,
      basis: pick(['COMBINED', 'RISK', 'CAT']),
    }, { conflict: '(contract_id, class_of_business_id) DO UPDATE SET limit_amount=EXCLUDED.limit_amount, updated_at=now()' });
  }
}

async function insertProfiles(client, cid, spec) {
  // Risk profile — banded sums insured per class, the input to MBBEFD exposure rating.
  for (const cls of spec.classIds) {
    const profile = await ins(client, 'contract_risk_profile', {
      contract_id: cid,
      class_of_business_id: cls.id,
      c_value: round2(rand(1.5, 5)),
      pml_percentage: round2(rand(35, 100)),
      selected_curve: pick(SWISS_RE_CURVES),
      custom_b: round4(rand(0.05, 0.95)),
      custom_g: round2(rand(2, 60)),
      gross_loss_ratio: round2(rand(45, 85)),
    }, { conflict: '(contract_id, class_of_business_id) DO UPDATE SET c_value=EXCLUDED.c_value', returning: 'profile_id' });

    let from = 0;
    let to = 100_000 * spec.fx;
    for (let b = 0; b < 8; b += 1) {
      const risks = Math.max(1, Math.round(rand(4, 900) / (b + 1)));
      const avg = (from + to) / 2 || to / 2;
      await ins(client, 'contract_risk_profile_band', {
        profile_id: profile.profile_id,
        from_amt: from,
        to_amt: to,
        no_of_risks: risks,
        total_sum_insured: Math.round(risks * avg),
        gross_premium: Math.round(risks * avg * rand(0.0015, 0.006)),
      });
      from = to;
      to = Math.round(to * rand(2.5, 4));
    }

    // Claims profile — banded claim counts/amounts per class.
    const claims = await ins(client, 'contract_claims_profile', {
      contract_id: cid, class_of_business_id: cls.id,
    }, { conflict: '(contract_id, class_of_business_id) DO NOTHING', returning: 'profile_id' })
      || (await client.query(
        `SELECT profile_id FROM public.contract_claims_profile WHERE contract_id=$1 AND class_of_business_id=$2`,
        [cid, cls.id])).rows[0];

    let cFrom = 0;
    let cTo = 25_000 * spec.fx;
    for (let b = 0; b < 8; b += 1) {
      const n = Math.max(1, Math.round(rand(3, 400) / (b + 1)));
      const avg = (cFrom + cTo) / 2 || cTo / 2;
      const risks = Math.max(n, Math.round(n * rand(2, 12)));
      await ins(client, 'contract_claims_profile_band', {
        profile_id: claims.profile_id,
        from_amt: cFrom,
        to_amt: cTo,
        no_of_claims: n,
        aggregate_incurred: Math.round(n * avg),
        no_of_risks: risks,
        total_sum_insured: Math.round(risks * avg * rand(6, 20)),
        gross_premium: Math.round(risks * avg * rand(0.02, 0.09)),
      });
      cFrom = cTo;
      cTo = Math.round(cTo * rand(2.5, 4));
    }
  }
}

async function insertCresta(client, cid, spec) {
  const zones = shuffle(CRESTA_ZONES).slice(0, randInt(4, 6));
  for (const [zoneId, zoneName] of zones) {
    const base = money(20_000_000, 900_000_000, 1_000_000) * spec.fx;
    const cls = pick(spec.classIds);
    await ins(client, 'contract_cresta_data', {
      contract_id: cid,
      country_id: spec.cedant.country_id,
      zone_id: zoneId,
      zone_name: zoneName,
      eq_agg: Math.round(base * rand(0.15, 0.4)),
      ws_agg: Math.round(base * rand(0.1, 0.35)),
      flood_agg: Math.round(base * rand(0.05, 0.3)),
      srcc_agg: Math.round(base * rand(0.02, 0.12)),
      others_agg: Math.round(base * rand(0.01, 0.08)),
      treaty_type: spec.type.name,
      cob_id: cls.id,
      cob_name: cls.name,
      residential_bldg_pct: 30,
      commercial_bldg_pct: 25,
      commercial_cont_pct: 15,
      industrial_bldg_pct: 20,
      industrial_cont_pct: 10,
    });
  }
}

async function insertTriangles(client, cid, spec, econ, includeNpExcess) {
  const types = includeNpExcess ? [...TRIANGLE_TYPES, 'NP_EXCESS'] : TRIANGLE_TYPES;
  const latestOrigin = spec.uwYear - 1;
  const devPoints = econ.expYears;                   // 12 … expYears*12 months

  for (const type of types) {
    for (const variant of TRIANGLE_VARIANTS) {
      // MODIFIED is the as-if/on-level view — a few points off the raw ACTUAL.
      const variantFactor = variant === 'MODIFIED' ? rand(1.02, 1.12) : 1;
      for (const origin of econ.years) {
        const yearPremium = econ.epi * rand(0.75, 1.2) * (1 + (origin - econ.years[0]) * 0.05);
        const ultimateClaims = yearPremium * econ.targetLossRatio * rand(0.8, 1.25);
        const maxDev = (latestOrigin - origin + 1) * 12;
        for (let dev = 12; dev <= maxDev; dev += 12) {
          const step = dev / 12;
          // Premium is written by month 12 and only trues up; claims develop.
          const developed = type === 'PREMIUM'
            ? Math.min(1, 0.94 + 0.02 * step)
            : 1 - Math.exp(-0.75 * step);
          let value;
          if (type === 'PREMIUM') value = yearPremium * developed;
          else if (type === 'CLAIMS_PAID') value = ultimateClaims * developed * 0.82;
          else if (type === 'CLAIMS_OS') value = ultimateClaims * developed * 0.22;
          else if (type === 'INCURRED') value = ultimateClaims * developed;
          else value = ultimateClaims * developed * 0.35;   // NP_EXCESS
          await ins(client, 'contract_triangle_cells', {
            contract_id: cid,
            type,
            variant,
            origin_year: origin,
            dev_months: dev,
            cum_value: Math.round(value * variantFactor),
          }, { conflict: '(contract_id, type, variant, origin_year, dev_months) DO UPDATE SET cum_value=EXCLUDED.cum_value, updated_at=now()' });
        }
      }
    }

    // Selected development factors per triangle, and the pattern the pricing
    // screens read back.
    const selected = {};
    let cdf = round4(rand(1.05, 1.6));
    for (let dev = 12; dev <= devPoints * 12; dev += 12) {
      const ldf = round4(1 + (cdf - 1) * rand(0.35, 0.65));
      const actual = round4(ldf * rand(0.94, 1.06));
      const param = round4(ldf * rand(0.96, 1.04));
      const source = pick(['ACTUAL', 'PARAMETRIZED', 'SELECTED']);
      const chosen = source === 'ACTUAL' ? actual : (source === 'PARAMETRIZED' ? param : ldf);
      await ins(client, 'contract_dev_factor', {
        contract_id: cid,
        triangle_type: type,
        dev_month: dev,
        selected_ldf: ldf,
        selected_cdf: cdf,
        actual_ldf: actual,
        actual_cdf: round4(cdf * rand(0.95, 1.05)),
        param_ldf: param,
        param_cdf: round4(cdf * rand(0.97, 1.03)),
        parametrized_ldf: param,
        parametrized_cdf: round4(cdf * rand(0.97, 1.03)),
        chosen_source: source,
        chosen_ldf: chosen,
        chosen_cdf: cdf,
        overridden: source === 'SELECTED',
        saved_at: ts(spec.uwYear, spec.inceptionMonth, 2, 9),
      }, { conflict: '(contract_id, triangle_type, dev_month) DO UPDATE SET chosen_ldf=EXCLUDED.chosen_ldf, saved_at=now()' });
      selected[String(dev)] = ldf;
      cdf = round4(Math.max(1.0005, cdf / ldf));
    }

    await ins(client, 'contract_pricing_patterns', {
      contract_id: cid,
      triangle_type: type,
      selection_method: pick(['WEIGHTED', 'SIMPLE', 'LATEST_3', 'MANUAL']),
      selected_factors: J(selected),
      tail_factor: round4(rand(1.0, 1.08)),
      bf_ielr: round4(econ.targetLossRatio),
    }, { conflict: '(contract_id, triangle_type) DO UPDATE SET selected_factors=EXCLUDED.selected_factors, updated_at=now()' });

    // Benchmark blend — the weights that produced the curve above.
    const blend = await ins(client, 'contract_ldf_blend', {
      contract_id: cid, triangle_type: type, overridden: chance(0.3),
    }, { conflict: '(contract_id, triangle_type) DO UPDATE SET overridden=EXCLUDED.overridden, updated_at=now()', returning: 'blend_id' });
    let wcdf = round4(rand(1.05, 1.5));
    for (let dev = 12; dev <= devPoints * 12; dev += 12) {
      const wldf = round4(1 + (wcdf - 1) * rand(0.4, 0.6));
      await ins(client, 'contract_ldf_blend_curve', {
        blend_id: blend.blend_id, dev_month: dev, weighted_ldf: wldf, weighted_cdf: wcdf,
      }, { conflict: '(blend_id, dev_month) DO UPDATE SET weighted_ldf=EXCLUDED.weighted_ldf, weighted_cdf=EXCLUDED.weighted_cdf' });
      wcdf = round4(Math.max(1.0005, wcdf / wldf));
    }
    const weights = spec.classIds.map(() => rnd());
    const wSum = weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < spec.classIds.length; i += 1) {
      await ins(client, 'contract_ldf_blend_weight', {
        blend_id: blend.blend_id,
        class_of_business_id: spec.classIds[i].id,
        weight: round4(weights[i] / wSum),
        benchmark_scope: pick(['COUNTRY', 'REGION', 'GLOBAL']),
        n_contracts: randInt(3, 60),
      }, { conflict: '(blend_id, class_of_business_id) DO UPDATE SET weight=EXCLUDED.weight' });
    }
  }
}

async function insertStraightExperience(client, cid, spec, econ) {
  await ins(client, 'contract_straight_experience', {
    contract_id: cid,
    tail_type: pick(['SHORT_TAIL', 'LONG_TAIL', 'CUSTOM']),
    uw_start_year: econ.years[0],
    uw_end_year: econ.years[econ.years.length - 1],
  }, { conflict: '(contract_id) DO UPDATE SET tail_type=EXCLUDED.tail_type, updated_at=now()' });

  for (const year of econ.years) {
    const premium = Math.round(econ.epi * rand(0.75, 1.2));
    const incurred = Math.round(premium * econ.targetLossRatio * rand(0.7, 1.35));
    await ins(client, 'contract_straight_uw_stats', {
      contract_id: cid,
      underwriting_year: year,
      premium,
      paid_claims: Math.round(incurred * rand(0.7, 0.9)),
      os_claims: Math.round(incurred * rand(0.1, 0.3)),
    }, { conflict: '(contract_id, underwriting_year) DO UPDATE SET premium=EXCLUDED.premium' });
  }
}

// Large and CAT loss listings, plus the inflation/selection snapshot the
// Pareto screens persist.
async function insertLosses(client, cid, spec, econ, kind, threshold) {
  const reportTable = kind === 'CAT' ? 'contract_cat_loss_report' : 'contract_large_loss_report';
  const lossTable = kind === 'CAT' ? 'contract_cat_losses' : 'contract_large_losses';
  const report = await ins(client, reportTable, {
    contract_id: cid, quote_id: null, report_date: ymd(spec.uwYear, spec.inceptionMonth, 1),
  }, { conflict: '(contract_id) DO UPDATE SET report_date=EXCLUDED.report_date, updated_at=now()', returning: 'report_id' });

  const n = kind === 'CAT' ? randInt(4, 9) : randInt(8, 18);
  const losses = [];
  for (let i = 0; i < n; i += 1) {
    const year = pick(econ.years);
    const month = randInt(0, 11);
    const day = randInt(1, 28);
    const incurred = Math.round(threshold * rand(0.6, 9));
    const paid = Math.round(incurred * rand(0.55, 0.92));
    const cls = pick(spec.classIds);
    // Trend each loss to the current year at the country's inflation rate.
    const inflation = round4(Math.pow(1 + rand(0.06, 0.22), spec.uwYear - year));
    const row = await ins(client, lossTable, {
      report_id: report.report_id,
      contract_id: cid,
      uw_year: year,
      insured_name: pick(INSURED_NAMES),
      loss_name: kind === 'CAT' ? `${pick(PERILS)} event ${year}-${i + 1}` : `${cls.name} loss ${year}-${i + 1}`,
      date_of_loss: ts(year, month, day, 3),
      class_of_business: cls.name,
      paid,
      os: incurred - paid,
      incurred,
      gross_amount: Math.round(incurred * rand(1.05, 1.6)),
      our_share_pct: round2(rand(2.5, 30)),
      is_selected: chance(0.85),
      inflation_factor: inflation,
      loss_type: 'REPORTED',
      reported_date: ymd(year, Math.min(11, month + 1), day),
      actuarial_reported_date: ymd(year, Math.min(11, month + 2), day),
      policy_inception_date: ymd(year, 0, 1),
    }, { returning: 'loss_id' });
    losses.push({ loss_id: row.loss_id, year, month, day, incurred, paid, cls, inflation, name: kind });
  }

  const snapshot = await ins(client, 'contract_loss_selection_snapshot', {
    contract_id: cid,
    quote_id: null,
    loss_type: kind,
    inflation_mode: pick(['INDEX', 'FLAT']),
    inflation_index: 'CPI',
    inflation_base_year: econ.years[0],
    inflation_to_year: spec.uwYear,
    inflation_rate_pct: round2(rand(6, 22)),
    global_factor: round4(rand(1.0, 1.6)),
    selected_count: losses.length,
    threshold,
    return_period_curve: J([5, 10, 25, 50, 100, 200].map((rp) => ({ return_period: rp, loss: Math.round(threshold * Math.pow(rp, 0.45)) }))),
    return_period_key_points: J({ rp10: Math.round(threshold * 2.7), rp100: Math.round(threshold * 7.6), rp250: Math.round(threshold * 11.2) }),
    assumptions_hash: `seed-${kind.toLowerCase()}-${spec.lineage}-${spec.uwYear}`,
    loadings: J([{ name: 'Model uncertainty', pct: 5 }, { name: 'Data quality', pct: 2.5 }]),
    total_loading_pct: 7.5,
    distribution_fits: J({ pareto: { alpha: round4(rand(1.2, 2.6)) }, lognormal: { mu: round4(rand(11, 15)), sigma: round4(rand(0.6, 1.8)) } }),
    active_distribution: pick(['PARETO', 'LOGNORMAL']),
    distribution: pick(['PARETO', 'LOGNORMAL']),
    pareto_xm: threshold,
    pareto_alpha: round4(rand(1.2, 2.6)),
    pareto_limit: Math.round(threshold * 25),
    xm: threshold,
    limit_amt: Math.round(threshold * 25),
    observation_years: econ.expYears,
    years_override: econ.expYears,
    snapshot_date: ts(spec.uwYear, spec.inceptionMonth, 2, 12),
  }, { returning: 'snapshot_id' });

  for (const l of losses) {
    await ins(client, 'contract_loss_selection_snapshot_item', {
      snapshot_id: snapshot.snapshot_id,
      loss_id: l.loss_id,
      source_loss_id: l.loss_id,
      uw_year: l.year,
      insured_name: pick(INSURED_NAMES),
      loss_name: `${l.name} loss ${l.year}`,
      date_of_loss: ymd(l.year, l.month, l.day),
      class_of_business: l.cls.name,
      paid: l.paid,
      os: l.incurred - l.paid,
      incurred: l.incurred,
      inflation_factor: l.inflation,
      inflated_incurred: Math.round(l.incurred * l.inflation),
      original_loss: l.incurred,
      inflated_loss: Math.round(l.incurred * l.inflation),
      is_selected: true,
      note: 'Seeded selection — trended to the current underwriting year.',
    });
  }
  return losses;
}

async function insertExposureExtras(client, cid, spec) {
  // Event loss table — both jsonb columns carry the same payload; `data` is the
  // newer of the two and readers fall back to `elt_data`.
  const elt = {
    vendor: pick(['RMS', 'Verisk', 'CoreLogic', 'Internal']),
    modelVersion: `v${randInt(18, 24)}.${randInt(0, 4)}`,
    perilSet: pick(PERILS),
    updatedAt: ts(spec.uwYear, spec.inceptionMonth, 2, 10),
    rows: [10, 25, 50, 100, 250, 500].map((rp) => ({
      return_period: rp,
      event_id: `EVT-${spec.uwYear}-${rp}`,
      gross_loss: money(1_000_000, 400_000_000, 100_000) * spec.fx,
      rate: round4(1 / rp),
    })),
  };
  await ins(client, 'contract_event_loss_tables', {
    contract_id: cid, elt_data: J(elt), data: J(elt),
  }, { conflict: '(contract_id) DO UPDATE SET elt_data=EXCLUDED.elt_data, data=EXCLUDED.data, updated_at=now()' });

  const groundUp = money(5_000_000, 250_000_000, 100_000) * spec.fx;
  await ins(client, 'contract_gem_eq_scenario', {
    contract_id: cid,
    model_version: `GEM-${randInt(2020, 2024)}.${randInt(1, 4)}`,
    curve_assignments: J(Object.fromEntries(spec.classIds.map((c) => [c.name, pick(['RC-LOW', 'RC-MID', 'RC-HIGH', 'MASONRY', 'STEEL'])]))),
    intensities: J({ mmi_vi: round4(rand(0.1, 0.6)), mmi_vii: round4(rand(0.05, 0.3)), mmi_viii: round4(rand(0.01, 0.12)) }),
    ground_up_eq_loss: groundUp,
    effective_mdr: round4(rand(0.005, 0.09)),
    computed_at: ts(spec.uwYear, spec.inceptionMonth, 2, 13),
  }, { conflict: '(contract_id) DO UPDATE SET ground_up_eq_loss=EXCLUDED.ground_up_eq_loss, updated_at=now()' });
}

async function insertCommissions(client, cid, spec, econ) {
  const sliding = chance(0.45);
  const minComm = round2(econ.commissionPct - rand(4, 8));
  const maxComm = round2(econ.commissionPct + rand(4, 8));
  await ins(client, 'contract_commissions', {
    contract_id: cid,
    mode: sliding ? 'SLIDING' : 'FIXED',
    fixed_commission_pct: econ.commissionPct,
    fixed_commission_qs_pct: econ.commissionPct,
    fixed_commission_surplus_pct: round2(econ.commissionPct - rand(0.5, 3)),
    provisional_commission_pct: round2(econ.commissionPct - 1),
    sliding_min_commission: minComm,
    sliding_max_commission: maxComm,
    sliding_min_loss_ratio: round2(rand(40, 52)),
    sliding_max_loss_ratio: round2(rand(62, 78)),
    mgmt_expenses_pct: round2(rand(2, 6)),
    profit_commission_pct: round2(rand(10, 25)),
    lcf_years: randInt(1, 5),
    lcf_extinction: chance(0.3),
  }, { conflict: '(contract_id) DO UPDATE SET mode=EXCLUDED.mode, updated_at=now()' });

  // Sliding scale — commission falls as the loss ratio rises.
  const rows = 8;
  const lrLo = 40;
  const lrHi = 80;
  for (let i = 0; i < rows; i += 1) {
    const lr = round2(lrLo + ((lrHi - lrLo) * i) / (rows - 1));
    const comm = round2(maxComm - ((maxComm - minComm) * i) / (rows - 1));
    await ins(client, 'contract_commission_slides', {
      contract_id: cid, row_no: i + 1, loss_ratio_pct: lr, commission_pct: comm,
    }, { conflict: '(contract_id, row_no) DO UPDATE SET loss_ratio_pct=EXCLUDED.loss_ratio_pct, commission_pct=EXCLUDED.commission_pct, updated_at=now()' });
  }

  const lpMin = round2(rand(70, 85));
  const lpMax = round2(rand(95, 130));
  await ins(client, 'contract_loss_participation', {
    contract_id: cid,
    enabled: true,
    min_loss_ratio_pct: lpMin,
    max_loss_ratio_pct: lpMax,
    reinsurer_share_pct: round2(rand(50, 100)),
    slides: J([
      { min_lr: lpMin, max_lr: round2((lpMin + lpMax) / 2), share: 50 },
      { min_lr: round2((lpMin + lpMax) / 2), max_lr: lpMax, share: 75 },
    ]),
  }, { conflict: '(contract_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()' });
}

async function insertPricing(client, cid, spec, econ, result, ref) {
  const attritional = round4(econ.targetLossRatio * rand(0.55, 0.75));
  const largeLoad = round4(econ.targetLossRatio * rand(0.15, 0.3));
  const catLoad = round4(econ.targetLossRatio * rand(0.05, 0.2));
  const commissionRatio = round4(econ.commissionPct / 100);
  const brokerageRatio = round4(econ.brokeragePct / 100);
  const taxRatio = round4(econ.taxesPct / 100);
  const technical = round4(1 - attritional - largeLoad - catLoad - commissionRatio - brokerageRatio - taxRatio);

  await ins(client, 'contract_pricing_outputs', {
    contract_id: cid,
    epi: econ.epi,
    attritional_ratio: attritional,
    large_loss_load: largeLoad,
    cat_loss_load: catLoad,
    commission_ratio: commissionRatio,
    brokerage_ratio: brokerageRatio,
    tax_ratio: taxRatio,
    technical_result: technical,
    max_commission: round4(commissionRatio + Math.max(0, technical) * 0.6),
    target_margin: round4(rand(0.05, 0.18)),
    actuarial_margin: round4(technical * rand(0.85, 1.0)),
    actual_margin: round4(technical * rand(0.8, 1.15)),
    uw_margin: round4(technical * rand(0.9, 1.1)),
    uw_comment: `Rate adequate at the offered terms; ${spec.type.name} on ${spec.cedant.company_name}.`,
    offer_status: result.offerStatus,
    offer_line: `${round2(rand(2.5, 30))}%`,
    offer_comment: 'Seeded offer — line subject to signed order.',
    offer_approver: result.approverName,
    signed_line_pct: result.signedLinePct,
  }, { conflict: '(contract_id) DO UPDATE SET epi=EXCLUDED.epi, updated_at=now()' });

  // Six years of actual experience plus the projected view for the same years.
  for (const year of [...econ.years, spec.uwYear]) {
    for (const recordType of ['ACTUAL', 'PROJECTED']) {
      const premium = Math.round(econ.epi * rand(0.8, 1.2));
      const lr = recordType === 'ACTUAL' ? econ.targetLossRatio * rand(0.7, 1.4) : econ.targetLossRatio;
      const loss = Math.round(premium * lr);
      await ins(client, 'contract_pricing_yearly', {
        contract_id: cid,
        uw_year: year,
        record_type: recordType,
        ultimate_premium: premium,
        ultimate_loss: loss,
        loss_ratio: round4(lr),
        commission_amt: Math.round(premium * commissionRatio),
        brokerage_amt: Math.round(premium * brokerageRatio),
        technical_result: Math.round(premium - loss - premium * (commissionRatio + brokerageRatio + taxRatio)),
      }, { conflict: '(contract_id, uw_year, record_type) DO UPDATE SET ultimate_premium=EXCLUDED.ultimate_premium, updated_at=now()' });
    }
  }

  const componentValues = {
    'Attritional Loss Ratio': attritional,
    'Large Loss Loading': largeLoad,
    'Cat Loss Loading': catLoad,
    Commissions: commissionRatio,
    Brokerage: brokerageRatio,
    Taxes: taxRatio,
    Result: technical,
    'Maximum Commissions (Reinsurer)': round4(commissionRatio + Math.max(0, technical) * 0.6),
  };
  const pct = (v) => `${round2(v * 100)}%`;
  for (let i = 0; i < COMPONENT_ROWS.length; i += 1) {
    const name = COMPONENT_ROWS[i];
    const base = componentValues[name];
    await ins(client, 'pricing_components', {
      contract_id: cid,
      component_name: name,
      actuarial_value: pct(base),
      uw_value: pct(base * rand(0.95, 1.06)),
      market_value: pct(base * rand(0.9, 1.12)),
      actual_stats_value: pct(base * rand(0.85, 1.2)),
      exposure_value: pct(base * rand(0.92, 1.1)),
      underwriter_value: pct(base * rand(0.95, 1.05)),
      comment: `${name} — seeded from the ${econ.expYears}-year experience.`,
      selected: true,
      display_order: i + 1,
    }, { conflict: '(contract_id, component_name) DO UPDATE SET uw_value=EXCLUDED.uw_value' });
  }

  const lead = pick(ref.reinsurers);
  const expiringLead = pick(ref.reinsurers);
  await ins(client, 'pricing_leads', {
    contract_id: cid,
    lead_reinsurer: lead.reinsurer_name,
    expiring_reinsurer: expiringLead.reinsurer_name,
    lead_share_pct: round2(rand(10, 40)),
  }, { conflict: '(contract_id) DO UPDATE SET lead_reinsurer=EXCLUDED.lead_reinsurer, updated_at=now()' });

  for (const label of SHARE_ROWS) {
    const share = Number(label.replace('%', '')) / 100;
    const limit = Math.round(econ.epi * 3 * share);
    await ins(client, 'pricing_share_scenarios', {
      contract_id: cid,
      share_label: label,
      limit_amt: limit,
      premium_amt: Math.round(econ.epi * share),
      cedant_limit: Math.round(econ.epi * 3),
      agg_contrib: Math.round(limit * rand(1.5, 3)),
      country_agg: Math.round(limit * rand(3, 8)),
      event_limit: Math.round(limit * rand(1, 2)),
      downside_amt: Math.round(limit * rand(0.6, 1)),
      shortfall_amt: Math.round(limit * rand(0.2, 0.5)),
    }, { conflict: '(contract_id, share_label) DO UPDATE SET limit_amt=EXCLUDED.limit_amt, updated_at=now()' });
  }
}

// ── workflow, offer and governance trail ────────────────────────────────────

async function insertWorkflow(client, cid, spec, econ, header, ref, layers) {
  const path = workflowPath(spec.status);
  const { submitted, approved, terminal } = header.dates;
  const stamps = [
    ts(spec.uwYear, Math.max(0, spec.inceptionMonth - 2), 4, 9),
    submitted, approved, terminal,
  ];
  const owner = spec.owner;
  const approver = spec.approver;

  for (let i = 1; i < path.length; i += 1) {
    const actor = path[i] === 'AWAITING_APPROVAL' ? owner : approver;
    await ins(client, 'contract_workflow_event', {
      contract_id: cid,
      from_status: path[i - 1],
      to_status: path[i],
      actor: actor.display_name,
      comment: `${path[i - 1]} → ${path[i]} (seeded lifecycle)`,
      created_at: stamps[Math.min(i, stamps.length - 1)],
    });
    await ins(client, 'contract_audit_event', {
      contract_id: cid,
      event_type: 'STATUS_CHANGED',
      actor: actor.display_name,
      payload: J({ from: path[i - 1], to: path[i], source: SEED_SOURCE }),
      created_at: stamps[Math.min(i, stamps.length - 1)],
    });
  }

  await ins(client, 'contract_assignment_history', {
    entity_type: 'contract',
    entity_id: cid,
    from_user_id: null,
    to_user_id: owner.user_id,
    assigned_by: owner.user_id,
    assignment_type: 'CREATED',
    comment: 'Created by the seed generator.',
    assigned_at: stamps[0],
  });
  // A second hop so from_user_id carries a value on at least one row per treaty.
  await ins(client, 'contract_assignment_history', {
    entity_type: 'contract',
    entity_id: cid,
    from_user_id: owner.user_id,
    to_user_id: approver.user_id,
    assigned_by: owner.user_id,
    assignment_type: 'REASSIGNED',
    comment: 'Referred to the approver for the authority check.',
    assigned_at: submitted,
  });

  const isSigned = spec.status === 'SIGNED';
  const isNtu = spec.status === 'NTU';
  const isDeclined = spec.status === 'DECLINED';
  const decided = isSigned || isNtu || spec.status === 'AWAITING_SIGNED_LINE';
  const decision = isDeclined ? 'DECLINED' : (decided ? 'APPROVED' : null);
  const writtenLine = round2(rand(5, 35));
  const signedLine = isSigned ? round4(rand(2.5, 30)) : null;

  const offer = await ins(client, 'contract_offer', {
    contract_id: cid,
    quote_id: null,
    written_line_pct: writtenLine,
    premium_driver: pick(['Rate adequacy', 'Exposure growth', 'Cedant relationship', 'Portfolio diversification']),
    profit_driver: pick(['Low attritional volatility', 'Improved terms', 'Reduced commission', 'Better attachment']),
    strategic_rationale: `Core ${spec.cedant.country_name} relationship — supports the ${spec.type.name} programme.`,
    tactical_rationale: 'Priced above technical; supports the wider treaty account for the year.',
    next_approver: approver.display_name,
    next_approver_id: approver.user_id,
    next_approver_role: approver.role_code,
    approver_options: J(ref.approvers.map((a) => ({ user_id: a.user_id, display_name: a.display_name, role_code: a.role_code }))),
    status: spec.status,
    breach_type: pick(['NONE', 'LIMIT', 'CLASS', 'BOTH']),
    approval_step: decided || isDeclined ? 2 : 1,
    submitted_by_id: owner.user_id,
    submitted_at: submitted,
    epi_usd: econ.epiUsd,
    peer1_user_id: approver.user_id,
    peer1_decision: decision,
    peer1_comment: decision ? `${decision} by ${approver.display_name} — within authority.` : 'Awaiting first peer review.',
    peer1_at: decision ? approved : null,
    peer2_user_id: pick(ref.approvers).user_id,
    peer2_decision: decision,
    peer2_comment: decision ? 'Concurs with the first reviewer.' : 'Awaiting second peer review.',
    peer2_at: decision ? approved : null,
    arbiter_user_id: approver.user_id,
    arbiter_decision: decision,
    arbiter_comment: 'No split decision — arbiter not required.',
    arbiter_at: decision ? approved : null,
    arbiter_required: false,
    approved_at: decided ? approved : null,
    sent_to_market_at: decided ? approved : null,
    signed_at: isSigned ? terminal : null,
    ntu_at: isNtu ? terminal : null,
    ntu_reason: isNtu ? pick(NTU_REASONS) : null,
    declined_at: isDeclined ? terminal : null,
    decline_reason: isDeclined ? pick(DECLINE_REASONS) : null,
    offer_line: `${writtenLine}%`,
    offer_comment: 'Seeded offer — line subject to signed order.',
    offer_approver: approver.display_name,
    created_at: submitted,
  }, { conflict: '(contract_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now()', returning: 'offer_id' });

  // One offered line per NP layer; proportional treaties offer a single section.
  const offerLayers = layers.length ? layers : [{
    layer_number: 1,
    layer_limit: Math.round(econ.epi * 3),
    attachment: 0,
    aggregate_limit: Math.round(econ.epi * 6),
  }];
  for (const l of offerLayers) {
    await ins(client, 'contract_offer_layer', {
      offer_id: offer.offer_id,
      layer_number: l.layer_number,
      offered_share_pct: writtenLine,
      offered_premium: Math.round(econ.epi * (writtenLine / 100) / offerLayers.length),
      risk_limit: Math.round(l.layer_limit),
      cat_limit: Math.round(l.layer_limit * rand(1, 2)),
      agg_limit: Math.round(l.aggregate_limit || l.layer_limit * 3),
    }, { conflict: '(offer_id, layer_number) DO UPDATE SET offered_share_pct=EXCLUDED.offered_share_pct' });
  }

  await ins(client, 'contract_approval', {
    contract_id: cid,
    requested_by: owner.display_name,
    requested_at: submitted,
    decision: decision || 'RETURNED',
    decided_by: approver.display_name,
    decided_at: decision ? approved : submitted,
    note: decision
      ? `${decision} — ${spec.type.name} ${spec.uwYear}.`
      : 'Returned to the underwriter for further exposure data.',
  });

  await ins(client, 'approval_decision', {
    request_id: offer.offer_id,
    decided_by: approver.user_id,
    decided_by_role: approver.role_id,
    decision: decision || 'RETURNED',
    comment: 'Seeded approval decision.',
    decided_at: decision ? approved : submitted,
  }, { conflict: '(request_id, decided_by) DO UPDATE SET decision=EXCLUDED.decision, decided_at=EXCLUDED.decided_at' });

  return { offerStatus: spec.status, approverName: approver.display_name, signedLinePct: signedLine };
}

async function insertWordingChecklist(client, cid, spec, ref) {
  if (!ref.checklistItems.length) return;
  const run = await ins(client, 'contract_wording_checklist_run', {
    contract_id: cid,
    quote_id: null,
    document_id: null,
    doc_type: 'SLIP',
    provider: 'heuristic',
    status: 'completed',
    summary: `Seeded wording review for ${spec.type.name} ${spec.uwYear}.`,
    raw_result: J({ generator: SEED_SOURCE, items: ref.checklistItems.length }),
    created_at: ts(spec.uwYear, spec.inceptionMonth, 3, 10),
  }, { returning: 'analysis_run_id' });

  for (const key of ref.checklistItems) {
    const status = weighted([
      { status: 'found', w: 60 }, { status: 'partial', w: 15 },
      { status: 'missing', w: 15 }, { status: 'unknown', w: 10 },
    ]).status;
    await ins(client, 'contract_wording_checklist', {
      contract_id: cid,
      quote_id: null,
      item_key: key,
      status,
      source: 'heuristic',
      evidence: `Seeded evidence for ${key} (${status}).`,
      checked_at: ts(spec.uwYear, spec.inceptionMonth, 3, 11),
      checked_by_user_id: spec.owner.user_id,
      document_id: null,
      analysis_run_id: run.analysis_run_id,
    });
  }
}

async function insertTermsSnapshot(client, cid, spec, econ, terms) {
  await ins(client, 'contract_terms_snapshot', {
    contract_id: cid,
    terms_kind: spec.category === 'PROPORTIONAL' ? 'PROP' : 'NP',
    terms: J(terms),
    created_at: ts(spec.uwYear, spec.inceptionMonth, 4, 10),
  });
}

// ── proportional ────────────────────────────────────────────────────────────
//
// Every prop treaty gets both a quota-share and a surplus section populated,
// whatever its treaty type. On a pure Quota Share the surplus figures describe
// the companion section of the same programme rather than this contract — the
// alternative is a form full of blank inputs, which is what this seed exists to
// avoid.

async function insertProp(client, cid, spec, econ, header) {
  const qsShare = round2(rand(0.35, 0.7));
  const qsEpi = Math.round(econ.epi * qsShare);
  const surplusEpi = econ.epi - qsEpi;
  const qsLimit = money(2_000_000, 40_000_000, 250_000) * spec.fx;
  const cessionPct = round2(rand(50, 85));
  const retentionPct = round2(100 - cessionPct);
  const lineSize = money(500_000, 6_000_000, 100_000) * spec.fx;
  const numLines = randInt(4, 12);

  await ins(client, 'contract_prop_details', {
    contract_id: cid,
    triangulations_available: chance(0.85),
    inception_date: header.inception,
    renewal_date: header.renewal,
    qs_limit: qsLimit,
    retention_pct: retentionPct,
    retention_amt: Math.round(qsLimit * (retentionPct / 100)),
    cession_pct: cessionPct,
    cession_amt: Math.round(qsLimit * (cessionPct / 100)),
    surplus_max_retention: lineSize,
    num_lines: numLines,
    total_capacity: Math.round(lineSize * (numLines + 1)),
    event_limit: Math.round(qsLimit * rand(2, 5)),
    aal: Math.round(econ.epi * rand(0.15, 0.5)),
    quota_share_epi: qsEpi,
    surplus_epi: surplusEpi,
    brokerage_pct: econ.brokeragePct,
    taxes_pct: econ.taxesPct,
    loss_cap_pct: round2(rand(120, 300)),
    experience_start_year: econ.years[0],
    strip_large_cat_losses: chance(0.35),
    loss_selection_saved_at: ts(spec.uwYear, spec.inceptionMonth, 2, 12),
  }, { conflict: '(contract_id) DO UPDATE SET qs_limit=EXCLUDED.qs_limit, updated_at=now()' });

  return {
    treaty_detail: {
      inceptionDate: header.inception,
      renewalDate: header.renewal,
      startYear: String(spec.uwYear),
      estEpi: econ.epi,
      currency: spec.currencyCode,
    },
    structure: {
      quotaShareEpi: qsEpi, surplusEpi, qsLimit, cessionPct, retentionPct,
      lineSize, numLines, totalCapacity: lineSize * (numLines + 1),
    },
    commissions: { fixedPct: econ.commissionPct, brokeragePct: econ.brokeragePct, taxesPct: econ.taxesPct },
  };
}

// ── non-proportional ────────────────────────────────────────────────────────

function buildTower(spec, econ) {
  const isCat = CAT_TYPES.has(spec.type.name);
  const isRisk = RISK_TYPES.has(spec.type.name);
  const count = randInt(2, 5);
  const layers = [];
  let attachment = money(500_000, 5_000_000, 100_000) * spec.fx;
  for (let i = 0; i < count; i += 1) {
    const limit = money(1_000_000, 40_000_000, 250_000) * spec.fx * (i + 1);
    const frac = count > 1 ? i / (count - 1) : 0;
    const rol = round2(Math.max(1.5, Math.min(60, (38 - frac * 30) * rand(0.75, 1.25))));
    const egnpi = Math.round(econ.epi);
    const premium = Math.round(limit * (rol / 100));
    const perilScope = isCat && isRisk ? 'BOTH' : (isCat ? 'CAT' : 'RISK');
    layers.push({
      layer_number: i + 1,
      attachment,
      layer_limit: limit,
      aggregate_limit: Math.round(limit * randInt(2, 4)),
      egnpi,
      earned_premium: premium,
      rate: round2((premium / egnpi) * 100),
      rol,
      num_reinstatements: randInt(0, 3),
      reinstatement_pct: pick([50, 100, 100]),
      annual_agg_deductible: Math.round(attachment * rand(0.5, 2)),
      peril_scope: perilScope,
      mdp: Math.round(premium * rand(0.7, 0.95)),
      mdp_pct: round2(rand(70, 95)),
      hist_margin: round4(rand(-0.15, 0.4)),
      modelled_margin: round4(rand(-0.1, 0.35)),
      tech_ratio: round4(rand(0.55, 1.25)),
      uw_price: round2(rol * rand(0.9, 1.15)),
      expiring_price: round2(rol * rand(0.85, 1.1)),
      lead_price: round2(rol * rand(0.9, 1.05)),
    });
    attachment += limit;
  }
  return layers;
}

async function insertNp(client, cid, spec, econ, header) {
  const layers = buildTower(spec, econ);
  const deductible = layers[0].attachment;

  await ins(client, 'contract_np_details', {
    contract_id: cid,
    number_of_layers: layers.length,
    expiring_number_of_layers: Math.max(1, layers.length - (chance(0.3) ? 1 : 0)),
    deductible,
    max_retention: Math.round(deductible * rand(0.6, 1)),
    accounting_method: pick(['Losses Occurring', 'Risks Attaching']),
    xl_type: pick(['Gross XL', 'Net XL']),
    accounts: pick(['Annual', 'Half yearly', 'Quarterly']),
    brokerage_pct: econ.brokeragePct,
    taxes_pct: econ.taxesPct,
    no_claims_bonus_pct: round2(rand(0, 15)),
    profit_commission_pct: round2(rand(0, 20)),
    est_gnpi: econ.epi,
    adjustment_rate: round4(rand(0.5, 8)),
    deposit_premium: Math.round(layers.reduce((s, l) => s + l.earned_premium, 0) * rand(0.75, 0.95)),
    experience_start_year: econ.years[0],
  }, { conflict: '(contract_id) DO UPDATE SET number_of_layers=EXCLUDED.number_of_layers, updated_at=now()' });

  for (const layer of layers) {
    const row = await ins(client, 'contract_np_layers', {
      contract_id: cid, ...layer,
    }, { conflict: '(contract_id, layer_number) DO UPDATE SET layer_limit=EXCLUDED.layer_limit, updated_at=now()', returning: 'layer_id' });
    for (const cls of spec.classIds) {
      await ins(client, 'contract_np_layer_class_of_business', {
        layer_id: row.layer_id, class_of_business_id: cls.id,
      }, { conflict: 'DO NOTHING' });
    }

    // The expiring tower — slightly smaller and cheaper than the renewal.
    await ins(client, 'contract_np_expiring_layers', {
      contract_id: cid,
      layer_number: layer.layer_number,
      attachment: Math.round(layer.attachment * 0.92),
      layer_limit: Math.round(layer.layer_limit * 0.92),
      aggregate_limit: Math.round(layer.aggregate_limit * 0.92),
      egnpi: Math.round(layer.egnpi * 0.9),
      earned_premium: Math.round(layer.earned_premium * 0.88),
      rate: round2(layer.rate * 0.95),
      rol: round2(layer.rol * 0.95),
      num_reinstatements: layer.num_reinstatements,
      reinstatement_pct: layer.reinstatement_pct,
      annual_agg_deductible: Math.round(layer.annual_agg_deductible * 0.9),
      peril_scope: layer.peril_scope,
      mdp: Math.round(layer.mdp * 0.9),
      mdp_pct: round2(layer.mdp_pct * 0.98),
    }, { conflict: '(contract_id, layer_number) DO UPDATE SET layer_limit=EXCLUDED.layer_limit, updated_at=now()' });

    await ins(client, 'contract_np_pricing_layer_inputs', {
      contract_id: cid,
      layer_number: layer.layer_number,
      expiring_pricing_pct: round2(layer.expiring_price),
    }, { conflict: '(contract_id, layer_number) DO UPDATE SET expiring_pricing_pct=EXCLUDED.expiring_pricing_pct, updated_at=now()' });

    // Both sections are written for every layer so the RISK and CAT views of
    // the pricing grid are populated regardless of the layer's peril scope.
    for (const section of ['RISK', 'CAT']) {
      const burn = round4(layer.rol * rand(0.5, 0.9));
      const pareto = round4(layer.rol * rand(0.55, 0.95));
      const exposure = round4(layer.rol * rand(0.6, 1.05));
      const burnW = 40; const expW = 40; const paretoW = 20;
      const loading = round2(rand(2, 15));
      const blended = (burn * burnW + exposure * expW + pareto * paretoW) / 100;
      await ins(client, 'contract_np_pricing_outputs', {
        contract_id: cid,
        layer_number: layer.layer_number,
        section,
        pure_burning_cost: burn,
        pareto_pricing: pareto,
        burn_plus_pareto: round4((burn + pareto) / 2),
        exposure_rating: exposure,
        burn_weight_pct: burnW,
        exposure_weight_pct: expW,
        pareto_weight_pct: paretoW,
        pricing_loading_pct: loading,
        total_price: round4(blended * (1 + loading / 100)),
        prob_attach: round4(rand(0.05, 0.9)),
        prob_exhaust: round4(rand(0.01, 0.45)),
      }, { conflict: '(contract_id, layer_number, section) DO UPDATE SET total_price=EXCLUDED.total_price, updated_at=now()' });
    }
  }

  await ins(client, 'contract_np_expiring_terms', {
    contract_id: cid,
    egnpi: Math.round(econ.epi * 0.9),
    deductible: Math.round(deductible * 0.92),
    risk_limit: Math.round(layers[layers.length - 1].attachment * 0.92),
    cat_limit: Math.round(layers[layers.length - 1].attachment * 1.1),
    brokerage_pct: round2(econ.brokeragePct * 0.95),
    no_claims_bonus_pct: round2(rand(0, 12)),
    profit_commission_pct: round2(rand(0, 18)),
    notes: `Expiring ${spec.uwYear - 1} terms as advised by ${spec.broker.broker_name}.`,
    covered_props: J(spec.classIds.map((c) => ({ cobId: c.id, name: c.name, covered: true }))),
  }, { conflict: '(contract_id) DO UPDATE SET egnpi=EXCLUDED.egnpi, updated_at=now()' });

  // Premium and inflation history behind the tower.
  for (const year of econ.years) {
    const egnpi = Math.round(econ.epi * rand(0.7, 1.15));
    const premiums = Math.round(egnpi * rand(0.03, 0.12));
    const claims = Math.round(premiums * econ.targetLossRatio * rand(0.5, 1.6));
    const expenseRatio = round4((econ.brokeragePct + econ.taxesPct) / 100);
    const lossRatio = round4(claims / premiums);
    await ins(client, 'contract_np_egnpi_year', {
      contract_id: cid,
      uw_year: year,
      egnpi,
      inflation_pct: round2(rand(3, 22)),
      rate_change_pct: round2(rand(-8, 18)),
    }, { conflict: '(contract_id, uw_year) DO UPDATE SET egnpi=EXCLUDED.egnpi, updated_at=now()' });
    await ins(client, 'contract_np_historical_performance', {
      contract_id: cid,
      uw_year: year,
      premiums,
      claims,
      egnpi,
      result: premiums - claims,
      loss_ratio: lossRatio,
      expense_ratio: expenseRatio,
      combined_ratio: round4(lossRatio + expenseRatio),
    }, { conflict: '(contract_id, uw_year) DO UPDATE SET premiums=EXCLUDED.premiums, updated_at=now()' });
  }

  await ins(client, 'contract_np_pricing_inputs', {
    contract_id: cid,
    burn_weight_pct: 40,
    exposure_weight_pct: 40,
    pareto_weight_pct: 20,
    pricing_loading_pct: round2(rand(2, 15)),
    swiss_re_curve_name: pick(['Y1', 'Y2', 'Y3', 'Y4']),
  }, { conflict: '(contract_id) DO UPDATE SET burn_weight_pct=EXCLUDED.burn_weight_pct, updated_at=now()' });

  // Excess/large/CAT development, and the ultimates they roll up to.
  let cdf = round4(rand(1.15, 1.9));
  for (let dev = 12; dev <= econ.expYears * 12; dev += 12) {
    const ldf = round4(1 + (cdf - 1) * rand(0.4, 0.6));
    const tail = round4(rand(1.0, 1.08));
    await ins(client, 'contract_np_large_loss_ldf', {
      contract_id: cid, dev_month: dev, chosen_ldf: ldf, chosen_cdf: cdf, tail_factor: tail,
    }, { conflict: '(contract_id, dev_month) DO UPDATE SET chosen_ldf=EXCLUDED.chosen_ldf, updated_at=now()' });
    await ins(client, 'contract_np_cat_loss_ldf', {
      contract_id: cid, dev_month: dev, chosen_ldf: round4(ldf * rand(0.95, 1.05)), chosen_cdf: cdf, tail_factor: tail,
    }, { conflict: '(contract_id, dev_month) DO UPDATE SET chosen_ldf=EXCLUDED.chosen_ldf, updated_at=now()' });
    const actual = round4(ldf * rand(0.94, 1.06));
    const param = round4(ldf * rand(0.96, 1.04));
    await ins(client, 'contract_np_excess_ldf', {
      contract_id: cid,
      dev_month: dev,
      chosen_source: pick(['ACTUAL', 'PARAMETRIZED', 'SELECTED']),
      chosen_ldf: ldf,
      chosen_cdf: cdf,
      actual_ldf: actual,
      actual_cdf: round4(cdf * rand(0.95, 1.05)),
      param_ldf: param,
      param_cdf: round4(cdf * rand(0.97, 1.03)),
      tail_factor: tail,
    }, { conflict: '(contract_id, dev_month) DO UPDATE SET chosen_ldf=EXCLUDED.chosen_ldf, updated_at=now()' });
    cdf = round4(Math.max(1.0005, cdf / ldf));
  }

  for (const year of econ.years) {
    for (const table of ['contract_np_large_loss_ultimate', 'contract_np_cat_loss_ultimate']) {
      const reported = money(500_000, 30_000_000, 50_000) * spec.fx;
      const appliedCdf = round4(rand(1.0, 1.75));
      const ultimate = Math.round(reported * appliedCdf);
      await ins(client, table, {
        contract_id: cid,
        acc_year: year,
        loss_count: randInt(1, 14),
        reported,
        applied_cdf: appliedCdf,
        ibnr: ultimate - reported,
        ultimate,
      }, { conflict: '(contract_id, acc_year) DO UPDATE SET ultimate=EXCLUDED.ultimate, updated_at=now()' });
    }
  }

  const slInputs = {
    egnpi: econ.epi,
    attachment_pct: round2(rand(70, 90)),
    exhaust_pct: round2(rand(110, 160)),
    expected_loss_ratio: round4(econ.targetLossRatio),
    volatility: round4(rand(0.12, 0.4)),
    distribution: 'LOGNORMAL',
  };
  await ins(client, 'contract_np_stop_loss_pricing', {
    contract_id: cid,
    inputs: J(slInputs),
    outputs: J({
      expected_loss_cost_pct: round4(rand(0.5, 8)),
      technical_rate_pct: round4(rand(1, 12)),
      prob_attach: round4(rand(0.05, 0.5)),
      prob_exhaust: round4(rand(0.005, 0.15)),
    }),
  }, { conflict: '(contract_id) DO UPDATE SET inputs=EXCLUDED.inputs, outputs=EXCLUDED.outputs, updated_at=now()' });

  const terms = {
    treaty_detail: {
      inceptionDate: header.inception,
      renewalDate: header.renewal,
      startYear: String(spec.uwYear),
      estGnpi: String(econ.epi),
      expiringNumberOfLayers: String(layers.length),
      quoteStructuresCount: '1',
    },
    np_structure: {
      layers: layers.map((l) => ({
        layer: l.layer_number,
        limit: String(l.layer_limit),
        deductible: String(l.attachment),
        annualAggLimit: String(l.aggregate_limit),
        egnpi: String(l.egnpi),
        rate: String(l.rate),
        earnedPremium: String(l.earned_premium),
        mdp: String(l.mdp),
        mdpPct: `${l.mdp_pct}%`,
        reinstatements: String(l.num_reinstatements),
        reinstatementPct: String(l.reinstatement_pct),
        aad: true,
        aadAmount: String(l.annual_agg_deductible),
        riskCover: l.peril_scope !== 'CAT',
        catCover: l.peril_scope !== 'RISK',
        rol: `${l.rol}%`,
      })),
      cobRows: spec.classIds.map((c) => ({
        cobId: c.id, name: c.name, code: '',
        underwritingLimit: String(Math.round(econ.epi * 0.4)),
        layers: layers.map(() => true),
        manual: layers.map(() => false),
      })),
      coveredProps: [],
    },
    np_final_pricing: {
      layers: layers.map((l) => ({
        layer: l.layer_number,
        technicalPrice: l.uw_price,
        expiringPrice: l.expiring_price,
        leadPrice: l.lead_price,
        selectedPrice: l.rol,
      })),
    },
    event_loss_tables: {
      vendor: 'RMS', modelVersion: 'v23.0', perilSet: pick(PERILS), rows: [],
      updatedAt: ts(spec.uwYear, spec.inceptionMonth, 2, 10),
    },
  };
  await ins(client, 'contract_np_terms', {
    contract_id: cid, terms: J(terms),
  }, { conflict: '(contract_id) DO UPDATE SET terms=EXCLUDED.terms, updated_at=now()' });

  return { layers, terms };
}

// ── one complete treaty ─────────────────────────────────────────────────────

async function seedContract(client, spec, ref, parentContractId, seq) {
  const econ = buildEconomics(spec);
  const header = await insertHeader(client, spec, econ, parentContractId, seq);
  const cid = header.contractId;

  await insertClassesAndLimits(client, cid, spec, econ);

  let layers = [];
  let terms;
  if (spec.category === 'PROPORTIONAL') {
    terms = await insertProp(client, cid, spec, econ, header);
  } else {
    const np = await insertNp(client, cid, spec, econ, header);
    layers = np.layers;
    terms = np.terms;
  }

  await insertProfiles(client, cid, spec);
  await insertCresta(client, cid, spec);
  await insertTriangles(client, cid, spec, econ, spec.category === 'NON_PROPORTIONAL');
  await insertStraightExperience(client, cid, spec, econ);

  // Large-loss threshold: the bottom attachment on an XL tower, otherwise a
  // slice of the EPI — that is what the cedant would report against.
  const largeThreshold = layers.length
    ? Math.round(layers[0].attachment * 0.6)
    : Math.round(econ.epi * 0.04);
  await insertLosses(client, cid, spec, econ, 'LARGE', largeThreshold);
  await insertLosses(client, cid, spec, econ, 'CAT', Math.round(largeThreshold * 2.5));

  await insertExposureExtras(client, cid, spec);
  await insertCommissions(client, cid, spec, econ);

  const result = await insertWorkflow(client, cid, spec, econ, header, ref, layers);
  await insertPricing(client, cid, spec, econ, result, ref);
  await insertWordingChecklist(client, cid, spec, ref);
  await insertTermsSnapshot(client, cid, spec, econ, terms);

  return cid;
}

// ── NULL-coverage verification ──────────────────────────────────────────────
//
// The point of the seed is that nothing is blank. This walks every table the
// seed writes and counts NULLs per column over the seeded rows only. Columns
// listed in EXPECTED_NULLS are the documented exceptions (see NULL POLICY);
// anything else showing NULLs is a gap in the generator.

const SEEDED_SCOPE = {
  contract: 'contract_id = ANY($1)',
  contract_class_of_business: 'contract_id = ANY($1)',
  contract_epi_split: 'contract_id = ANY($1)',
  contract_underwriting_limit: 'contract_id = ANY($1)',
  contract_prop_details: 'contract_id = ANY($1)',
  contract_commissions: 'contract_id = ANY($1)',
  contract_commission_slides: 'contract_id = ANY($1)',
  contract_loss_participation: 'contract_id = ANY($1)',
  contract_risk_profile: 'contract_id = ANY($1)',
  contract_risk_profile_band: 'profile_id IN (SELECT profile_id FROM public.contract_risk_profile WHERE contract_id = ANY($1))',
  contract_claims_profile: 'contract_id = ANY($1)',
  contract_claims_profile_band: 'profile_id IN (SELECT profile_id FROM public.contract_claims_profile WHERE contract_id = ANY($1))',
  contract_cresta_data: 'contract_id = ANY($1)',
  contract_triangle_cells: 'contract_id = ANY($1)',
  contract_dev_factor: 'contract_id = ANY($1)',
  contract_pricing_patterns: 'contract_id = ANY($1)',
  contract_ldf_blend: 'contract_id = ANY($1)',
  contract_ldf_blend_curve: 'blend_id IN (SELECT blend_id FROM public.contract_ldf_blend WHERE contract_id = ANY($1))',
  contract_ldf_blend_weight: 'blend_id IN (SELECT blend_id FROM public.contract_ldf_blend WHERE contract_id = ANY($1))',
  contract_straight_experience: 'contract_id = ANY($1)',
  contract_straight_uw_stats: 'contract_id = ANY($1)',
  contract_large_loss_report: 'contract_id = ANY($1)',
  contract_large_losses: 'contract_id = ANY($1)',
  contract_cat_loss_report: 'contract_id = ANY($1)',
  contract_cat_losses: 'contract_id = ANY($1)',
  contract_loss_selection_snapshot: 'contract_id = ANY($1)',
  contract_loss_selection_snapshot_item: 'snapshot_id IN (SELECT snapshot_id FROM public.contract_loss_selection_snapshot WHERE contract_id = ANY($1))',
  contract_event_loss_tables: 'contract_id = ANY($1)',
  contract_gem_eq_scenario: 'contract_id = ANY($1)',
  contract_pricing_outputs: 'contract_id = ANY($1)',
  contract_pricing_yearly: 'contract_id = ANY($1)',
  pricing_components: 'contract_id = ANY($1)',
  pricing_leads: 'contract_id = ANY($1)',
  pricing_share_scenarios: 'contract_id = ANY($1)',
  contract_offer: 'contract_id = ANY($1)',
  contract_offer_layer: 'offer_id IN (SELECT offer_id FROM public.contract_offer WHERE contract_id = ANY($1))',
  contract_approval: 'contract_id = ANY($1)',
  contract_workflow_event: 'contract_id = ANY($1)',
  contract_audit_event: 'contract_id = ANY($1)',
  contract_assignment_history: "entity_type='contract' AND entity_id = ANY($1)",
  contract_wording_checklist: 'contract_id = ANY($1)',
  contract_wording_checklist_run: 'contract_id = ANY($1)',
  contract_terms_snapshot: 'contract_id = ANY($1)',
  contract_np_details: 'contract_id = ANY($1)',
  contract_np_layers: 'contract_id = ANY($1)',
  contract_np_layer_class_of_business: 'layer_id IN (SELECT layer_id FROM public.contract_np_layers WHERE contract_id = ANY($1))',
  contract_np_egnpi_year: 'contract_id = ANY($1)',
  contract_np_terms: 'contract_id = ANY($1)',
  contract_np_expiring_layers: 'contract_id = ANY($1)',
  contract_np_expiring_terms: 'contract_id = ANY($1)',
  contract_np_historical_performance: 'contract_id = ANY($1)',
  contract_np_pricing_inputs: 'contract_id = ANY($1)',
  contract_np_pricing_layer_inputs: 'contract_id = ANY($1)',
  contract_np_pricing_outputs: 'contract_id = ANY($1)',
  contract_np_large_loss_ldf: 'contract_id = ANY($1)',
  contract_np_cat_loss_ldf: 'contract_id = ANY($1)',
  contract_np_excess_ldf: 'contract_id = ANY($1)',
  contract_np_large_loss_ultimate: 'contract_id = ANY($1)',
  contract_np_cat_loss_ultimate: 'contract_id = ANY($1)',
  contract_np_stop_loss_pricing: 'contract_id = ANY($1)',
};

// Documented, deliberate NULLs — see NULL POLICY at the top of this file.
const EXPECTED_NULLS = new Set([
  'contract.source_quote_id',            // direct treaties, never bound from a quote
  'contract.parent_contract_id',         // NULL on the first year of a lineage only
  'contract.signed_line_pct', 'contract.signed_at',
  'contract.ntu_reason', 'contract.ntu_at',
  'contract.decline_reason', 'contract.declined_at',   // status-exclusive terminals
  'contract_offer.quote_id', 'contract_offer.signed_at', 'contract_offer.ntu_at',
  'contract_offer.ntu_reason', 'contract_offer.declined_at', 'contract_offer.decline_reason',
  'contract_offer.approved_at', 'contract_offer.sent_to_market_at',
  'contract_offer.peer1_decision', 'contract_offer.peer1_at',
  'contract_offer.peer2_decision', 'contract_offer.peer2_at',
  'contract_offer.arbiter_decision', 'contract_offer.arbiter_at',
  'contract_large_loss_report.quote_id', 'contract_cat_loss_report.quote_id',
  'contract_loss_selection_snapshot.quote_id',
  'contract_wording_checklist.quote_id', 'contract_wording_checklist.document_id',
  'contract_wording_checklist_run.quote_id', 'contract_wording_checklist_run.document_id',
  'contract_pricing_outputs.signed_line_pct',
  'contract_assignment_history.from_user_id',   // NULL on the CREATED row by definition
]);

async function verify(client) {
  const ids = await seededContractIds(client);
  if (!ids.length) { console.log('verify: no seeded contracts found.'); return { ids: 0, gaps: [] }; }

  const gaps = [];
  let checked = 0;
  for (const [table, scope] of Object.entries(SEEDED_SCOPE)) {
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
    if (!cols.length) continue;
    const counts = cols.map((c) => `count(*) FILTER (WHERE ${c.column_name} IS NULL) AS "${c.column_name}"`);
    const { rows } = await client.query(
      `SELECT count(*)::int AS total, ${counts.join(', ')} FROM public.${table} WHERE ${scope}`, [ids]);
    const row = rows[0];
    if (!row.total) { gaps.push({ table, column: '(no rows)', nulls: 0, total: 0 }); continue; }
    for (const c of cols) {
      checked += 1;
      const nulls = Number(row[c.column_name]);
      if (nulls > 0 && !EXPECTED_NULLS.has(`${table}.${c.column_name}`)) {
        gaps.push({ table, column: c.column_name, nulls, total: row.total });
      }
    }
  }

  console.log(`\n=== NULL COVERAGE (${ids.length} seeded contracts, ${Object.keys(SEEDED_SCOPE).length} tables, ${checked} columns) ===`);
  if (!gaps.length) {
    console.log('✓ every column of every seeded table is populated on every seeded row');
  } else {
    console.log(`✗ ${gaps.length} column(s) carry unexpected NULLs:`);
    for (const g of gaps) console.log(`   ${g.table}.${g.column}: ${g.nulls}/${g.total} NULL`);
  }
  return { ids: ids.length, gaps };
}

// ── production guard ────────────────────────────────────────────────────────
//
// Seeding writes ~40k rows of fabricated business into whatever DATABASE_URL
// points at, and it lands in the live portfolio views — dashboards, home
// summary, portfolio exports, country aggregates. On a deployed environment
// that has to be a deliberate act, so require an explicit opt-in there.
// --verify (read-only) and --reset-only (removes seeded rows only) are never
// blocked: the escape hatch must always work.

function redactUrl(value) {
  if (!value) return '(DATABASE_URL unset — using the built-in default)';
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:[^@]*@/, ':***@');
  }
}

function assertSeedableTarget() {
  if (process.env.NODE_ENV !== 'production') return;
  if (['1', 'true', 'yes'].includes(String(process.env.SEED_ALLOW_PRODUCTION || '').toLowerCase())) {
    console.log(`⚠  NODE_ENV=production — seeding anyway (SEED_ALLOW_PRODUCTION set).`);
    console.log(`   Target: ${redactUrl(process.env.DATABASE_URL)}`);
    return;
  }
  console.error(
    `Refusing to seed: NODE_ENV=production.\n`
    + `  Target: ${redactUrl(process.env.DATABASE_URL)}\n`
    + `  This inserts ${PROP_COUNT + NP_COUNT} fabricated treaties that will show up in the\n`
    + `  dashboards, home summary and portfolio exports everyone sees.\n`
    + `  If that is what you want, re-run with SEED_ALLOW_PRODUCTION=1.\n`
    + `  To undo a seed: node server/scripts/seedTestTreaties.js --reset-only`,
  );
  process.exit(1);
}

// ── main ────────────────────────────────────────────────────────────────────

async function summarise(client) {
  const { rows } = await client.query(
    `SELECT tt.category, c.status, cnt.country_code, count(*)::int AS n
       FROM public.contract c
       JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
       JOIN public.country cnt ON cnt.country_id = c.country_id
      WHERE c.import_metadata->>'source' = $1
      GROUP BY 1,2,3 ORDER BY 1,2,3`, [SEED_SOURCE]);
  const byCategory = {}; const byStatus = {}; const byCountry = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + r.n;
    byStatus[r.status] = (byStatus[r.status] || 0) + r.n;
    byCountry[r.country_code] = (byCountry[r.country_code] || 0) + r.n;
  }
  console.log('\n=== SEED SUMMARY ===');
  console.log('By category:', byCategory);
  console.log('By status:  ', byStatus);
  console.log('By country: ', byCountry);
  const { rows: sample } = await client.query(
    `SELECT c.contract_id, c.alt_contract_id, tt.category
       FROM public.contract c JOIN public.treaty_type tt ON tt.treaty_type_id=c.treaty_type_id
      WHERE c.import_metadata->>'source' = $1
      ORDER BY tt.category, c.uw_year DESC LIMIT 4`, [SEED_SOURCE]);
  for (const s of sample) console.log(`Sample ${s.category}: ${s.alt_contract_id}  ${s.contract_id}`);
  console.log(`\nCleanup: node server/scripts/seedTestTreaties.js --reset-only`);
}

async function main() {
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    if (VERIFY_ONLY) {
      const { gaps } = await verify(client);
      if (gaps.length) process.exitCode = 1;
      return;
    }

    if (!RESET_ONLY) assertSeedableTarget();
    if (RESET) await resetSeed(client);
    if (RESET_ONLY) return;

    console.log('Ensuring reference data…');
    const ref = await ensureReference(client);

    const specs = [
      ...buildPlan(ref, 'PROPORTIONAL', PROP_COUNT),
      ...buildPlan(ref, 'NON_PROPORTIONAL', NP_COUNT),
    ];
    console.log(`Seeding ${specs.length} contracts (${PROP_COUNT} proportional, ${NP_COUNT} non-proportional)…`);

    const contractIds = [];
    // One transaction per contract: a failure loses that treaty, not the batch.
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      // parentIndex is an index into this same list; the two categories are
      // planned separately, so offset the NP half.
      const offset = spec.category === 'PROPORTIONAL' ? 0 : PROP_COUNT;
      const parent = spec.parentIndex === null ? null : contractIds[spec.parentIndex + offset];
      await client.query('BEGIN');
      try {
        contractIds[i] = await seedContract(client, spec, ref, parent || null, i + 1);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      if ((i + 1) % 10 === 0 || i === specs.length - 1) {
        process.stdout.write(`  …${i + 1}/${specs.length}\r`);
      }
    }

    await summarise(client);
    const { gaps } = await verify(client);
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    if (gaps.length) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('SEED FAILED:', e);
  process.exitCode = 1;
  pool.end().catch(() => {});
});
