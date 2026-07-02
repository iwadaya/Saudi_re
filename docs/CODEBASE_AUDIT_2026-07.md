# Codebase Audit — Universe 3 (Reinsurance Treaty Pricing & Modelling Tool)

**Date:** 2026-07-02
**Scope:** Full-stack audit — server (~46k LOC Node/Express/Postgres) and client (~78k LOC React/Vite).
**Method:** Six parallel domain deep-dives (auth/authz, DB/SQL, input/uploads/AI/SSRF, client/React, business/pricing logic, config/secrets/infra). Findings below were spot-verified against source.

---

## Overall assessment

This is a **mature, security-conscious codebase**. Notable strengths confirmed during the audit:

- **No SQL injection** — every dynamic identifier is schema-derived, a hardcoded ternary, or an allow-list; all values are parameterized. ~90 `pool.connect()` sites all release in `finally` (no pool leaks).
- **Strong auth primitives** — httpOnly + `SameSite=Strict` + `Secure` cookies, async scrypt with constant-time compare, server-side session revocation + per-user epoch, CSRF double-submit, HMAC/state comparisons via `timingSafeEqual`, SSO with PKCE(S256)+state+nonce.
- **No committed secrets**, `npm audit` clean across all three workspaces, enforcing helmet CSP with nonce-based `script-src`, layered rate limiting, non-root hardened Dockerfile, advisory-locked migrations.
- **No `dangerouslySetInnerHTML` / `eval` / exposed `VITE_` keys** in client production code.

The findings that follow are the exceptions. **Two are must-fix before the next production deploy** (C1, and the SSRF I1). Nothing here contradicts the general quality of the code — they are gaps, not systemic rot.

---

## Priority fix list (top of the queue)

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| C1 | **Critical** | `selfAssign` lets any user seize + edit any treaty/quote (broken access control) | `services/assignments.js:93-102` |
| I1 | **High** | SSRF via user-controlled `file_path` → unrestricted `fetch()` in AI doc analyzer | `routes/facultative.js:583` → `lib/facDocAi.js:27-31` |
| A2 | **High** | Deactivated SSO users silently reactivated on next login | `services/identity/provisioning.js:79-85` |
| A3 | **High** | Unauthenticated user-directory + PII disclosure (`GET /auth/users`) | `routes/auth.js:38-49,449-475` |
| G1 | **High** | Prod boot gate accepts the repo's own `CHANGE_ME` placeholder JWT secret | `config/env.js:140-160`, `.env.example:16,39,44` |
| CL1 | **High** | Stale-response race shows wrong contract's/mode's pricing figures | `screens/proportional/.../PropQuickSummary.jsx:108,199` |

---

## Critical

### C1 — Ownership takeover: any user can seize and edit any treaty/quote
**`server/src/services/assignments.js:93-102`** (route `routes/assignments.js:26-55`, `POST /api/contracts/:id/assign`, `/quotes/:id/assign`)

`selfAssign` is documented as "claim an **unassigned** contract," but it only early-returns when the caller already owns the item — in every other case it unconditionally runs `UPDATE … SET assigned_to_user_id = <caller>`. It never checks that the item is unassigned or that status is `DRAFT`. The sibling `allocate()` (`:58-76`) *does* enforce both `status === 'DRAFT'` and `requesterLevel <= ownerLevel`; the `/assign` route calls the unguarded `selfAssign` instead. These routes are not covered by `guardApiMutations` (`classifyMutationPath` has no `/contracts/` case → passes through).

**Exploit:** A level-5 Treaty Underwriter POSTs `/api/contracts/{id}/assign` for a BOUND contract owned by the Chief Executive → becomes the assignee. The edit-lock model (`permissions.js:33-36`) grants edit rights to "the current assignee," so they can now edit pricing, terms, and loss data of any treaty/quote in the system.

**Fix:** In `selfAssign`, reject when `currentOwner` is non-null and `!== userId`; enforce `DRAFT` status like `allocate`.

---

## High

### I1 — SSRF via user-controlled `file_path` reaching an unrestricted `fetch()`
**`routes/facultative.js:583-599` → `routes/ai.js:206-231` → `lib/facDocAi.js:24-41`**

`facDocumentMetaSchema` is `.passthrough()` and declares `file_path: optionalText` (`validation/facultative.js:309-318`); the value is stored verbatim. `POST /api/ai/fac/analyse-document` loads the row (ownership check only) and `readDocumentBytes` does `if (/^https?:\/\//i.test(key)) { await fetch(key) }` with **no allow-list, no IP filtering, no redirect cap, no timeout**. Fetched bytes are base64'd and sent to OpenAI, and the model's summary returned to the caller → SSRF with a data-exfiltration channel.

**Exploit:** POST a document with `file_path: "http://169.254.169.254/latest/meta-data/iam/security-credentials/"`, then call `analyse-document`.

**Fix:** Drop `file_path` from the schema entirely (real bytes arrive only via the multipart route). Never `fetch()` a `file_path`-sourced URL. Introduce one hardened `fetchStoredAsset(url)` — Cloudinary host allow-list, private/link-local IP block, `redirect:'error'`, `AbortController` timeout, streamed byte cap — and route the two remaining stored-URL fetches (`facDocAi.js`, `renewalPack/importJob.js:200-211`) through it too.

### A2 — Deactivated SSO users silently reactivated on next login
**`services/identity/provisioning.js:79-85`; SSO callback `routes/sso.js:113-137`**

The returning-user UPDATE sets `is_active = true` unconditionally, and the callback never checks `is_active` before minting a session. Local deactivation of an SSO user is not durable — as long as the IdP still authenticates them, their next callback re-activates the account.

**Fix:** Do not force `is_active = true`; if a matched user is inactive, abort provisioning and deny login.

### A3 — Unauthenticated user enumeration + PII disclosure
**`routes/auth.js:38-49` (PUBLIC_AUTH), handler `:449-475`**

`GET /auth/users` is public and returns every active user's username, email, office, role, `hierarchy_level`, and mandate limits (`treaty_limit_usd`, `single_risk_limit_usd`). This is a GDPR/PII exposure and a direct enabler for password spraying (see A4). The client login screen even fetches this by sending a spoofed `x-user-role: CU` header (CL4).

**Fix:** Require auth for the full list; expose a minimal display-name-only projection for the login dropdown. Never expose mandate limits pre-auth.

### G1 — Production boot gate accepts the repo's own placeholder JWT secret
**`config/env.js:140-160`; `.env.example:16,39,44`**

`checkSecretsConfig` rejects only the literal `dev-insecure-secret-change-me` and length < 32. The `.env.example` placeholder `CHANGE_ME_RUN_NODE_RANDOMBYTES_48_BASE64URL` is 43 chars and not the blacklisted string, so it **passes**. The template also ships `NODE_ENV=production` uncommented. An operator who does `cp .env.example .env`, edits DB/CORS, and overlooks the secret boots production with a signing key that is public in the repo → anyone can forge `auth_token` → full auth bypass. `SESSION_SECRET` has the same property.

**Fix:** Reject `/^CHANGE_ME/` (and the other known placeholders) in `checkSecretsConfig`; comment out `AUTH_JWT_SECRET`/`NODE_ENV=production` in the template.

### CL1 — Stale-response race displays wrong contract's/mode's pricing figures
**`screens/proportional/quick_summary/PropQuickSummary.jsx:108,199`; `screens/proportional/projected_summary/PropProjectedSummary.jsx:42-84`**

These load effects `await` a multi-step pricing fetch then `setState` with **no cancellation guard** — while the sibling effect at `PropProjectedSummary.jsx:88-102` *does* use a `cancelled` flag, proving the omission is an oversight. Toggling quote mode or switching contract mid-flight lets an older response overwrite newer state → the projected/quick summary renders loss-ratio, premium and result figures for the **wrong contract or wrong (treaty vs quote) mode**, potentially driving a mispricing decision.

**Fix:** Mirror the sibling — `let cancelled = false`, guard each `setState`, cleanup `() => { cancelled = true }` (or use the codebase's `useResource`).

---

## Medium

### A4 — Login user-enumeration timing side-channel + distinct lock message
`routes/auth.js:223-234`. Unknown username → immediate 401 (no hashing); real user → awaits scrypt (tens of ms) → timing oracle. Locked-account branch returns a distinct 403 confirming existence. **Fix:** dummy scrypt verify on unknown user; uniform generic 401.

### A5 — Admin endpoints permit escalation to/above the actor's own authority
`routes/auth.js:611` (`PATCH /auth/users/:id`) and `:713` (`PUT /auth/mandates/:userId`), both `requireMinLevel(2)`. Any level-≤2 user can set another user's role to CE, promote themselves, deactivate the CE, or raise their own mandate limits — no "≤ own level" check, no self-target guard. **Fix:** forbid granting a role/mandate senior to the actor; forbid self role/mandate changes; restrict CE-tier to CE.

### A6 — `ALLOW_DEMO_AUTH` not fenced out of production
`middleware/requestContext.js:41,142`, `routes/auth.js:200,243`, `app.js:179-181`. If ever set true in prod it trusts `x-user-*` headers (impersonation as any role), accepts the `demo2026` universal password, honours `Authorization: Bearer`, and disables all rate limiting. Nothing in `validateEnv()` rejects it. **Fix:** hard-fail boot when `ALLOW_DEMO_AUTH` is truthy and `NODE_ENV==='production'`.

### D1 — Optimistic lock has a TOCTOU race (no row lock)
`db/optimisticLock.js:55-58`. `assertEntityUnchanged` does a bare `SELECT updated_at … WHERE id=$1` with **no `FOR UPDATE`**; two concurrent saves with the same baseline timestamp both pass, then the later `UPDATE` silently clobbers the earlier — the exact lost-update this module exists to prevent (affects `saveCompositePricing`, `npExpiringPut`, all `assertParentEntityUnchanged` paths). **Fix:** `SELECT … FOR UPDATE`, or fold into `UPDATE … WHERE updated_at <= $expected` and 409 on `rowCount===0`; always pass the txn `client`.

### B1 — Pricing money fields can never be cleared; inconsistent null handling
`modules/pricing/repositories/pricingOutputsRepository.js:130-150`. The composite-save path uses `COALESCE(EXCLUDED.x, existing.x)`, and `numOrNull('')` returns `null`, so once set a field (EPI, `attritional_ratio`, `technical_result`, `target_margin`…) can **never be blanked** — save returns `{ok:true}` but retains the stale value. The two sibling writers (`repositoryUtils.js:61-72`, `pricingOutputsRepository.js:73-84`) do the opposite (overwrite to null). Same inputs → different persisted state by endpoint. **Fix:** pick one semantic and apply it consistently.

### B2 / D2 — Component save failures silently swallowed while save reports success
`pricingOutputsRepository.js:199-232`. The `pricing_components` DELETE+INSERT is wrapped in `SAVEPOINT sp_components`; on any error it does `ROLLBACK TO SAVEPOINT` + logs, then the outer txn commits and returns `{ok:true}`. The rollback also undoes the DELETE, so **stale components survive while the user is told the save succeeded**. **Fix:** propagate the failure or return a `components_saved:false` flag.

### B3 — Renewal-pack triangle import doesn't normalize dev periods to months
`services/renewalPack/wizardMapper.js:119-126` vs `lib/triangleBounds.js:128-133`. `trianglesToCells` writes `dev_months = Number(header)` verbatim; a pack with columns `1,2,3` (common convention) stores `dev_months 1,2,3`. The other intake path guards with `raw < 12 ? raw*12 : raw` and a bounds filter. Downstream LDF logic keyed on 12/24/36 silently sees a broken triangle. **Fix:** apply the same normalization in `trianglesToCells`.

### I3 — `/ai/complete` PII-redaction bypass for array-form content
`routes/ai.js:133-166`, schema `validation/ai.js:26-35`. `redactForLlm` runs only when `content` is a string; the schema allows `content: array(unknown())`, so array-form message blocks (and the `system` field) reach Anthropic **unredacted**. **Fix:** redact/serialize array content blocks before send, or reject non-string content on this proxy.

### I4 — Renewal-pack XLSX parser has no row/sheet/cell caps
`services/renewalPack/parser.js:46-133`. `ExcelJS.load()` + full-range iteration on an uploaded buffer with no guards; a crafted `.xlsx` with a huge declared range/many sheets expands to GBs of JS arrays (in-process via `setImmediate`) → memory-exhaustion DoS. **Fix:** cap sheet/row/column/cell counts; abort past thresholds; consider a worker with a memory ceiling.

### CL2 — Document-preview iframes render user files same-origin with no `sandbox`
`screens/shared/DocumentsScreen.jsx:534,538`. `<iframe src={api.getDocumentViewUrl(docId)}>` is same-origin with no `sandbox`. If the server ever serves an uploaded file inline with a sniffable/`text/html`/`image/svg+xml` type, a malicious upload runs JS in the app origin (stored XSS). **Fix:** add `sandbox` (no `allow-scripts`); ensure server sends `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.

### CL3 — `href` bound directly to AI/model-generated URL (`javascript:` XSS)
`components/market/MarketIntelligenceModal.jsx:1134`. `<a href={s.url}>` where `s.url` comes from the LLM/web-search report pipeline. React does not block `javascript:` in `href`. **Fix:** allow only `^https?://`, otherwise render as text.

### CL4 — Login screen fetches full user directory via a spoofed elevated header
`screens/login/LoginScreen.jsx:254`. Pre-auth screen hardcodes `x-user-role: CU` to list all users (see A3). Combined with `getAuthHeaders()` echoing tamperable localStorage role/level, this is a privilege-spoofing pattern only safe while the server ignores `x-user-*`. **Fix:** dedicated minimal server endpoint returning display names only.

### CL5 — Committed default / seed credentials in the client bundle
`components/ChangePasswordForm.jsx:12` (`TEMP_SEED_PASSWORD = 'Universe#1234'`), `screens/admin/UserManagementScreen.jsx:186` (default `demo2026`). Well-known defaults shipped in JS and permanently in git history. **Fix:** server-generate a random one-time password per user, delivered out-of-band.

### A5b — CA granted final-approval override contradicting stated policy
`services/approvals.js:20-22,803-822,320-328`. `LEVEL = {CE:1, CU:2, CA:2}` and `FINAL_AUTH = {1,2}`, so a Chief Actuary in the peer1 slot is treated as final authority (bypassing the two-approver requirement) and can arbitrate — contradicting the file's own "only CU/CE override" comment. Segregation-of-duties question. **Fix:** confirm policy; if CA shouldn't override, give it a distinct level or exclude from `FINAL_AUTH`.

---

## Low / informational

- **G2** — `render.yaml:7` / `deploy.sh:11-13` use `npm install` (mutates lockfile, runs freshly-resolved lifecycle scripts) instead of `npm ci`. CI correctly uses `npm ci`.
- **G3** — `lib/logger.js:5-39` has no secret/PII redaction; no current leak, but a single careless `logger.info('x', {body:req.body})` would emit credentials. Add a key-based redaction pass.
- **G4** — `.github/workflows/ci.yml:80-92,163-171` downloads a native `.node` binding via `curl | tar` with no checksum. Pin a SHA-256.
- **G5** — No prod posture warning when `CORS_ORIGIN='*'` (default in `env.js:35`).
- **G6** — `runMigrations.js:21-30` globally swallows `23505` (unique_violation) yet records the migration as applied → silent data drift. Scope skipping to idempotent seed statements.
- **G7** — `unhandledRejection` logs but does not shut down (`gracefulShutdown.js:94-97`); `uncaughtException` does. Make it an explicit decision.
- **D3** — `db = client || pool` fallback in `pricingOfferRepository.js:40,60` makes multi-statement writes non-atomic if ever called without a client (not currently exploitable — all callers pass a client). Drop the `|| pool` fallback for multi-write functions.
- **D4** — N+1 per-row INSERT loops (`pricingYearlyRepository.js:12`, `pricingStraightStatsRepository.js:14`, `crestaSave.js:69`, `nonProp.js:511`); bounded input, perf not DoS. Route through `buildBatchInsert` (already used elsewhere).
- **D5** — Swallowed DB errors mask failures: `pricingAggregateRepository.js:413` (`catch{continue}`), `lookups.js:379`, `pricingRepository.js:112`, `repositoryUtils.js:48`. Log at minimum.
- **D6** — `batchInsert.js:27-42` interpolates table/columns with no IDENT validation (unlike `partialUpdate.js`); `partialUpdate.js:76` interpolates a raw `where` string (no prod caller today). Harden + document. Consolidate duplicate `withTransaction` (`db/withTransaction.js` vs `repositoryUtils.js:6-19`).
- **B4** — NP per-layer line % is an **unweighted** mean that **drops 0%/negative layers** (`pricingHelpers.js:19-22,35-38`, `quoteWorkflow.js:48-51`), biasing `written/signed_line_pct` upward → affects authority-breach gating and portfolio aggregate. Use exposure-weighted line; stop dropping 0% layers.
- **B5** — `deriveComponentTotal` clamps loading to ≤99% (`pricingMath.js:213`) while `applyLoading` throws at ≥100% (`:149-158`); disagreement can flag legitimate high-loading rates as drift. Make the two agree.
- **B6** — LDF blend collapses to CDF 1.0 (no development) when all class premiums are 0 (`ldf/blending.js:30,81`) rather than erroring.
- **B7** — Benchmark scope gate keys off only the first dev-month row's contract count (`ldf/benchmark.js:31,47`).
- **B8** — GEM has no residential-contents bucket (`gemDamageRatio.js:61-67`); if upstream splits residential into bldg/contents, that TSI gets no MDR (ground-up EQ loss understated). Data-model choice — flagged for awareness.
- **I5** — Prompt injection from untrusted document content into LLM prompts (`extractorPrompts.js:192-218`, `facDocAi.js:71-112`). Fac path is well-mitigated by output-side Zod + `sanitizeRecommendations`; renewal-pack path can poison imported pricing data within the uploader's own scope. Keep output validation as primary control.
- **I6** — Uploads fully buffered in memory (`multer.memoryStorage()`, up to 50MB) with no `fileFilter`; validation runs after buffering. Add `files:1`, an extension `fileFilter`, and a global size budget.
- **I7** — Broad `.passthrough()` on save schemas (fac/treaty/quote) — mass-assignment latent risk (this is what let `file_path` through in I1). Prefer `.strip()`/`.strict()`.
- **CL6** — `errorReporter.js:112` POSTs `/api/client-events` bypassing the central CSRF wiring; telemetry silently drops if CSRF is enforced there.
- **CL7** — Additional secondary stale-response races (same class as CL1, lower blast radius): `FacHomeScreen.jsx:40-59`, `useAnalysisDrawerState.js:42-58`, `AggregateAnalysisPanel.jsx:76-85`, `GemDamageRatioPanel.jsx:182-231`, `CoveredProportionalSection.jsx:42-57`, `CompareTermsPanel.jsx:45-105`, `TreatyMetricsPanel.jsx:21-52`. Add a `cancelled`/token guard before each `setState`.
- **A7** — `guardApiMutations` no-ops when it can't resolve the entity id (`permissions.js:252-253`) for `/pricing/save`, `/straight-stats/save` — defense-in-depth gap; confirm each handler independently calls `assertCanEdit`.
- **A8** — CSRF token is a bare signed nonce not bound to session/user (`lib/csrf.js`); safe under `SameSite=Strict` but would weaken if `SameSite` is ever relaxed.

---

## Recommended remediation order

1. **C1** — gate `selfAssign` (unassigned + DRAFT only). *Small, localized, highest impact.*
2. **I1** — drop `file_path` from the fac-document schema and stop fetching it; add `fetchStoredAsset` for the remaining stored-URL fetches.
3. **A2, A3, A6** — SSO reactivation, public user directory, `ALLOW_DEMO_AUTH` prod fence.
4. **G1** — reject `CHANGE_ME*` placeholders in the secret gate.
5. **CL1** — cancellation guard on the proportional pricing-summary loads.
6. **D1, B1, B2** — optimistic-lock `FOR UPDATE`; consistent null semantics; stop swallowing component-save failures.
7. Work the Medium/Low list as hardening.
