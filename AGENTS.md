# AGENTS.md

## Cursor Cloud specific instructions

Universe 3 is an npm monorepo (root + `client/` + `server/` + `shared/`) for a reinsurance treaty
pricing platform: a Vite/React 19 client (`:3000`), an Express 5 API (`:4000`), and PostgreSQL 16.
Standard commands live in `README.md` and root `package.json`; only the non-obvious cloud caveats
are captured here.

### PostgreSQL (must be running for the app + DB-backed tests)
- PostgreSQL 16 is installed via the update-script snapshot; it does **not** auto-start on VM boot.
  Start it each session with: `sudo pg_ctlcluster 16 main start` (idempotent — ignore "already running").
- Connection: `postgresql://postgres:postgres@localhost:5432/<db>`. Two databases are pre-created and
  migrated: `reinsurance_tool` (dev) and `reinsurance_tool_test` (integration tests). They persist in
  the VM snapshot, so you normally only need to start Postgres, not recreate them.
- If a database is ever missing, recreate with `sudo -u postgres psql -c 'CREATE DATABASE <name>;'`
  then run migrations (`DATABASE_URL=... npm run migrate --prefix server`).

### Environment file
- A root `.env` (gitignored, persisted via snapshot) drives local dev with `NODE_ENV=development`,
  `ALLOW_DEMO_AUTH=true`, and the `DATABASE_URL` above. `ALLOW_DEMO_AUTH=true` enables the demo login
  backdoor (e.g. user `cuo` / password `demo2026`) and is never honoured when `NODE_ENV=production`.
- In dev/test, `AUTH_JWT_SECRET`/`SESSION_SECRET` are optional (an ephemeral per-process secret is
  minted). They are only mandatory under `NODE_ENV=production` (server refuses to boot without them).

### Running, testing, building
- Dev (both services, hot reload): `npm run dev` → client `http://localhost:3000` (proxies `/api` to
  `:4000`), server `http://localhost:4000` (health: `/api/health`). The server runs migrations on boot
  (`RUN_MIGRATIONS_ON_BOOT=true`).
- Client tests require a built client first: run `npm run build` before `npm run test:client`.
- Server integration tests are gated behind `TEST_WITH_DB=1` + a reachable Postgres; the helper
  `scripts/test-db.sh` creates/migrates the test DB and runs the full server suite (the same path CI uses).
- AI slip-ingestion, Cloudinary, OIDC/SSO, and OpenTelemetry are all optional and off by default — the
  core pricing flows work without any external API keys.
