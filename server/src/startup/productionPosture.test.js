import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let isProd = true;
let corsOrigin = 'https://app.example';
vi.mock('../config/env.js', () => ({
  get env() { return { isProduction: isProd, corsOrigin }; },
}));

const { checkProductionPosture, inClusterMode } = await import('./productionPosture.js');

// Capture log lines without real I/O.
function fakeLog() {
  const calls = { warn: [], error: [], info: [] };
  return {
    log: {
      warn: (m) => calls.warn.push(m),
      error: (m) => calls.error.push(m),
      info: (m) => calls.info.push(m),
    },
    calls,
  };
}

const IDENTITY_KEYS = [
  'IDENTITY_SSO_ENABLED', 'IDENTITY_ISSUER', 'IDENTITY_CLIENT_ID', 'IDENTITY_CLIENT_SECRET',
  'IDENTITY_REDIRECT_URI', 'IDENTITY_REQUIRED_AMR', 'IDENTITY_BREAK_GLASS_USERS', 'IDENTITY_ROLE_MAP',
];
const STORAGE_KEYS = ['CLOUDINARY_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'ALLOW_LOCAL_UPLOADS'];
const CLUSTER_KEYS = ['POOL_WATCHDOG_CLUSTER', 'NODE_APP_INSTANCE', 'WEB_CONCURRENCY'];

beforeEach(() => {
  isProd = true;
  corsOrigin = 'https://app.example'; // non-wildcard by default; the G5 test opts in to '*'
  for (const k of [...IDENTITY_KEYS, ...STORAGE_KEYS, ...CLUSTER_KEYS, 'REDIS_URL']) delete process.env[k];
});
afterEach(() => {
  for (const k of [...IDENTITY_KEYS, ...STORAGE_KEYS, ...CLUSTER_KEYS, 'REDIS_URL']) delete process.env[k];
});

describe('inClusterMode', () => {
  it('detects the cluster signals', () => {
    expect(inClusterMode({})).toBe(false);
    expect(inClusterMode({ POOL_WATCHDOG_CLUSTER: '1' })).toBe(true);
    expect(inClusterMode({ NODE_APP_INSTANCE: '0' })).toBe(true);
    expect(inClusterMode({ WEB_CONCURRENCY: '3' })).toBe(true);
    expect(inClusterMode({ WEB_CONCURRENCY: '1' })).toBe(false);
  });
});

describe('checkProductionPosture', () => {
  it('flags storage (error), SSO-off (warn) and Redis (warn) on a bare production config', () => {
    const { log, calls } = fakeLog();
    const { errors, warnings } = checkProductionPosture({ log });

    expect(errors.join('\n')).toMatch(/STORAGE_NOT_DURABLE|no durable upload storage/);
    expect(warnings.join('\n')).toMatch(/SSO is OFF in production/);
    expect(warnings.join('\n')).toMatch(/REDIS_URL not set/);
    // logged at the matching levels
    expect(calls.error.length).toBeGreaterThan(0);
    expect(calls.warn.length).toBeGreaterThan(0);
  });

  it('escalates Redis to an error when multi-instance without REDIS_URL', () => {
    process.env.POOL_WATCHDOG_CLUSTER = '1';
    const { log } = fakeLog();
    const { errors } = checkProductionPosture({ log });
    expect(errors.join('\n')).toMatch(/multi-instance\/cluster WITHOUT REDIS_URL/);
  });

  it('warns when CORS_ORIGIN is "*" in production (G5)', () => {
    corsOrigin = '*';
    const { log, calls } = fakeLog();
    const { warnings } = checkProductionPosture({ log });
    expect(warnings.join('\n')).toMatch(/CORS_ORIGIN is "\*" in production/);
    expect(calls.warn.join('\n')).toMatch(/CORS_ORIGIN is "\*" in production/);
  });

  it('does not warn about CORS when an explicit origin allow-list is set', () => {
    corsOrigin = 'https://app.example,https://admin.example';
    const { log } = fakeLog();
    const { warnings } = checkProductionPosture({ log });
    expect(warnings.join('\n')).not.toMatch(/CORS_ORIGIN/);
  });

  it('does not warn about CORS "*" outside production', () => {
    isProd = false;
    corsOrigin = '*';
    const { log } = fakeLog();
    const { warnings } = checkProductionPosture({ log });
    expect(warnings.join('\n')).not.toMatch(/CORS_ORIGIN/);
  });

  it('treats ALLOW_LOCAL_UPLOADS as a warning, not an error', () => {
    process.env.ALLOW_LOCAL_UPLOADS = 'true';
    const { log } = fakeLog();
    const { errors, warnings } = checkProductionPosture({ log });
    expect(errors.join('\n')).not.toMatch(/upload storage/);
    expect(warnings.join('\n')).toMatch(/EPHEMERAL local disk/);
  });

  it('is clean when storage, Redis and SSO+MFA+break-glass are all configured', () => {
    process.env.CLOUDINARY_URL = 'cloudinary://k:s@cloud';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.IDENTITY_SSO_ENABLED = 'true';
    process.env.IDENTITY_ISSUER = 'https://idp.example/';
    process.env.IDENTITY_CLIENT_ID = 'client-123';
    process.env.IDENTITY_CLIENT_SECRET = 'shh';
    process.env.IDENTITY_REDIRECT_URI = 'https://app.example/api/auth/sso/callback';
    process.env.IDENTITY_REQUIRED_AMR = 'pwd,mfa';
    process.env.IDENTITY_BREAK_GLASS_USERS = 'root.admin';

    const { log, calls } = fakeLog();
    const { errors, warnings } = checkProductionPosture({ log });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(calls.info.join('\n')).toMatch(/posture checks passed/);
  });

  it('is tolerant outside production (no storage/redis/SSO posture noise)', () => {
    isProd = false;
    const { log } = fakeLog();
    const { errors, warnings } = checkProductionPosture({ log });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
