import { describe, it, expect, afterEach } from 'vitest';
import { scryptSync } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  configuredLog2N,
  DEFAULT_LOG2_N,
} from './passwordHash.js';

afterEach(() => {
  delete process.env.PASSWORD_SCRYPT_COST;
});

describe('hashPassword / verifyPassword (async scrypt)', () => {
  it('returns a promise (does not block) and produces the parameterised format', async () => {
    const p = hashPassword('correcthorse12');
    expect(typeof p.then).toBe('function'); // thenable → async, off the event loop
    const stored = await p;
    // scrypt$<log2N>$<r>$<p>$<saltHex>$<hashHex>
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(stored.split('$')[1]).toBe(String(DEFAULT_LOG2_N));
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('s3cret-passphrase', stored)).toBe(true);
    expect(await verifyPassword('s3cret-passphras3', stored)).toBe(false);
  });

  it('uses a fresh random salt each call (same password → different hash)', async () => {
    const a = await hashPassword('samePassword99');
    const b = await hashPassword('samePassword99');
    expect(a).not.toBe(b);
    expect(await verifyPassword('samePassword99', a)).toBe(true);
    expect(await verifyPassword('samePassword99', b)).toBe(true);
  });

  it('rejects non-scrypt, malformed and nullish stored values without throwing', async () => {
    expect(await verifyPassword('x', 'DEMO_HASH_2026')).toBe(false);
    expect(await verifyPassword('x', 'sso$no-local-password')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$only')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3$4')).toBe(false); // wrong field count
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', 42)).toBe(false);
  });
});

describe('legacy compatibility (scrypt$salt$hash, N=2^14)', () => {
  it('verifies a hash produced by the old scryptSync(plain, saltHex, 64)', async () => {
    const salt = 'deadbeefdeadbeefdeadbeefdeadbeef'; // 32 hex chars (16 bytes)
    const legacy = `scrypt$${salt}$${scryptSync('legacy-pass-123', salt, 64).toString('hex')}`;
    expect(await verifyPassword('legacy-pass-123', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });
});

describe('configuredLog2N (cost calibration knob)', () => {
  it('defaults to DEFAULT_LOG2_N when unset', () => {
    delete process.env.PASSWORD_SCRYPT_COST;
    expect(configuredLog2N()).toBe(DEFAULT_LOG2_N);
  });

  it('honours a valid override', () => {
    process.env.PASSWORD_SCRYPT_COST = '16';
    expect(configuredLog2N()).toBe(16);
  });

  it('clamps absurd values into the safe range (14..20)', () => {
    process.env.PASSWORD_SCRYPT_COST = '2';
    expect(configuredLog2N()).toBe(14);
    process.env.PASSWORD_SCRYPT_COST = '99';
    expect(configuredLog2N()).toBe(20);
    process.env.PASSWORD_SCRYPT_COST = 'not-a-number';
    expect(configuredLog2N()).toBe(DEFAULT_LOG2_N);
  });
});

describe('needsRehash (opportunistic cost upgrade)', () => {
  it('flags a legacy/under-cost hash for upgrade under the current policy', async () => {
    process.env.PASSWORD_SCRYPT_COST = '15';
    const salt = 'a'.repeat(32);
    const legacy = `scrypt$${salt}$${scryptSync('p', salt, 64).toString('hex')}`; // log2N=14
    expect(needsRehash(legacy)).toBe(true);
  });

  it('does not flag a hash already at the current cost', async () => {
    process.env.PASSWORD_SCRYPT_COST = '15';
    const fresh = await hashPassword('p'); // hashed at 15
    expect(needsRehash(fresh)).toBe(false);
  });

  it('never flags an unparseable value', () => {
    expect(needsRehash('DEMO_HASH_2026')).toBe(false);
    expect(needsRehash(null)).toBe(false);
  });
});
