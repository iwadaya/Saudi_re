// Secret-config validation: production refuses to boot without a strong
// AUTH_JWT_SECRET; dev/test mints an ephemeral one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSecretsConfig, checkDemoAuthConfig, checkNameAuthConfig, checkLoadTestConfig, checkMfaEnforcementConfig, validateEnv, INSECURE_SECRET_PLACEHOLDER } from './env.js';

const STRONG = 'x'.repeat(40);

describe('checkSecretsConfig', () => {
  it('production: missing AUTH_JWT_SECRET is an error', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: '', sessionSecret: '' }))
      .toEqual([expect.stringMatching(/AUTH_JWT_SECRET is required/)]);
  });
  it('production: the insecure dev literal is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: INSECURE_SECRET_PLACEHOLDER, sessionSecret: '' }))
      .toEqual([expect.stringMatching(/must not be a placeholder/)]);
  });
  it('production: the CHANGE_ME .env.example placeholder is rejected (even though it is >32 chars)', () => {
    const placeholder = 'CHANGE_ME_RUN_NODE_RANDOMBYTES_48_BASE64URL';
    expect(placeholder.length).toBeGreaterThan(32); // would pass the length check
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: placeholder, sessionSecret: '' }))
      .toEqual([expect.stringMatching(/must not be a placeholder/)]);
  });
  it('production: a CHANGE_ME SESSION_SECRET is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: STRONG, sessionSecret: 'CHANGE_ME_RUN_NODE_RANDOMBYTES_48_BASE64URL' }))
      .toEqual([expect.stringMatching(/SESSION_SECRET must not be a placeholder/)]);
  });
  it('production: a short secret (<32) is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: 'short', sessionSecret: '' }))
      .toEqual([expect.stringMatching(/at least 32/)]);
  });
  it('production: a strong secret with no session secret is OK', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: STRONG, sessionSecret: '' })).toEqual([]);
  });
  it('production: a configured-but-weak SESSION_SECRET is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: STRONG, sessionSecret: 'short' }))
      .toEqual([expect.stringMatching(/SESSION_SECRET must be at least/)]);
  });
  it('development: nothing is required', () => {
    expect(checkSecretsConfig({ nodeEnv: 'development', authJwtSecret: '', sessionSecret: '' })).toEqual([]);
  });
});

describe('checkDemoAuthConfig (A6 — demo-auth fenced from production)', () => {
  it('production + ALLOW_DEMO_AUTH=true is an error', () => {
    expect(checkDemoAuthConfig({ nodeEnv: 'production', allowDemoAuth: 'true' }))
      .toEqual([expect.stringMatching(/ALLOW_DEMO_AUTH must not be enabled in production/)]);
  });
  it('production accepts other truthy forms (1/yes/on) as enabled', () => {
    for (const v of ['1', 'yes', 'on']) {
      expect(checkDemoAuthConfig({ nodeEnv: 'production', allowDemoAuth: v })).toHaveLength(1);
    }
  });
  it('production without ALLOW_DEMO_AUTH (unset / false) is OK', () => {
    expect(checkDemoAuthConfig({ nodeEnv: 'production', allowDemoAuth: undefined })).toEqual([]);
    expect(checkDemoAuthConfig({ nodeEnv: 'production', allowDemoAuth: 'false' })).toEqual([]);
  });
  it('development with ALLOW_DEMO_AUTH=true is fine (dev/test convenience)', () => {
    expect(checkDemoAuthConfig({ nodeEnv: 'development', allowDemoAuth: 'true' })).toEqual([]);
  });
});

describe('checkNameAuthConfig (passwordless name-login fenced from production)', () => {
  it('production + ALLOW_NAME_AUTH=true is an error', () => {
    expect(checkNameAuthConfig({ nodeEnv: 'production', allowNameAuth: 'true' }))
      .toEqual([expect.stringMatching(/ALLOW_NAME_AUTH must not be enabled in production/)]);
  });
  it('production accepts other truthy forms (1/yes/on) as enabled', () => {
    for (const v of ['1', 'yes', 'on']) {
      expect(checkNameAuthConfig({ nodeEnv: 'production', allowNameAuth: v })).toHaveLength(1);
    }
  });
  it('production without ALLOW_NAME_AUTH (unset / false) is OK', () => {
    expect(checkNameAuthConfig({ nodeEnv: 'production', allowNameAuth: undefined })).toEqual([]);
    expect(checkNameAuthConfig({ nodeEnv: 'production', allowNameAuth: 'false' })).toEqual([]);
  });
  it('development with ALLOW_NAME_AUTH=true is fine (pilot convenience)', () => {
    expect(checkNameAuthConfig({ nodeEnv: 'development', allowNameAuth: 'true' })).toEqual([]);
  });
});

describe('checkLoadTestConfig (rate-limit bypass fenced from production)', () => {
  it('production + LOAD_TEST=true is an error', () => {
    expect(checkLoadTestConfig({ nodeEnv: 'production', loadTest: 'true' }))
      .toEqual([expect.stringMatching(/LOAD_TEST must not be enabled in production/)]);
  });
  it('production without LOAD_TEST (unset / false) is OK', () => {
    expect(checkLoadTestConfig({ nodeEnv: 'production', loadTest: undefined })).toEqual([]);
    expect(checkLoadTestConfig({ nodeEnv: 'production', loadTest: 'false' })).toEqual([]);
  });
  it('development with LOAD_TEST=true is fine (benchmarking convenience)', () => {
    expect(checkLoadTestConfig({ nodeEnv: 'development', loadTest: 'true' })).toEqual([]);
  });
});

describe('checkMfaEnforcementConfig (fail-closed MFA, opt-in)', () => {
  it('unset IDENTITY_ENFORCE_MFA is a no-op regardless of the rest', () => {
    expect(checkMfaEnforcementConfig({ enforceMfa: undefined, ssoEnabled: 'false' })).toEqual([]);
    expect(checkMfaEnforcementConfig({ enforceMfa: 'false', ssoEnabled: 'true', requiredAcr: '', requiredAmr: '' })).toEqual([]);
  });
  it('enforce + SSO off → error (nothing carries the assurance claims)', () => {
    expect(checkMfaEnforcementConfig({ enforceMfa: '1', ssoEnabled: 'false' }))
      .toEqual([expect.stringMatching(/IDENTITY_SSO_ENABLED is off/)]);
  });
  it('enforce + SSO on + no acr/amr → error (in-app check is a no-op)', () => {
    expect(checkMfaEnforcementConfig({ enforceMfa: '1', ssoEnabled: 'true', requiredAcr: '', requiredAmr: '' }))
      .toEqual([expect.stringMatching(/neither IDENTITY_REQUIRED_ACR nor IDENTITY_REQUIRED_AMR/)]);
  });
  it('enforce + SSO on + acr OR amr set → OK', () => {
    expect(checkMfaEnforcementConfig({ enforceMfa: '1', ssoEnabled: 'true', requiredAcr: 'urn:mfa', requiredAmr: '' })).toEqual([]);
    expect(checkMfaEnforcementConfig({ enforceMfa: '1', ssoEnabled: 'true', requiredAcr: '', requiredAmr: 'mfa' })).toEqual([]);
  });
});

describe('validateEnv (fail-fast)', () => {
  const orig = { NODE_ENV: process.env.NODE_ENV, AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET, SESSION_SECRET: process.env.SESSION_SECRET, ALLOW_DEMO_AUTH: process.env.ALLOW_DEMO_AUTH };
  afterEach(() => {
    process.env.NODE_ENV = orig.NODE_ENV;
    if (orig.AUTH_JWT_SECRET === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = orig.AUTH_JWT_SECRET;
    if (orig.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = orig.SESSION_SECRET;
    if (orig.ALLOW_DEMO_AUTH === undefined) delete process.env.ALLOW_DEMO_AUTH; else process.env.ALLOW_DEMO_AUTH = orig.ALLOW_DEMO_AUTH;
    vi.restoreAllMocks();
  });

  it('exits(1) in production with no AUTH_JWT_SECRET', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_JWT_SECRET;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('exits(1) in production with the insecure dev literal', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_JWT_SECRET = INSECURE_SECRET_PLACEHOLDER;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit with a strong secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_JWT_SECRET = STRONG;
    delete process.env.ALLOW_DEMO_AUTH; // isolate the secret check (test env defaults it on)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) in production when ALLOW_DEMO_AUTH is enabled, even with a strong secret (A6)', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_JWT_SECRET = STRONG; // secrets are fine…
    process.env.ALLOW_DEMO_AUTH = 'true'; // …but the demo backdoor is fatal in prod
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join('\n')).toMatch(/ALLOW_DEMO_AUTH must not be enabled in production/);
  });

  it('does NOT exit in development with ALLOW_DEMO_AUTH=true (dev/test convenience)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_DEMO_AUTH = 'true';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) in production when ALLOW_NAME_AUTH is enabled, even with a strong secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_JWT_SECRET = STRONG;
    delete process.env.ALLOW_DEMO_AUTH; // isolate the name-auth fence
    process.env.ALLOW_NAME_AUTH = 'true';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join('\n')).toMatch(/ALLOW_NAME_AUTH must not be enabled in production/);
    delete process.env.ALLOW_NAME_AUTH;
  });
});

// The AI gate's default posture: ON in every environment, production included,
// so the AI features work without per-environment setup. Enabling AI sends
// treaty/document content to an external provider — closing the gate is an
// explicit AI_FEATURES_ENABLED=false (see lib/aiGovernance.js).
describe('aiFeaturesEnabled default (AI gate posture)', () => {
  const ORIGINAL = { ...process.env };

  async function loadEnv({ nodeEnv, flag }) {
    vi.resetModules();
    process.env.NODE_ENV = nodeEnv;
    if (flag === undefined) delete process.env.AI_FEATURES_ENABLED;
    else process.env.AI_FEATURES_ENABLED = flag;
    const mod = await import('./env.js');
    return mod.env;
  }

  afterEach(() => { process.env = { ...ORIGINAL }; });

  it.each(['development', 'test', 'production'])('%s defaults to ON', async (nodeEnv) => {
    expect((await loadEnv({ nodeEnv })).aiFeaturesEnabled).toBe(true);
  });

  it('an explicit AI_FEATURES_ENABLED=false closes the gate, production included', async () => {
    expect((await loadEnv({ nodeEnv: 'development', flag: 'false' })).aiFeaturesEnabled).toBe(false);
    expect((await loadEnv({ nodeEnv: 'production', flag: 'false' })).aiFeaturesEnabled).toBe(false);
  });
});
