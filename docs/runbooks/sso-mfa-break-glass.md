# Runbook — Production SSO / MFA posture & break-glass controls

Audience: platform operators and security owners. Covers the **production login
posture** for an enterprise rollout: enforce SSO + MFA for everyone, keep a
small, audited local **break-glass** path for emergencies.

Code: `server/src/config/identity.js` (config + pure helpers), `server/src/routes/sso.js`
(OIDC auth-code + PKCE flow), `server/src/routes/auth.js` (local-login gate),
`server/src/services/identity/provisioning.js` (JIT provisioning). Boot-time
posture is surfaced by `server/src/startup/productionPosture.js`.

---

## 1. Target posture

| Control | Decision | Enforced by |
| --- | --- | --- |
| SSO is the login path | `IDENTITY_SSO_ENABLED=true` | `auth.js` refuses local passwords (403 `SSO_REQUIRED`) for non-break-glass users |
| MFA required | in-app via `acr`/`amr` | `acrSatisfied()` checked in the SSO callback (D2) — not trusting the IdP alone |
| Least privilege on provision | default role = lowest | `mapClaimsToRole()` / `IDENTITY_DEFAULT_ROLE` (D3) |
| Break-glass | small, audited, alerted | `IDENTITY_BREAK_GLASS_USERS` (D4) |
| Authority change → re-auth | revocation epoch bump | role re-mapped every SSO login; change revokes sessions (D5) |

The server **fails closed**: with no `IDENTITY_REQUIRED_ACR/AMR` set, MFA is not
enforced; with no break-glass list, there is no local emergency path. The boot
posture check logs a warning for each gap — do not ship production with them.

## 2. Enable SSO + MFA (rollout)

1. Register a **confidential** OIDC client with the IdP (Entra ID, Okta, Keycloak,
   …). Redirect URI: `https://<app>/api/auth/sso/callback`. Post-logout:
   `https://<app>/`.
2. Set the identity env (see `.env.example` → *Identity / SSO / MFA*):
   - `IDENTITY_SSO_ENABLED=true`
   - `IDENTITY_ISSUER`, `IDENTITY_CLIENT_ID`, `IDENTITY_CLIENT_SECRET`, `IDENTITY_REDIRECT_URI`
   - `IDENTITY_REQUIRED_AMR=pwd,mfa` (and/or `IDENTITY_REQUIRED_ACR=<idp acr>`)
   - `IDENTITY_ROLE_MAP` + `IDENTITY_DEFAULT_ROLE=TUW`
   - `IDENTITY_BREAK_GLASS_USERS=<1–2 usernames>`
3. Configure the IdP to **require MFA** for the app, and confirm it emits the
   matching `amr`/`acr` claims (otherwise every login is denied `mfa_required`).
4. Deploy. Confirm the boot log shows **no** `[posture] identity config:` errors.
5. Verify: a normal user is sent to the IdP and must pass MFA; a user without MFA
   is denied (`SSO_ACR_DENIED` audit + alert); a non-break-glass local password
   login returns `403 SSO_REQUIRED`.

> MFA is enforced **in-app**: even if the IdP is misconfigured to skip MFA, a
> token lacking the required `amr`/`acr` is rejected at the callback.

## 3. Break-glass accounts (D4)

For when SSO/the IdP is unavailable (outage, misconfig, expired client secret).

**Controls**
- Listed in `IDENTITY_BREAK_GLASS_USERS` (case-insensitive usernames). Keep it to
  **1–2 named accounts**; never a shared/role mailbox.
- Each must have a **real scrypt password** (set via admin create / change-password
  — SSO accounts carry a no-password sentinel and cannot break-glass). Use a long,
  unique password stored in the org password vault; rotate after every use.
- Every break-glass login writes a `BREAK_GLASS_LOGIN` **audit** row **and** raises
  an out-of-band `emitSecurityAlert('BREAK_GLASS_LOGIN', …)`. The gate runs **after**
  the password check, so the posture is never disclosed to an unauthenticated guesser,
  and the audit/alert are best-effort so they can never block an emergency login.
- Account lockout still applies (4 failed attempts → 15-minute lock).

**Use (emergency)**
1. Retrieve the break-glass password from the vault (two-person rule recommended).
2. Sign in at the normal login screen with username + password.
3. Perform only the necessary remediation.
4. **Afterward:** rotate the break-glass password, confirm the `BREAK_GLASS_LOGIN`
   alert fired and was reviewed, and file an incident note (who/when/why).

**Hygiene**
- Review the break-glass list quarterly and on every leaver.
- Alert on `BREAK_GLASS_LOGIN`, `SSO_ACR_DENIED`, and `LOCAL_LOGIN_BLOCKED` in your
  SIEM (these are emitted via `securityAlerts`).

## 4. Rollback / disable SSO

Set `IDENTITY_SSO_ENABLED=false` and redeploy. Local password login is restored
for all active users; SSO routes return 404. Use only as a deliberate, audited
step — it removes MFA enforcement for non-break-glass users.

## 5. Quick verification checklist

- [ ] `IDENTITY_SSO_ENABLED=true` and boot log shows no identity-config errors.
- [ ] `IDENTITY_REQUIRED_AMR`/`ACR` set; a non-MFA login is denied.
- [ ] Non-break-glass local password → `403 SSO_REQUIRED` (audited `LOCAL_LOGIN_BLOCKED`).
- [ ] Break-glass user can log in; `BREAK_GLASS_LOGIN` audit + alert fire.
- [ ] New SSO user lands on the least-privilege default role.
- [ ] SIEM alerts wired for the three identity events above.
