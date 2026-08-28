import { env } from '../config/env.js';
import { logger, serializeError } from '../lib/logger.js';

// Known Postgres SQLSTATE codes mapped to client-facing HTTP status, code and
// message. These turn a raw driver error (which otherwise resolves to 500) into
// an accurate 4xx — e.g. writing to a non-existent treaty id is a client error,
// not a server fault.
const PG_ERROR = {
  '23503': { status: 400, code: 'FK_VIOLATION',    message: 'Referenced record does not exist' },
  '22P02': { status: 400, code: 'INVALID_ID',      message: 'Invalid identifier format' },
  '23505': { status: 409, code: 'DUPLICATE',       message: 'Record already exists' },
  // raise_exception from a trigger — keep the trigger's own message, just the status.
  'P0001': { status: 422, code: 'CHECK_VIOLATION', message: null },
};

function pgMapping(err) {
  // Only treat as a pg error when the caller hasn't set an explicit HTTP status
  // (app-level errors like STALE_WRITE/VALIDATION_FAILED set their own status).
  const hasExplicitStatus = Number.isFinite(Number(err?.status ?? err?.statusCode));
  if (hasExplicitStatus) return null;
  return (typeof err?.code === 'string' && PG_ERROR[err.code]) || null;
}

function resolveStatus(err) {
  const explicit = Number(err?.status || err?.statusCode || 0);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  const pg = pgMapping(err);
  if (pg) return pg.status;
  return 500;
}

function resolveCode(err, status) {
  const pg = pgMapping(err);
  if (pg) return pg.code;
  if (typeof err?.code === 'string' && err.code.trim()) return err.code;
  if (status === 404) return 'NOT_FOUND';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 400) return 'BAD_REQUEST';
  return 'INTERNAL_SERVER_ERROR';
}

export function errorHandler(err, req, res, _next) {
  const status = resolveStatus(err);
  const code = resolveCode(err, status);
  const pg = pgMapping(err);
  let message = (pg && pg.message) || err?.message || 'Internal server error';
  // 5xx in production: never echo the raw internal error (driver/stack details
  // are an information leak). The full error is still logged server-side below
  // and the requestId in the body correlates the two. 4xx keep their message —
  // they are intentional client-facing errors.
  if (status >= 500 && env.isProduction) {
    message = 'Internal server error';
  }
  const requestId = res.locals.requestId || req.id || null;

  const log = status >= 500 ? logger.error : logger.warn;
  log('request failed', {
    requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    statusCode: status,
    code,
    error: serializeError(err),
  });

  const body = {
    error: message,
    code,
    requestId,
  };

  // Surface optimistic-lock metadata so clients can prompt the user to
  // refresh and retry. STALE_WRITE carries both the timestamp the client
  // sent and the current server timestamp.
  if (err?.code === 'STALE_WRITE') {
    if (err.current) body.current = err.current;
    if (err.expected) body.expected = err.expected;
  }

  // Surface the attempted edge so clients can show "this contract is
  // already <current>, it can't go to <target>" without parsing prose.
  if (err?.code === 'INVALID_TRANSITION') {
    if (err.from) body.from = err.from;
    if (err.to)   body.to   = err.to;
  }

  if (!env.isProduction && err?.stack) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

export function notFoundHandler(req, res) {
  const requestId = res.locals.requestId || req.id || null;
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    code: 'NOT_FOUND',
    requestId,
  });
}
