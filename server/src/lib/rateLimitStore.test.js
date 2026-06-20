// Tests for the distributed rate-limit store: FallbackStore behaviour and
// makeLimiterStore's REDIS_URL gating. These exercise the two requirements
// that matter operationally — counts are SHARED across instances when Redis
// is up, and limiting is PRESERVED (degrades to in-memory, not allow-all)
// when Redis errors — without needing a real Redis server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimit from 'express-rate-limit';

// Stub the real RedisStore so the wiring test doesn't preload Lua scripts
// against a fake client. FallbackStore behaviour is tested with hand-rolled
// stores below; this only checks makeLimiterStore wraps the primary.
vi.mock('rate-limit-redis', () => ({
  RedisStore: class { constructor(opts) { this.opts = opts; } init() {} async increment() { return { totalHits: 1, resetTime: new Date() }; } },
}));

const { FallbackStore, makeLimiterStore, rateLimitStoreEnabled } = await import('./rateLimitStore.js');

// A tiny in-memory stand-in for a Redis-backed store implementing the
// express-rate-limit Store interface. Two FallbackStores sharing ONE of
// these model two app instances sharing one Redis.
class FakeSharedStore {
  constructor() { this.hits = new Map(); this.windowMs = 60_000; }
  init(opts) { this.windowMs = opts.windowMs; }
  async increment(key) {
    const totalHits = (this.hits.get(key) || 0) + 1;
    this.hits.set(key, totalHits);
    return { totalHits, resetTime: new Date(Date.now() + this.windowMs) };
  }
  async decrement(key) { this.hits.set(key, Math.max(0, (this.hits.get(key) || 0) - 1)); }
  async resetKey(key) { this.hits.delete(key); }
  async resetAll() { this.hits.clear(); }
}

// A store whose primary always throws — models Redis being unreachable.
class BrokenStore {
  init() {}
  async increment() { throw new Error('ECONNREFUSED'); }
  async decrement() { throw new Error('ECONNREFUSED'); }
  async resetKey() { throw new Error('ECONNREFUSED'); }
  async resetAll() { throw new Error('ECONNREFUSED'); }
}

// A store that works for N increments, then starts failing (mid-window outage).
class FailsAfterNStore extends FakeSharedStore {
  constructor(failAfter) {
    super();
    this.failAfter = failAfter;
    this.calls = 0;
  }

  async increment(key) {
    this.calls += 1;
    if (this.calls > this.failAfter) throw new Error('ECONNRESET');
    return super.increment(key);
  }
}

describe('FallbackStore — shared counts across instances', () => {
  it('two stores over one shared backend see each other\'s counts', async () => {
    const shared = new FakeSharedStore();
    const a = new FallbackStore(shared, { label: 'api' });
    const b = new FallbackStore(shared, { label: 'api' });
    a.init({ windowMs: 60_000 });
    b.init({ windowMs: 60_000 });

    const r1 = await a.increment('ip:1.2.3.4');
    const r2 = await b.increment('ip:1.2.3.4'); // different instance, same key
    expect(r1.totalHits).toBe(1);
    expect(r2.totalHits).toBe(2); // count is shared, not per-instance
  });
});

describe('FallbackStore — degrade to in-memory on Redis error', () => {
  let errSpy;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('keeps counting via the in-memory fallback instead of allowing all', async () => {
    const store = new FallbackStore(new BrokenStore(), { label: 'login' });
    store.init({ windowMs: 60_000 });

    // Limiting must persist during the outage: repeated hits keep climbing.
    // (MemoryStore mutates+returns one record, so read totalHits inline.)
    const a = (await store.increment('login:ip:x')).totalHits;
    const b = (await store.increment('login:ip:x')).totalHits;
    const c = (await store.increment('login:ip:x')).totalHits;
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(store.degraded).toBe(true);
  });

  it('does not reset counters when Redis fails after earlier successes', async () => {
    const store = new FallbackStore(new FailsAfterNStore(3), { label: 'login' });
    store.init({ windowMs: 60_000 });

    // First three increments come from the primary store.
    expect((await store.increment('login:ip:y')).totalHits).toBe(1);
    expect((await store.increment('login:ip:y')).totalHits).toBe(2);
    expect((await store.increment('login:ip:y')).totalHits).toBe(3);

    // After the primary fails, fallback must continue from the existing count
    // (not restart at 1, which would grant a fresh brute-force burst).
    expect((await store.increment('login:ip:y')).totalHits).toBe(4);
    expect((await store.increment('login:ip:y')).totalHits).toBe(5);
    expect(store.degraded).toBe(true);
  });

  it('recovers (clears degraded) when the primary works again', async () => {
    const flaky = new FakeSharedStore();
    const store = new FallbackStore(flaky, { label: 'api' });
    store.init({ windowMs: 60_000 });
    // Force one failure, then a success.
    const orig = flaky.increment.bind(flaky);
    flaky.increment = async () => { throw new Error('blip'); };
    await store.increment('k');
    expect(store.degraded).toBe(true);
    flaky.increment = orig;
    await store.increment('k');
    expect(store.degraded).toBe(false);
  });
});

describe('FallbackStore — enforces a real limiter end to end', () => {
  it('blocks the 6th login attempt across two instances sharing the store', async () => {
    const shared = new FakeSharedStore();
    const mk = () => rateLimit({
      windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false,
      keyGenerator: () => 'login:ip:1.1.1.1',
      store: new FallbackStore(shared, { label: 'login' }),
    });
    const inst1 = mk();
    const inst2 = mk();

    const run = (mw) => new Promise((resolve) => {
      const req = { ip: '1.1.1.1', method: 'POST', headers: {}, body: {}, app: { get: () => undefined } };
      const res = {
        statusCode: 200, headersSent: false,
        setHeader() {}, getHeader() {}, removeHeader() {},
        status(c) { this.statusCode = c; return this; },
        send() { resolve(this.statusCode); return this; },
        json() { resolve(this.statusCode); return this; },
        end() { resolve(this.statusCode); return this; },
      };
      mw(req, res, () => resolve(200));
    });

    // 5 allowed (alternating instances), 6th blocked — proving the shared count.
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await run(i % 2 ? inst2 : inst1));
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});

describe('makeLimiterStore — REDIS_URL gating', () => {
  const orig = process.env.REDIS_URL;
  afterEach(() => { if (orig === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = orig; });

  it('returns undefined (built-in in-memory store) when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    expect(makeLimiterStore('api')).toBeUndefined();
    expect(rateLimitStoreEnabled()).toBe(false);
  });

  it('builds a FallbackStore when a client is supplied', () => {
    const fakeClient = { call: vi.fn() };
    const store = makeLimiterStore('api', { client: fakeClient });
    expect(store).toBeInstanceOf(FallbackStore);
  });
});
