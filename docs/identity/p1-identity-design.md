# P1-identity — SSO + Session Revocation + Identity Hardening — Design & Integration-Point Map

> **Status: DESIGN FOR REVIEW — no code changes yet.** This document maps the
> current identity machinery, proposes a design for each P1-identity requirement,
> and lists every integration point (file + change). Decisions that need your
> sign-off are collected at the end. Nothing here is implemented.

## 0. Scope (the ask)

1. **OIDC/SAML SSO** with **MFA enforced at the IdP**.
2. **Server-side session/token revocation.**
3. **Invalidate sessions** on: logout, password change, role change, deactivation.
4. **Audit user-admin changes** (role change, deactivation, etc.) as **critical** events.
5. **Open registration fail-closed** outside an explicit dev flag.

The single keystone is **(2) server-side revocation** — (1), (3) and most of the
value of (4) depend on it. The plan below is phased so revocation lands first and
SSO builds on top.

---

## 1. Current state (verified by recon)

| Concern | Today | Gap vs ask |
|---|---|---|
| Token | Custom HMAC `payload.sig`, claims `{sub,iat,exp}`, 8h TTL, signed with `AUTH_JWT_SECRET` (`server/src/lib/authToken.js`) | No `sid`/`jti`; not revocable |
| Identity per request | `authenticate()` verifies cookie token → `loadUserFromDb()` re-reads `v_user_mandate WHERE is_active=true` (`server/src/middleware/requestContext.js`) | No session-liveness check |
| Session store | **None** — pure stateless | Must add |
| Logout | `clearAuthCookies()` only (`routes/auth.js`) | No server-side revoke |
| Password change | Updates hash, **token stays valid** (explicit TODO to "bump a token version") | No revoke |
| Role change / deactivate | `PATCH /auth/users/:id` mutates `role_id`/`is_active`; takes effect next request via the `is_active` view filter; **token not revoked**, **no audit** | No revoke, no audit |
| User-admin audit | `USER_CREATED`, `PASSWORD_CHANGED`, `LOGIN`, `MANDATE_UPDATED` (non-critical) audited; **role change, deactivation, lock NOT audited** | Add critical events |
| Open registration | `openRegistrationEnabled()` → **true by default in dev/test**, false in prod unless `ALLOW_OPEN_REGISTRATION=true` (`routes/auth.js`) | Make it require the explicit flag everywhere |
| SSO | None | Add OIDC (+ optional SAML) |
| MFA | None | Enforce at IdP |

Relevant files: `server/src/lib/authToken.js`, `server/src/lib/authCookies.js`,
`server/src/lib/csrf.js`, `server/src/middleware/requestContext.js`,
`server/src/routes/auth.js`, `server/src/config/env.js`, `server/src/services/audit.js`,
migrations `034` (uw_user/uw_role/user_mandate), `122` (password_changed_at),
`123` (v_user_mandate, must_change_password).

---

## 2. Keystone design — server-side sessions & revocation

### 2.1 Model: a `session` table (source of truth), token carries a session id

Add a server-side **session record** per login. The token gains a `sid` claim
(opaque, random). Authentication becomes: *verify token signature + expiry*,
then *the session row must exist, be unrevoked, and unexpired*, then *load the
(active) user*. Revocation is a single `UPDATE … SET revoked_at = now()`.

Why a session table (not just a `uw_user.token_version` epoch):
- Supports **per-session** revoke (log out one device) **and** **revoke-all**
  (one `UPDATE … WHERE user_id`), which a bare epoch cannot.
- Gives an **auditable session inventory** ("active sessions", last-seen, IP/UA),
  which security reviews and the user-admin screen will want.
- Natural home for the **SSO** session (provider, IdP session id for back-channel
  logout, `amr/acr` snapshot).

We keep the existing **per-request DB read** (so role/mandate stay live) and
**JOIN** the session check into it — **no extra round-trip** (see 2.3).

### 2.2 Schema (new migration `2xx_auth_sessions.sql`)

```sql
CREATE TABLE public.auth_session (
  session_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = token `sid`
  user_id        uuid NOT NULL REFERENCES public.uw_user(user_id) ON DELETE CASCADE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                         -- = token exp
  last_seen_at   timestamptz,
  revoked_at     timestamptz,                                  -- NULL = live
  revoked_reason text,        -- LOGOUT | PASSWORD_CHANGE | ROLE_CHANGE | DEACTIVATED | ADMIN | SUPERSEDED
  auth_method    text NOT NULL DEFAULT 'PASSWORD',             -- PASSWORD | SSO_OIDC | SSO_SAML
  amr            text[],      -- IdP auth methods (e.g. {pwd,mfa}) — SSO only
  idp_sub        text,        -- IdP subject (SSO) for back-channel logout match
  idp_sid        text,        -- IdP session id (SSO) for back-channel logout
  ip             inet,
  user_agent     text
);
CREATE INDEX ON public.auth_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON public.auth_session (idp_sid) WHERE idp_sid IS NOT NULL;
```

Plus a **defence-in-depth epoch** on the user, so a "revoke everything for this
user" is also enforceable even against a session row that was missed:

```sql
ALTER TABLE public.uw_user
  ADD COLUMN session_epoch integer NOT NULL DEFAULT 0,        -- bumped on pwd/role/deactivate
  ADD COLUMN auth_provider text NOT NULL DEFAULT 'LOCAL',     -- LOCAL | SSO (per-user)
  ADD COLUMN idp_subject   text;                              -- external IdP subject (SSO link)
CREATE UNIQUE INDEX ON public.uw_user (idp_subject) WHERE idp_subject IS NOT NULL;
```

Token claims become `{ sub, sid, epoch, iat, exp }`. A request is valid iff
`session live` **and** `token.epoch == uw_user.session_epoch`. The epoch makes
mass-revocation O(1) and atomic with the user mutation; the session table makes
single-session revocation and inventory possible. (We can ship the epoch first
and the per-session table in the same migration; both are cheap.)

### 2.3 Per-request flow (revised `authenticate()`)

```
extractToken → verifyAuthToken (sig + exp)         [unchanged crypto]
  → ONE query joining v_user_mandate + auth_session:
      SELECT <user cols>, s.session_id, s.revoked_at, s.expires_at, u.session_epoch
      FROM v_user_mandate v
      JOIN uw_user u   ON u.user_id = v.user_id
      LEFT JOIN auth_session s ON s.session_id = $sid AND s.user_id = v.user_id
      WHERE v.user_id = $sub AND v.is_active = true
  → reject (401) if: no row (inactive/unknown), session missing,
                     s.revoked_at NOT NULL, s.expires_at <= now(),
                     token.epoch != u.session_epoch
  → else req.user = {…}, fire-and-forget UPDATE last_seen_at (throttled)
```

This is **one query** (today it's already one query), so the steady-state cost is
unchanged. The demo/Bearer path (`ALLOW_DEMO_AUTH`) bypasses sessions exactly as
it bypasses cookies today (dev/test only).

### 2.4 New service `server/src/services/sessions.js`

| Function | Use |
|---|---|
| `createSession({userId, ttl, authMethod, amr, idpSub, idpSid, ip, ua})` → `{sessionId, expiresAt}` | login / SSO callback |
| `validateSession(sessionId, userId)` | (used inside the joined query; helper for tests) |
| `revokeSession(sessionId, reason)` | logout (this device) |
| `revokeAllForUser(userId, reason, client?)` | password change / role change / deactivation / "log out everywhere"; bumps `session_epoch` in the same txn |
| `listActiveSessions(userId)` | user-admin "active sessions" view (later) |

Revocation events are **audited** (see §5) and run **inside the mutation's
transaction** (reuse the `auditMutation` discipline from P1-validation).

---

## 3. SSO design (OIDC primary, SAML optional)

### 3.1 Protocol choice

- **OIDC (Authorization Code + PKCE)** is the primary path — works with Entra ID,
  Okta, Auth0, Google, Ping, Keycloak. Library: **`openid-client`** (maintained,
  no Passport needed) for discovery + code exchange + JWKS validation.
- **SAML 2.0** is an **optional** adapter for enterprises that mandate it.
  Library: **`@node-saml/node-saml`**. Same downstream (match user → create
  session). Shipped only if a target tenant requires it.

A thin **provider interface** keeps the rest of the app protocol-agnostic:

```
server/src/services/sso/
  provider.js     // resolveProvider() → { startLogin(req,res), handleCallback(req) → profile }
  oidc.js         // openid-client implementation
  saml.js         // node-saml implementation (optional, phase 2)
  profile.js      // normalize → { idpSub, idpSid, email, displayName, amr, acr }
```

### 3.2 Flow (OIDC)

```
GET  /api/auth/sso/login     → PKCE + state/nonce in a short-lived signed cookie → 302 to IdP authorize
GET  /api/auth/sso/callback  → validate state/nonce/PKCE → code exchange → verify id_token (JWKS, iss, aud, nonce)
                              → enforce MFA (§3.4) → match/provision user (§3.3)
                              → createSession(authMethod=SSO_OIDC, amr, idpSub, idpSid)
                              → setAuthCookies(token{sid,epoch}) → 302 to app
POST /api/auth/logout        → revokeSession(sid) + clear cookies; if SSO, optionally 302 to IdP end_session (RP-initiated logout)
POST /api/auth/sso/backchannel-logout (optional) → IdP-initiated; revoke by idp_sid
```

CSRF: the callback is a top-level redirect (not an app fetch), protected by the
**state/nonce/PKCE** triple, not the double-submit token. The `/auth/sso/*`
paths join the existing `CSRF_EXEMPT` set (like `/auth/login`).

### 3.3 User matching & provisioning

- **Match** IdP `sub` → `uw_user.idp_subject`; else fall back to verified `email`
  (and then **link** by setting `idp_subject`). Email must be `email_verified`.
- **JIT provisioning** (create a `uw_user` on first SSO login) is **config-gated**
  (`SSO_JIT_PROVISION=true`) and assigns a **default least-privilege role**
  (e.g. `TUW`) — never a privileged role from an IdP claim by default. Role
  elevation stays an explicit admin action (audited). *Decision D3.*
- Provisioned/linked users get `auth_provider='SSO'`; their local password login
  can be disabled (*Decision D4*).

### 3.4 MFA enforcement (at the IdP)

The app **does not implement MFA**; it **trusts and verifies the IdP**:
- Prefer to **require MFA via the IdP's policy / authentication context request**
  (OIDC `acr_values` / SAML `RequestedAuthnContext`).
- **Verify on return**: reject the session unless the assertion proves MFA —
  configurable matcher `SSO_REQUIRED_ACR` (e.g. `mfa`, `phr`, or Entra's
  `http://schemas.microsoft.com/claims/multipleauthn`) **or** `amr` contains an
  MFA factor (`mfa`, `otp`, `hwk`, `fido`, `phr`). If neither present and
  enforcement is on → 401 + audit `SSO_MFA_REQUIRED`. *Decision D2.*

### 3.5 Local login coexistence

- `LOGIN_MODES = {LOCAL, SSO, BOTH}` (*Decision D4*). `SSO`/`BOTH` enable the SSO
  routes; `LOCAL`/`BOTH` keep password login. A **break-glass** local admin path
  (system-admin only, flag-gated) is recommended even in `SSO` mode to avoid IdP
  lockout.

---

## 4. Session-invalidation triggers (built on §2)

| Trigger | Where | Action |
|---|---|---|
| **Logout** | `POST /auth/logout` | `revokeSession(sid, 'LOGOUT')` + clear cookies (+ optional IdP end-session) |
| **Password change** | `POST /auth/change-password` | in the same txn: update hash, `revokeAllForUser(userId,'PASSWORD_CHANGE')` (bumps epoch). Re-issue a fresh session+cookie for the current device so the user isn't logged out of the tab they're in. Removes the existing "token stays valid" TODO. |
| **Role change** | `PATCH /auth/users/:id` when `role_id` changes | `revokeAllForUser(target,'ROLE_CHANGE')` — forces re-login so the new authority is re-derived cleanly (today it changes next request, but a long-lived token under the old session shouldn't persist silently). *Decision D5: revoke-all vs let the per-request re-read suffice.* |
| **Deactivation** | `PATCH /auth/users/:id` when `is_active` → false | `revokeAllForUser(target,'DEACTIVATED')` — **immediate**, not next-request. |

All four go through `revokeAllForUser`/`revokeSession`, which audit (critical).

---

## 5. Audit hardening (user-admin → critical)

Fill the gaps found in recon. New/changed events in `services/audit.js` callers:

| Event | Where | critical | Notes |
|---|---|---|---|
| `USER_ROLE_CHANGED` | `PATCH /auth/users/:id` | **yes** | old/new role_id; **currently unaudited** |
| `USER_DEACTIVATED` / `USER_REACTIVATED` | `PATCH /auth/users/:id` | **yes** | **currently unaudited** |
| `USER_UPDATED` | `PATCH /auth/users/:id` (other fields) | yes | email/office/phone/company diff |
| `SESSION_REVOKED` | `services/sessions.js` | yes | reason + count |
| `ACCOUNT_LOCKED` / `ACCOUNT_UNLOCKED` | login lockout path | yes | **currently unaudited** |
| `MANDATE_UPDATED` | `PUT /auth/mandates/:userId` | **upgrade to yes** | currently non-critical |
| `SSO_LOGIN` / `SSO_MFA_REQUIRED` / `SSO_PROVISIONED` | SSO callback | yes | provider, amr/acr |

"Critical" = the audit write shares the mutation's transaction and **rolls it
back** if the audit fails (existing semantics in `services/audit.js`). The
`PATCH` handler must therefore become **transactional** and compute a field diff.

---

## 6. Open-registration fail-closed

`openRegistrationEnabled()` currently returns `true` whenever `NODE_ENV !==
production` (no flag needed in dev/test). Change it to be **closed unless the
explicit flag is set**, in every environment:

```js
// fail-closed everywhere; the dev flag is the ONLY way to open it
function openRegistrationEnabled() {
  return toBool(process.env.ALLOW_OPEN_REGISTRATION, false);
}
```

Authenticated admin creation (`hierarchyLevel <= 2`) is unaffected. Add a startup
**warning** if `ALLOW_OPEN_REGISTRATION=true` while `NODE_ENV=production`. This is
a tiny, standalone change — can ship in **Phase 0** independently of SSO.

---

## 7. Integration-point map (file-by-file)

| File | Change | Phase |
|---|---|---|
| `server/src/db/migrations/2xx_auth_sessions.sql` | **new** — `auth_session` table; `uw_user.session_epoch/auth_provider/idp_subject` | 0 |
| `server/src/db/migrations/2xx_v_user_mandate.sql` | extend `v_user_mandate` to expose `session_epoch`, `auth_provider` | 0 |
| `server/src/lib/authToken.js` | add `sid`, `epoch` claims to `signAuthToken`; return them from `verifyAuthToken` | 0 |
| `server/src/services/sessions.js` | **new** — create/validate/revoke/revokeAll/list | 0 |
| `server/src/middleware/requestContext.js` | `authenticate()` → joined session+epoch check; reject revoked/stale; throttled `last_seen_at` | 0 |
| `server/src/routes/auth.js` | login → `createSession`; logout → `revokeSession`; change-password → `revokeAllForUser`+reissue; **PATCH users → transactional + critical audit + revoke on role/deactivate**; mandate audit → critical; registration flag fail-closed; account-lock audit | 0 |
| `server/src/services/audit.js` | (callers add) new critical event types; no schema change | 0 |
| `server/src/config/env.js` + `.env.example` | new vars (§8); change registration default; SSO vars | 0/1 |
| `server/src/services/sso/{provider,oidc,profile}.js` | **new** — OIDC | 1 |
| `server/src/routes/sso.js` | **new** — `/auth/sso/login`, `/auth/sso/callback`, optional backchannel-logout; register in `registerApiRoutes.js`; add to `CSRF_EXEMPT` | 1 |
| `server/src/services/sso/saml.js` | **new** — SAML adapter | 2 (optional) |
| `package.json` | deps: `openid-client` (1), `@node-saml/node-saml` (2) | 1/2 |
| `client/src/…/Login` | "Sign in with SSO" button → `/api/auth/sso/login`; hide password form per `LOGIN_MODES` | 1 |
| Tests | session revocation integration tests; SSO callback unit tests with a mock IdP; audit-critical tests; registration fail-closed test | each phase |

---

## 8. Config / env (additions)

```
# Sessions / revocation (Phase 0)
SESSION_TTL_HOURS=8                 # already exists; now also = session expires_at
# Registration (Phase 0) — fail-closed everywhere now
ALLOW_OPEN_REGISTRATION=false

# SSO (Phase 1+)
LOGIN_MODES=LOCAL                   # LOCAL | SSO | BOTH
SSO_PROTOCOL=oidc                   # oidc | saml
SSO_OIDC_ISSUER=https://idp.example.com/...
SSO_OIDC_CLIENT_ID=...
SSO_OIDC_CLIENT_SECRET=...          # (or PKCE-only public client)
SSO_OIDC_REDIRECT_URI=https://app.example.com/api/auth/sso/callback
SSO_REQUIRED_ACR=mfa               # enforce MFA; empty = don't enforce in-app (rely on IdP policy)
SSO_JIT_PROVISION=false
SSO_JIT_DEFAULT_ROLE=TUW
SSO_POST_LOGOUT_REDIRECT=https://app.example.com/
# SAML (Phase 2)
SSO_SAML_IDP_METADATA_URL=...  SSO_SAML_SP_CERT=...  SSO_SAML_SP_KEY=...
```

Production validation (`checkSecretsConfig`): when `LOGIN_MODES` includes `SSO`,
require the relevant OIDC/SAML vars; refuse to boot otherwise (fail-fast, matching
the existing secret-strength gate).

---

## 9. Security considerations

- **Token theft**: `sid` + server revocation means a stolen cookie can be killed
  (logout-all) — strictly better than today. Cookies stay `httpOnly`,
  `sameSite=strict`, `secure` in prod.
- **Epoch + session**: two independent revocation levers; either alone is
  sufficient for mass-revoke, together they're belt-and-suspenders.
- **OIDC**: enforce `state`, `nonce`, **PKCE**, `iss`/`aud` checks, JWKS signature,
  clock-skew bounds; short-lived signed state cookie; reject `email_verified=false`.
- **MFA spoofing**: never trust a self-asserted `amr` over an unsigned channel —
  it comes from the **signed** `id_token` / SAML assertion only.
- **JIT least privilege**: default role only; **never** map IdP group claims to
  privileged roles without an explicit, audited admin step (Decision D3).
- **Break-glass**: keep at least one local system-admin path to avoid IdP lockout.
- **No secrets in logs**: client secret, id_tokens, assertions never logged.

---

## 10. Rollout phases

- **Phase 0 — revocation + audit + registration (no SSO).** Highest security ROI,
  self-contained, fully testable with the existing DB harness. Delivers ask
  items **2, 3, 4, 5**. Ship as its own PR(s).
- **Phase 1 — OIDC SSO + MFA enforcement.** Delivers **1** (OIDC). Behind
  `LOGIN_MODES`, default `LOCAL`, so it's dark-launchable per environment.
- **Phase 2 — SAML adapter** (only if a tenant requires it).
- **Phase 3 — SSO-only enforcement** per tenant (`LOGIN_MODES=SSO`, disable local
  login, keep break-glass).

Each phase is independently reviewable/mergeable; Phase 0 unblocks the rest.

## 11. Testing strategy

- **Phase 0**: integration tests — logout revokes (next request 401); password
  change revokes other sessions but keeps current; role change/deactivation force
  re-login immediately; PATCH role/deactivate writes a **critical** audit and
  rolls back if audit fails; registration is 403 without the flag. Reuse the
  `TEST_WITH_DB=1` harness.
- **Phase 1**: unit-test the OIDC callback against a **mock IdP** (canned JWKS +
  signed id_tokens) — happy path, missing MFA, bad nonce/state, unverified email,
  JIT on/off. No live IdP needed in CI.

---

## 12. Decisions needed from you (before Phase 0 implementation)

- **D1 — Revocation model:** session-table **+** user epoch (recommended), or
  epoch-only (simpler, no per-device logout / no session inventory)?
- **D2 — MFA enforcement strictness:** rely on IdP policy only, or **also** verify
  `acr/amr` in-app and reject non-MFA sessions (recommended)? Which ACR value(s)
  for your IdP?
- **D3 — JIT provisioning & role mapping:** auto-create SSO users (default
  least-privilege role), or require pre-created accounts? Any IdP→role mapping?
- **D4 — Login modes:** SSO-only, both, or local-only initially? Keep a break-glass
  local admin?
- **D5 — Role-change revocation:** force re-login on role change (recommended), or
  rely on the existing per-request re-read (lighter, but the old session lingers)?
- **D6 — IdP target(s):** which IdP(s) (Entra ID / Okta / Auth0 / Google / Ping /
  Keycloak) and **OIDC or SAML**? This fixes library + claim details.
- **D7 — Scope of first PR:** ship **Phase 0** (revocation + audit + registration)
  first for review, then SSO — recommended.

---

*Prepared as a design for review. No application code has been changed.*
