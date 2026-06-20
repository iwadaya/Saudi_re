# P1-identity — Phase 0c: IdP abstraction config & break-glass plumbing

Phase 0c lands the **configuration skeleton** that the SSO work (Phase 1) plugs
into. It commits to **no provider** and makes **no network call** — it only reads
and validates the configuration any OIDC integration will need, and wires a
**tolerant** login-posture gate that is inert until SSO is switched on.

Everything here is driven by **reviewable configuration**, not code, so claim→role
mappings and MFA requirements can be audited and changed without a deploy of
application logic.

## Modules

| File | Responsibility |
| --- | --- |
| `server/src/config/identity.js` | Provider-agnostic config reader + pure helpers (claim→role mapping, ACR/AMR check, break-glass allowlist, validation). |
| `server/src/services/securityAlerts.js` | Single seam (`emitSecurityAlert`) for out-of-band security signals; today a matchable high-severity log line, later a webhook/pager. |
| `server/src/routes/auth.js` (login) | SSO-posture gate — tolerant while SSO off; once on, local password login is allowed only for a break-glass admin (audited + alerted). |
| `server/src/app.js` (boot) | Logs identity config errors/warnings at startup (never throws). |

## Environment configuration

All keys are read from `process.env` on every call (not snapshotted), so changes
take effect without a process restart and tests stay hermetic.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IDENTITY_SSO_ENABLED` | `false` | Master switch. While `false`, the whole gate is a pass-through and local password login is unchanged. |
| `IDENTITY_PROVIDER` | _(none)_ | Free-text label only (e.g. `keycloak`, `entra`). **No provider is committed or wired in Phase 0c.** |
| `IDENTITY_ISSUER` | _(none)_ | OIDC issuer URL. Required (error) when SSO is enabled. |
| `IDENTITY_CLIENT_ID` | _(none)_ | OIDC client id. Required (error) when SSO is enabled. |
| `IDENTITY_ROLE_CLAIM` | `groups` | Name of the token claim carrying group/role membership. |
| `IDENTITY_ROLE_MAP` | `{}` | JSON object mapping claim values → internal role codes, e.g. `{"uw-chiefs":"CU"}`. Invalid role codes are a config **error**. |
| `IDENTITY_DEFAULT_ROLE` | `TUW` | Role new SSO users are provisioned into (D3). Setting it above lowest-privilege is a **warning**. |
| `IDENTITY_REQUIRED_ACR` | _(none)_ | Comma list of acceptable `acr` values. Enforced **in-app** (D2). |
| `IDENTITY_REQUIRED_AMR` | _(none)_ | Comma list of `amr` methods that must ALL be present (e.g. `pwd,mfa`). Enforced in-app (D2). |
| `IDENTITY_BREAK_GLASS_USERS` | _(none)_ | Comma list of usernames (case-insensitive) allowed to use local password login while SSO is the default path (D4). |

## Behaviour & decisions

- **D2 — MFA enforced in-app.** `acrSatisfied(claims)` checks the token's `acr`/`amr`
  against the configured requirements rather than trusting the IdP's own policy.
  No requirements configured → satisfied (tolerant). _Wired here; consumed by the
  OIDC callback in Phase 1._
- **D3 — provision low-privilege by default.** `mapClaimsToRole(claims)` returns the
  **most-privileged mapped** role found in the claim, or the low-privilege default
  when nothing matches. A missing/unknown claim can only ever yield the default —
  it can never silently elevate. The mapping is configuration.
- **D4 — SSO default + audited break-glass.** Once `IDENTITY_SSO_ENABLED=true`,
  the login route accepts a local password **only** for a configured break-glass
  username; that login writes a `BREAK_GLASS_LOGIN` audit row **and** raises a
  `emitSecurityAlert('BREAK_GLASS_LOGIN', …)`. Everyone else gets `403 SSO_REQUIRED`
  (audited `LOCAL_LOGIN_BLOCKED`). The gate runs **after** the password check so the
  posture is never disclosed to an unauthenticated guesser, and the break-glass
  audit/alert are best-effort so they can never block an emergency login.

## Tolerance / rollout

With no `IDENTITY_*` variables set (the default), Phase 0c changes **nothing**:
SSO is off, the login gate is a pass-through, and `validateIdentityConfig()`
reports clean. The startup validator logs errors/warnings but never throws, so a
misconfigured SSO posture is visible to operators without taking the API down.

## Not in Phase 0c (Phase 1)

- The actual OIDC flow (discovery, auth-code+PKCE, token validation, JWKS).
- Back-channel / front-channel logout matching on `idp_sid` (columns already exist
  from Phase 0a migration 127).
- JIT provisioning that calls `mapClaimsToRole` + `acrSatisfied` on the callback.
- Provider selection (D6 — blocked on buyer confirmation; Keycloak in dev).
