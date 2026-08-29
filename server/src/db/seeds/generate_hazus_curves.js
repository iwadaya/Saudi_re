// server/src/db/seeds/generate_hazus_curves.js
//
// Generate HAZUS earthquake MDR curves from equivalent-PGA fragility + damage-
// ratio parameters and upsert them into public.gem_vulnerability_function with
// source='HAZUS', so they appear alongside GEM curves for selection.
//
// SAFETY: by default this REFUSES to run while the parameters are the shipped
// illustrative placeholders (HAZUS_PARAMS_ARE_PLACEHOLDER). Replace the values
// in hazusParameters.js with authoritative FEMA Technical Manual numbers, set
// HAZUS_PARAMS_ARE_PLACEHOLDER=false, and re-run. To generate placeholder curves
// for a NON-PRICING demo/dev DB only, pass ALLOW_PLACEHOLDER=1.
//
// Run:
//   GEM_MODEL_VERSION=HAZUS-6.1 \
//   HAZUS_COUNTRY=GENERIC \                 # or a country tag you map exposure to
//   DATABASE_URL=postgres://… \
//   node server/src/db/seeds/generate_hazus_curves.js
//
// Idempotent: ON CONFLICT (model_version, country_code, loss_category, taxonomy, imt).

import pg from 'pg';
import { buildHazusMdrCurve } from '../../modules/hazusVulnerability/hazusDamageRatio.js';
import {
  HAZUS_PLACEHOLDER_PARAMS, OCCUPANCY_TO_HAZUS, HAZUS_PARAMS_ARE_PLACEHOLDER,
} from '../../modules/hazusVulnerability/hazusParameters.js';
import { loadHazusParametersFromFile } from '../../modules/hazusVulnerability/hazusParameterLoader.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://universe:universe@localhost:5432/universe';
const MODEL_VERSION = process.env.GEM_MODEL_VERSION || 'HAZUS-unknown';
const COUNTRY = process.env.HAZUS_COUNTRY || 'GENERIC';
const ALLOW_PLACEHOLDER = process.env.ALLOW_PLACEHOLDER === '1';
// Authoritative parameters: a validated JSON the operator exports from the FEMA
// Technical Manual / HAZUS DB (see hazus_parameters.template.json). When set,
// it REPLACES the in-code placeholders and is validated before any insert.
const PARAMS_FILE = process.env.HAZUS_PARAMS_FILE || '';

// Which loss_category each occupancy bucket's curve represents (building →
// structural; contents → contents) so the slot→curve routing in the engine and
// UI lines up with GEM's loss-category filtering.
const SLOT_LOSS_CATEGORY = {
  residentialBldg: 'structural',
  commercialBldg: 'structural',
  commercialCont: 'contents',
  industrialBldg: 'structural',
  industrialCont: 'contents',
};
const SLOT_OCCUPANCY = {
  residentialBldg: 'RES', commercialBldg: 'COM', commercialCont: 'COM',
  industrialBldg: 'IND', industrialCont: 'IND',
};

async function main() {
  // Source of truth: a validated params file if supplied, else the in-code
  // placeholders (which require the explicit dev override to proceed).
  let params;
  let occupancyToKey;
  let modelVersion = MODEL_VERSION;
  if (PARAMS_FILE) {
    const loaded = loadHazusParametersFromFile(PARAMS_FILE); // throws on bad data
    params = loaded.params;
    occupancyToKey = loaded.occupancyMapping;
    if (MODEL_VERSION === 'HAZUS-unknown' && loaded.modelVersion) modelVersion = loaded.modelVersion;
    console.log(`Loaded + validated HAZUS parameters from ${PARAMS_FILE}.`);
  } else {
    if (HAZUS_PARAMS_ARE_PLACEHOLDER && !ALLOW_PLACEHOLDER) {
      console.error(
        'No HAZUS_PARAMS_FILE set and the in-code parameters are ILLUSTRATIVE placeholders.\n'
        + 'Export authoritative values from the FEMA Technical Manual into a JSON file (see\n'
        + 'hazus_parameters.template.json) and set HAZUS_PARAMS_FILE, or pass ALLOW_PLACEHOLDER=1\n'
        + 'to seed a NON-PRICING demo/dev DB with placeholders.',
      );
      process.exit(1);
    }
    params = HAZUS_PLACEHOLDER_PARAMS;
    occupancyToKey = OCCUPANCY_TO_HAZUS;
  }
  const usingPlaceholders = !PARAMS_FILE && HAZUS_PARAMS_ARE_PLACEHOLDER;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query('BEGIN');
    for (const [slot, paramKey] of Object.entries(occupancyToKey)) {
      const entry = params[paramKey];
      if (!entry) { console.warn(`  ! no params for ${paramKey} (${slot})`); continue; }
      // Slot-specific taxonomy: the row's identity is (model_version,
      // country_code, loss_category, taxonomy, imt), so when the operator maps
      // two slots with the same loss category to ONE HAZUS param key (e.g.
      // commercial AND industrial buildings both → C2M — an explicitly
      // permitted mapping), a shared `HAZUS:${paramKey}` taxonomy collapses
      // them into one row whose occupancy the second upsert overwrites,
      // emptying the first slot's occupancy-filtered dropdown. Keying by slot
      // keeps one row PER mapping (and makes the `upserted` count honest).
      const taxonomy = `HAZUS:${paramKey}:${slot}`;
      const lossCategory = SLOT_LOSS_CATEGORY[slot];
      const occupancy = SLOT_OCCUPANCY[slot];
      const curve = buildHazusMdrCurve({ fragility: entry.fragility, damageRatios: entry.damageRatios, taxonomy });
      await client.query(
        `INSERT INTO public.gem_vulnerability_function
           (source, model_version, region, country_code, country_name, loss_category,
            asset_category, taxonomy, occupancy, dist, imt, imls, mean_lrs, cov_lrs,
            source_license, updated_at)
         VALUES ('HAZUS',$1,'HAZUS',$2,$2,$3,'buildings',$4,$5,'LN',$6,$7,$8,NULL,
            'FEMA HAZUS (US Government work, public domain) — verify trademark/use', now())
         ON CONFLICT (model_version, country_code, loss_category, taxonomy, imt)
         DO UPDATE SET source='HAZUS', occupancy=EXCLUDED.occupancy, imls=EXCLUDED.imls,
           mean_lrs=EXCLUDED.mean_lrs, updated_at=now()`,
        [modelVersion, COUNTRY, lossCategory, taxonomy, occupancy, curve.imt, curve.imls, curve.meanLRs],
      );
      // Retire the legacy ambiguous row (`HAZUS:${paramKey}` with no slot
      // suffix) this row replaces, so a re-seeded DB doesn't list both.
      await client.query(
        `DELETE FROM public.gem_vulnerability_function
          WHERE source='HAZUS' AND model_version=$1 AND country_code=$2
            AND loss_category=$3 AND imt=$4 AND taxonomy=$5`,
        [modelVersion, COUNTRY, lossCategory, curve.imt, `HAZUS:${paramKey}`],
      );
      upserted += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.error('HAZUS generate failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  console.log(`HAZUS curves upserted: ${upserted} (country ${COUNTRY}, model ${modelVersion})${usingPlaceholders ? ' — PLACEHOLDER data, NOT for pricing' : ''}.`);
  await pool.end();
}

main();
