// server/src/routes/clientEvents.js
// Endpoint the client posts to when it catches a runtime error in
// an error boundary, or hits a condition worth auditing from the
// server's perspective (unhandled rejection, chunk-load failure, etc.).
//
// Intent: replace "it works on my machine" with a searchable log
// line — structured, request-scoped, rate-limited by this router's
// OWN 20/min per-user cap (app.js exempts /client-events from the
// global limiters on the strength of that cap, so it must live here).
// Not a full APM; just the one breadcrumb we need to reproduce issues
// without an external tool.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { makeLimiterStore } from '../lib/rateLimitStore.js';
import { logger } from '../lib/logger.js';

const router = Router();

// The 20/min cap app.js relies on when it skips the global IP + per-user
// limiters for this path. Keyed on the VERIFIED user id (runs after
// authenticate), falling back to the client IP for anonymous reporters —
// so one crash-looping tab cannot flood the log for everyone.
export function createClientEventsLimiter({ max = 20, windowMs = 60 * 1000, store = makeLimiterStore('client-events') } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many client events, please slow down.', code: 'TOO_MANY_REQUESTS' },
    keyGenerator: (req) => (req.user?.userId ? `ce:${req.user.userId}` : `ce-ip:${ipKeyGenerator(req.ip)}`),
    ...(store ? { store } : {}),
  });
}

const clientErrorSchema = z.object({
  type:    z.enum(['boundary', 'unhandled', 'chunk_load', 'other']).default('other'),
  message: z.string().max(2_000),
  stack:   z.string().max(10_000).optional(),
  path:    z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  buildId: z.string().max(64).optional(),
  // Caller-supplied breadcrumbs — small untyped object
  context: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * POST /api/client-events
 *
 * Best-effort logging. We always respond 204 so the client's fetch
 * never blocks on our response shape — the user has already seen the
 * error UI by the time this fires, we just want the telemetry.
 */
router.post('/client-events', createClientEventsLimiter(), validateBody(clientErrorSchema), asyncHandler(async (req, res) => {
  const body = req.body;
  logger.error('client error reported', {
    requestId: res.locals.requestId || req.id || null,
    type:      body.type,
    message:   body.message,
    stack:     body.stack?.split('\n').slice(0, 12).join('\n'), // cap deep frames
    path:      body.path,
    userAgent: body.userAgent,
    buildId:   body.buildId,
    context:   body.context,
    user:      req.user?.userId || null,
  });
  res.status(204).end();
}));

export default router;
