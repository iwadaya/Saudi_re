// server/src/config/identity.js unit tests (pure — no DB, no network).
//
// Covers the provider-agnostic IdP config skeleton: env parsing, claim→role
// mapping (always defaulting low-privilege), in-app ACR/AMR enforcement, the
// break-glass allowlist, and config validation (tolerant while SSO is off).

import { describe, it, expect } from 'vitest';
import {
  getIdentityConfig, isSsoEnabled, mapClaimsToRole, acrSatisfied,
  isBreakGlassUser, validateIdentityConfig, DEFAULT_LOW_PRIV_ROLE,
} from './identity.js';

// Build a config straight from an env-like object (the module reads process.env
// by default; passing envObj keeps these tests hermetic and parallel-safe).
const cfg = (env) => getIdentityConfig(env);

describe('getIdentityConfig — env parsing + safe defaults', () => {
  it('is tolerant by default (no env): SSO off, low-priv default role, empty maps', () => {
    const c = cfg({});
    expect(c.ssoEnabled).toBe(false);
    expect(c.defaultRole).toBe(DEFAULT_LOW_PRIV_ROLE);
    expect(c.roleClaim).toBe('groups');
    expect(c.roleMap).toEqual({});
    expect(c.requiredAcr).toEqual([]);
    expect(c.requiredAmr).toEqual([]);
    expect(c.breakGlassUsers).toEqual([]);
    expect(c.provider).toBeNull();
  });

  it('parses lists, JSON role map, and coerces booleans', () => {
    const c = cfg({
      IDENTITY_SSO_ENABLED: 'true',
      IDENTITY_PROVIDER: 'keycloak',
      IDENTITY_ISSUER: 'https://idp.example/realms/x',
      IDENTITY_CLIENT_ID: 'reins-tool',
      IDENTITY_ROLE_CLAIM: 'roles',
      IDENTITY_ROLE_MAP: '{"uw-chiefs":"CU","uw-directors":"TD"}',
      IDENTITY_REQUIRED_ACR: 'urn:mace:mfa, urn:other',
      IDENTITY_REQUIRED_AMR: 'mfa,pwd',
      IDENTITY_BREAK_GLASS_USERS: 'Root.Admin, OnCall',
    });
    expect(c.ssoEnabled).toBe(true);
    expect(c.provider).toBe('keycloak');
    expect(c.roleClaim).toBe('roles');
    expect(c.roleMap).toEqual({ 'uw-chiefs': 'CU', 'uw-directors': 'TD' });
    expect(c.requiredAcr).toEqual(['urn:mace:mfa', 'urn:other']);
    expect(c.requiredAmr).toEqual(['mfa', 'pwd']);
    expect(c.breakGlassUsers).toEqual(['root.admin', 'oncall']); // lowercased
  });

  it('falls back to the low-priv default for an invalid/unknown default role', () => {
    expect(cfg({ IDENTITY_DEFAULT_ROLE: 'GOD' }).defaultRole).toBe(DEFAULT_LOW_PRIV_ROLE);
    expect(cfg({ IDENTITY_DEFAULT_ROLE: 'cu' }).defaultRole).toBe('CU'); // valid, normalised
  });

  it('ignores malformed JSON in the role map (→ {})', () => {
    expect(cfg({ IDENTITY_ROLE_MAP: 'not json' }).roleMap).toEqual({});
    expect(cfg({ IDENTITY_ROLE_MAP: '["array","not","object"]' }).roleMap).toEqual({});
  });

  it('isSsoEnabled reflects the flag', () => {
    expect(isSsoEnabled(cfg({}))).toBe(false);
    expect(isSsoEnabled(cfg({ IDENTITY_SSO_ENABLED: 'yes' }))).toBe(true);
  });
});

describe('mapClaimsToRole — D3: default low-privilege, never silently elevate', () => {
  const c = cfg({ IDENTITY_ROLE_CLAIM: 'groups', IDENTITY_ROLE_MAP: '{"chiefs":"CU","mgrs":"TM"}' });

  it('returns the default role when claims are missing/empty/unknown', () => {
    expect(mapClaimsToRole(null, c)).toBe('TUW');
    expect(mapClaimsToRole({}, c)).toBe('TUW');
    expect(mapClaimsToRole({ groups: ['unmapped-group'] }, c)).toBe('TUW');
  });

  it('maps a single claim value and an array of groups', () => {
    expect(mapClaimsToRole({ groups: 'chiefs' }, c)).toBe('CU');
    expect(mapClaimsToRole({ groups: ['mgrs'] }, c)).toBe('TM');
  });

  it('picks the MOST-privileged role when several groups map', () => {
    expect(mapClaimsToRole({ groups: ['mgrs', 'chiefs'] }, c)).toBe('CU'); // CU(2) beats TM(4)
  });

  it('honours a configured non-default role claim name', () => {
    const c2 = cfg({ IDENTITY_ROLE_CLAIM: 'realm_roles', IDENTITY_ROLE_MAP: '{"x":"TD"}' });
    expect(mapClaimsToRole({ realm_roles: ['x'] }, c2)).toBe('TD');
    expect(mapClaimsToRole({ groups: ['x'] }, c2)).toBe('TUW'); // wrong claim name → default
  });

  it('ignores a role-map value that is not a real role code', () => {
    const bad = cfg({ IDENTITY_ROLE_MAP: '{"g":"SUPERADMIN"}' });
    expect(mapClaimsToRole({ groups: ['g'] }, bad)).toBe('TUW');
  });
});

describe('acrSatisfied — D2: enforce assurance in-app', () => {
  it('is satisfied when nothing is required (tolerant)', () => {
    expect(acrSatisfied({ acr: 'anything' }, cfg({})).ok).toBe(true);
  });

  it('requires the acr to be one of the configured values', () => {
    const c = cfg({ IDENTITY_REQUIRED_ACR: 'mfa-strong' });
    expect(acrSatisfied({ acr: 'mfa-strong' }, c).ok).toBe(true);
    const miss = acrSatisfied({ acr: 'pwd-only' }, c);
    expect(miss.ok).toBe(false);
    expect(miss.reasons[0]).toMatch(/acr/);
  });

  it('requires every configured amr method to be present', () => {
    const c = cfg({ IDENTITY_REQUIRED_AMR: 'pwd,mfa' });
    expect(acrSatisfied({ amr: ['pwd', 'mfa', 'extra'] }, c).ok).toBe(true);
    const miss = acrSatisfied({ amr: ['pwd'] }, c);
    expect(miss.ok).toBe(false);
    expect(miss.reasons.join(' ')).toMatch(/amr.*mfa/);
  });

  it('a missing acr/amr fails when requirements are set', () => {
    const c = cfg({ IDENTITY_REQUIRED_ACR: 'mfa', IDENTITY_REQUIRED_AMR: 'mfa' });
    const r = acrSatisfied({}, c);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

describe('isBreakGlassUser — D4 allowlist (case-insensitive)', () => {
  const c = cfg({ IDENTITY_BREAK_GLASS_USERS: 'Root.Admin, oncall' });
  it('matches configured usernames regardless of case/space', () => {
    expect(isBreakGlassUser('root.admin', c)).toBe(true);
    expect(isBreakGlassUser('  OnCall ', c)).toBe(true);
  });
  it('rejects everyone else and falsy input', () => {
    expect(isBreakGlassUser('ada.lovelace', c)).toBe(false);
    expect(isBreakGlassUser('', c)).toBe(false);
    expect(isBreakGlassUser(null, c)).toBe(false);
  });
});

describe('validateIdentityConfig — tolerant off, strict on', () => {
  it('off + clean → no errors, no warnings', () => {
    expect(validateIdentityConfig(cfg({}))).toEqual({ errors: [], warnings: [] });
  });

  it('flags a bad role-map value even while SSO is off (config bug regardless)', () => {
    const { errors } = validateIdentityConfig(cfg({ IDENTITY_ROLE_MAP: '{"g":"NOPE"}' }));
    expect(errors.join(' ')).toMatch(/not a valid role code/);
  });

  it('SSO on without issuer/clientId → errors', () => {
    const { errors } = validateIdentityConfig(cfg({ IDENTITY_SSO_ENABLED: 'true' }));
    expect(errors.join(' ')).toMatch(/IDENTITY_ISSUER/);
    expect(errors.join(' ')).toMatch(/IDENTITY_CLIENT_ID/);
  });

  it('SSO on with no MFA + no break-glass → warnings (D2/D4)', () => {
    const { warnings } = validateIdentityConfig(cfg({
      IDENTITY_SSO_ENABLED: 'true', IDENTITY_ISSUER: 'i', IDENTITY_CLIENT_ID: 'c',
    }));
    expect(warnings.join(' ')).toMatch(/MFA would not be enforced/);
    expect(warnings.join(' ')).toMatch(/break-glass/);
  });

  it('warns when the default provisioning role is above lowest privilege', () => {
    const { warnings } = validateIdentityConfig(cfg({ IDENTITY_DEFAULT_ROLE: 'CU' }));
    expect(warnings.join(' ')).toMatch(/over-provisioned/);
  });
});
