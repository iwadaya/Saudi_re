import crypto from 'crypto';
import { logger } from '../lib/logger.js';

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

export function attachRequestId(req, res, next) {
  const requestId = req.get('x-request-id') || createRequestId();
  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();
  const requestLogger = logger.child({ requestId, method: req.method, path: req.originalUrl || req.url });
  req.log = requestLogger;

  res.on('finish', () => {
    const path = req.originalUrl || req.url || '';
    if (path === '/api/health' && res.statusCode < 500 && process.env.REQUEST_LOG_HEALTH !== '1') {
      return;
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    requestLogger.info('request completed', {
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      contentLength: res.getHeader('content-length') || null,
    });
  });

  next();
}
