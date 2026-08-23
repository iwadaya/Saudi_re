# Universe 3

Universe 3 is a reinsurance treaty pricing and modelling platform: it prices
proportional, non-proportional and facultative business, runs the quote →
approval → bind workflow, and produces renewal packs and portfolio analytics.

## Stack
- React 19 + Vite frontend (lazy-loaded SPA, served by the API in production)
- Express 5 API server
- PostgreSQL database
- Shared pricing math in `shared/`, imported by both client and server

## Prerequisites
- **Node.js** — the version pinned in [`.nvmrc`](.nvmrc) (`nvm use` selects it). `package.json` engines require `>=20.18.0`.
- **PostgreSQL 16** (the bundled Docker stack uses `postgres:16-alpine`).
- **npm** (ships with Node).

## Local development
1. Copy `.env.example` to `.env`
2. Install dependencies
3. Start both services

```bash
npm run install:all
npm run dev
```

Client runs on `http://localhost:3000` and proxies API traffic to the server on `http://localhost:4000`.

## Production build
```bash
npm run build
npm start
```

The Express server serves the built SPA from `client/dist` and exposes API routes under `/api`.

## Testing
```bash
npm run test:server   # server unit tests (DB integration tests skip without TEST_WITH_DB=1)
npm run build --prefix client && npm run test:client   # client tests need a built dist/
npm run verify        # full gate: lint + typecheck + budget + server tests + build + client coverage
```

DB-backed integration tests (`server/tests/integration/*`) only run when
`TEST_WITH_DB=1` and a `DATABASE_URL` points at a disposable Postgres. The
easiest way is the helper script, which creates the DB if needed, runs the
migrations, and runs the suite — the same steps CI's `integration` job uses:

```bash
scripts/test-db.sh
# or point at an existing database:
DATABASE_URL=postgres://user:pass@host:5432/reinsurance_tool_test scripts/test-db.sh
```

See `CONTRIBUTING.md` → _Database integration tests_ for the manual steps and
conventions for adding new ones.

## Docker (local / controlled test environment)
```bash
docker compose up --build
```

Starts the app and a PostgreSQL database, runs migrations on boot, and seeds
reference data. Sign in with a seeded demo user (e.g. `cuo` / `demo2026`) —
`docker-compose.yml` sets `ALLOW_DEMO_AUTH=true`, which is a dev/test-only
convenience the server refuses to honour under `NODE_ENV=production`.

Load sample treaties for manual testing once the stack is healthy:

```bash
docker compose exec universe-app node server/scripts/seedTestTreaties.js
```

> The compose file is for local/test use. Production deploys via Render
> (`render.yaml`) or your own orchestrator, with real auth secrets injected as
> secret env vars. See `DEPLOYMENT.md`.

## Environment variables
Every variable is documented in [`.env.example`](.env.example). The essentials:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port for the server (default `4000`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `CORS_ORIGIN` | Allowed origin list for browser requests |
| `AUTH_JWT_SECRET` | Auth-token signing secret (**required in production**, ≥32 chars) |
| `SESSION_SECRET` | CSRF/session secret (≥32 chars; falls back to `AUTH_JWT_SECRET`) |
| `UPLOAD_DIR` | Upload storage path |
| `RUN_MIGRATIONS_ON_BOOT` | Whether SQL migrations run at startup |
| `DB_POOL_MAX` / `DB_POOL_MIN` | Pool sizing (per-process; see `docs/scaling.md`) |
| `OTEL_ENABLED` | Set to `1` to enable OpenTelemetry traces + metrics |
| `PRICING_STRICT` | Set to `1` to reject (422) client pricing that drifts from `shared/pricingMath.js` |

## Scheduled jobs
There is no in-process scheduler. These scripts are invoked nightly by the
platform's cron facility (Render Cron, Kubernetes CronJob, GitHub Actions —
see `render.yaml` and `.github/workflows/scheduled-jobs.yml`) from the
`server/` directory:

- `npm run cleanup:snapshots` — purges `import_snapshots` rows past the 30-day retention window.
- `npm run refresh:ldf-benchmarks` — rebuilds the `mv_ldf_benchmark_*` materialized views. Also fires opportunistically after each contract reaches a terminal state (SIGNED / DECLINED / NTU); the nightly run is the safety net.

## Further reading
| Document | What it covers |
|---|---|
| `DEPLOYMENT.md` | Deployment options (Docker, Render, PM2), env wiring, backups |
| `SECURITY.md` | Auth model, CSP, dependency/image scanning, disclosure |
| `CONTRIBUTING.md` | Dev workflow, integration-test conventions |
| `docs/architecture.md` | Data model and quote/treaty duality |
| `docs/scaling.md` | PM2 cluster mode and horizontal scaling |
| `docs/observability.md` | OpenTelemetry enable-to-dashboards recipe |

## License
Proprietary and confidential — see [`LICENSE`](LICENSE). All package manifests
are marked `UNLICENSED`; the code is not licensed for redistribution.
