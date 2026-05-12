// server/src/middleware/requestTimeout.js
// Per-request timeout. If a handler stalls (DB deadlock, stuck external
// call, infinite loop in pricing engine), we don't want the request
// sitting on a pool connection forever — better to fail it fast with
// 503 and free the slot for the next user.
//
// The DB pool already has its own statement_timeout (30s), so this
// middleware should be set slightly above that (default 35s) to give
// Postgres time to return its own error first — which produces a better
// error message than a bare "Request timed out".

import { logger } from '../lib/logger.js';

/**
 * @param {number} ms How long a single request may run before we
 *   abandon it with 503. Default 35_000.
 */
export function requestTimeout(ms = 35_000) {
  return function requestTimeoutMiddleware(req, res, next) {
    // Don't apply to long-polling or file-upload endpoints that can
    // legitimately run long. Add more paths here as needed.
    const mountedPath = req.path || '';
    const originalPath = req.originalUrl || req.url || mountedPath;
    if (
      mountedPath.startsWith('/ai/') ||
      originalPath.startsWith('/api/ai/') ||
      mountedPath.includes('/documents') ||
      originalPath.includes('/documents')
    ) {
      return next();
    }

    const timer = setTimeout(() => {
      if (res.headersSent) return; // response already started; nothing to do
      logger.warn('request timeout', {
        requestId: res.locals.requestId || req.id,
        method: req.method,
        path: req.originalUrl || req.url,
        timeoutMs: ms,
      });
      res.status(503).json({
        error: 'Request timed out',
        code: 'REQUEST_TIMEOUT',
        requestId: res.locals.requestId || req.id || null,
      });
    }, ms);
    timer.unref(); // don't keep the event loop alive for timers alone

    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));
    next();
  };
}
