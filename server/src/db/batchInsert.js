// server/src/db/batchInsert.js
// Helper for building a single multi-row INSERT statement.
//
// Several routes drop a slice of rows linked to a parent (contract,
// quote, etc.) and then re-insert them — historically inside a
// `for(...) await client.query(INSERT ... VALUES ($1,$2,...))` loop.
// That pattern issues one DB round-trip per row and is the single
// largest source of N+1 latency in our save endpoints.
//
// `buildBatchInsert` packs all rows into one INSERT ... VALUES
// (...),(...),(...) statement that shares a leading `$1` parameter
// (the parent entity id). Returns null when there are no rows so the
// caller can skip the query entirely.
//
// Table/column names are interpolated (values are always parameterised),
// so they are validated against an identifier allow-list and the helper
// throws on anything that isn't a plain identifier. All call sites use
// hard-coded names, so this only ever fires on a programming error,
// never on user input.

const IDENT = /^[a-z_][a-z0-9_]*$/i;

// A table may be schema-qualified (`public.foo`); every dot-separated
// segment must be a plain identifier.
function assertIdentifier(name, kind) {
  const segments = String(name).split('.');
  if (!segments.length || !segments.every((s) => IDENT.test(s))) {
    throw new Error(`Invalid ${kind} identifier: ${name}`);
  }
}

/**
 * @param {object} args
 * @param {string} args.table        Fully-qualified table name.
 * @param {string[]} args.columns    Column names; the first must be the
 *                                   parent-id column bound to leadingId.
 * @param {Array<Array<unknown>>} args.rows
 *                                   Per-row values for columns[1..].
 * @param {string|number} args.leadingId
 *                                   Value bound to $1 across all rows.
 * @param {string} [args.conflict]   Optional `ON CONFLICT ...` clause.
 * @returns {{sql:string, params:unknown[]}|null}
 */
export function buildBatchInsert({ table, columns, rows, leadingId, conflict = '' }) {
  if (!rows.length) return null;
  assertIdentifier(table, 'table');
  for (const column of columns) assertIdentifier(column, 'column');
  const colsAfterId = columns.length - 1;
  const placeholders = [];
  const params = [leadingId];
  let p = 2;
  for (const row of rows) {
    const slots = ['$1'];
    for (let c = 0; c < colsAfterId; c++) {
      slots.push(`$${p++}`);
      params.push(row[c]);
    }
    placeholders.push(`(${slots.join(',')})`);
  }
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}${conflict ? ` ${conflict}` : ''}`;
  return { sql, params };
}

// Postgres caps bind parameters per statement at 65535 (Int16 in the wire
// protocol); beyond it the count silently wraps and the insert fails with a
// confusing "bind message supplies N parameters" error. Leave headroom.
const MAX_PARAMS_PER_STATEMENT = 60000;

/**
 * Chunked variant of buildBatchInsert: returns an array of {sql, params}
 * statements, each safely under the wire-protocol parameter limit, so
 * callers with unbounded row counts (CRESTA zone imports, loss schedules)
 * can `for (const s of ...) await client.query(s.sql, s.params)`.
 * Returns [] when there are no rows. With an ON CONFLICT clause the caller
 * must ensure conflict keys don't repeat across rows (dedupe first), which
 * a single statement requires anyway.
 *
 * @param {Parameters<typeof buildBatchInsert>[0]} args
 * @returns {Array<{sql: string, params: unknown[]}>}
 */
export function buildBatchInserts({ table, columns, rows, leadingId, conflict = '' }) {
  const perRow = Math.max(1, columns.length - 1);
  const rowsPerChunk = Math.max(1, Math.floor((MAX_PARAMS_PER_STATEMENT - 1) / perRow));
  const out = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const stmt = buildBatchInsert({ table, columns, rows: rows.slice(i, i + rowsPerChunk), leadingId, conflict });
    if (stmt) out.push(stmt);
  }
  return out;
}
