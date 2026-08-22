# Enterprise Readiness Audit — Universe 3

**Date:** 2026-08-22
**Scope:** Full stack — server (~52k LOC Node/Express/Postgres), client (~80k LOC React/Vite), shared math (~15k LOC), infra/CI/deployment manifests.
**Method:** Static review plus live execution of the repo's own gates (lint, 2,009 server tests, 976 client tests, both coverage runs, production build, frontend budget, `npm audit` across all three workspaces). Every finding below was verified against source; the exploit chain in C1 was traced end to end.
**Prior art:** `docs/CODEBASE_AUDIT_2026-07.md`. Its critical items were re-tested — see *Regression check*.

---

## Overall assessment

**The code is enterprise-grade. The shipped production configuration is not.**

This is a genuinely mature codebase: no SQL injection, strong auth primitives, enforcing CSP with nonces, advisory-locked transactional migrations, OpenTelemetry wired, graceful shutdown, non-root pinned container, four CI workflows with SHA-pinned actions and least-privilege tokens, committed RPO/RTO targets, a GDPR retention inventory, and only 10 TODO markers across 161k LOC. All gates pass green.

Almost every finding below is in **deployment configuration and seed data**, not application logic. That is good news — the fixes are small and low-risk. But one of them is a remotely exploitable, unauthenticated path to the highest-privilege account in the system, and it is enabled in `render.yaml` on the `NODE_ENV: production` service.

| Severity | Count | Theme |
|---|---|---|
| Critical | 1 | Unauthenticated privilege escalation (config-enabled) |
| High | 3 | Known-credential accounts, directory disclosure, uploads broken in prod |
| Medium | 5 | Error leakage, log control, rate-limit/HA scale-out, DB TLS |
| Low / architectural | 4 | Pricing authority, migration rollback, tenancy, client coverage |

---

## Critical

### C1 — Unauthenticated login as any user, including Chief Executive

**`render.yaml:45-46`, `server/src/routes/auth.js:43,46` and the `/auth/name-login` handler**

`render.yaml` declares one service with `NODE_ENV: production` (line 20) and, on the same service, `ALLOW_NAME_AUTH: "true"` (line 46). That flag enables `POST /api/auth/name-login`, which authenticates a user **by display name alone — no password, no token, no second factor**:

```js
// routes/auth.js
`SELECT * FROM public.v_user_mandate
  WHERE lower(display_name) = lower($1) AND is_active = true`
```

On a match it mints a full session with that user's real role and mandate:

```js
const sess = await createSession({ userId: user.user_id, authMethod: 'NAME', ... });
setAuthCookies(res, signAuthToken({ sub: user.user_id, sid: sess.sessionId, epoch: sess.epoch }));
```

There is no role restriction — it matches *any* active user, Chief Executive included.

**The names are handed out for free.** `GET /api/auth/users` is in `PUBLIC_AUTH` (`auth.js:43`) and, unauthenticated, returns every active user's `display_name` **and `role_code`** (see H2). So the full attack is two unauthenticated requests:

```
GET  /api/auth/users                    → [{display_name:"Chief Underwriter", role_code:"CU"}, ...]
POST /api/auth/name-login  {"first_name":"Chief","surname":"Underwriter"}
                                        → Set-Cookie: auth_token=…  (CU session, approvals authority)
```

Even without step 1, migration 132 names the approvals persona literally `Chief Underwriter` — a one-guess target.

**Why the existing controls do not help.** The login limiter *does* cover `/auth/name-login` (`app.js:444`) at 5 attempts per 15 min per IP+identity — irrelevant when the attacker needs exactly one attempt with a known-correct name. Account lockout and `failed_attempts` never engage: nothing fails. And unlike `ALLOW_DEMO_AUTH`, which `checkDemoAuthConfig()` makes a **fatal boot error** in production, `ALLOW_NAME_AUTH` has **no production fence anywhere** — not in `validateEnv()`, not in `checkProductionPosture()`.

The flag is documented as a temporary Saudi Re pilot convenience, and as a pilot mechanism it is well built (real revocable sessions, audit events, name-shape validation). The defect is that it is switched on in the production manifest with no guard rail preventing that.

**Fix (three parts, all small):**
1. Set `ALLOW_NAME_AUTH: "false"` in `render.yaml` — or move the pilot to its own non-production service.
2. Add a production fence beside `checkDemoAuthConfig` in `config/env.js` so `NODE_ENV=production` + `ALLOW_NAME_AUTH=true` **refuses to boot**. This is the durable fix; without it the flag can be re-enabled by anyone editing the manifest.
3. Require authentication for `GET /api/auth/users` (see H2), removing the enumeration half of the chain.

---

## High

### H1 — Five production accounts share a password published in this repo

**`server/src/db/migrations/132_saudi_re_demo_personas.sql`**

The migration runs unconditionally in every environment — production included, via `preDeployCommand: npm run migrate:up`. It sets `chief.underwriter` (role `CU`, hierarchy level 2 → `canApprove`, `isSupervisor`) and `underwriter1`–`underwriter4` to a real scrypt hash, then:

```sql
password_hash        = pw,
must_change_password = false,   -- forced-change gate explicitly cleared
failed_attempts      = 0,
locked_until         = NULL,
is_active            = true
```

The plaintext is in the file's own header comment (`demo2026`), and the migration notes the hash is real precisely *"so the password works in production where ALLOW_DEMO_AUTH is off."* Clearing `must_change_password` also disables the `passwordChangeGate` that would otherwise block writes until reset. Independent of C1, this is a known-credential path into approvals authority.

**Fix:** Gate the persona seed behind a non-production flag, or add a follow-up migration that sets `must_change_password = true` and rotates these hashes to random values for any deployment that has already applied 132.

### H2 — Unauthenticated user directory disclosure

**`server/src/routes/auth.js:38-49, 449-475`**

The prior audit's A3 was **partially** fixed: email, office, and mandate limits are now correctly gated behind `authed`. But the *unauthenticated* branch still returns, for every active user: `user_id`, `username`, `display_name`, `role_name`, `role_code`. That is a complete org roster with privilege labels, free to any internet caller — valuable for password spraying and phishing on its own, and the enumeration step of C1.

**Fix:** Move `GET /auth/users` out of `PUBLIC_AUTH`. If the login screen needs a picker, expose a separate minimal endpoint, or drop the roster entirely once name-login is off.

### H3 — Document uploads fail in production as configured

**`render.yaml` (no `CLOUDINARY_*`, no `ALLOW_LOCAL_UPLOADS`) → `server/src/lib/uploadStorage.js:79-83`**

`assertLocalStorageAllowed()` throws `503 STORAGE_NOT_DURABLE` when `isProduction && !localUploadsAllowed()`, and `remoteStorageConfigured()` is false because no Cloudinary vars are set. `checkProductionPosture()` logs this at **error** level at boot. The fail-closed design is correct; the shipped manifest simply does not satisfy it, so every document upload 503s in production.

**Fix:** Configure Cloudinary in `render.yaml`, or set `ALLOW_LOCAL_UPLOADS=true` as a deliberate, documented acceptance of ephemeral per-instance storage.

---

## Medium

### M1 — Internal error messages reach clients on 500 in production
**`server/src/middleware/errorHandler.js:47`** — `const message = (pg && pg.message) || err?.message || 'Internal server error';`
Stacks are correctly withheld in production, but for any unmapped error the raw `err.message` is returned. Driver and library messages can carry schema names, file paths, or connection details. Return a generic string for `status >= 500` in production; keep the real message in the (already correct) server-side log, correlated by `requestId`.

### M2 — No log-level control
`server/src/lib/logger.js` has no `LOG_LEVEL` gate — `logger.debug` always writes to stdout. Only one call site today, so the impact is latent, but there is no way to raise verbosity during an incident or suppress it under cost pressure. Add a level threshold read from env.

### M3 — Rate limits are per-process; no Redis in production
`REDIS_URL` is unset in `render.yaml`, so limiter counts are per-instance. Correct at the current single instance, and `checkProductionPosture()` warns — but the ceiling multiplies by N the moment the service scales out or moves to PM2 cluster mode. Provision Redis before any scale-out.

### M4 — Single instance, no redundancy
`plan: starter`, no `numInstances`. Any deploy, crash, or host event is full downtime. The `RTO ≤ 4h` commitment in `docs/backup-recovery.md` is defensible under this topology, but it is worth stating explicitly that there is no HA today.

### M5 — Database TLS is documented, not enforced
`server/src/db/pool.js` passes `connectionString` with no `ssl` option, so transport security depends entirely on `?sslmode=require` being present in `DATABASE_URL`. `DEPLOYMENT.md:138` documents it; nothing verifies it. Add an explicit `ssl` config in production, or assert the connection string carries `sslmode=require` at boot.

---

## Low / architectural

- **L1 — Pricing is computed client-side.** The browser derives `total_price`; `lib/pricingVerifier.js` re-derives and compares server-side. With `PRICING_STRICT=1` (set in `render.yaml`) drift is rejected with 422, which is a genuine mitigation — but the authoritative financial calculation still originates in a tamperable client. Worth a roadmap item to move the primary computation server-side.
- **L2 — Forward-only migrations.** 131 migrations, no `down` scripts. Recovery from a bad migration is restore-from-backup, which is what the DR runbook assumes. Reasonable, but should be an explicit stated policy.
- **L3 — Single-tenant by construction.** No `tenant_id`, no row-level security. Fine for deploy-per-customer; a hard blocker if multi-tenant SaaS is ever the target. Make the decision explicit in `docs/architecture.md`.
- **L4 — Client test coverage is thin.** Measured: **52.0% statements / 43.0% branches / 55.0% lines** across 80k LOC — half the codebase, and the half where pricing is computed (L1). Server is materially better at **69.7% / 60.4% / 72.2%**. The ratchet policy is sound; the client floor (48/37) needs raising over time.

---

## Regression check — prior audit (2026-07)

| # | Finding | Status |
|---|---|---|
| C1 | `selfAssign` ownership takeover | **Fixed** — `assignments.js:93-99` now rejects a non-null different owner and enforces `DRAFT` |
| I1 | SSRF via `file_path` → unrestricted `fetch()` | **Fixed** — `file_path` removed from the schema; `facDocAi.js:44` explicitly refuses it; fetches go through `fetchRemoteAsset` |
| A2 | Deactivated SSO users reactivated on login | **Fixed** — `provisioning.js:83` throws `ACCOUNT_DEACTIVATED`; `is_active` never written |
| A3 | Unauthenticated user directory + PII | **Partially fixed** — PII gated, roster still public (**H2 above**) |
| G1 | Prod gate accepts `CHANGE_ME` placeholder secret | **Fixed** — `isPlaceholderSecret()` in `config/env.js` |
| CL1 | Stale-response race in PropQuickSummary | Not re-tested in this pass |

---

## Verified strengths

Confirmed by execution, not assertion:

- **Gates all green** — lint `--max-warnings=0` clean; 2,009/2,009 server tests pass; 976/976 client tests pass; production build succeeds; frontend budget passes with no regression.
- **Dependencies** — server and client production trees report **0 vulnerabilities**. The 6 high-severity findings are entirely root **devDependencies** (`concurrently`/`shell-quote`, `postcss`, `brace-expansion`, `ip-address`) and never ship. CI gates prod deps at `moderate` with `--omit=dev`, plus a licence scan.
- **No SQL injection.** Every dynamic identifier traced in this pass is an allow-list, a hardcoded ternary, or schema-derived; all values are parameterized. Verified across `facReferenceAdminService`, `assignments`, `permissions`, `nonProp`, `dashboard`, `crestaSave`.
- **Auth primitives** — httpOnly cookie, per-request DB re-read of role/level, server-side session + revocation epoch (mass-revoke lever), CSRF double-submit, `timingSafeEqual` on token comparison, scrypt with rehash-on-login, 12-char minimum with a weak-password deny list.
- **Headers/transport** — enforcing CSP with per-request nonces and no `unsafe-inline` for scripts, violation collector, `x-powered-by` off, explicit CORS allow-list support with a posture warning on wildcard.
- **Data layer** — advisory-locked, transactional, per-statement-classified migrations; pool sized and instrumented; `statement_timeout` and `query_timeout` set; request timeout above the DB timeout.
- **Operability** — OpenTelemetry (traces + Prometheus, loopback-bound by default), shallow and deep health endpoints, graceful SIGTERM drain, `uncaughtException` shutdown with a documented `unhandledRejection` policy, non-root Alpine container on a pinned digest with a HEALTHCHECK.
- **Governance docs** — DR runbook with committed **RPO ≤ 24h / RTO ≤ 4h**, incident response, backup/restore drills, GDPR PII inventory and retention schedule, SSO/MFA/break-glass runbook. This is the material an enterprise procurement questionnaire asks for, and it already exists.
- **Audit trail** — same-transaction enforcement documented and implemented, `critical: true` events throw rather than commit an unaudited mutation, actor derived only from verified identity.

---

## Recommended order of work

1. **C1** — flip `ALLOW_NAME_AUTH` to `false`, add the production boot fence. *(hours)*
2. **H2** — authenticate `GET /auth/users`. *(hours)*
3. **H1** — rotate the persona credentials, restore `must_change_password`. *(hours)*
4. **H3** — configure durable upload storage. *(hours)*
5. **M1, M5** — generic 500 messages; enforce DB TLS. *(days)*
6. **M2, M3, M4** — log levels; Redis; HA topology. *(days, before scale-out)*
7. **L1, L4** — server-side pricing authority; raise the client coverage ratchet. *(roadmap)*

Items 1–4 are configuration and seed-data changes with no application-logic risk. With those closed, this system presents as enterprise-ready.
