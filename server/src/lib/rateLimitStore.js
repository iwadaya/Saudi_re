// server/src/lib/rateLimitStore.js
//
// Distributed store for the express-rate-limit limiters so per-IP and
// per-user ceilings are shared across instances instead of each Node
// process keeping its own counts (which let N instances allow N× the
// limit — most dangerously on the auth/login routes).
//
// Policy (see the P1-observability rate-limiting decision):
//   • REDIS_URL set    → shared Redis/Valkey store.
//   • REDIS_URL unset  → undefined, so express-rate-limit uses its
//     built-in in-memory MemoryStore exactly as before. Dev/test/CI run
//     unchanged with no Redis required.
//   • Redis unreachable (at boot OR mid-flight) → degrade to a per-
//     instance in-memory store so limiting is NEVER silently lost, and
//     log LOUDLY (operators alert on the "[ratelimit] degraded" line).
//     We do not fail-open (allow-all): the auth routes must stay limited
//     even during a Redis outage.
//
// The limit thresholds themselves are unchanged here — this module only
// swaps where the counts live.

import Redis from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import { MemoryStore } from 'express-rate-limit';
import { logger } from './logger.js';

let _client = null; // shared ioredis connection (one per process)

// Throttle the degraded/recovered/connection logs so a Redis outage
// can't flood the log (one increment per request would be thousands/min).
const LOG_THROTTLE_MS = 60_000;
let _lastDegradedLog = 0;
let _lastClientErrLog = 0;

function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (_client) return _client;
  // enableOfflineQueue:false → while disconnected, commands reject fast
  // instead of buffering, so FallbackStore fails over to memory promptly
  // (covers Redis being unreachable at boot). maxRetriesPerRequest:1 keeps
  // a slow/broken Redis from holding requests open.
  _client = new Redis(process.env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  _client.on('error', (err) => {
    const now = Date.now();
    if (now - _lastClientErrLog > LOG_THROTTLE_MS) {
      _lastClientErrLog = now;
      logger.warn('[ratelimit] redis client error', { message: err?.message || String(err) });
    }
  });
  return _client;
}

/**
 * A store that delegates to a primary (Redis) store and, on ANY error
 * from it, transparently falls back to a per-instance in-memory store so
 * rate limiting keeps working during a Redis outage. Implements the
 * express-rate-limit Store interface (init/increment/decrement/resetKey/
 * resetAll/get/shutdown).
 */
export class FallbackStore {
  constructor(primary, { label = 'ratelimit' } = {}) {
    this.primary = primary;
    this.memory = new MemoryStore();
    this.label = label;
    this.degraded = false;
    this.localKeys = false;
  }

  init(options) {
    this.primary.init?.(options);
    this.memory.init(options);
  }

  _onError(err) {
    const now = Date.now();
    if (!this.degraded || now - _lastDegradedLog > LOG_THROTTLE_MS) {
      _lastDegradedLog = now;
      // ERROR level: this is the alertable signal that distributed limiting
      // is degraded to per-instance counts. Alert on "[ratelimit] degraded".
      logger.error('[ratelimit] degraded — Redis store unreachable, falling back to in-memory limiting', {
        label: this.label,
        message: err?.message || String(err),
      });
    }
    this.degraded = true;
  }

  _onSuccess() {
    if (this.degraded) {
      this.degraded = false;
      logger.warn('[ratelimit] recovered — Redis store reachable again', { label: this.label });
    }
  }

  async increment(key) {
    try {
      const r = await this.primary.increment(key);
      this._onSuccess();
      return r;
    } catch (err) {
      this._onError(err);
      return this.memory.increment(key);
    }
  }

  async decrement(key) {
    try {
      await this.primary.decrement(key);
    } catch (err) {
      this._onError(err);
      await this.memory.decrement(key);
    }
  }

  async resetKey(key) {
    try {
      await this.primary.resetKey(key);
    } catch (err) {
      this._onError(err);
    }
    // Always clear the memory copy too so a key reset is honoured in
    // whichever store currently holds the count.
    await this.memory.resetKey(key);
  }

  async resetAll() {
    try {
      await this.primary.resetAll?.();
    } catch (err) {
      this._onError(err);
    }
    await this.memory.resetAll?.();
  }

  async get(key) {
    try {
      const r = await this.primary.get?.(key);
      this._onSuccess();
      return r;
    } catch (err) {
      this._onError(err);
      return this.memory.get?.(key);
    }
  }

  async shutdown() {
    await this.primary.shutdown?.();
    await this.memory.shutdown?.();
  }
}

/**
 * Build a store for one limiter. `prefix` namespaces the limiter's keys
 * in the shared Redis keyspace (so the IP, login, per-user and password
 * limiters don't collide). Returns undefined when REDIS_URL is unset, so
 * the caller's express-rate-limit falls back to its built-in MemoryStore.
 *
 * @param {string} prefix
 * @param {{ client?: import('ioredis').Redis }} [opts]  client override for tests
 */
export function makeLimiterStore(prefix, { client = getClient() } = {}) {
  if (!client) return undefined; // no REDIS_URL → built-in in-memory store
  const redisStore = new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args) => client.call(...args),
  });
  return new FallbackStore(redisStore, { label: prefix });
}

/** True when a shared (Redis) rate-limit store is configured. */
export function rateLimitStoreEnabled() {
  return !!process.env.REDIS_URL;
}

/** Close the shared Redis connection (called from graceful shutdown). */
export async function closeRateLimitStore() {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      _client.disconnect();
    }
    _client = null;
  }
}
