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
// so — like partialUpdate.js — they are validated against an identifier
// allow-list and the helper throws on anything that isn't a plain
// identifier. All call sites use hard-coded names, so this only ever
// fires on a programming error, never on user input.

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
