// server/src/lib/treatyCategoryGuard.js
//
// Middleware that resolves a contract's treaty category (PROPORTIONAL
// vs NON_PROPORTIONAL) once per request and attaches it to
// `req.treatyContext`. Pricing/offer routes are shared across both
// types — without this guard a caller has no server-side check that
// the contract they think they're approving is actually the type they
// think it is.
//
// Two layers:
//
//   loadTreatyCategory          — looks up the contract by :id, 404s
//                                 if missing, attaches treatyContext.
//   requireTreatyCategory(cat)  — factory; rejects 409 if the loaded
//                                 category doesn't match the expected
//                                 one. Use sparingly — most offer
//                                 endpoints handle both categories.
//   assertBodyCategoryMatches   — if the request body carries a
//                                 declared `treaty_category`, ensure
//                                 it matches the actual contract
//                                 category. Protects against the
//                                 "thought I was approving prop, was
//                                 actually NP" client-state drift.

import { pool } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * Normalise category strings coming from the DB / client into one of
 * 'PROPORTIONAL' | 'NON_PROPORTIONAL' | null.
 */
export function normaliseCategory(raw) {
  if (raw == null) return null;
  const u = String(raw).toUpperCase().trim();
  if (!u) return null;
  // The DB column is free-text; existing rows use 'PROPORTIONAL' and
  // 'NON_PROPORTIONAL', and the routes/treaties renewal handler
  // detects NP via .includes('NON'). Mirror that here so a single
  // canonical value flows downstream.
  if (u.includes('NON')) return 'NON_PROPORTIONAL';
  if (u.includes('PROP')) return 'PROPORTIONAL';
  return null;
}

/**
 * Express middleware that resolves the contract's treaty category and
 * attaches `{ contractId, treatyCategory, uwStatus, isNp, isProp }` to
 * `req.treatyContext`. If the contract id doesn't exist a 404 is sent
 * and downstream handlers never run.
 */
export async function loadTreatyCategory(req, res, next) {
  const id = req.params?.id;
  if (!id) {
    return res.status(400).json({ error: 'Missing contract id', code: 'MISSING_CONTRACT_ID' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.contract_id, c.uw_status, tt.category AS treaty_category
         FROM public.contract c
         LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
        WHERE c.contract_id = $1`,
      [id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Contract not found', code: 'CONTRACT_NOT_FOUND' });
    }
    const row = rows[0];
    const treatyCategory = normaliseCategory(row.treaty_category);
    req.treatyContext = {
      contractId: row.contract_id,
      treatyCategory,
      uwStatus: row.uw_status || null,
      isNp: treatyCategory === 'NON_PROPORTIONAL',
      isProp: treatyCategory === 'PROPORTIONAL',
    };
    next();
  } catch (err) {
    logger.error('[treatyCategoryGuard] lookup failed', { id, error: err.message });
    next(err);
  }
}

/**
 * Factory: require the loaded contract to be of the given category.
 * Returns 409 on mismatch. Routes that handle both categories (most
 * offer endpoints) skip this; routes that are category-specific use
 * it as a hard fence.
 *
 * @param {'PROPORTIONAL'|'NON_PROPORTIONAL'} expected
 */
export function requireTreatyCategory(expected) {
  if (expected !== 'PROPORTIONAL' && expected !== 'NON_PROPORTIONAL') {
    throw new Error(`requireTreatyCategory: invalid category '${expected}'`);
  }
  return function requireTreatyCategoryMiddleware(req, res, next) {
    const ctx = req.treatyContext;
    if (!ctx) {
      logger.warn('[treatyCategoryGuard] requireTreatyCategory used without loadTreatyCategory');
      return res.status(500).json({ error: 'Treaty context not loaded', code: 'TREATY_CONTEXT_MISSING' });
    }
    if (!ctx.treatyCategory) {
      return res.status(409).json({
        error: 'Contract has no treaty category',
        code: 'TREATY_CATEGORY_UNKNOWN',
        contract_id: ctx.contractId,
      });
    }
    if (ctx.treatyCategory !== expected) {
      return res.status(409).json({
        error: `Endpoint requires ${expected} treaty; contract is ${ctx.treatyCategory}`,
        code: 'TREATY_CATEGORY_MISMATCH',
        contract_id: ctx.contractId,
        expected,
        actual: ctx.treatyCategory,
      });
    }
    next();
  };
}

/**
 * Middleware: if the request body declares a `treaty_category` field
 * (clients can pass it as a defensive double-check), ensure it
 * matches the actual contract category. Mismatch → 409. Used on
 * shared offer endpoints where the route itself is category-agnostic
 * but the caller still wants a guard against client-state drift.
 */
export function assertBodyCategoryMatches(req, res, next) {
  const declared = normaliseCategory(req.body?.treaty_category);
  if (!declared) return next();
  const ctx = req.treatyContext;
  if (!ctx) {
    logger.warn('[treatyCategoryGuard] assertBodyCategoryMatches used without loadTreatyCategory');
    return res.status(500).json({ error: 'Treaty context not loaded', code: 'TREATY_CONTEXT_MISSING' });
  }
  if (ctx.treatyCategory && declared !== ctx.treatyCategory) {
    return res.status(409).json({
      error: 'Declared treaty_category does not match contract category',
      code: 'TREATY_CATEGORY_MISMATCH',
      contract_id: ctx.contractId,
      declared,
      actual: ctx.treatyCategory,
    });
  }
  next();
}
