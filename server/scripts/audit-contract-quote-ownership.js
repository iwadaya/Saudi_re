// Audit + repair contract/quote ownership after the identity migration.
//
// Background:
//   contract.assigned_to_user_id / quote.assigned_to_user_id drive the whole
//   edit-lock model (services/permissions.computeEditPermission: you may edit
//   only what is assigned to you; an unassigned DRAFT can be claimed). After
//   the identity migration some rows are left in a bad state:
//     • assigned_to_user_id IS NULL              — nobody owns it.
//     • assigned_to_user_id points at a user_id that is no longer in uw_user
//       (a deleted/demo identity). The inline FK from 002/036 normally blocks
//       this, but a restore / out-of-band load / FK relaxation can leave a
//       dangling owner. Such a row is WORSE than unassigned: it is invisible
//       in everyone's "my work + unclaimed" list (assignments.listContracts-
//       WithOwnership only surfaces assigned=me OR created=me OR assigned IS
//       NULL), so no one can even find it to claim.
//
// What this script does (per the audit spec):
//   1. Report counts of both problem classes on contract + quote.
//   2. NULL-but-has-creator → set assigned_to_user_id = created_by_user_id,
//      but ONLY when that creator still exists in uw_user (otherwise we'd just
//      re-create a dangling owner, and the FK would reject the write anyway).
//      Never touches a row that already has a valid owner — idempotent.
//   3. Owner is a deleted/demo id (not in uw_user) → set assigned_to_user_id
//      = NULL so the row drops back into the claimable pool.
//   4. Print a before/after count.
//
// Ordering: backfill runs FIRST, then danglers are freed. Backfill only touches
// rows that are already NULL, so within a run it never adopts a dangling-owner row
// — those are freed to NULL afterwards and left for claiming. Backfill also never
// overwrites a valid owner. In the normal data model a re-run is therefore an
// exact no-op: the creation INSERT sets created_by = assigned_to, so a dangling owner
// means the creator is the SAME deleted user, and a freed dangler then has an
// invalid creator that backfill skips. The only row a redundant second --apply
// would touch is one reassigned to a since-deleted user whose ORIGINAL creator is
// still active (created_by ≠ the deleted owner): it is freed on the first apply,
// and a second apply would adopt that still-valid creator. That is benign (a real
// active owner) and rare; distinguishing it would need assignment-history. Use is
// one-shot — audit (dry-run), then a single --apply.
//
// Detection is row-presence in uw_user, matching the spec's "no longer exists
// in uw_user". A still-present but is_active=false owner is a VALID owner here
// and is left alone (deactivation ≠ deletion); it is reported separately as info
// so an operator can decide on it out of band.
//
// Dry-run by default — every change runs inside a transaction that is ROLLED
// BACK unless you pass --apply, so the before/after counts are exact in both
// modes.
//
// Usage:
//   node scripts/audit-contract-quote-ownership.js            # audit only (dry-run)
//   node scripts/audit-contract-quote-ownership.js --apply    # perform the repair
//   node scripts/audit-contract-quote-ownership.js --rows=50  # list up to 50 problem rows/table

import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const APPLY = process.argv.includes('--apply');
const rowsArg = process.argv.find((a) => a.startsWith('--rows='));
const ROWS_LIMIT = rowsArg ? Math.max(0, parseInt(rowsArg.split('=')[1], 10) || 0) : 20;

// Fixed identifiers (never user input) — safe to interpolate into SQL.
const TABLES = [
  { entity: 'CONTRACT', table: 'public.contract', idCol: 'contract_id' },
  { entity: 'QUOTE', table: 'public.quote', idCol: 'quote_id' },
];

// One query → the full ownership breakdown for a table.
const breakdownSql = (table) => `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NULL)::int AS unassigned,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NOT NULL AND ua.user_id IS NULL)::int AS dangling,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NOT NULL AND ua.user_id IS NOT NULL)::int AS valid_owner,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NOT NULL AND ua.user_id IS NOT NULL AND ua.is_active = false)::int AS owner_inactive,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NULL AND t.created_by_user_id IS NOT NULL AND uc.user_id IS NOT NULL)::int AS unassigned_fixable,
    count(*) FILTER (WHERE t.assigned_to_user_id IS NULL AND (t.created_by_user_id IS NULL OR uc.user_id IS NULL))::int AS unassigned_unfixable
  FROM ${table} t
  LEFT JOIN public.uw_user ua ON ua.user_id = t.assigned_to_user_id
  LEFT JOIN public.uw_user uc ON uc.user_id = t.created_by_user_id
`;

// NULL owner + still-valid creator → adopt the creator as owner.
const backfillSql = (table) => `
  UPDATE ${table} t
     SET assigned_to_user_id = t.created_by_user_id,
         updated_at = now()
   WHERE t.assigned_to_user_id IS NULL
     AND t.created_by_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.uw_user u WHERE u.user_id = t.created_by_user_id)
`;

// Owner no longer in uw_user (deleted/demo) → free it for claiming.
const freeDanglingSql = (table) => `
  UPDATE ${table} t
     SET assigned_to_user_id = NULL,
         updated_at = now()
   WHERE t.assigned_to_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.uw_user u WHERE u.user_id = t.assigned_to_user_id)
`;

// Sample of the rows the spec asks to report: unassigned OR dangling owner.
const sampleSql = (table, idCol) => `
  SELECT t.${idCol}::text AS id,
         t.assigned_to_user_id::text AS owner,
         t.created_by_user_id::text AS creator,
         (ua.user_id IS NOT NULL) AS owner_exists,
         (uc.user_id IS NOT NULL) AS creator_exists
    FROM ${table} t
    LEFT JOIN public.uw_user ua ON ua.user_id = t.assigned_to_user_id
    LEFT JOIN public.uw_user uc ON uc.user_id = t.created_by_user_id
   WHERE t.assigned_to_user_id IS NULL
      OR (t.assigned_to_user_id IS NOT NULL AND ua.user_id IS NULL)
   ORDER BY t.updated_at DESC NULLS LAST
   LIMIT $1
`;

function classifyRow(r) {
  if (r.owner === null) {
    return r.creator_exists
      ? `BACKFILL    → owner = creator ${r.creator}`
      : `UNASSIGNED  (no valid creator${r.creator ? ` — ${r.creator} not in uw_user` : ''})`;
  }
  return `FREE        (owner ${r.owner} not in uw_user → unassigned)`;
}

async function auditTable(client, cfg) {
  const before = (await client.query(breakdownSql(cfg.table))).rows[0];
  const samples = ROWS_LIMIT > 0
    ? (await client.query(sampleSql(cfg.table, cfg.idCol), [ROWS_LIMIT])).rows
    : [];
  // Order is load-bearing: backfill (IS NULL rows) before freeing danglers, so
  // within this apply a dangling row is freed for claiming, not adopted by its
  // creator (the freed row only becomes NULL after backfill has already run).
  const backfilled = (await client.query(backfillSql(cfg.table))).rowCount;
  const freed = (await client.query(freeDanglingSql(cfg.table))).rowCount;
  const after = (await client.query(breakdownSql(cfg.table))).rows[0];
  return { ...cfg, before, after, backfilled, freed, samples };
}

function printTable(res) {
  const { entity, before, after, backfilled, freed, samples } = res;
  console.log(`\n── ${entity} ───────────────────────────────────────────────`);
  console.log(`  total rows ................. ${before.total}`);
  console.log(`  BEFORE  unassigned (NULL) .. ${before.unassigned}  (fixable: ${before.unassigned_fixable}, no valid creator: ${before.unassigned_unfixable})`);
  console.log(`          dangling owner ..... ${before.dangling}  (owner not in uw_user)`);
  console.log(`          valid owner ........ ${before.valid_owner}  (of which inactive: ${before.owner_inactive})`);
  console.log(`  CHANGES backfilled ......... ${backfilled}  (NULL → creator)`);
  console.log(`          freed .............. ${freed}  (dangling → NULL)`);
  console.log(`  AFTER   unassigned (NULL) .. ${after.unassigned}`);
  console.log(`          dangling owner ..... ${after.dangling}`);
  console.log(`          valid owner ........ ${after.valid_owner}`);

  if (samples.length) {
    console.log(`\n  problem rows (showing ${samples.length}${before.unassigned + before.dangling > samples.length ? ` of ${before.unassigned + before.dangling}` : ''}):`);
    for (const r of samples) console.log(`    ${r.id}  ${classifyRow(r)}`);
  }
}

async function main() {
  const client = await pool.connect();
  let results;
  try {
    await client.query('BEGIN');
    results = [];
    for (const cfg of TABLES) results.push(await auditTable(client, cfg));
    if (APPLY) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(`[audit-ownership] mode: ${APPLY ? 'APPLY (changes committed)' : 'DRY-RUN (no changes written)'}`);
  for (const res of results) printTable(res);

  const totalBackfilled = results.reduce((s, r) => s + r.backfilled, 0);
  const totalFreed = results.reduce((s, r) => s + r.freed, 0);
  console.log(`\n[audit-ownership] ${APPLY ? 'backfilled' : 'would backfill'}: ${totalBackfilled}, ${APPLY ? 'freed' : 'would free'}: ${totalFreed}`);
  if (!APPLY && (totalBackfilled > 0 || totalFreed > 0)) {
    console.log('[audit-ownership] re-run with --apply to perform these changes.');
  }
  return true;
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((err) => {
    logger.error('[audit-ownership] crashed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  })
  .finally(() => closePools().catch(() => {}));
