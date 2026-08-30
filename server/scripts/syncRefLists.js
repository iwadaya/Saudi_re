// server/scripts/syncRefLists.js
//
// Copy the shared reference LISTS (the dropdown data underwriters see —
// cedants, brokers, reinsurers, countries, currencies, treaty types, classes
// of business, generic ref lists, FX rates, CRESTA zones, inflation, benchmark
// LDFs) from one Universe database to another. Built for the "new server is
// up but the lists we curated on Render are missing" migration case:
//
//   # 1. Export from the source DB (Render → use the EXTERNAL connection
//   #    string from the Render dashboard; append ?sslmode=require, or
//   #    ?sslmode=no-verify if the cert chain is not locally trusted):
//   SOURCE_DATABASE_URL='postgresql://…render.com/universe?sslmode=require' \
//     node server/scripts/syncRefLists.js export --out ref-lists.json
//
//   # 2. Copy ref-lists.json to the new server, then import into its DB
//   #    (DATABASE_URL, same env var the app itself uses):
//   node server/scripts/syncRefLists.js import --in ref-lists.json --dry-run
//   node server/scripts/syncRefLists.js import --in ref-lists.json
//
// Or stream end-to-end when one machine can reach both databases:
//   SOURCE_DATABASE_URL=$RENDER_URL node server/scripts/syncRefLists.js export --out - \
//     | DATABASE_URL=$NEW_URL node server/scripts/syncRefLists.js import --in -
//
// Flags:
//   --dry-run             run the whole import in a transaction and ROLL BACK,
//                         printing what would have happened.
//   --deactivate-missing  after merging, soft-hide (is_active=false) target
//                         rows whose natural key is absent from the snapshot,
//                         so the new server's dropdowns show EXACTLY the
//                         source's lists (defaults seeded by boot that the
//                         source team never used get hidden, not deleted).
//
// MERGE SEMANTICS (why this is not a plain pg_dump):
//   Boot (startup/ensureReferenceData.js) and the migrations already seed the
//   default lists, so a fresh server has rows like 'Aon' under NEW random
//   UUIDs. A blind copy would duplicate every default. Instead each snapshot
//   row is matched against the target by primary key first (a row this tool
//   inserted on a previous run — renames propagate), then by natural key
//   (country_code, broker_name, …, preferring active rows, matching the
//   migration-150 partial uniques); matched rows are updated in place keeping
//   the target's id, unmatched rows are inserted PRESERVING the source UUID.
//   Foreign keys between lists (companies.country_id, ref_list_item.list_id,
//   ref_cresta_zone/ref_country_inflation/ref_benchmark_ldf.country_id) are
//   remapped through the same matching, so they always point at the right
//   target row even when the target already had its own copy of the parent.
//   The whole import is ONE transaction — it lands completely or not at all.
//
// Deliberately NOT copied: users (password hashes — provision via Admin →
// Add User), contracts/quotes and their children, and the fac_* rating
// reference (versioned + governed in-app; move it with a full pg_dump
// restore — see docs/seed-ref-lists.md).
//
// Inactive rows ARE exported and imported: they may be FK targets and they
// carry the soft-delete state (migration 141) that hides retired entries.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const SNAPSHOT_FORMAT = 'universe-ref-lists@1';

// Canonical column names, with per-column aliases for schema drift between
// old and new databases (e.g. class_of_business vs class_name, ref_list.label
// vs list_name). Export normalises to the canonical name; import resolves the
// canonical name back to whatever physical column the target actually has.
// Columns missing on either side are simply skipped — the tool never fails on
// a database that predates a migration.
//
// Order matters: FK parents (country, ref_list) must sync before referrers.
export const REF_TABLES = [
  {
    name: 'country', pk: 'country_id', naturalKey: ['country_code'],
    cols: { country_name: [], country_code: [], region: [], is_active: [] },
  },
  {
    name: 'currency', pk: 'currency_id', naturalKey: ['currency_code'],
    cols: { currency_code: [], currency_name: [], is_active: [] },
  },
  {
    name: 'brokers', pk: 'broker_id', naturalKey: ['broker_name'],
    cols: { broker_name: [], is_active: [] },
  },
  {
    name: 'reinsurers', pk: 'reinsurer_id', naturalKey: ['reinsurer_name'],
    cols: { reinsurer_name: [], rating: [], is_active: [] },
  },
  {
    name: 'treaty_type', pk: 'treaty_type_id', naturalKey: ['treaty_type'],
    cols: { treaty_type: [], category: [], is_active: [] },
  },
  {
    name: 'class_of_business', pk: 'class_of_business_id', naturalKey: ['class_of_business'],
    cols: { class_of_business: ['class_name'], code: ['class_code'], is_active: [] },
  },
  {
    name: 'companies', pk: 'company_id', naturalKey: ['company_name'],
    cols: { company_name: [], country_id: [], company_type: [], is_active: [] },
    fks: { country_id: 'country' },
  },
  {
    name: 'ref_list', pk: 'list_id', naturalKey: ['list_key'],
    cols: { list_key: [], label: ['list_name'] },
  },
  {
    name: 'ref_list_item', pk: 'item_id', naturalKey: ['list_id', 'name'],
    cols: { list_id: [], code: [], name: [], sort_order: [], is_active: [] },
    fks: { list_id: 'ref_list' },
  },
  {
    name: 'ref_exchange_rate', pk: 'rate_id', naturalKey: ['currency_code', 'effective_date'],
    cols: { currency_code: [], rate_to_usd: [], effective_date: [], source: [] },
  },
  {
    name: 'ref_cresta_zone', pk: 'zone_db_id', naturalKey: ['country_id', 'zone_id'],
    cols: { country_id: [], zone_id: [], zone_name: [], sort_order: [] },
    fks: { country_id: 'country' },
  },
  {
    // Composite natural PK only — no surrogate id column.
    name: 'ref_country_inflation', pk: null, naturalKey: ['country_id', 'uw_year'],
    cols: { country_id: [], uw_year: [], inflation_pct: [], source: [] },
    fks: { country_id: 'country' },
  },
  {
    name: 'ref_benchmark_ldf', pk: 'benchmark_id', naturalKey: ['country_id', 'tail_type', 'development_month'],
    cols: { country_id: [], tail_type: [], development_month: [], incurred_ldf: [], premium_ldf: [] },
    fks: { country_id: 'country' },
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** Resolve the spec's canonical columns against the live table. null = table absent. */
async function resolveColumns(db, spec) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [spec.name],
  );
  if (!rows.length) return null;
  const tableCols = new Map(rows.map((r) => [r.column_name, r.data_type]));
  const mapping = new Map(); // canonical -> physical
  for (const [canonical, aliases] of Object.entries(spec.cols)) {
    const physical = [canonical, ...aliases].find((c) => tableCols.has(c));
    if (physical) mapping.set(canonical, physical);
  }
  return { tableCols, mapping };
}

// DATE columns are selected ::text so values survive JSON and string
// comparison as plain 'YYYY-MM-DD' — node-postgres would otherwise hand back
// a local-midnight Date whose ISO form can shift a day across timezones.
function selectExpr(tableCols, physical, canonical) {
  const cast = tableCols.get(physical) === 'date' ? '::text' : '';
  return `${quoteIdent(physical)}${cast} AS ${quoteIdent(canonical)}`;
}

/**
 * Loose value equality for change detection across JSON round-trips.
 * Numeric columns need a numeric compare: Postgres returns NUMERIC as text
 * with declared scale ('5.5000'), which must match a snapshot's 5.5 instead
 * of triggering a rewrite on every re-import.
 */
function sameValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (String(a) === String(b)) return true;
  if (a === '' || b === '') return false;
  const [na, nb] = [Number(a), Number(b)];
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:[^@]*@/, ':***@');
  }
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * Read every reference-list table from `db` into a plain JSON-able snapshot.
 * Each row carries its canonical columns plus `_id` (the source primary key,
 * used by import for stable re-matching and FK remapping).
 */
export async function exportSnapshot(db, { log = console } = {}) {
  const tables = {};
  for (const spec of REF_TABLES) {
    const phys = await resolveColumns(db, spec);
    if (!phys) {
      log.warn(`[sync-ref-lists] source table public.${spec.name} not found — skipped`);
      continue;
    }
    const selects = [];
    if (spec.pk && phys.tableCols.has(spec.pk)) {
      selects.push(`${quoteIdent(spec.pk)} AS "_id"`);
    }
    for (const [canonical, physical] of phys.mapping) {
      selects.push(selectExpr(phys.tableCols, physical, canonical));
    }
    const orderCols = spec.naturalKey
      .filter((c) => phys.mapping.has(c))
      .map((c) => quoteIdent(phys.mapping.get(c)));
    const orderBy = orderCols.length ? `ORDER BY ${orderCols.join(', ')}` : '';
    const { rows } = await db.query(
      `SELECT ${selects.join(', ')} FROM public.${quoteIdent(spec.name)} ${orderBy}`,
    );
    tables[spec.name] = { rows };
  }
  return {
    format: SNAPSHOT_FORMAT,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

// ── import ───────────────────────────────────────────────────────────────────

/**
 * Merge a snapshot into the database behind `db` (a pg.Pool). One transaction:
 * everything lands or nothing does. Returns a per-table summary
 * { inserted, updated, unchanged, skipped, deactivated }.
 */
export async function importSnapshot(db, snapshot, { dryRun = false, deactivateMissing = false, log = console } = {}) {
  if (snapshot?.format !== SNAPSHOT_FORMAT) {
    throw new Error(`unrecognised snapshot format ${JSON.stringify(snapshot?.format)} — expected ${SNAPSHOT_FORMAT}`);
  }

  const summary = {};
  const idMaps = {}; // table name -> Map(source id -> target id)
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const spec of REF_TABLES) {
      const stats = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, deactivated: 0 };
      summary[spec.name] = stats;

      const snap = snapshot.tables?.[spec.name];
      if (!snap) continue; // table wasn't in the snapshot (older source schema)

      const phys = await resolveColumns(client, spec);
      if (!phys) {
        log.warn(`[sync-ref-lists] target table public.${spec.name} not found — run migrations first; skipped ${snap.rows.length} rows`);
        stats.skipped = snap.rows.length;
        continue;
      }

      const tableIdent = `public.${quoteIdent(spec.name)}`;
      const pkUsable = Boolean(spec.pk && phys.tableCols.has(spec.pk));
      const idMap = new Map();
      idMaps[spec.name] = idMap;
      const seenTargetIds = [];

      // SELECT list used by both match paths: target pk (as _pk) + current
      // values of every canonical column, for change detection.
      const matchSelects = [
        ...(pkUsable ? [`${quoteIdent(spec.pk)} AS "_pk"`] : []),
        ...[...phys.mapping].map(([canonical, physical]) => selectExpr(phys.tableCols, physical, canonical)),
      ].join(', ');

      for (const raw of snap.rows) {
        const row = { ...raw };

        // Remap FK values through the parent table's source→target id map.
        let unresolvedFk = null;
        for (const [col, parentTable] of Object.entries(spec.fks || {})) {
          if (row[col] == null) continue;
          const mapped = idMaps[parentTable]?.get(row[col]);
          if (mapped == null) { unresolvedFk = col; break; }
          row[col] = mapped;
        }
        if (unresolvedFk) {
          stats.skipped += 1;
          if (stats.skipped <= 3) {
            log.warn(`[sync-ref-lists] ${spec.name}: skipped a row — ${unresolvedFk} points at a ${spec.fks[unresolvedFk]} row that did not import`);
          }
          continue;
        }

        // Canonical columns this row can actually set on this target.
        const setCols = [...phys.mapping.keys()].filter((c) => c in row);

        // 1) Match by primary key — a row a previous run inserted with the
        //    source's UUID. Renames at the source propagate through this path.
        let target = null;
        if (pkUsable && row._id != null) {
          const res = await client.query(
            `SELECT ${matchSelects} FROM ${tableIdent} WHERE ${quoteIdent(spec.pk)} = $1`,
            [row._id],
          );
          target = res.rows[0] || null;
        }

        // 2) Match by natural key, preferring active rows (soft-deleted rows
        //    may legitimately share a name with a live replacement — 141/150).
        if (!target && spec.naturalKey.every((c) => phys.mapping.has(c) && c in row)) {
          const where = spec.naturalKey
            .map((c, i) => {
              const physical = phys.mapping.get(c);
              const cast = phys.tableCols.get(physical) === 'date' ? '::text' : '';
              return `${quoteIdent(physical)}${cast} IS NOT DISTINCT FROM $${i + 1}`;
            })
            .join(' AND ');
          const activeOrder = phys.mapping.has('is_active')
            ? `(${quoteIdent(phys.mapping.get('is_active'))} IS NOT FALSE) DESC, `
            : '';
          const tieBreak = pkUsable ? quoteIdent(spec.pk) : '1';
          const res = await client.query(
            `SELECT ${matchSelects} FROM ${tableIdent} WHERE ${where}
              ORDER BY ${activeOrder}${tieBreak} LIMIT 1`,
            spec.naturalKey.map((c) => row[c]),
          );
          target = res.rows[0] || null;
        }

        if (target) {
          const changed = setCols.filter((c) => !sameValue(target[c], row[c]));
          if (changed.length) {
            const assignments = changed.map((c, i) => `${quoteIdent(phys.mapping.get(c))} = $${i + 1}`);
            const values = changed.map((c) => row[c]);
            let where;
            if (pkUsable) {
              values.push(target._pk);
              where = `${quoteIdent(spec.pk)} = $${values.length}`;
            } else {
              // pk-less table (ref_country_inflation): address via natural key.
              where = spec.naturalKey
                .map((c) => {
                  values.push(row[c]);
                  return `${quoteIdent(phys.mapping.get(c))} IS NOT DISTINCT FROM $${values.length}`;
                })
                .join(' AND ');
            }
            await client.query(`UPDATE ${tableIdent} SET ${assignments.join(', ')} WHERE ${where}`, values);
            stats.updated += 1;
          } else {
            stats.unchanged += 1;
          }
          if (pkUsable) {
            if (row._id != null) idMap.set(row._id, target._pk);
            seenTargetIds.push(target._pk);
          }
        } else {
          // Insert, preserving the source UUID where possible so later runs
          // (and any future full-data move) line up across environments.
          const insertCanon = [...setCols];
          const physCols = insertCanon.map((c) => quoteIdent(phys.mapping.get(c)));
          const values = insertCanon.map((c) => row[c]);
          if (pkUsable && row._id != null) {
            physCols.push(quoteIdent(spec.pk));
            values.push(row._id);
          }
          const placeholders = values.map((_, i) => `$${i + 1}`);
          const returning = pkUsable ? ` RETURNING ${quoteIdent(spec.pk)} AS "_pk"` : '';
          const insertSql = `INSERT INTO ${tableIdent} (${physCols.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;

          let inserted;
          await client.query('SAVEPOINT sync_ref_insert');
          try {
            inserted = await client.query(insertSql, values);
            await client.query('RELEASE SAVEPOINT sync_ref_insert');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT sync_ref_insert');
            if (err.code === '23505' && pkUsable && row._id != null) {
              // Freak UUID collision with an unrelated row: retry without the
              // source pk and let the target mint its own.
              const retrySql = `INSERT INTO ${tableIdent} (${physCols.slice(0, -1).join(', ')})
                                VALUES (${placeholders.slice(0, -1).join(', ')})${returning}`;
              inserted = await client.query(retrySql, values.slice(0, -1));
            } else {
              err.message = `${spec.name} ${JSON.stringify(Object.fromEntries(spec.naturalKey.map((c) => [c, raw[c]])))}: ${err.message}`;
              throw err;
            }
          }
          stats.inserted += 1;
          if (pkUsable) {
            const newId = inserted.rows[0]._pk;
            if (row._id != null) idMap.set(row._id, newId);
            seenTargetIds.push(newId);
          }
        }
      }

      // Optionally hide (never delete — rows may be FK targets) active target
      // rows the snapshot doesn't know about, so dropdowns mirror the source.
      if (deactivateMissing && pkUsable && phys.mapping.has('is_active')) {
        const activeCol = quoteIdent(phys.mapping.get('is_active'));
        const res = await client.query(
          `UPDATE ${tableIdent} SET ${activeCol} = false
            WHERE ${activeCol} IS NOT FALSE AND ${quoteIdent(spec.pk)} <> ALL($1::uuid[])`,
          [seenTargetIds],
        );
        stats.deactivated = res.rowCount;
      }
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node server/scripts/syncRefLists.js export [--out ref-lists.json]
      Reads SOURCE_DATABASE_URL (falls back to DATABASE_URL).
      --out -   writes the snapshot to stdout.

  node server/scripts/syncRefLists.js import [--in ref-lists.json] [--dry-run] [--deactivate-missing]
      Reads DATABASE_URL (falls back to TARGET_DATABASE_URL).
      --in -    reads the snapshot from stdin.

See docs/seed-ref-lists.md for the full Render → new-server walkthrough.`;

function parseArgs(argv) {
  const args = { command: argv[0], out: 'ref-lists.json', in: 'ref-lists.json', dryRun: false, deactivateMissing: false };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out' || flag === '-o') args.out = argv[++i];
    else if (flag === '--in' || flag === '-i') args.in = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--deactivate-missing') args.deactivateMissing = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown flag ${flag}\n\n${USAGE}`);
  }
  return args;
}

function printSummary(summary, { dryRun }) {
  const header = ['table', 'inserted', 'updated', 'unchanged', 'skipped', 'deactivated'];
  const rows = Object.entries(summary).map(([name, s]) => [
    name, s.inserted, s.updated, s.unchanged, s.skipped, s.deactivated,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((v, i) => String(v)[i === 0 ? 'padEnd' : 'padStart'](widths[i])).join('  ');
  console.error(fmt(header));
  for (const r of rows) console.error(fmt(r));
  if (dryRun) console.error('[sync-ref-lists] DRY RUN — rolled back, nothing was written.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.help) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  if (args.command === 'export') {
    const url = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('set SOURCE_DATABASE_URL (or DATABASE_URL) to the database to export from');
    console.error(`[sync-ref-lists] exporting from ${redactUrl(url)}`);
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 });
    try {
      const snapshot = await exportSnapshot(pool);
      for (const [table, { rows }] of Object.entries(snapshot.tables)) {
        console.error(`[sync-ref-lists] exported ${table}: ${rows.length} rows`);
      }
      const json = JSON.stringify(snapshot, null, 2);
      if (args.out === '-') {
        process.stdout.write(`${json}\n`);
      } else {
        writeFileSync(args.out, `${json}\n`);
        console.error(`[sync-ref-lists] wrote ${args.out}`);
      }
    } finally {
      await pool.end();
    }
    return;
  }

  if (args.command === 'import') {
    const url = process.env.DATABASE_URL || process.env.TARGET_DATABASE_URL;
    if (!url) throw new Error('set DATABASE_URL (or TARGET_DATABASE_URL) to the database to import into');
    const raw = args.in === '-' ? readFileSync(0, 'utf8') : readFileSync(args.in, 'utf8');
    const snapshot = JSON.parse(raw);
    console.error(`[sync-ref-lists] importing into ${redactUrl(url)}${args.dryRun ? ' (dry run)' : ''}`);
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 });
    try {
      const summary = await importSnapshot(pool, snapshot, {
        dryRun: args.dryRun,
        deactivateMissing: args.deactivateMissing,
      });
      printSummary(summary, args);
      if (!args.dryRun) {
        console.error('[sync-ref-lists] done. Restart the app (or wait ~5 min / DELETE /api/ref/cache) so cached dropdowns refresh.');
      }
    } finally {
      await pool.end();
    }
    return;
  }

  throw new Error(`unknown command ${args.command}\n\n${USAGE}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[sync-ref-lists] FAILED: ${err.message}`);
    process.exit(1);
  });
}
