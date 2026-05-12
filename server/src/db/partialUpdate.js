// server/src/db/partialUpdate.js
// Build a safe UPDATE ... SET patch from an allow-list of columns.
// Centralises the partial-save semantics the treaty + quote handlers
// each reimplemented with long COALESCE chains. Two rules:
//
//   1. If the caller didn't include the column in `patch`, it is NOT
//      touched (existing value stays).
//   2. If the caller included the column with `null`, the column is
//      set to NULL (distinct from "not provided").
//
// This matches the longstanding partial-save convention documented in
// server/src/routes/quotes.js and removes a bunch of hand-rolled
// "COALESCE($2, cedant_id), COALESCE($3, broker_id)..." chains.
//
// Sanitises identifiers — never interpolates caller-provided column
// names.

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * @typedef {Object} PartialUpdateSpec
 * @property {string} table       Fully-qualified table name, e.g. 'public.quote'.
 * @property {string[]} allowed   Column names the caller may update. Anything
 *                                 else in `patch` is silently ignored.
 * @property {Record<string, any>} patch  The caller-supplied partial — only
 *                                         keys present will be updated. Null
 *                                         values are written as NULL.
 * @property {string} where       WHERE clause (without leading WHERE), e.g.
 *                                 'quote_id = $?'. Use '$?' placeholders;
 *                                 they get renumbered after the SET params.
 * @property {any[]} [whereParams] Params for the WHERE clause in '$?' order.
 * @property {boolean} [touchUpdatedAt] When true, appends `updated_at = now()`.
 *                                       Default: true.
 * @property {string} [returning]  Optional RETURNING clause, without the keyword.
 */

/**
 * @param {PartialUpdateSpec} spec
 * @returns {{ sql: string, params: any[] } | null} null when there's nothing to update.
 */
export function buildPartialUpdate(spec) {
  const {
    table, allowed, patch,
    where, whereParams = [],
    touchUpdatedAt = true,
    returning,
  } = spec;

  if (!IDENT.test(String(table).split('.').slice(-1)[0])) {
    throw new Error(`Invalid table identifier: ${table}`);
  }
  const allowSet = new Set(allowed.filter((c) => IDENT.test(c)));

  const sets = [];
  const params = [];
  for (const key of Object.keys(patch || {})) {
    if (!allowSet.has(key)) continue;
    params.push(patch[key]);
    sets.push(`${key} = $${params.length}`);
  }

  if (!sets.length && !touchUpdatedAt) return null;
  if (touchUpdatedAt) sets.push('updated_at = now()');
  if (!sets.length) return null; // caller sent empty patch AND told us not to touch updated_at

  // Renumber '$?' placeholders in the WHERE clause so they don't
  // collide with the SET params.
  let rewrittenWhere = where;
  const shiftedWhereParams = [];
  let nextIdx = params.length + 1;
  rewrittenWhere = rewrittenWhere.replace(/\$\?/g, () => {
    shiftedWhereParams.push(whereParams[shiftedWhereParams.length]);
    return `$${nextIdx++}`;
  });
  params.push(...shiftedWhereParams);

  let sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${rewrittenWhere}`;
  if (returning) sql += ` RETURNING ${returning}`;

  return { sql, params };
}
