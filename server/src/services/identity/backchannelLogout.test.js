// Back-channel logout_token validation unit tests.
// Signs real RS256 tokens with jose and verifies against an injected local JWKS,
// so no network/discovery is needed.

import { describe, it, expect, beforeAll } from 'vitest';
import * as jose from 'jose';
import { validateLogoutToken } from './backchannelLogout.js';

const EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const cfg = { issuer: 'https://idp.example', clientId: 'client-x' };

let privateKey;
let jwks;

beforeAll(async () => {
  const kp = await jose.generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const pub = await jose.exportJWK(kp.publicKey);
  pub.kid = 'test-key';
  pub.alg = 'RS256';
  jwks = jose.createLocalJWKSet({ keys: [pub] });
});

// Build a logout_token with overridable claims/header.
async function mint(claims = {}, { issuer = cfg.issuer, audience = cfg.clientId } = {}) {
  const base = { events: { [EVENT]: {} }, ...claims };
  const jwt = new jose.SignJWT(base)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setJti('jti-1');
  if (claims.sub !== null) jwt.setSubject(claims.sub || 'user-1');
  return jwt.sign(privateKey);
}

describe('validateLogoutToken', () => {
  it('accepts a valid token and returns { sub, sid }', async () => {
    const token = await mint({ sub: 'user-1', sid: 'sess-9' });
    await expect(validateLogoutToken(token, cfg, { jwks })).resolves.toEqual({ sub: 'user-1', sid: 'sess-9' });
  });

  it('accepts sid-only (no sub)', async () => {
    const token = await mint({ sub: null, sid: 'sess-9' });
    await expect(validateLogoutToken(token, cfg, { jwks })).resolves.toEqual({ sub: null, sid: 'sess-9' });
  });

  it('rejects a token missing the back-channel logout event', async () => {
    const jwt = await new jose.SignJWT({ sid: 'sess-9' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(cfg.issuer).setAudience(cfg.clientId).setIssuedAt().setSubject('user-1')
      .sign(privateKey);
    await expect(validateLogoutToken(jwt, cfg, { jwks })).rejects.toThrow(/back-channel logout event/);
  });

  it('rejects a token carrying a nonce (an ID token replay)', async () => {
    const token = await mint({ sub: 'user-1', sid: 'sess-9', nonce: 'n-123' });
    await expect(validateLogoutToken(token, cfg, { jwks })).rejects.toThrow(/nonce/);
  });

  it('rejects a token with neither sub nor sid', async () => {
    const jwt = await new jose.SignJWT({ events: { [EVENT]: {} } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(cfg.issuer).setAudience(cfg.clientId).setIssuedAt()
      .sign(privateKey);
    await expect(validateLogoutToken(jwt, cfg, { jwks })).rejects.toThrow(/sub and\/or sid/);
  });

  it('rejects a wrong audience (different client)', async () => {
    const token = await mint({ sub: 'user-1', sid: 'sess-9' }, { audience: 'someone-else' });
    await expect(validateLogoutToken(token, cfg, { jwks })).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    const token = await mint({ sub: 'user-1', sid: 'sess-9' }, { issuer: 'https://evil.example' });
    await expect(validateLogoutToken(token, cfg, { jwks })).rejects.toThrow();
  });

  it('rejects empty input', async () => {
    await expect(validateLogoutToken('', cfg, { jwks })).rejects.toThrow(/required/);
  });
});
