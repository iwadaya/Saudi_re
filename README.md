# Universe 3

Deployment-ready monorepo for the Universe 3 reinsurance treaty pricing platform.

## Stack
- React 19 + Vite frontend
- Express 5 API server
- PostgreSQL database

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

## Environment variables
- `PORT`: HTTP port for the server
- `DATABASE_URL`: PostgreSQL connection string
- `CORS_ORIGIN`: allowed origin list for browser requests
- `UPLOAD_DIR`: upload storage path
- `RUN_MIGRATIONS_ON_BOOT`: whether SQL migrations run at startup
- `DB_POOL_MAX` / `DB_POOL_MIN`: pool sizing (per-process; see `docs/scaling.md`)
- `OTEL_ENABLED`: set to `1` to enable OpenTelemetry traces + metrics
- `OTEL_SERVICE_NAME`: service name in traces (default `universe-server`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`: OTLP HTTP endpoint (default `http://localhost:4318`)
- `OTEL_TRACES_SAMPLER_ARG`: optional 0..1 sampling ratio
- `PROM_EXPORTER_PORT`: Prometheus scrape port (default `9464`)
- `PRICING_STRICT`: set to `1` to reject (`422 PRICING_DRIFT`) client-submitted
  NP pricing outputs that fail the server-side spot check against
  `shared/pricingMath.js`. Defaults to warn-only; every response carries
  an `X-Pricing-Drift-Count` header either way.

See `docs/observability.md` for the full enable-to-dashboards recipe,
`docs/scaling.md` for PM2 cluster mode, `docs/architecture.md` for the
data model and quote/treaty duality, `docs/migration-audit.md` for the
prod-schema rebase checklist, and `docs/css-roadmap.md` for the CSS
tokens-to-pilot plan.

## Docker
```bash
docker compose up --build
```

The compose file starts the application and a PostgreSQL database.

## Notes
- Legacy snapshot directories were removed from the deployment package.
- Request user context is now normalized on the server from request headers to support cleaner auditing and role-aware endpoints.
- Routes are lazy-loaded on the client to reduce the initial bundle size.

## Scheduled jobs
There is no in-process scheduler. The following scripts are designed to be invoked nightly by the platform's cron facility (Render Cron, Kubernetes CronJob, GitHub Actions, etc.) from the `server/` directory:

- `npm run cleanup:snapshots` — purges `import_snapshots` rows past the 30-day retention window.
- `npm run refresh:ldf-benchmarks` — rebuilds the `mv_ldf_benchmark_*` materialized views. Also fires opportunistically after each contract reaches a terminal state (SIGNED / DECLINED / NTU); the nightly run is the safety net.
