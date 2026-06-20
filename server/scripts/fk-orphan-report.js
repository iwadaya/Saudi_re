// server/scripts/fk-orphan-report.js
//
// READ-ONLY orphan detection for NOT VALID foreign keys (P0-7).
//
// Background:
//   84 of 117 FKs are NOT VALID — retrofitted to protect NEW writes but never
//   validated against existing data (see docs/database-design-audit.md). Before
//   ALTER TABLE … VALIDATE CONSTRAINT can be run, every NOT VALID FK must be
//   checked for orphan child rows (a non-null FK value with no matching parent),
//   because VALIDATE fails hard the moment it meets one.
//
// What this does:
//   • Discovers every NOT VALID FK from the catalog (so it tracks the actual
//     snapshot, not a hard-coded list).
//   • For each, counts orphan child rows.
//   • Prints a per-constraint report + a summary.
//
// It WRITES NOTHING. The session is forced read-only (default_transaction_read_only
// = on), so any accidental write would error rather than mutate data.
//
// ⚠️  STAGING ONLY. Point DATABASE_URL at a RESTORED PRODUCTION SNAPSHOT, never at
//     the live production database. This script is the first step of the runbook
//     docs/runbooks/validate-not-valid-fks.md.
//
// Usage:
//   DATABASE_URL=postgres://…/restored_snapshot node scripts/fk-orphan-report.js
//   …                                              node scripts/fk-orphan-report.js --json
//   …                                              node scripts/fk-orphan-report.js --constraint fk_contract_cedant_id
//
// Exit codes: 0 = no orphans, 2 = orphans found (clean/archive before VALIDATE),
//             1 = error.

import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = (() => {
  const i = args.indexOf('--constraint');
  return i >= 0 ? args[i + 1] : null;
})();

const DISCOVERY_SQL = `
  SELECT con.conname                 AS constraint_name,
         child.relname               AS child_table,
         parent.relname              AS parent_table,
         ca.attname                  AS child_col,
         pa.attname                  AS parent_col,
         con.confdeltype             AS on_delete,
         array_length(con.conkey, 1) AS n_cols
    FROM pg_constraint con
    JOIN pg_class child  ON child.oid  = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid     = con.connamespace
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
   WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public'
   ORDER BY child.relname, con.conname`;

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

async function main() {
  const client = await pool.connect();
  try {
    // Belt-and-braces: make the whole session refuse writes.
    await client.query('SET SESSION default_transaction_read_only = on');

    const { rows: fks } = await client.query(DISCOVERY_SQL);
    const targets = only ? fks.filter((f) => f.constraint_name === only) : fks;

    const results = [];
    for (const fk of targets) {
      if (Number(fk.n_cols) > 1) {
        results.push({ ...fk, orphans: null, note: 'composite FK — count manually' });
        continue;
      }
      const sql = `SELECT count(*)::bigint AS n
                     FROM public.${q(fk.child_table)} c
                    WHERE c.${q(fk.child_col)} IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM public.${q(fk.parent_table)} p
                         WHERE p.${q(fk.parent_col)} = c.${q(fk.child_col)})`;
      const { rows } = await client.query(sql);
      results.push({ ...fk, orphans: Number(rows[0].n) });
    }

    const withOrphans = results.filter((r) => r.orphans > 0);

    if (asJson) {
      console.log(JSON.stringify({
        scanned: results.length,
        constraintsWithOrphans: withOrphans.length,
        totalOrphanRows: withOrphans.reduce((s, r) => s + r.orphans, 0),
        results,
      }, null, 2));
    } else {
      console.log('[fk-orphan-report] READ-ONLY scan of NOT VALID foreign keys — writes nothing.\n');
      console.log('orphans  child_table.child_col -> parent_table.parent_col  (constraint)');
      console.log('-------  ----------------------------------------------------------------');
      for (const r of results) {
        const n = r.orphans === null ? 'MANUAL' : String(r.orphans);
        const flag = r.orphans > 0 ? '  <== ORPHANS' : '';
        console.log(
          `${n.padStart(7)}  ${r.child_table}.${r.child_col} -> ${r.parent_table}.${r.parent_col}  (${r.constraint_name})${flag}`,
        );
      }
      console.log('\n[fk-orphan-report] summary:');
      console.log(`  constraints scanned:        ${results.length}`);
      console.log(`  constraints with orphans:   ${withOrphans.length}`);
      console.log(`  total orphan child rows:    ${withOrphans.reduce((s, r) => s + r.orphans, 0)}`);
      if (withOrphans.length) {
        console.log('\n  Clean or archive these orphans (see docs/runbooks/validate-not-valid-fks.md)');
        console.log('  BEFORE running ALTER TABLE … VALIDATE CONSTRAINT.');
      } else {
        console.log('\n  No orphans found — safe to proceed to the batched VALIDATE step.');
      }
    }

    return withOrphans.length > 0 ? 2 : 0;
  } finally {
    client.release();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    logger.error('[fk-orphan-report] failed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  })
  .finally(() => closePools().catch(() => {}));
