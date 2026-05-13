// server/src/lib/entityContext.js
// Resolve "is this request operating on a quote or a contract" once,
// in one place. Eliminates the dozens of duplicated patterns like:
//
//   const isQuote = req.query.quote === 'true';
//   const tbl = isQuote ? 'quote_np_expiring' : 'contract_np_expiring';
//   const col = isQuote ? 'quote_id' : 'contract_id';
//   const parentTbl = isQuote ? 'quote' : 'contract';
//
// across nonProp.js, treatyData.js, pricing repositories, etc.
// Centralising it means schema renames (add a new sub-table for quote
// vs contract) become a one-file edit instead of a grep-and-pray.
//
// Usage:
//   import { entityContext } from '../lib/entityContext.js';
//   router.get('/treaties/:id/np/foo', asyncHandler(async (req, res) => {
//     const ctx = entityContext(req);
//     const { rows } = await pool.query(
//       `SELECT * FROM public.${ctx.npTable('foo')} WHERE ${ctx.idColumn} = $1`,
//       [req.params.id],
//     );
//   }));

/** @typedef {{
 *   isQuote: boolean,
 *   parentTable: 'quote' | 'contract',
 *   idColumn:    'quote_id' | 'contract_id',
 *   prefix:      'quote_' | 'contract_',
 *   apiOpts:     {quote: true} | undefined,
 *   subTable:    (suffix: string) => string,
 *   npTable:     (suffix: string) => string,
 * }} EntityContext */

/**
 * Inspect the request and return a strongly-shaped context object that
 * encodes the quote-vs-contract distinction as data instead of branches
 * scattered through every route. Returns the same shape regardless of
 * mode so handlers stay a single straight-line read.
 *
 * @param {import('express').Request} req
 * @returns {EntityContext}
 */
export function entityContext(req) {
  // Detection by URL path — robust to Express 5's req.query getter, which
  // returns a freshly parsed object on every access. Earlier versions of
  // this code mutated req.query.quote in route wrappers; that pattern
  // silently stopped working on Express 5 because the mutation lands on
  // a throwaway object. The path is the canonical source of truth anyway.
  const url = req.originalUrl || req.url || '';
  const quoteFlag = req.query?.quote;
  const isQuote = /^\/(?:api\/)?quotes?\//.test(url)
    || quoteFlag === true || quoteFlag === 'true' || quoteFlag === '1';
  const parentTable = isQuote ? 'quote' : 'contract';
  const idColumn = isQuote ? 'quote_id' : 'contract_id';
  const prefix = isQuote ? 'quote_' : 'contract_';
  return {
    isQuote,
    parentTable,
    idColumn,
    prefix,
    apiOpts: isQuote ? { quote: true } : undefined,
    /**
     * Build a sub-entity table name. e.g. subTable('triangle_cells')
     * returns 'quote_triangle_cells' or 'contract_triangle_cells'.
     */
    subTable(suffix) { return `${prefix}${suffix}`; },
    /**
     * Build a non-proportional sub-table name. NP tables follow a
     * consistent naming convention: {prefix}np_{suffix}.
     */
    npTable(suffix) { return `${prefix}np_${suffix}`; },
  };
}
