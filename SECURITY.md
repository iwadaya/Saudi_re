# Security

## Authentication & authorization

Identity comes from a **verified bearer token**, not client headers. On every
request `authenticate` (server/src/middleware/requestContext.js) verifies the
`Authorization: Bearer <token>` (or `auth_token` cookie), then re-reads the
user's role and hierarchy level **fresh from the database** (`v_user_mandate`).
A token issued before a demotion therefore cannot carry elevated rights.

- `requireAuth` blocks anonymous requests on all `/api` routes except the
  login-screen public endpoints: `POST /auth/login`, `GET /auth/users`,
  `GET /auth/roles`, and `POST /auth/users` (open registration, see below).
- `requireRole(...codes)` / `requireMinLevel(n)` gate privileged routes
  (e.g. user create/patch, mandate writes) on the **verified** `req.user`.
- Assignment actions (allocate/reassign/self-assign) take the actor from
  `req.user.userId` only — `reassigned_by`/`user_id` in the body and
  `x-user-*` headers are ignored, so nobody can act as someone else.
- Audit/log rows record the actor from the verified `req.user.userId`, with the
  display name resolved server-side from the DB (`resolveAuditActor` in
  services/audit.js); `x-user-name`/`x-user-role` and body `_actor` are never
  the recorded actor, and an anonymous/system action is labelled `SYSTEM`.
  Spoofing `x-user-name` therefore changes nothing in the trail. (Headers may
  still appear in request logging, never as the recorded actor.)
- Editing a treaty/quote/fac risk is allowed only for the current assignee
  (services/permissions.js); seniority governs allocate/reassign, not edit.

## Environment flags

| Flag | Production | Dev / preview | Effect |
|------|------------|---------------|--------|
| `NODE_ENV` | `production` | `development` | standard |
| `AUTH_JWT_SECRET` | **set (secret)** | optional | signs/verifies auth tokens (falls back to `SESSION_SECRET`, then a dev-only default) |
| `ALLOW_DEMO_AUTH` | **unset / false** | `true` | when true, accepts the universal `demo2026` password and `x-user-*` header identity. **Dev/test only.** |
| `ALLOW_OPEN_REGISTRATION` | `false` | `true` | login-screen "Add user" self-registration; when false only CU/CE create users |

In **production** (`NODE_ENV=production`, `ALLOW_DEMO_AUTH` unset):

- The universal `demo2026` password and the static demo-user fallback are
  rejected — login requires a real scrypt password (`scrypt$<salt>$<hash>`).
- `x-user-*` headers grant nothing; only token-authenticated users reach
  protected routes.
- Open registration returns `403`.
- The client's "Enter without password" test panel and the `demo2026` hint are
  compiled out of the bundle (`import.meta.env.DEV`).

The seeded demo accounts' password hashes are replaced by migration 120 with a
locked placeholder (real scrypt format, random unknown plaintext), so they
cannot password-login in production until an admin sets a real password.

## Dependency audit

CI gates each workspace's **runtime** tree (`npm audit --omit=dev
--audit-level=moderate --prefix {server,client}`); the baseline is **zero**
moderate-or-higher advisories in shipped dependencies. Root devDeps are not
gated (not shipped). To triage, separate runtime from dev with
`npm audit --omit=dev` and fix runtime/high first.

Resolved advisories (runtime, both workspaces now report 0):

| Advisory | Sev | Path | Resolution |
|----------|-----|------|------------|
| GHSA-ph9p-34f9-6g65 (`tmp`) | high | `exceljs → tmp` | `overrides` pin `exceljs.tmp` → `^0.2.6` (client + server). exceljs passes its own controlled prefix, so the bump is API-compatible. |
| GHSA-5375-pq7m-f5r2 / GHSA-99f4-grh7-6pcq (`@grpc/grpc-js`) | high | `@opentelemetry/* → @grpc/grpc-js` | `overrides` pin → `^1.14.4` (server). Patch within OTel's range. |
| GHSA-w5hq-g745-h8pq (`uuid`) | moderate | `exceljs → uuid` | `overrides` pin `exceljs.uuid` → `^11.1.1` (client + server). exceljs only calls `uuid.v4` via `require('uuid')`, which uuid 11 still ships as CJS — verified a workbook round-trip. (The flaw is in the v3/v5/v6 `buf` path, which exceljs never reaches; the pin removes it regardless.) |
| GHSA-q8mj-m7cp-5q26 (`qs`) | moderate | `express → qs` | `overrides` pin → `^6.15.2` (server). Patch. |
| GHSA-2j2x-hqr9-3h42 (`react-router`) | moderate | `react-router-dom` (direct) | direct bump `react-router-dom` → `^6.30.4` (client). Non-major fix. |

Deliberately **dev-only**, excluded from the runtime gate (documented, not silently ignored):

- **GHSA-gv7w-rqvm-qjhr (`esbuild`, high)** — reached only at build time via the
  Vite toolchain (`vite`, `@vitejs/plugin-react`), which are now in
  `devDependencies`. esbuild is **not** in the shipped browser bundle:
  production serves the pre-built static assets in `client/dist`, and the
  Docker `client-builder` stage installs full deps to build, copying only
  `dist` into the runtime image. `--omit=dev` therefore excludes it. The
  upstream fix is `vite@8` (a breaking major) — deferred to a dedicated
  Vite upgrade rather than forced here.

We pin patched transitives via `overrides` rather than `npm audit fix --force`,
which would otherwise downgrade `exceljs` to 3.x and bump Vite to 8.

## Content-Security-Policy

CSP is rolled out **Report-Only first** (server/src/app.js): the server sends
`Content-Security-Policy-Report-Only`, so browsers report violations to
`/csp-report` (logged as `csp-violation`) but enforce nothing. This lets us
tighten the policy from real traffic and confirm a clean load before flipping it
to the enforcing `Content-Security-Policy` in a follow-up.

Policy:

```
default-src 'self';
script-src  'self' 'nonce-<per-request>';                        # inline bootstrap script only — no 'unsafe-inline'
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com; # 'unsafe-inline' = React style attributes
font-src    'self' https://fonts.gstatic.com;                    # Google Fonts files
img-src     'self' data:;                                        # data: = the SVG favicon
connect-src 'self';                                              # same-origin API
object-src  'none'; frame-ancestors 'none'; base-uri 'self';
report-uri  /csp-report;
```

- **Nonce, not `'unsafe-inline'`, for scripts.** A fresh per-request nonce
  (`res.locals.cspNonce`) is injected into the single inline `<script>` in
  index.html when the SPA is served, so the policy is already enforcing-ready.
- **`style-src 'unsafe-inline'`** is required for React's inline style
  *attributes* (`style={{}}`), which cannot carry a nonce. Moving those to
  classes/CSS would let us drop it.
- **To enforce:** confirm `/csp-report` logs no violations under real use, then
  drop `reportOnly: true` (ships `Content-Security-Policy`) in a follow-up
  commit.

## Reporting

Report suspected vulnerabilities to the maintainers privately rather than via a
public issue.
