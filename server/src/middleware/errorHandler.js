import { env } from '../config/env.js';
import { logger, serializeError } from '../lib/logger.js';

function resolveStatus(err) {
  const status = Number(err?.status || err?.statusCode || 500);
  if (!Number.isFinite(status) || status < 400 || status > 599) return 500;
  return status;
}

function resolveCode(err, status) {
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
  const message = err?.message || 'Internal server error';
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
