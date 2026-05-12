// server/src/routes/clientEvents.js
// Endpoint the client posts to when it catches a runtime error in
// an error boundary, or hits a condition worth auditing from the
// server's perspective (unhandled rejection, chunk-load failure, etc.).
//
// Intent: replace "it works on my machine" with a searchable log
// line — structured, request-scoped, rate-limited by the global
// API limiter. Not a full APM; just the one breadcrumb we need to
// reproduce issues without an external tool.

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { logger } from '../lib/logger.js';

const router = Router();

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
router.post('/client-events', validateBody(clientErrorSchema), asyncHandler(async (req, res) => {
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
