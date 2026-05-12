# Universe 3

Deployment-ready monorepo for the Universe 3 reinsurance treaty pricing platform.

## Stack
- React 18 + Vite frontend
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

## Environment variables
- `PORT`: HTTP port for the server
- `DATABASE_URL`: PostgreSQL connection string
- `DASHBOARD_DATABASE_URL`: optional secondary database
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
