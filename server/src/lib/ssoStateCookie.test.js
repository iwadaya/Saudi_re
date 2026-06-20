// SSO state-cookie sign/verify unit tests.

import { describe, it, expect } from 'vitest';
import { signSsoState, verifySsoState } from './ssoStateCookie.js';

describe('ssoStateCookie', () => {
  const tx = { state: 'st-123', nonce: 'no-456', codeVerifier: 'cv-789', returnTo: '/quotes' };

  it('round-trips the flow secrets', () => {
    const decoded = verifySsoState(signSsoState(tx));
    expect(decoded).toMatchObject(tx);
  });

  it('rejects a tampered payload', () => {
    const token = signSsoState(tx);
    const [body] = token.split('.');
    expect(verifySsoState(`${body}.deadbeef`)).toBeNull();
  });

  it('rejects malformed / empty tokens', () => {
    expect(verifySsoState('')).toBeNull();
    expect(verifySsoState('no-dot')).toBeNull();
    expect(verifySsoState(null)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = signSsoState(tx, -1); // already past
    expect(verifySsoState(expired)).toBeNull();
  });

  it('requires state + codeVerifier to be present', () => {
    const partial = signSsoState({ state: '', nonce: 'n', codeVerifier: 'c' });
    expect(verifySsoState(partial)).toBeNull();
  });
});
