// server/src/middleware/httpCache.js
// Two lightweight helpers for scaling read-heavy endpoints:
//
//   1. `cacheHeaders(maxAgeSeconds)` — sets Cache-Control + Vary so
//      browsers and any CDN in front of the app short-circuit re-fetches
//      of reference data that changes rarely (countries, currencies,
//      brokers, COBs, etc.).
//
//   2. `jsonCache({ key, ttlMs, loader })` — a server-side in-memory
//      TTL cache for JSON payloads. First request computes and stores;
//      subsequent requests within the TTL return from memory without
//      touching the DB. Safe for global reference data — wrong for
//      anything per-user or mutable.
//
// Together these turn every reference-data page load from "30 users ×
// 6 lookup queries = 180 DB round-trips" into "6 DB queries per TTL
// window", which is the single biggest concurrency unlock this app
// has available without schema changes.

import crypto from 'node:crypto';

/**
 * Express middleware that stamps Cache-Control on the response. Use
 * for GET endpoints that return static reference data.
 *
 * @param {number} maxAgeSeconds — how long browsers/CDNs may reuse
 *   the cached response. 300s (5 min) is a sane default for lookups.
 * @param {object} [opts]
 * @param {boolean} [opts.private] — mark as private (only browser,
 *   no shared cache). Default false = public.
 */
export function cacheHeaders(maxAgeSeconds = 300, opts = {}) {
  const scope = opts.private ? 'private' : 'public';
  const directive = `${scope}, max-age=${maxAgeSeconds}, stale-while-revalidate=60`;
  return function cacheHeadersMiddleware(_req, res, next) {
    res.setHeader('Cache-Control', directive);
    res.setHeader('Vary', 'Accept-Encoding, x-user-role');
    next();
  };
}

// ── Server-side TTL cache ───────────────────────────────────────────

const _store = new Map(); // key -> { value, expiresAt, etag }

function computeETag(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return `W/"${crypto.createHash('sha1').update(json).digest('base64').slice(0, 16)}"`;
}

/**
 * Wrap an async loader with an in-memory TTL cache. Returns the
 * cached JSON if fresh; otherwise calls `loader()` and stores the
 * result. Also computes a weak ETag so callers can short-circuit
 * with 304 Not Modified when the client sends If-None-Match.
 *
 * @template T
 * @param {{ key: string, ttlMs: number, loader: () => Promise<T> }} opts
 * @returns {Promise<{ value: T, etag: string, fromCache: boolean }>}
 */
export async function jsonCache({ key, ttlMs, loader }) {
  const now = Date.now();
  const hit = _store.get(key);
  if (hit && hit.expiresAt > now) {
    return { value: hit.value, etag: hit.etag, fromCache: true };
  }
  const value = await loader();
  const etag = computeETag(value);
  _store.set(key, { value, etag, expiresAt: now + ttlMs });
  return { value, etag, fromCache: false };
}

/**
 * Drop one or more keys (prefix match). Call from mutation endpoints
 * so writers don't see stale reads from the same process.
 *
 * @param {string} prefix
 */
export function invalidateJsonCache(prefix) {
  for (const k of _store.keys()) {
    if (k.startsWith(prefix)) _store.delete(k);
  }
}

/**
 * Express helper: handle If-None-Match against the cached ETag and
 * send 304 if it matches. Otherwise write the payload with ETag +
 * Cache-Control headers set.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ value: any, etag: string }} cached
 * @param {number} [browserMaxAgeSeconds]
 */
export function sendCached(req, res, cached, browserMaxAgeSeconds = 300) {
  res.setHeader('ETag', cached.etag);
  res.setHeader('Cache-Control', `public, max-age=${browserMaxAgeSeconds}, stale-while-revalidate=60`);
  res.setHeader('Vary', 'Accept-Encoding');
  const inm = req.headers['if-none-match'];
  if (inm && inm === cached.etag) {
    res.status(304).end();
    return;
  }
  res.json(cached.value);
}

/** Exposed for diagnostics — size and a few keys for /api/health/cache. */
export function cacheStats() {
  return {
    size: _store.size,
    sampleKeys: Array.from(_store.keys()).slice(0, 10),
  };
}
