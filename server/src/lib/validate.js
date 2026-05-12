// server/src/lib/validate.js
// Thin wrapper around Zod that turns a parse failure into a 400 with a
// machine-readable error body. Use as middleware:
//
//   import { validateBody } from '../lib/validate.js';
//   import { quoteHeaderPatchSchema } from '../validation/quote.js';
//
//   router.put('/quotes/:id/header',
//     validateBody(quoteHeaderPatchSchema),
//     asyncHandler(async (req, res) => { /* req.body is validated + typed */ }),
//   );
//
// Goals:
//   • Reject malformed payloads BEFORE they reach the DB layer, so we
//     don't have to second-guess types in handlers or rely on Postgres
//     to scream about constraint violations.
//   • Emit a consistent error shape — { error, code, fields } — so
//     clients can highlight the bad fields without parsing prose.
//   • Stay opt-in: existing handlers without a schema keep working.

import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Walk two objects and log any keys present in `actual` that are
 * missing from `schemaShape`. Used in dev only to flag wire-shape
 * drift so we can tighten schemas to `.strict()` once every key is
 * accounted for. Recurses one level for the common "nested slice"
 * pattern (terms.header, terms.detail, …) but no deeper — the
 * signal/noise past one level gets bad.
 */
function warnOnUnknownKeys(schema, actual, path = '', reqId) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return;
  const shape = schema?._def?.shape?.() || schema?.shape;
  if (!shape) return;
  const known = new Set(Object.keys(shape));
  for (const key of Object.keys(actual)) {
    if (!known.has(key)) {
      logger.warn('unknown key in request body', {
        requestId: reqId, path: path ? `${path}.${key}` : key, schema: schema?.description || null,
      });
    } else if (actual[key] && typeof actual[key] === 'object' && shape[key]) {
      warnOnUnknownKeys(shape[key], actual[key], path ? `${path}.${key}` : key, reqId);
    }
  }
}

/**
 * Format a ZodError into the wire shape used by the rest of the app.
 * The `fields` array lists every offending path with its message so
 * the client can highlight individual inputs.
 */
function formatZodError(err) {
  return {
    error: 'Request body failed validation',
    code: 'VALIDATION_FAILED',
    fields: err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    })),
  };
}

/**
 * Express middleware factory that validates `req.body` with the given
 * schema. On success, replaces req.body with the parsed value (so
 * unknown keys are stripped and types are coerced); on failure, sends
 * 400 + the structured error and short-circuits.
 *
 * @param {import('zod').ZodType} schema
 */
export function validateBody(schema) {
  return function validateBodyMiddleware(req, res, next) {
    try {
      if (!env.isProduction) {
        warnOnUnknownKeys(schema, req.body, '', res.locals.requestId || req.id);
      }
      req.body = schema.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const body = formatZodError(err);
        body.requestId = res.locals.requestId || req.id || null;
        logger.warn('request validation failed', {
          requestId: body.requestId,
          path: req.originalUrl || req.url,
          fields: body.fields,
        });
        return res.status(400).json(body);
      }
      next(err);
    }
  };
}

/**
 * Same as validateBody but for query parameters. Useful for paginated
 * list endpoints that accept page/limit/filter strings.
 *
 * @param {import('zod').ZodType} schema
 */
export function validateQuery(schema) {
  return function validateQueryMiddleware(req, res, next) {
    try {
      // Don't replace req.query directly — Express types it as an
      // immutable view in some configs. Stash the parsed copy on
      // res.locals where handlers can read it.
      res.locals.query = schema.parse(req.query ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const body = formatZodError(err);
        body.requestId = res.locals.requestId || req.id || null;
        return res.status(400).json(body);
      }
      next(err);
    }
  };
}
