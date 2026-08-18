# Security

## Authentication & authorization

Identity comes from a **verified token carried in an httpOnly cookie**, not
client headers and not JS-readable storage. On every request `authenticate`
(server/src/middleware/requestContext.js) reads the token from the `auth_token`
cookie, verifies its signature, then re-reads the user's role and hierarchy
level **fresh from the database** (`v_user_mandate`). A token issued before a
demotion therefore cannot carry elevated rights.

- The token is set as an **httpOnly, SameSite=Strict, `Secure` (prod), `Path=/api`
  cookie** by `POST /auth/login` and is **never** returned in the JSON body or
  stored in `localStorage` — so an XSS payload cannot read or exfiltrate it.
  `POST /auth/logout` clears the cookie.
- `Authorization: Bearer <token>` is accepted **only** as a dev/test convenience
  gated behind `ALLOW_DEMO_AUTH`; in production the header path is off entirely
  (the browser cannot read the httpOnly cookie to forge it).
- **CSRF:** because cookies are sent automatically by the browser, every
  state-changing request (`POST/PUT/PATCH/DELETE`) that is cookie-authenticated
  must carry a valid CSRF token. Login issues a **signed double-submit token** as
  a readable `csrf_token` cookie (`Path=/`); the SPA echoes it in the
  `X-CSRF-Token` header and `csrfProtection` requires header == cookie **and** a
  valid server signature (a missing/forged/mismatched token → `403 CSRF_FAILED`).
  GETs are exempt; `login`/`logout` are exempt (bootstrap); the Bearer/demo-header
  dev-test paths are exempt (they carry no ambient cookie credential).
- `requireAuth` blocks anonymous requests on all `/api` routes except the
  login-screen public endpoints: `POST /auth/login`, `POST /auth/logout`,
  `GET /auth/users`, `GET /auth/roles`, and `POST /auth/users` (open
  registration, see below).
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

When the API and SPA share an origin (the production deployment serves the built
client), `SameSite=Strict` + same-origin requests need no CORS. A split-origin
deployment must set `CORS_ORIGIN` to the explicit client origin (never `*`) so
the credentialed cookie flow works; `*` cannot be combined with credentials.

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
| GHSA-2j2x-hqr9-3h42 (`react-router`) | moderate | `react-router-dom` (direct) | direct bump (client). Since superseded by the v7 line — see GHSA-qwww-vcr4-c8h2 below. |
| GHSA-qwww-vcr4-c8h2 (`react-router`) | high | `react-router-dom` (direct, v7) | Resolved inside the declared `^7.9.3` range (7.18.1 → 7.18.2). The advisory is an RSC-mode CSRF bypass; this client is a plain SPA and does not use RSC, so it was not reachable — patched regardless. |
| GHSA-mwp4-54f8-5fhr / GHSA-4xrf-jv44-h6hh / GHSA-22jq-vg5j-6vgg (`ip-address`) | high | `@opentelemetry/* → ip-address` | Resolved in-range. All three are SSRF / trust-boundary bypasses via address-parsing misclassification — relevant because `lib/uploadStorage.js` blocks private ranges on stored-asset fetches. |
| GHSA-j3f2-48v5-ccww (`protobufjs`) | moderate | `@opentelemetry/* → protobufjs` | Resolved in-range. DoS via infinite loop in `.proto` option parsing (OTLP export path). |
| GHSA-... (`@opentelemetry/propagator-jaeger`) | high | `@opentelemetry/sdk-node → propagator-jaeger` | `overrides` pin → `^2.9.0` (server), resolving to 2.10.0. `npm audit fix` only offered `--force`, which would have taken `sdk-node` through a major; the propagator is a leaf package and the pin is a minor bump within the SDK's own range. |

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

## Container image

The production image (`Dockerfile`) is built for a minimal, least-privilege
runtime:

- **Non-root.** The runtime stage runs as the built-in unprivileged `node`
  user (uid 1000); all copied artifacts are `--chown=node:node`. Nothing in the
  container runs as root.
- **Minimal surface.** Multi-stage build copies only the production server
  (`npm ci --omit=dev`), the pre-built `client/dist`, and `shared/` into a clean
  Alpine base. No build toolchain, tests, docs or `.env` reach the image
  (`.dockerignore`). The only added OS package is `tini`.
- **Correct PID 1.** `tini` is the entrypoint so `SIGTERM` reaches Node's
  graceful-shutdown handler and in-flight requests drain on deploy.
- **Healthcheck.** A `HEALTHCHECK` probes the DB-free `/api/health` endpoint
  using Node's built-in `fetch` (no `curl`/`wget` in the image).
- **Pinned base.** The base image is pinned to an exact patch
  (`node:20.18.0-alpine`) for reproducible builds; bump it deliberately when the
  scanner reports a fixed base CVE.

**SBOM + image scanning** run in CI (`.github/workflows/image-security.yml`):
Syft produces an SPDX SBOM (uploaded as a 90-day artifact) and Trivy scans the
built image. Trivy runs as the official release image pinned by digest
(`aquasec/trivy@sha256:…`, v0.74.0) rather than via `aquasecurity/trivy-action`
— the action internally referenced `aquasecurity/setup-trivy@v0.2.1`, a tag that
stopped resolving upstream and failed the job before any scan ran. Bump the
digest deliberately, the same way the base image is bumped. HIGH+CRITICAL findings (fixable) are reported to GitHub code
scanning (SARIF); a fixable **CRITICAL** hard-fails the build. This complements
the source-level `npm audit` gate by covering the OS/base-image layers. Tighten
the hard gate to HIGH+CRITICAL once the base image is on a regular bump cadence.

## Content-Security-Policy

CSP is **enforcing** (server/src/app.js): the server sends
`Content-Security-Policy` (not Report-Only), and still keeps a `report-uri`
pointing at `/csp-report` (logged as `csp-violation`) so any blocked legitimate
source shows up as a regression signal.

Policy:

```
default-src 'self';
script-src  'self' 'nonce-<per-request>';                        # inline bootstrap script only — no 'unsafe-inline'
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com; # 'unsafe-inline' = React style attributes (documented exception)
font-src    'self' https://fonts.gstatic.com;                    # Google Fonts files
img-src     'self' data: https://res.cloudinary.com;             # data: = SVG favicon; Cloudinary = optional document/image backend
frame-src   'self' https://res.cloudinary.com;                   # PDF/file preview iframe (/api/documents/:id/view, may redirect to Cloudinary)
connect-src 'self';                                              # same-origin API
object-src  'none'; frame-ancestors 'none'; base-uri 'self';
report-uri  /csp-report;
```

- **Nonce, not `'unsafe-inline'`, for scripts.** A fresh per-request nonce
  (`res.locals.cspNonce`) is injected into the single inline `<script>` in
  index.html when the SPA is served.
- **`style-src 'unsafe-inline'` (documented exception)** is required for React's
  inline style *attributes* (`style={{}}`), which cannot carry a nonce/hash. It
  is scoped to styles only — scripts stay nonce-based. Moving those attributes to
  classes/CSS would let us drop it.
- **`img-src`/`frame-src` allow `https://res.cloudinary.com`** because document
  view/download (`/api/documents/:id/view`) 302-redirects to Cloudinary when
  remote storage is configured; local-disk deployments stay same-origin.
- **Regression monitoring:** `/csp-report` stays wired so violations are logged
  even while enforcing.

## Static analysis & secret scanning

Beyond the runtime `npm audit` gate and the Trivy image scan, the pipeline runs:

- **CodeQL** (`.github/workflows/codeql.yml`) — SAST over first-party JS/TS on
  every push/PR and weekly; findings surface in the repo's Code scanning tab.
  **Requires Code Security (GitHub Advanced Security) to be enabled on the
  repository.** It is not currently enabled, so the workflow probes for the
  feature and skips with a warning in the run summary instead of failing every
  run with "Code Security must be enabled". Until an administrator turns it on
  under Settings → Code security, **first-party code is not being scanned** —
  this is an open gap, not a passing check. No workflow change is needed once
  the setting is flipped.
- **Dependency licence scan** (`ci.yml` → `license-scan`) — fails the build on a
  strong/network-copyleft licence (GPL/AGPL/LGPL/SSPL/EUPL/CDDL) in any shipped
  dependency, protecting the proprietary licence (`LICENSE`, `UNLICENSED`).
- **GitHub-native secret scanning + push protection** — enable these in the
  repository's Security settings (Settings → Code security). This is the primary
  control against committed credentials; push protection blocks a secret before
  it ever lands. Rotate immediately (and follow the incident runbook) if the
  scanner or a reviewer flags one.

## Reporting a vulnerability

We welcome reports from security researchers and users.

- **Contact:** email **security@darchville.com** (PGP key on request). Do **not**
  open a public GitHub issue for a suspected vulnerability.
- **Include:** affected component/URL, a description, reproduction steps or PoC,
  and impact assessment. A machine-readable pointer to this policy is published at
  `/.well-known/security.txt`.
- **Acknowledgement SLA:** within **2 business days**. **Triage & severity** within
  **5 business days**. We aim to remediate Critical/High issues within **30 days**
  and Medium/Low within **90 days**, and will keep you updated on progress.
- **Coordinated disclosure:** please give us a reasonable window (target **90 days**)
  to remediate before any public disclosure, and coordinate timing with us.
- **Safe harbour:** we will not pursue or support legal action against researchers
  who act in good faith, avoid privacy violations and service disruption, only
  interact with accounts/data they own or have explicit permission to test, and
  give us a reasonable time to respond before disclosure.

Security incidents (as opposed to reports) are handled per
`docs/runbooks/incident-response.md` → *Security incidents*.
