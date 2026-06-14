import cors from 'cors';
import compression from 'compression';
import express from 'express';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pool, getPoolStats } from './db/pool.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { authenticate, requireAuth } from './middleware/requestContext.js';
import { attachRequestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { cacheStats } from './middleware/httpCache.js';
import { requestTimeout } from './middleware/requestTimeout.js';

import authRouter from './routes/auth.js';
import { registerApiRoutes } from './routes/registerApiRoutes.js';

// Pagination metadata + error codes exposed so browsers can read them.
const EXPOSED_HEADERS = ['X-Total-Count', 'X-Page', 'X-Page-Size', 'X-Request-Id', 'X-Pricing-Drift-Count'];

// Cache CORS preflight for 24h. Without this every cross-origin XHR
// pays a synchronous OPTIONS round-trip — on a chatty page that's
// dozens of extra requests stacked on top of the real ones. 86400
// is the maximum Chromium honours; Firefox caps at 7200 but still
// benefits.
const CORS_PREFLIGHT_MAX_AGE = 86400;

function createCorsOptions() {
  if (env.corsOrigin === '*') {
    return {
      origin: true,
      credentials: false,
      exposedHeaders: EXPOSED_HEADERS,
      maxAge: CORS_PREFLIGHT_MAX_AGE,
    };
  }
  const allowedOrigins = new Set(env.corsOrigin.split(',').map((item) => item.trim()).filter(Boolean));
  // When the API also serves the built SPA, browsers may still attach an
  // Origin header to module/CSS asset requests. Always allow the server's
  // own localhost origins so local single-port deployments don't 500 on
  // hashed assets if CORS_ORIGIN omits the active PORT override.
  allowedOrigins.add(`http://localhost:${env.port}`);
  allowedOrigins.add(`http://127.0.0.1:${env.port}`);
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: CORS_PREFLIGHT_MAX_AGE,
  };
}

function registerHealthRoutes(app) {
  // Lightweight health check — no DB round-trip. Used by load balancers
  // that hammer this every few seconds; keeping it DB-free means health
  // polling never competes with user traffic for pool connections.
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.nodeEnv, requestId: res.locals.requestId || null });
  });

  // Deep health — verifies DB reachability + returns pool + cache stats.
  // Watch X-Pool-Waiting in production: > 0 sustained = bump DB_POOL_MAX.
  app.get('/api/health/deep', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const started = Date.now();
      await pool.query('SELECT 1');
      const dbMs = Date.now() - started;
      const ps = getPoolStats();
      res.setHeader('X-Pool-Waiting', String(ps.waitingCount));
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: env.nodeEnv,
        db: { ok: true, pingMs: dbMs, pool: ps },
        cache: cacheStats(),
        requestId: res.locals.requestId || null,
      });
    } catch (error) {
      res.status(503).json({ status: 'error', message: error.message, requestId: res.locals.requestId || null });
    }
  });
}

function registerClient(app) {
  // Try multiple path strategies to find client/dist — no __dirname (ESM)
  const candidates = [
    env.clientDistDir,
    path.resolve(process.cwd(), 'client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];

  const clientDir = candidates.find(p => fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html')));

  logger.info('[static] resolving client dist', {
    cwd: process.cwd(),
    candidates,
    clientDir: clientDir || null,
  });

  if (!clientDir) {
    logger.warn('[static] client/dist not found — SPA will not be served');
    return;
  }

  // JS/CSS assets have content-hash in filename — long cache fine
  // index.html and manifest must never be cached so fresh chunk hashes load
  //
  // For the hashed bundle in /assets/ we send `immutable` so browsers skip
  // the conditional GET entirely on revisits. Vite emits content-hashed
  // filenames there, so a different hash means a different URL — there is
  // never a case where the cached bytes for a given URL go stale.
  app.use(express.static(clientDir, {
    maxAge: '1y',
    etag: false,        // hashed filenames already invalidate; ETag is wasted CPU
    lastModified: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('manifest.json') || filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
  // SPA fallback: serve index.html for all non-API, non-asset routes.
  // IMPORTANT: exclude /assets/ so stale chunk URLs return 404 instead of index.html.
  // A 404 is correctly handled by the chunk error handler; index.html with text/html
  // MIME type causes browser to throw a MIME type mismatch error.
  app.get(/^(?!\/api\/)(?!\/assets\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  logger.info('[static] serving client', { clientDir });
}

// Endpoints that must never be throttled at the IP layer (health probes and
// our own crash-report telemetry, which has its own 20/min cap).
function skipRateLimit(req) {
  const path = req.path || '';
  const original = req.originalUrl || req.url || '';
  return path.startsWith('/health') ||
         original.startsWith('/api/health') ||
         path === '/client-events' ||
         original === '/api/client-events';
}

// ── Pre-auth global limiter: keyed on the real client IP ONLY ──
// With trust proxy set, req.ip is the forwarded client IP (each user's own IP,
// not the shared Render proxy), so a per-IP ceiling no longer throttles the
// whole team. It is keyed on IP ONLY — never x-user-id — so rotating that
// header can't manufacture fresh buckets to bypass the limit (incl. login
// brute force, which hits this before authenticate runs).
export function createApiLimiter({ max = 300, windowMs = 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
    skip: skipRateLimit,
  });
}

// ── Login limiter: strict, keyed on IP + the submitted identity ──
// Complements the DB failed_attempts lockout (5 fails → 15-min account lock):
// this throttles brute force at the edge per IP+identity before the handler/DB
// is touched. Low ceiling, 15-min window.
export function createLoginLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please wait a few minutes and try again.', code: 'TOO_MANY_LOGINS' },
    keyGenerator: (req) => {
      const id = String(req.body?.username || req.body?.email || '').trim().toLowerCase();
      return `login:${ipKeyGenerator(req.ip)}:${id}`;
    },
  });
}

// ── Optional per-user limiter (additive, runs AFTER authenticate) ──
// Per-user quota keyed on the VERIFIED req.user.userId — never replaces the IP
// limiter. Anonymous requests are skipped here (already IP-limited above).
export function createUserApiLimiter({ max = 600, windowMs = 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
    keyGenerator: (req) => `u:${req.user?.userId}`,
    skip: (req) => !req.user || skipRateLimit(req),
  });
}

export function createApp() {
  const app = express();

  // Trust Render's proxy so rate-limiter reads the real client IP
  app.set('trust proxy', 1);
  // Weak ETag is a fast non-cryptographic hash of the body; strong ETag
  // is a full md5. Hot JSON endpoints already set their own ETag in the
  // cache middleware, so the only consumer of Express's default is rare
  // payloads we haven't explicitly cached — weak is cheaper there and
  // still produces correct 304s.
  app.set('etag', 'weak');

  fs.mkdirSync(env.uploadDir, { recursive: true });

  app.disable('x-powered-by');

  app.use(attachRequestId);

  // Fast path: health checks skip the heavy middleware chain entirely.
  // They still get request IDs above, and the handlers set their own
  // Cache-Control. Load-balancer polling should never queue behind
  // real user traffic waiting on helmet/compression/CORS.
  registerHealthRoutes(app);

  // Security headers (CSP disabled — client uses inline styles in dev)
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // Compression — gzip responses > 1KB. Skip already-compressed bodies
  // (images, PDFs) by default via compression's filter.
  //
  // Level 4 trades ~3-5% larger payloads for roughly half the CPU cost of
  // level 6 — a worthwhile swap for a JSON-heavy API where TTFB matters
  // more than wire bytes. memLevel 9 lets zlib keep more state in RAM,
  // which removes a small per-call allocation hit at high concurrency.
  app.use(compression({
    level: 4,
    memLevel: 9,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    },
  }));

  // Per-request timeout so a stuck handler never pins a pool connection
  // forever. Set slightly above the DB statement_timeout so Postgres'
  // own error surfaces first with a more useful message.
  app.use('/api', requestTimeout(Number(process.env.REQUEST_TIMEOUT_MS) || 35_000));

  app.use(cors(createCorsOptions()));

  // Rate limiting on all /api — intentionally before JSON parsing so
  // throttled clients do not make the process spend CPU/memory parsing
  // a body that will be rejected anyway. In-memory store is fine for a
  // single Node process; swap to Redis when scaling horizontally.
  app.use('/api', createApiLimiter());

  // Body parser — 1MB is plenty for any realistic pricing payload.
  // File uploads use multer and bypass this. 5MB was unnecessarily
  // generous and just made DoS-via-fat-body easier.
  app.use(express.json({ limit: '1mb' }));

  // Strict brute-force limiter on login (after JSON parse so the identity is
  // available for keying; keyed on IP + identity).
  app.use('/api/auth/login', createLoginLimiter());

  // ── Authentication ──
  // authenticate sets req.user from a verified token (role/level re-read from
  // the DB), or — only under ALLOW_DEMO_AUTH — from x-user-* headers, else null.
  app.use('/api', authenticate);

  // Optional additive per-user quota (keyed on the verified user id).
  app.use('/api', createUserApiLimiter());

  // Auth routes self-gate (login / open-registration / login-screen lookups are
  // public; /auth/me and the rest require a real identity) — register before the
  // blanket requireAuth so those public endpoints aren't blocked.
  app.use('/api', authRouter);

  // Every other API route — reads and writes alike — requires a real identity.
  app.use('/api', requireAuth);

  registerApiRoutes(app);
  registerClient(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
