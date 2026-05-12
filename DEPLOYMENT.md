# Universe — Deployment Handover

**Audience:** IT team standing up the Universe reinsurance pricing tool on an Ubuntu server.
**Source repo:** https://github.com/iwadaya/Darchville-Universe
**Snapshot date:** 2 May 2026
**Maintainer contact:** Isheanesu Wadaya (Riyadh, UTC+3)

---

## 1. What this application does

Universe is an internal reinsurance treaty pricing and modelling tool used by underwriters to:

- Price proportional treaties (quota share, surplus) and non-proportional treaties (excess of loss, stop loss)
- Price facultative risks
- Manage the quote → bind lifecycle, including amendments and renewals
- Run actuarial calculations: chain ladder, Bornhuetter-Ferguson, Munich chain ladder, Pareto fitting, MBBEFD curves, exposure rating, IBNR
- Maintain CRESTA aggregate exposure across countries
- Capture loss history with development triangles, dev factors, and selection snapshots
- Enforce a multi-tier approval workflow (peer → arbiter → mark-approved/return/recall/mark-signed/NTU)
- Audit every significant action for compliance (login, save, status change, override)
- Ingest treaty slips from PDF/Excel via AI extraction
- Govern formula parameters through a workbench with proposed-change-and-approve flow
- Surface portfolio-level dashboards and country aggregates

Target user base: ~30 underwriters in a single office. The app is internal only — there is currently no expectation of internet exposure without an additional auth layer (see §10).

## 2. Architecture summary

| Layer | Technology |
|---|---|
| Client | React 18 + Vite, served as static SPA from the API server |
| API | Express 5 on Node 20+ |
| Database | PostgreSQL 14+ (17.5 used in development) |
| File storage | Local filesystem by default; Cloudinary supported via env vars |
| Process management | PM2 (config provided), or Docker Compose (config provided), or systemd |

The Express server serves both the API under `/api/*` and the built SPA from `client/dist`. There is no separate frontend host required.

Migrations live in `server/src/db/migrations/` (74 files at time of writing) and run automatically on boot when `RUN_MIGRATIONS_ON_BOOT=true`. They are idempotent and safe to re-run.

## 3. Server requirements

Minimum specification for ~30 concurrent users:

| Resource | Minimum | Comfortable |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB |
| Ubuntu | 22.04 LTS | 24.04 LTS |
| Node.js | 20.18.0 | 20.18.0+ |
| PostgreSQL | 14 | 17 |

Notes:
- The Node version is pinned in `.nvmrc` and `.node-version`. Use exactly what's there.
- The 4 GB minimum assumes Postgres on a separate host. Co-locating Postgres on the same box pushes the minimum to 8 GB.
- A real load test has not yet been run. Treat these numbers as a starting point and revise after measuring.

## 4. Pre-flight checklist

Before starting deployment, the IT team should obtain or decide:

- [ ] Server hostname or IP and SSH access
- [ ] Whether Postgres runs on the same Ubuntu box or a separate database server (§5)
- [ ] Which runtime to use: PM2 + Nginx, Docker Compose, or systemd (§6)
- [ ] Public DNS name for the application (e.g. `universe.internal.company.com`)
- [ ] TLS certificate strategy (Let's Encrypt via certbot, internal CA, or terminate at upstream proxy)
- [ ] An `OPENAI_API_KEY` for AI slip ingestion (optional — feature degrades gracefully if absent)
- [ ] A 64-byte random `SESSION_SECRET` (generate with `openssl rand -hex 32`)
- [ ] Confirmation that the server can reach `https://api.openai.com` if the AI feature is required
- [ ] Backup strategy for Postgres (recommended: nightly `pg_dump` to off-host storage)

## 5. PostgreSQL setup

### 5.1 Same-box deployment

Install Postgres on the application server:

```bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-contrib
sudo systemctl enable --now postgresql
```

Create the database and a dedicated user:

```bash
sudo -u postgres psql <<SQL
CREATE USER universe WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE universe OWNER universe;
GRANT ALL PRIVILEGES ON DATABASE universe TO universe;
SQL
```

The resulting `DATABASE_URL` is:
```
postgresql://universe:CHANGE_ME_STRONG_PASSWORD@localhost:5432/universe
```

If the password contains URL-special characters (`@`, `:`, `/`, `#`, `%`), URL-encode them. For example `Sahara@66` becomes `Sahara%4066`.

### 5.2 Separate database host

If Postgres lives on a different server, install only the client tools on the app box:

```bash
sudo apt install -y postgresql-client-16
```

Provision the database on the DB host (same `CREATE USER` / `CREATE DATABASE` as above) and ensure the app server can reach it. Edit `pg_hba.conf` and `postgresql.conf` on the DB host to allow connections from the app server's IP, then:

```bash
sudo systemctl reload postgresql
```

Verify connectivity from the app server:

```bash
psql "postgresql://universe:PASSWORD@db.internal:5432/universe" -c "SELECT 1"
```

The `DATABASE_URL` then points at the remote host:
```
postgresql://universe:PASSWORD@db.internal:5432/universe
```

For production: enable TLS on the Postgres connection by appending `?sslmode=require` to the URL and configuring server certificates per the Postgres documentation.

### 5.3 Sizing

Postgres `max_connections` defaults to 100. The app's pool default is 50 (`DB_POOL_MAX`). Leave at least 30 connections free for migrations, ad-hoc queries, and monitoring. For a single Node process this is comfortable. If running PM2 cluster mode (multiple Node processes), each process has its own pool — ensure `processes × DB_POOL_MAX` stays well under `max_connections`.

## 6. Application deployment

The repo provides three deployment paths. Pick one. Do not mix them.

### 6.1 Option A — PM2 + Nginx (recommended for most deployments)

Best for: traditional Linux deployment, simple operational model, fine-grained logs.

Install Node, PM2, and Nginx:

```bash
# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm install -g pm2
```

Clone and build:

```bash
cd /opt
sudo git clone https://github.com/iwadaya/Darchville-Universe.git universe
sudo chown -R $USER:$USER /opt/universe
cd /opt/universe
npm run install:all
npm run build
```

Create the env file (see §7):

```bash
cp .env.example .env
nano .env   # fill in real values
chmod 600 .env
```

Start with PM2 using the bundled config:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup     # follow the printed command to enable on-boot start
```

The `ecosystem.config.cjs` already covers cluster mode, log rotation, and graceful reload. Useful commands:

```bash
pm2 status
pm2 logs universe
pm2 reload ecosystem.config.cjs   # zero-downtime restart after code changes
pm2 stop universe
```

Configure Nginx as a reverse proxy. Create `/etc/nginx/sites-available/universe`:

```nginx
server {
    listen 80;
    server_name universe.internal.company.com;

    client_max_body_size 50M;   # matches multer 50MB upload limit

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/universe /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Add TLS via Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d universe.internal.company.com
```

If the server is on an internal network without public DNS, use an internal CA or self-signed certificate instead.

### 6.2 Option B — Docker Compose

Best for: teams that already run a Docker host, want isolation, or prefer reproducible builds.

The repo includes a `Dockerfile` and a `docker-compose.yml`. The compose file starts the application and a Postgres container side by side.

Install Docker:

```bash
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out and back in for group to apply
```

Clone and configure:

```bash
cd /opt
sudo git clone https://github.com/iwadaya/Darchville-Universe.git universe
sudo chown -R $USER:$USER /opt/universe
cd /opt/universe
cp .env.example .env
nano .env
chmod 600 .env
```

Review `docker-compose.yml` first — the bundled file uses development defaults. For production, edit it to remove the bundled Postgres if you're using a separate DB host (§5.2), or strengthen its passwords if you keep it.

Bring up the stack:

```bash
docker compose up -d --build
docker compose logs -f
```

The application will be exposed on port 4000 by default. Front it with Nginx (same config as Option A) or use a reverse-proxy container if your team prefers. Operational commands:

```bash
docker compose ps
docker compose logs --tail=200 app
docker compose restart app
docker compose pull && docker compose up -d --build   # update
docker compose down                                    # stop everything
```

### 6.3 Option C — systemd (no PM2)

Best for: single-process deployments, environments that prohibit external process managers.

Install Node only:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Create a service user and clone:

```bash
sudo useradd --system --create-home --shell /bin/false universe
sudo -u universe git clone https://github.com/iwadaya/Darchville-Universe.git /home/universe/app
cd /home/universe/app
sudo -u universe npm run install:all
sudo -u universe npm run build
sudo -u universe cp .env.example .env
sudo -u universe nano .env
sudo chmod 600 /home/universe/app/.env
```

Create `/etc/systemd/system/universe.service`:

```ini
[Unit]
Description=Universe Reinsurance Pricing Tool
After=network.target postgresql.service
Requires=network.target

[Service]
Type=simple
User=universe
Group=universe
WorkingDirectory=/home/universe/app
EnvironmentFile=/home/universe/app/.env
ExecStart=/usr/bin/node server/src/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=universe

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/universe/app/uploads /home/universe/app/server/uploads

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now universe
sudo systemctl status universe
journalctl -u universe -f
```

Front with Nginx for TLS and connection management (same config as Option A).

## 7. Environment variables

Copy `.env.example` to `.env` and fill in real values. **Never commit the populated `.env` file** — it's in `.gitignore` already.

Key variables (full list in `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | Yes | App listens here. Default `4000` |
| `DATABASE_URL` | Yes | Postgres connection string |
| `SESSION_SECRET` | Yes | At least 64 random hex chars |
| `RUN_MIGRATIONS_ON_BOOT` | Yes | Set to `true` for first deploy and updates |
| `CORS_ORIGIN` | Yes | Set to the public URL, e.g. `https://universe.internal.company.com`. **Do not use `*` in production.** |
| `OPENAI_API_KEY` | No | Required only for AI slip ingestion |
| `UPLOAD_DIR` | No | Defaults to `./uploads` relative to project root |
| `DB_POOL_MAX` | No | Defaults to 50 |
| `DB_POOL_MIN` | No | Defaults to 4 |

## 8. First-run checklist

After starting the service for the first time:

1. **Confirm the process is alive.** `pm2 status` / `docker compose ps` / `systemctl status universe`. Look for "online" / "Up" / "active (running)".

2. **Hit the shallow health endpoint.** Should return JSON with `"status":"ok"` in well under a second:
   ```bash
   curl -s http://localhost:4000/api/health | jq
   ```

3. **Hit the deep health endpoint.** This forces a Postgres round-trip and returns pool stats:
   ```bash
   curl -s http://localhost:4000/api/health/deep | jq
   ```
   `db.ok` must be `true` and `pingMs` should be under ~50ms for a same-box DB, under ~10ms for a well-tuned separate host on the same network.

4. **Verify migrations ran.** Connect to Postgres and confirm:
   ```sql
   SELECT COUNT(*) FROM public.contract;        -- should not error
   SELECT * FROM public.audit_log LIMIT 1;      -- table should exist
   ```

5. **Verify reference data seeded.** On first boot the app seeds 75 countries, 32 currencies, 11 brokers, 11 treaty types, 14 classes of business, 22 cedants. Check:
   ```sql
   SELECT COUNT(*) FROM public.country;     -- expect 75
   SELECT COUNT(*) FROM public.currency;    -- expect 32
   ```

6. **Test login.** Browse to `https://universe.internal.company.com`. The login screen lists demo users. Default password is `demo2026` — see §10 below before going live.

7. **Confirm logs flow.** Tail your chosen runtime's logs and confirm one or two real requests show up cleanly with request IDs.

## 9. Updating the application

The flow for picking up new commits from this repository:

```bash
cd /opt/universe         # or /home/universe/app for Option C
git pull origin main
npm run install:all      # only if package.json changed
npm run build
# Then, depending on runtime:
pm2 reload ecosystem.config.cjs                # Option A
docker compose up -d --build                   # Option B
sudo systemctl restart universe                # Option C
```

Migrations run automatically on boot. Keep `RUN_MIGRATIONS_ON_BOOT=true` so schema changes apply on restart.

For tighter change control, an IT team can set `RUN_MIGRATIONS_ON_BOOT=false` and run migrations manually:

```bash
cd /opt/universe/server
npm run migrate     # applies all pending migrations
```

## 10. Security notes — read before going live

Several items in this snapshot are intentionally open for development and **must be addressed before exposing the application to anyone other than trusted internal users**:

1. **Demo authentication.** Every user logs in with the password `demo2026`. The login route at `server/src/routes/auth.js` accepts `password === DEMO_PASSWORD` for all users. Replace this with `bcrypt.compare(password, user.password_hash)` and remove the demo branch before production. The seeded users have a placeholder hash `DEMO_HASH_2026` that must also be replaced with real bcrypt hashes.

2. **Header-based role enforcement.** The API trusts an `x-user-role` header for authorisation. Anyone who can craft an HTTP request can claim any role. This is acceptable behind a corporate authentication proxy that strips and re-injects this header from a verified session — not acceptable when exposed directly. Either deploy behind such a proxy (Nginx + an SSO module, Cloudflare Access, etc.) or replace the header check with proper session/JWT validation.

3. **`_actor` field is client-controlled.** Audit events take their actor from `req.body._actor` when present. Server-derive this from the authenticated session before going live for compliance auditing.

4. **CORS is permissive by default.** `.env.example` sets `CORS_ORIGIN=*` for development. Set it to the application's public URL only.

5. **No CSP.** Helmet is initialised with `contentSecurityPolicy: false`. Enable a sensible CSP before production.

6. **Rate limiting is in-memory.** Adequate for one Node process. If running PM2 cluster mode or multiple replicas, swap for Redis-backed rate limiting (the code calls this out as a future change).

A coordinated remediation pass is the right way to handle these — don't tackle them piecemeal.

## 11. Backup and recovery

Minimum recommended posture:

- **Nightly `pg_dump`** of the `universe` database to off-host storage. Retain at least 30 days.
- **Weekly verification** that a dump can be restored to a scratch Postgres instance.
- **Uploads directory** (`/opt/universe/uploads` or equivalent) backed up alongside the database — slip and document files live there. If using Cloudinary instead of local storage, this directory is empty.

Sample backup command for cron:

```bash
0 2 * * * pg_dump -Fc "postgresql://universe:PASSWORD@localhost/universe" \
  > /var/backups/universe-$(date +\%F).dump
```

## 12. Monitoring and observability

The application exposes:

- **`/api/health`** — shallow health, no DB round-trip. Use for load-balancer probes.
- **`/api/health/deep`** — verifies DB reachability, returns pool stats. Use for ops dashboards. Watch `X-Pool-Waiting` header — sustained values above 0 mean `DB_POOL_MAX` needs raising.
- **OpenTelemetry** — set `OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` to emit traces. See `docs/observability.md` in the repo for a full setup recipe.
- **Prometheus** — `PROM_EXPORTER_PORT` (default `9464`) exposes a `/metrics` endpoint when OTel is enabled.

Logs go to stdout in JSON. Capture with PM2 / Docker / journalctl as appropriate.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED ::1:5432` on boot | Postgres not running or wrong `DATABASE_URL` | `systemctl status postgresql`, verify the URL with `psql "$DATABASE_URL"` |
| Migrations fail with `permission denied` | DB user lacks privileges | Re-run the `GRANT ALL` from §5.1 as the postgres superuser |
| Login screen lists no users | Reference data didn't seed; tables missing | Tail logs for migration errors. The auth route falls back to two demo users when DB tables aren't yet ready — that's the symptom. Re-run migrations. |
| `X-Pool-Waiting` consistently > 0 | Pool exhaustion under load | Raise `DB_POOL_MAX`, ensure Postgres `max_connections` has headroom |
| 502 Bad Gateway via Nginx | Node process down or wrong port | Check the runtime's status, confirm `proxy_pass` port matches `PORT` env var |
| AI slip ingest returns 500 | `OPENAI_API_KEY` missing or invalid | Set the env var, restart. Feature is optional — disable the slip-ingest button if AI not desired. |

## 14. Repository structure (orientation)

```
/                        Repo root
├── client/              React + Vite frontend
│   └── src/             Components, screens, hooks, utils
├── server/              Express API
│   └── src/
│       ├── app.js       Express composition root
│       ├── config/      Env loading + validation
│       ├── db/          Pool, migrations, optimistic locking
│       ├── routes/      One file per HTTP feature
│       ├── lib/         Logger, validators, helpers
│       ├── middleware/  Request ID, CORS, error handler, etc.
│       └── services/    Audit, approvals, assignments
├── shared/              Code used by both client and server (pricing math)
├── docs/                Architecture, audit, observability, scaling docs
├── load-test/           k6 scripts for capacity testing
├── docker-compose.yml   Option B
├── Dockerfile           Option B
├── ecosystem.config.cjs Option A (PM2)
├── render.yaml          Render deployment hints (informational)
└── .env.example         Environment template
```

## 15. Documents in `docs/` worth reading

| File | What it tells you |
|---|---|
| `docs/architecture.md` | Data model, quote/treaty duality, save patterns |
| `docs/database-design-audit.md` | Known schema-level issues and what's been addressed |
| `docs/optimistic-locking-coverage.md` | Where stale-write protection is wired |
| `docs/observability.md` | OTel + Prometheus setup |
| `docs/scaling.md` | Capacity testing protocol (numbers TBD) |
| `docs/actuarial-audit.md` | Math review findings, awaiting credentialed actuary signoff |
| `docs/migration-audit.md` | Migration discipline notes |

## 16. Open questions for the IT team

These are items that affect deployment shape and need a decision:

1. Should this run behind the corporate SSO terminator, or is the demo auth being replaced first? (See §10 item 1-2.)
2. Where do uploaded slip and document files belong — local disk, network share, or Cloudinary?
3. Backup retention policy — 30 days, 90 days, longer?
4. Is the AI slip-ingest feature in scope for go-live, or is it disabled at launch?
5. What's the patch cadence for the underlying Ubuntu, Node, and Postgres?

---

*This document is a snapshot. Confirm details against the latest code in the repository before relying on them in production.*
