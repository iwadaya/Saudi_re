// server/scripts/seedMiddleEastTreaties.js
//
// Seeds ~1000 dummy reinsurance treaties (mixed proportional + non-proportional)
// for the Middle East region so the pricing/benchmark tool has realistic test
// data with varied classes of business and varied performance.
//
//   node server/scripts/seedMiddleEastTreaties.js          # seed
//   node server/scripts/seedMiddleEastTreaties.js --reset  # delete prior seed, then reseed
//
// Every seeded contract carries contract_description = 'SEED_ME_TEST' so it (and
// its children) can be removed cleanly. Reference data (ME countries, a broker,
// ~40 ME cedants) is inserted only if missing and is reused on re-run.
//
// The live schema is introspected at startup — enum values are read from
// pg_enum and we fail loudly if a status we need is missing.

import { pool } from '../src/db/pool.js';

const SENTINEL = 'SEED_ME_TEST';
const TOTAL = Number(process.env.SEED_COUNT || 1000);
const RESET = process.argv.includes('--reset');

// Curated Middle East country codes (matched/insert-if-missing — region values
// in this DB are GCC/Levant/North Africa, so region ILIKE 'middle east' is empty).
const ME_CODES = ['SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'EG', 'IQ', 'YE'];
const ME_NAMES = {
  SA: 'Saudi Arabia', AE: 'United Arab Emirates', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', LB: 'Lebanon', EG: 'Egypt',
  IQ: 'Iraq', YE: 'Yemen',
};
const CEDANT_PREFIXES = ['Gulf', 'Arabian', 'Levant', 'National', 'Emirates', 'Qatar', 'Kuwait', 'Saudi', 'Oman', 'Bahrain', 'Cairo', 'Mediterranean', 'Desert', 'Pearl', 'Crescent', 'Phoenix', 'Cedar', 'Falcon', 'Oasis', 'Union'];
const CEDANT_SUFFIXES = ['Insurance Co.', 'Reinsurance', 'Takaful', 'Assurance', 'General Insurance', 'Insurance Group', 'Cooperative Insurance'];

// Clean treaty-type names to prefer (ignore obvious test fixtures).
const NP_TYPE_NAMES = ['Risk XL', 'CAT XL', 'Aggregate XL', 'Stop Loss', 'Excess of Loss', 'Risk & CAT XL'];
const PROP_TYPE_NAMES = ['Quota Share', 'First Surplus', 'Second Surplus', 'Quota Share & Surplus', 'Third Surplus'];
const CAT_TYPE_NAMES = new Set(['CAT XL', 'Risk & CAT XL', 'Aggregate XL']);

// status → (uw_status, weight%) — total weight 100.
const STATUS_MIX = [
  { status: 'SIGNED', uw: 'SIGNED', w: 30 },
  { status: 'BOUND', uw: 'AWAITING_SIGNED_LINE', w: 10 },
  { status: 'QUOTED', uw: 'WAITING_APPROVAL', w: 25 },
  { status: 'NTU', uw: 'NTU', w: 20 },
  { status: 'DECLINED', uw: 'DECLINED', w: 15 },
];
const NTU_REASONS = ['Price not competitive', 'Capacity withdrawn', 'Cedant placed elsewhere', 'Terms not agreed'];
const DECLINE_REASONS = ['Outside risk appetite', 'Insufficient data', 'Adverse loss history', 'Aggregation breach'];

const CUR_YEAR = new Date().getFullYear();
const YEARS = [CUR_YEAR - 5, CUR_YEAR - 4, CUR_YEAR - 3, CUR_YEAR - 2, CUR_YEAR - 1, CUR_YEAR];
const YEAR_WEIGHTS = [1, 1.5, 2, 2.5, 3, 3.5]; // weighted toward recent

// ── small helpers ──
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rand = (min, max) => Math.random() * (max - min) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
function weighted(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}
function shuffle(a) { const c = [...a]; for (let i = c.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; }
function ymd(year, monthIdx = 0, day = 1) { return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }

async function enumLabels(client, typeName) {
  const { rows } = await client.query(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1`, [typeName]);
  return new Set(rows.map((r) => r.enumlabel));
}

async function assertEnums(client) {
  const cs = await enumLabels(client, 'contract_status');
  const uw = await enumLabels(client, 'uw_workflow_status');
  const needStatus = ['DRAFT', 'QUOTED', 'BOUND', 'SIGNED', 'NTU', 'DECLINED'];
  for (const v of needStatus) if (!cs.has(v)) throw new Error(`contract_status enum is missing required value "${v}"`);
  for (const m of STATUS_MIX) if (!uw.has(m.uw)) throw new Error(`uw_workflow_status enum is missing mapped value "${m.uw}" (for status ${m.status})`);
}

async function ensureRefData(client) {
  // Countries (match curated codes; insert any missing with region='Middle East').
  const { rows: existing } = await client.query(
    `SELECT country_id, country_code FROM public.country WHERE country_code = ANY($1)`, [ME_CODES]);
  const byCode = new Map(existing.map((r) => [r.country_code, r.country_id]));
  for (const code of ME_CODES) {
    if (!byCode.has(code)) {
      const { rows } = await client.query(
        `INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'Middle East') RETURNING country_id`,
        [code, ME_NAMES[code]]);
      byCode.set(code, rows[0].country_id);
      console.log(`  + inserted country ${code} (${ME_NAMES[code]})`);
    }
  }
  const countryIds = ME_CODES.map((c) => byCode.get(c));

  // Classes of business (use existing catalog; top up if very thin).
  const { rows: classes } = await client.query(`SELECT class_of_business_id AS id, class_of_business AS name FROM public.class_of_business`);
  if (classes.length < 8) {
    for (const name of ['Property', 'Engineering', 'Marine', 'Motor', 'Aviation', 'Energy', 'Liability', 'Political Violence', 'Medical', 'Agriculture']) {
      const { rows } = await client.query(
        `INSERT INTO public.class_of_business (class_of_business) VALUES ($1) RETURNING class_of_business_id AS id, class_of_business AS name`, [name]);
      classes.push(rows[0]);
    }
  }

  // Treaty types by category (prefer clean names; insert any missing curated ones).
  async function ensureTypes(category, names) {
    const { rows } = await client.query(
      `SELECT treaty_type_id AS id, treaty_type AS name FROM public.treaty_type WHERE category = $1 AND treaty_type = ANY($2)`,
      [category, names]);
    const have = new Map(rows.map((r) => [r.name, r.id]));
    for (const name of names) {
      if (!have.has(name)) {
        const { rows: ins } = await client.query(
          `INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,$2) RETURNING treaty_type_id AS id, treaty_type AS name`, [name, category]);
        have.set(name, ins[0].id);
        console.log(`  + inserted treaty_type ${name} (${category})`);
      }
    }
    return [...have.entries()].map(([name, id]) => ({ id, name }));
  }
  const npTypes = await ensureTypes('NON_PROPORTIONAL', NP_TYPE_NAMES);
  const propTypes = await ensureTypes('PROPORTIONAL', PROP_TYPE_NAMES);

  // Currency — one USD for all seed rows.
  let { rows: cur } = await client.query(`SELECT currency_id FROM public.currency WHERE currency_code = 'USD' LIMIT 1`);
  if (!cur.length) {
    cur = (await client.query(`INSERT INTO public.currency (currency_code, currency_name) VALUES ('USD','US Dollar') RETURNING currency_id`)).rows;
  }
  const currencyId = cur[0].currency_id;

  // Broker — contract.broker_id is NOT NULL; one shared seed broker.
  let { rows: br } = await client.query(`SELECT broker_id FROM public.brokers WHERE broker_name = 'ME Seed Broker' LIMIT 1`);
  if (!br.length) br = (await client.query(`INSERT INTO public.brokers (broker_name) VALUES ('ME Seed Broker') RETURNING broker_id`)).rows;
  const brokerId = br[0].broker_id;

  // Cedants in the seed countries — reuse existing ME companies + top up to ~40.
  const { rows: cedants } = await client.query(
    `SELECT company_id AS id, country_id FROM public.companies WHERE country_id = ANY($1)`, [countryIds]);
  let made = 0;
  while (cedants.length < 40) {
    const countryId = pick(countryIds);
    const name = `${pick(CEDANT_PREFIXES)} ${pick(CEDANT_SUFFIXES)} ${cedants.length + 1}`;
    const { rows } = await client.query(
      `INSERT INTO public.companies (company_name, country_id) VALUES ($1,$2) RETURNING company_id AS id, country_id`, [name, countryId]);
    cedants.push(rows[0]); made += 1;
  }
  if (made) console.log(`  + inserted ${made} ME cedant companies`);

  const cedantsByCountry = new Map();
  for (const c of cedants) {
    if (!c.country_id) continue;
    if (!cedantsByCountry.has(c.country_id)) cedantsByCountry.set(c.country_id, []);
    cedantsByCountry.get(c.country_id).push(c.id);
  }
  const allCedants = cedants.map((c) => c.id);

  return { countryIds, classes, npTypes, propTypes, currencyId, brokerId, cedantsByCountry, allCedants };
}

async function resetSeed(client) {
  const { rows } = await client.query(`SELECT contract_id FROM public.contract WHERE contract_description = $1`, [SENTINEL]);
  const ids = rows.map((r) => r.contract_id);
  if (!ids.length) { console.log('reset: no prior SEED_ME_TEST contracts.'); return; }
  await client.query('BEGIN');
  try {
    // Children first (losses → reports; layer COB → layers), then contract-keyed tables.
    await client.query(`DELETE FROM public.contract_large_losses WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_cat_losses   WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_large_loss_report WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_cat_loss_report   WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_np_layer_class_of_business WHERE layer_id IN (SELECT layer_id FROM public.contract_np_layers WHERE contract_id = ANY($1))`, [ids]);
    await client.query(`DELETE FROM public.contract_np_layers      WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_np_egnpi_year  WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_np_details     WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_prop_details   WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_class_of_business WHERE contract_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM public.contract_assignment_history WHERE entity_type='contract' AND entity_id = ANY($1)`, [ids]).catch(() => {});
    await client.query(`UPDATE public.contract SET parent_contract_id = NULL WHERE parent_contract_id = ANY($1)`, [ids]).catch(() => {});
    await client.query(`DELETE FROM public.contract WHERE contract_id = ANY($1)`, [ids]);
    await client.query('COMMIT');
    console.log(`reset: deleted ${ids.length} prior SEED_ME_TEST contracts (+ children).`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}

function buildNpTower(estGnpi, isCat) {
  const numLayers = randInt(1, 4);
  const level = rand(0.7, 1.3); // per-contract pricing level so treaties differ
  const layers = [];
  let attach = randInt(1_000_000, 10_000_000);
  for (let i = 0; i < numLayers; i += 1) {
    const layerLimit = randInt(2_000_000, 50_000_000);
    const frac = numLayers > 1 ? i / (numLayers - 1) : 0; // 0 = bottom, 1 = top
    const baseRol = 40 - frac * 32;                        // ~40% bottom → ~8% top
    let rol = (baseRol + (Math.random() - 0.5) * 8) * level;
    rol = round2(Math.max(1.5, Math.min(60, rol)));
    layers.push({
      layer_number: i + 1,
      attachment: attach,
      layer_limit: layerLimit,
      egnpi: estGnpi,
      rol,
      num_reinstatements: randInt(0, 3),
      reinstatement_pct: pick([0, 100]),
      peril_scope: isCat ? (Math.random() < 0.4 ? 'BOTH' : 'CAT') : 'RISK',
    });
    attach += layerLimit; // next layer attaches above this one
  }
  return layers;
}

async function insertNpContract(client, contractId, estGnpi, layers, cobIds, isCat, uwYear, classNameById) {
  await client.query(
    `INSERT INTO public.contract_np_details (contract_id, est_gnpi, number_of_layers, brokerage_pct, taxes_pct) VALUES ($1,$2,$3,$4,$5)`,
    [contractId, estGnpi, layers.length, round2(rand(5, 20)), round2(rand(0, 5))]);

  const layerIds = [];
  for (const L of layers) {
    const { rows } = await client.query(
      `INSERT INTO public.contract_np_layers
         (contract_id, layer_number, attachment, layer_limit, egnpi, rol, num_reinstatements, reinstatement_pct, peril_scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING layer_id`,
      [contractId, L.layer_number, L.attachment, L.layer_limit, L.egnpi, L.rol, L.num_reinstatements, L.reinstatement_pct, L.peril_scope]);
    const layerId = rows[0].layer_id;
    layerIds.push(layerId);
    for (const cobId of cobIds) {
      await client.query(
        `INSERT INTO public.contract_np_layer_class_of_business (layer_id, class_of_business_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [layerId, cobId]);
    }
  }

  // Per-year EGNPI across uw_year-4..uw_year.
  for (let y = uwYear - 4; y <= uwYear; y += 1) {
    await client.query(
      `INSERT INTO public.contract_np_egnpi_year (contract_id, uw_year, egnpi, inflation_pct, rate_change_pct) VALUES ($1,$2,$3,$4,$5)`,
      [contractId, y, Math.round(estGnpi * rand(0.7, 1.15)), round2(rand(1, 8)), round2(rand(-5, 10))]);
  }

  // ~40% get loss experience with a spread of implied loss ratios.
  let lossCount = 0;
  if (Math.random() < 0.4 && cobIds.length) {
    const firstAttach = layers[0].attachment;
    const targetLR = rand(0.4, 1.3);
    const n = randInt(4, 12);
    const totalGross = targetLR * estGnpi * 0.6;
    lossCount = await seedLosses(client, 'large', contractId, n, totalGross, firstAttach, uwYear, cobIds, classNameById);
    if (isCat) {
      const cn = randInt(2, 6);
      lossCount += await seedLosses(client, 'cat', contractId, cn, targetLR * estGnpi * 0.4, firstAttach, uwYear, cobIds, classNameById);
    }
  }
  return { layerIds, lossCount };
}

async function seedLosses(client, kind, contractId, n, totalGross, firstAttach, uwYear, cobIds, classNameById) {
  const reportTable = kind === 'cat' ? 'contract_cat_loss_report' : 'contract_large_loss_report';
  const lossTable = kind === 'cat' ? 'contract_cat_losses' : 'contract_large_losses';
  const { rows } = await client.query(
    `INSERT INTO public.${reportTable} (contract_id, report_date) VALUES ($1,$2) RETURNING report_id`,
    [contractId, ymd(uwYear, 11, 31)]);
  const reportId = rows[0].report_id;
  let made = 0;
  for (let i = 0; i < n; i += 1) {
    // Severity straddles the first attachment so some losses pierce the tower.
    const base = (totalGross / n) * rand(0.4, 1.8);
    const incurred = Math.round(Math.max(base, firstAttach * rand(0.3, 3)));
    const lyear = randInt(uwYear - 5, uwYear);
    const cobId = pick(cobIds);
    await client.query(
      `INSERT INTO public.${lossTable}
         (report_id, contract_id, uw_year, loss_name, class_of_business, incurred, paid, os, gross_amount, date_of_loss, is_selected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
      [reportId, contractId, lyear, `${kind === 'cat' ? 'CAT' : 'Large'} Loss ${i + 1}`,
        classNameById.get(cobId) || null, incurred, Math.round(incurred * 0.7), Math.round(incurred * 0.3), incurred,
        ymd(lyear, randInt(0, 11), randInt(1, 28))]);
    made += 1;
  }
  return made;
}

async function insertPropContract(client, contractId, treatyName) {
  const epi = randInt(3_000_000, 150_000_000);
  const isSurplus = /surplus/i.test(treatyName) && !/quota/i.test(treatyName);
  const commission = round2(rand(20, 35)); // stored in brokerage_pct (no dedicated commission col)
  await client.query(
    `INSERT INTO public.contract_prop_details
       (contract_id, quota_share_epi, surplus_epi, surplus_max_retention, loss_cap_pct, brokerage_pct, retention_pct, cession_pct, num_lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [contractId,
      isSurplus ? null : epi,
      isSurplus ? epi : null,
      isSurplus ? randInt(500_000, 5_000_000) : null,
      round2(rand(100, 300)),
      commission,
      round2(rand(10, 40)),
      round2(rand(60, 90)),
      isSurplus ? randInt(3, 12) : null]);
}

async function main() {
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    await assertEnums(client);
    if (RESET) await resetSeed(client);
    console.log(`Ensuring reference data…`);
    const ref = await ensureRefData(client);
    const classNameById = new Map(ref.classes.map((c) => [c.id, c.name]));
    const allClassIds = ref.classes.map((c) => c.id);

    const summary = {
      np: 0, prop: 0, byStatus: {}, byCountry: {}, byType: {}, npLayers: 0, losses: 0, sample: null,
    };

    console.log(`Seeding ${TOTAL} contracts…`);
    const BATCH = 100;
    for (let start = 0; start < TOTAL; start += BATCH) {
      await client.query('BEGIN');
      try {
        for (let k = start; k < Math.min(start + BATCH, TOTAL); k += 1) {
          const isNp = Math.random() < 0.55;
          const sm = weighted(STATUS_MIX, STATUS_MIX.map((s) => s.w));
          const uwYear = weighted(YEARS, YEAR_WEIGHTS);
          const countryId = pick(ref.countryIds);
          const cedantPool = ref.cedantsByCountry.get(countryId);
          const cedantId = (cedantPool && cedantPool.length) ? pick(cedantPool) : pick(ref.allCedants);
          const typeRow = isNp ? pick(ref.npTypes) : pick(ref.propTypes);
          const isCat = isNp && CAT_TYPE_NAMES.has(typeRow.name);

          const inception = ymd(uwYear, randInt(0, 11), 1);
          const renewal = ymd(uwYear + 1, new Date(inception).getMonth(), 1);
          const signedAt = sm.status === 'SIGNED' ? `${ymd(uwYear, randInt(0, 11), randInt(1, 28))} 10:00:00+00` : null;
          const ntuAt = sm.status === 'NTU' ? `${ymd(uwYear, randInt(0, 11), randInt(1, 28))} 10:00:00+00` : null;
          const declinedAt = sm.status === 'DECLINED' ? `${ymd(uwYear, randInt(0, 11), randInt(1, 28))} 10:00:00+00` : null;

          const cobIds = shuffle(allClassIds).slice(0, randInt(1, 3));
          const primaryCob = cobIds[0];

          const { rows: cr } = await client.query(
            `INSERT INTO public.contract
               (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, inception_date, renewal_date,
                status, uw_status, contract_description, primary_class_of_business_id,
                signed_at, signed_line_pct, ntu_at, ntu_reason, declined_at, decline_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::contract_status,$10::uw_workflow_status,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING contract_id`,
            [cedantId, ref.brokerId, countryId, ref.currencyId, typeRow.id, uwYear, inception, renewal,
              sm.status, sm.uw, SENTINEL, primaryCob,
              signedAt, signedAt ? round2(rand(5, 100)) : null,
              ntuAt, ntuAt ? pick(NTU_REASONS) : null,
              declinedAt, declinedAt ? pick(DECLINE_REASONS) : null]);
          const contractId = cr[0].contract_id;
          summary.sample = summary.sample || contractId;

          for (const cobId of cobIds) {
            await client.query(
              `INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [contractId, cobId]);
          }

          if (isNp) {
            const estGnpi = randInt(5_000_000, 250_000_000);
            const layers = buildNpTower(estGnpi, isCat);
            const { lossCount } = await insertNpContract(client, contractId, estGnpi, layers, cobIds, isCat, uwYear, classNameById);
            summary.np += 1; summary.npLayers += layers.length; summary.losses += lossCount;
          } else {
            await insertPropContract(client, contractId, typeRow.name);
            summary.prop += 1;
          }

          summary.byStatus[sm.status] = (summary.byStatus[sm.status] || 0) + 1;
          summary.byCountry[countryId] = (summary.byCountry[countryId] || 0) + 1;
          summary.byType[typeRow.name] = (summary.byType[typeRow.name] || 0) + 1;
        }
        await client.query('COMMIT');
        process.stdout.write(`  …${Math.min(start + BATCH, TOTAL)}/${TOTAL}\r`);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }

    // Resolve country names for the summary.
    const { rows: cnames } = await client.query(
      `SELECT country_id, country_code FROM public.country WHERE country_id = ANY($1)`, [ref.countryIds]);
    const codeById = new Map(cnames.map((r) => [r.country_id, r.country_code]));

    console.log(`\n\n=== SEED SUMMARY (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
    console.log(`Total contracts: ${summary.np + summary.prop}  (NP: ${summary.np}, Prop: ${summary.prop})`);
    console.log(`By status:`, summary.byStatus);
    console.log(`By treaty type:`, summary.byType);
    console.log(`By country:`, Object.fromEntries(Object.entries(summary.byCountry).map(([id, n]) => [codeById.get(id) || id, n])));
    console.log(`Total NP layers: ${summary.npLayers}   Total seeded losses: ${summary.losses}`);
    console.log(`Sample NP/Prop contract_id: ${summary.sample}`);
    console.log(`Cleanup later: DELETE ... WHERE contract_description = '${SENTINEL}'  (or run with --reset)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('SEED FAILED:', e); process.exitCode = 1; pool.end().catch(() => {}); });
