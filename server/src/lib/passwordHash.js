// server/src/lib/passwordHash.js
//
// Password hashing with the Node stdlib (no new dependency). Two things matter
// for the production login path:
//
//   1. NON-BLOCKING. The old helpers used `scryptSync`, which pins the single
//      Node event loop for the whole derivation (tens of ms at the default cost,
//      more once the cost is raised). Under concurrent logins that serialises
//      every other request behind the hash. We use the async `crypto.scrypt`
//      so the derivation runs on libuv's threadpool and the event loop stays
//      free to serve other traffic.
//
//   2. CALIBRATED, TUNABLE COST. scrypt's CPU/memory work factor is N (must be a
//      power of two). Node's `scryptSync` default is N=2^14 (16384). We raise the
//      default to 2^15 and expose PASSWORD_SCRYPT_COST (the log2 of N) so the
//      cost can be re-calibrated as hardware improves without a code change.
//
// Stored format (new):   scrypt$<log2N>$<r>$<p>$<saltHex>$<hashHex>
// Stored format (legacy): scrypt$<saltHex>$<hashHex>   (== log2N=14, r=8, p=1)
//
// verifyPassword reads BOTH formats, so existing rows keep working and there is
// no migration. needsRehash() lets the login path opportunistically upgrade a
// legacy/under-cost hash to the current policy on a successful sign-in.
//
// (Argon2id is the other modern option the P1 note mentions; it would mean a
// native add-on dependency. Async scrypt gives the same "don't block the loop"
// win with zero supply-chain surface, which is the higher-priority concern for
// this rollout — see SECURITY.md.)

import { scrypt as _scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

// r and p stay at the Node/scrypt defaults; N (via log2) is the tunable knob.
const R = 8;
const P = 1;
const KEYLEN = 64;

// Default work factor: N = 2^15 = 32768 (one step above Node's scryptSync
// default of 2^14). Clamped to a sane range so a typo in the env var can't make
// the login path either trivially weak or so heavy it DoSes itself.
export const DEFAULT_LOG2_N = 15;
const MIN_LOG2_N = 14; // never weaker than the historical scryptSync default
const MAX_LOG2_N = 20; // N=2^20 ≈ 1GiB working memory — guard rail

// scrypt needs 128 * N * r bytes of working memory and rejects the call unless
// `maxmem` is strictly larger. Give 2× headroom and never drop below Node's
// 32 MiB default.
function maxmemFor(N, r) {
  return Math.max(32 * 1024 * 1024, 128 * N * r * 2);
}

/** Resolve the configured work factor (log2 of N) from the environment. */
export function configuredLog2N() {
  const raw = parseInt(process.env.PASSWORD_SCRYPT_COST ?? '', 10);
  const log2n = Number.isInteger(raw) ? raw : DEFAULT_LOG2_N;
  return Math.min(MAX_LOG2_N, Math.max(MIN_LOG2_N, log2n));
}

function currentParams() {
  const log2n = configuredLog2N();
  const N = 2 ** log2n;
  return { log2n, N, r: R, p: P, maxmem: maxmemFor(N, R) };
}

// Parse a stored value into the params + salt + expected hash needed to verify.
// Returns null for anything that isn't one of our two scrypt formats so a demo
// sentinel / SSO no-password sentinel / garbage can never authenticate.
function parseStored(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return null;
  const parts = stored.split('$');
  if (parts.length === 6) {
    const [, log2nStr, rStr, pStr, salt, hashHex] = parts;
    const log2n = Number(log2nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(log2n) || log2n < 1 || log2n > 24) return null;
    if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
    if (!salt || !hashHex) return null;
    const N = 2 ** log2n;
    return { log2n, salt, hashHex, params: { N, r, p, maxmem: maxmemFor(N, r) } };
  }
  if (parts.length === 3) {
    // Legacy scryptSync(plain, saltHex, 64): N=16384 (2^14), r=8, p=1.
    const [, salt, hashHex] = parts;
    if (!salt || !hashHex) return null;
    const N = 2 ** 14;
    return { log2n: 14, salt, hashHex, params: { N, r: 8, p: 1, maxmem: maxmemFor(N, 8) } };
  }
  return null;
}

// Both formats use the salt's hex STRING (not the decoded bytes) as the scrypt
// salt — preserving exact compatibility with the original scryptSync(plain,
// saltHex, 64) so legacy hashes still verify. Security is unaffected: the salt
// is still 16 random bytes of entropy, just fed as its hex encoding.
async function deriveKey(plain, saltStr, params) {
  return scrypt(String(plain), saltStr, KEYLEN, params);
}

/**
 * Hash a plaintext password at the current (configured) cost. Async — runs the
 * derivation off the event loop.
 * @param {string} plain
 * @returns {Promise<string>} scrypt$<log2N>$<r>$<p>$<saltHex>$<hashHex>
 */
export async function hashPassword(plain) {
  const { log2n, r, p, N, maxmem } = currentParams();
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(plain, salt, { N, r, p, maxmem });
  return `scrypt$${log2n}$${r}$${p}$${salt}$${key.toString('hex')}`;
}

/**
 * Constant-time verify of a plaintext against a stored hash. Accepts both the
 * new and legacy formats; returns false (never throws) for any non-scrypt or
 * malformed stored value.
 * @param {string} plain
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  let actual;
  try {
    actual = await deriveKey(plain, parsed.salt, parsed.params);
  } catch {
    return false; // bad params / maxmem — treat as a non-match, never a 500
  }
  const expected = Buffer.from(parsed.hashHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * True when a (valid, currently-verifying) stored hash is below the current
 * cost policy and should be re-hashed on the next successful login. Returns
 * false for anything unparseable so callers never rehash garbage.
 * @param {string} stored
 * @returns {boolean}
 */
export function needsRehash(stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  return parsed.log2n < configuredLog2N();
}
