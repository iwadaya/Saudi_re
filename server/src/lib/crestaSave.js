// server/src/lib/crestaSave.js
// Shared CRESTA save logic used by both treaty and quote routes — the
// table layout is identical (only the parent FK column name differs)
// and the slice-deletion semantics must stay in lockstep, so a single
// helper is the cheapest way to keep them aligned.

import { pool } from '../db/pool.js';
import { numOrNull } from '../helpers.js';

const TABLES = {
  contract: { table: 'public.contract_cresta_data', parent: 'contract_id' },
  quote:    { table: 'public.quote_cresta_data',    parent: 'quote_id'    },
};

/**
 * Hash the slice tuple into a 64-bit advisory-lock key. Used to serialize
 * concurrent saves on the same (contract|quote, treaty_type, cob, country)
 * — without this two simultaneous PUTs can both DELETE under MVCC, both
 * see no rows, then both INSERT, doubling the slice. The unique index
 * added in migration 063 is the final safety net; this lock keeps the
 * common case clean (no retry-on-conflict needed).
 */
function lockKey(parentId, treatyType, cobId, countryId) {
  return `cresta:${parentId}:${treatyType}:${cobId || ''}:${countryId || ''}`;
}

/**
 * @param {object} args
 * @param {'contract'|'quote'} args.kind
 * @param {string}              args.id           - contract_id / quote_id
 * @param {Array<object>}       args.rows         - row payload from the UI
 * @param {string}              args.treatyType   - already defaulted by caller
 * @param {string|null}         args.cobId
 * @param {string|null}         args.cobName
 * @param {string|null}         args.countryId
 */
export async function saveCrestaSlice({ kind, id, rows, treatyType, cobId, cobName, countryId }) {
  const cfg = TABLES[kind];
  if (!cfg) throw new Error(`Unknown CRESTA save kind: ${kind}`);
  const { table, parent } = cfg;

  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    // Per-slice serialization. hashtextextended returns a bigint which
    // pg_advisory_xact_lock(bigint) expects.
    await cl.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(id, treatyType, cobId, countryId)]);

    // Slice DELETE — narrowed by every available coordinate so we never
    // collaterally drop another country/COB/treaty-type's data.
    const params = [id, treatyType];
    let where = `${parent}=$1 AND treaty_type=$2`;
    if (cobId) { params.push(cobId); where += ` AND cob_id=$${params.length}`; }
    else       { where += ` AND cob_id IS NULL`; }
    if (countryId) { params.push(countryId); where += ` AND country_id=$${params.length}`; }
    else           { where += ` AND country_id IS NULL`; }
    await cl.query(`DELETE FROM ${table} WHERE ${where}`, params);

    const insertSql = `
      INSERT INTO ${table} (
        ${parent}, country_id, zone_id, zone_name,
        eq_agg, ws_agg, flood_agg, srcc_agg, others_agg,
        treaty_type, cob_id, cob_name,
        residential_bldg_pct, commercial_bldg_pct, commercial_cont_pct,
        industrial_bldg_pct, industrial_cont_pct
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      )`;
    for (const r of rows) {
      await cl.query(insertSql, [
        id,
        r.country_id ?? countryId ?? null,
        r.zone_id ?? null,
        r.zone_name ?? null,
        numOrNull(r.eq_agg),
        numOrNull(r.ws_agg),
        numOrNull(r.flood_agg),
        numOrNull(r.srcc_agg),
        numOrNull(r.others_agg),
        treatyType,
        cobId,
        r.cob_name ?? cobName ?? null,
        numOrNull(r.residential_bldg_pct) ?? 30,
        numOrNull(r.commercial_bldg_pct)  ?? 25,
        numOrNull(r.commercial_cont_pct)  ?? 15,
        numOrNull(r.industrial_bldg_pct)  ?? 20,
        numOrNull(r.industrial_cont_pct)  ?? 10,
      ]);
    }
    await cl.query('COMMIT');
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}
