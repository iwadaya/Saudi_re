// server/src/routes/facPlaces.js
// Address lookup for the facultative risk form — a same-origin proxy in front
// of Google Places (see lib/googlePlaces.js for why it is server-side).
//
// Mounted under /api as /fac/places/*, matching routes/facultativeReference.js.
// Both endpoints are POST: the typed address is a fragment of customer data and
// has no business sitting in a URL, a query string, an access log or a Referer
// header.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../helpers.js';
import {
  autocompleteAddress,
  placeDetails,
  isPlacesConfigured,
  PlacesError,
} from '../lib/googlePlaces.js';

const router = Router();

function requireUserId(req, res, next) {
  if (!req.user?.userId) {
    return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
  }
  next();
}

// Every Places call is billed, and one address takes several keystrokes even
// with client-side debouncing. This is a per-user spend fence on top of the
// global API limiter — generous enough for real typing, low enough that a stuck
// component or a script cannot run up a bill. Keyed on the verified user id.
const placesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many address lookups, please slow down.', code: 'TOO_MANY_REQUESTS' },
  keyGenerator: (req) => `places:${req.user?.userId}`,
});

router.use('/fac/places', requireUserId, placesLimiter);

/**
 * Whether the deployment can do address lookup at all. The client calls this
 * once and silently falls back to a plain text input when it is false, so a
 * deployment with no key looks like the old form rather than a broken one.
 */
router.get('/fac/places/status', (_req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({ configured: isPlacesConfigured() });
});

router.post('/fac/places/suggest', asyncHandler(async (req, res) => {
  const { input, sessionToken, regionCode } = req.body || {};
  if (typeof input !== 'string') {
    return res.status(400).json({ error: 'input is required.', code: 'VALIDATION_FAILED' });
  }
  // Bound the upstream payload; nobody types a 500-character address prefix.
  const result = await autocompleteAddress(input.slice(0, 200), {
    sessionToken: typeof sessionToken === 'string' ? sessionToken.slice(0, 64) : undefined,
    regionCode: typeof regionCode === 'string' && /^[A-Za-z]{2}$/.test(regionCode) ? regionCode : undefined,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/fac/places/details', asyncHandler(async (req, res) => {
  const { placeId, sessionToken } = req.body || {};
  if (typeof placeId !== 'string' || !placeId) {
    return res.status(400).json({ error: 'placeId is required.', code: 'VALIDATION_FAILED' });
  }
  const result = await placeDetails(placeId, {
    sessionToken: typeof sessionToken === 'string' ? sessionToken.slice(0, 64) : undefined,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}));

// PlacesError carries its own status/code (503 not-configured, 504 timeout,
// 502 upstream, 400 bad place id); errorHandler reads both off the error, so
// this only has to let it through untouched.
router.use('/fac/places', (err, _req, res, next) => {
  if (err instanceof PlacesError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return next(err);
});

export default router;
