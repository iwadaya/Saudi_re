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

## Reporting

Report suspected vulnerabilities to the maintainers privately rather than via a
public issue.
