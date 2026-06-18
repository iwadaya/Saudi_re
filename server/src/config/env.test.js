// Secret-config validation: production refuses to boot without a strong
// AUTH_JWT_SECRET; dev/test mints an ephemeral one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSecretsConfig, validateEnv, INSECURE_SECRET_PLACEHOLDER } from './env.js';

const STRONG = 'x'.repeat(40);

describe('checkSecretsConfig', () => {
  it('production: missing AUTH_JWT_SECRET is an error', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: '', sessionSecret: '' }))
      .toEqual([expect.stringMatching(/AUTH_JWT_SECRET is required/)]);
  });
  it('production: the insecure dev literal is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: INSECURE_SECRET_PLACEHOLDER, sessionSecret: '' }))
      .toEqual([expect.stringMatching(/must not be the insecure/)]);
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
  it('production: ALLOW_DEMO_AUTH=true is rejected', () => {
    expect(checkSecretsConfig({ nodeEnv: 'production', authJwtSecret: STRONG, sessionSecret: '', allowDemoAuth: 'true' }))
      .toEqual([expect.stringMatching(/ALLOW_DEMO_AUTH must not be true/)]);
  });
  it('development: nothing is required', () => {
    expect(checkSecretsConfig({ nodeEnv: 'development', authJwtSecret: '', sessionSecret: '', allowDemoAuth: 'true' })).toEqual([]);
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
    delete process.env.ALLOW_DEMO_AUTH;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) in production when demo auth is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_JWT_SECRET = STRONG;
    process.env.ALLOW_DEMO_AUTH = 'true';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    expect(() => validateEnv()).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
