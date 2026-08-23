# Universe — Deployment Handover

**Audience:** IT team standing up the Universe reinsurance pricing tool on an Ubuntu server.
**Source repo:** https://github.com/Darchville-Analytics/modelling_tool
**Canonical facts:** version-specific values (Node, Postgres, migration count) are stated once in the repo — `.nvmrc`, `docker-compose.yml`, `server/src/db/migrations/` — and this doc defers to them rather than restating exact numbers that drift.
**Maintainer contact:** the Darchville Analytics platform team (review routing in `.github/CODEOWNERS`).

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
| Client | React 19 + Vite, served as static SPA from the API server |
| API | Express 5 on Node (version pinned in `.nvmrc`) |
| Database | PostgreSQL 16 (bundled Docker stack); 14+ supported |
| File storage | Local filesystem by default; Cloudinary supported via env vars |
| Process management | PM2 (config provided), or Docker Compose (config provided), or systemd |

The Express server serves both the API under `/api/*` and the built SPA from `client/dist`. There is no separate frontend host required.

Migrations live in `server/src/db/migrations/` (run `npm run migrate:status --prefix server` for the current count and applied/pending state). Each migration runs in a single transaction with per-statement savepoints — a non-skippable failure rolls the whole migration back so a half-applied state is never recorded. They are idempotent and safe to re-run.

Migrations do **not** run on app boot by default (`RUN_MIGRATIONS_ON_BOOT=false`). Run them as an explicit pre-deploy step:

```bash
npm run migrate:status --prefix server   # show applied vs. pending
npm run migrate:up     --prefix server   # apply all pending
```

`render.yaml` wires `migrate:up` into Render's `preDeployCommand` so a bad migration fails the deploy cleanly instead of taking the previous version down on boot. The local `docker-compose.yml` keeps `RUN_MIGRATIONS_ON_BOOT=true` for dev convenience.

## 3. Server requirements

Minimum specification for ~30 concurrent users:

| Resource | Minimum | Comfortable |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB |
| Ubuntu | 22.04 LTS | 24.04 LTS |
| Node.js | see `.nvmrc` | see `.nvmrc` |
| PostgreSQL | 14 | 16+ |

Notes:
- The Node version is pinned in `.nvmrc` and `.node-version`. Use exactly what's there (`nvm use` selects it).
- The 4 GB minimum assumes Postgres on a separate host. Co-locating Postgres on the same box pushes the minimum to 8 GB.
- A real load test has not yet been run. Treat these numbers as a starting point and revise after measuring.

## 4. Pre-flight checklist

Before starting deployment, the IT team should obtain or decide:

- [ ] Server hostname or IP and SSH access
- [ ] Whether Postgres runs on the same Ubuntu box or a separate database server (§5)
- [ ] Which runtime to use: PM2 + Nginx, Docker Compose, or systemd (§6)
- [ ] Public DNS name for the application (e.g. `universe.internal.company.com`)
- [ ] TLS certificate strategy (Let's Encrypt via certbot, internal CA, or terminate at upstream proxy)
- [ ] AI keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) — all optional. Slip ingestion falls back across providers; without any AI key, the slip-ingest feature is unavailable but the rest of the app runs normally. AI features (slip upload/check, market intelligence) are gated by `AI_FEATURES_ENABLED`, which defaults to ON — so adding a provider key is enough to start sending treaty and document content to that provider. Set `AI_FEATURES_ENABLED=false` to keep AI off.
- [ ] A 64-byte random `SESSION_SECRET` (generate with `openssl rand -hex 32`)
- [ ] Confirmation the server can reach the relevant AI provider endpoints (`api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`) for any AI keys you intend to use
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
sudo git clone https://github.com/Darchville-Analytics/modelling_tool.git universe
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
sudo git clone https://github.com/Darchville-Analytics/modelling_tool.git universe
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
docker compose logs --tail=200 universe-app
docker compose restart universe-app
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
sudo -u universe git clone https://github.com/Darchville-Analytics/modelling_tool.git /home/universe/app
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
| `AUTH_JWT_SECRET` | **Yes (production)** | Signs/verifies the login bearer token. Must be ≥ 32 chars. **The server refuses to start in production without a strong value** (`server/src/config/env.js` → `validateEnv()` exits 1). Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. In dev/test a per-process ephemeral secret is minted automatically. |
| `SESSION_SECRET` | No (reserved) | Reserved for future cookie/session use; not consumed at runtime today, so it does **not** block boot. If you set it, it is strength-checked (≥ 32 chars, not the dev placeholder). Generate the same way as `AUTH_JWT_SECRET`. |
| `RUN_MIGRATIONS_ON_BOOT` | No | Defaults to `false`. Leave unset in production — run `npm run migrate:up --prefix server` as a pre-deploy step instead. Set to `true` only for the local docker-compose path. |
| `CORS_ORIGIN` | Yes | Set to the public URL, e.g. `https://universe.internal.company.com`. **Do not use `*` in production.** |
| `ALLOW_DEMO_AUTH` | No | **Dev/test only.** When `true`, enables the `demo2026` shortcut and `x-user-*` header identity. NEVER set in production — leave unset so only verified bearer tokens authenticate. |
| `ALLOW_NAME_AUTH` | No | **Client-pilot testing only** (e.g. the Saudi Re pilot). When `true`, `POST /api/auth/name-login` signs a tester in with just first name + surname (no password) and issues a normal revocable cookie session; an unknown name gets an Underwriter account with an unusable random password. Fail-closed — off unless exactly `true`. Remove once the pilot moves to credential/SSO login. |
| `AI_FEATURES_ENABLED` | No | Master gate for ALL AI features (slip upload/check, market intelligence). **Defaults to ON in every environment, production included.** Set it to `false` to turn AI off, after which every AI endpoint returns `403 AI_DISABLED` regardless of provider keys. A provider key is still required to make a call. |
| `OPENAI_API_KEY` | No | Required for AI market intelligence; slip ingestion tries Gemini first and falls back to OpenAI. Needs `AI_FEATURES_ENABLED=true` to take effect. |
| `UPLOAD_DIR` | No | Defaults to `./uploads` relative to project root |
| `CLOUDINARY_URL` (or `CLOUDINARY_CLOUD_NAME`/`API_KEY`/`API_SECRET`) | **Yes (production)** | Durable **private** object storage for uploads. Without it, production uploads fail `503 STORAGE_NOT_DURABLE` (a web dyno's disk is ephemeral). Override with `ALLOW_LOCAL_UPLOADS=true` only for a single box with a persistent mounted volume. |
| `CLAMAV_ENABLED` | Recommended (prod) | `true` streams every upload to clamd (`CLAMAV_HOST`/`PORT`/`TIMEOUT_MS`) before storage, fail-closed (infected → 422, scan unavailable → 503). |
| `REDIS_URL` | **Yes (multi-instance)** | Shared store for distributed rate limits. Per-process in-memory when unset; **required** for PM2 cluster mode or multiple replicas (see §10.2). |
| `PASSWORD_SCRYPT_COST` | No | log2 of scrypt's N work factor; default 15. Hashing is async (off the event loop). |
| `IDENTITY_SSO_ENABLED` + `IDENTITY_*` | Recommended (prod) | Enterprise SSO/MFA login posture and break-glass controls. See `docs/runbooks/sso-mfa-break-glass.md`. |
| `DB_POOL_MAX` | No | Defaults to 50 |
| `DB_POOL_MIN` | No | Defaults to 4 |

> **Boot-time secret gate.** With `NODE_ENV=production` the server validates secrets before serving and exits with a clear error if `AUTH_JWT_SECRET` is missing, the insecure dev placeholder, or shorter than 32 chars. A production container/host that doesn't supply it will not start (this is intentional — a missing secret would let anyone forge tokens).

> **Boot-time posture warnings.** Beyond the fatal secret gate, the server logs
> `[posture] …` warnings/errors at startup for valid-but-risky production
> settings: no durable upload storage (P1 #2), no `REDIS_URL` while running
> multi-instance (P1 #3), and SSO/MFA/break-glass gaps (P1 #6). These do **not**
> stop boot — review the startup log and clear them before go-live
> (`server/src/startup/productionPosture.js`).

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

6. **Test login (bearer-token auth).** Browse to `https://universe.internal.company.com`. Login is a real credential check: `POST /api/auth/login` verifies the password against the user's stored scrypt hash and returns a signed bearer token. The SPA stores that token and sends it as `Authorization: Bearer <token>` on every request; the server re-reads the user's role and authority level from the database on each request (the token carries only the user id), so a demotion takes effect immediately. There is **no** `demo2026`-for-everyone and **no** `x-user-*` header auth in production — those exist only under `ALLOW_DEMO_AUTH=true` for local dev (§7, §10).

   **First login / seeded users.** Migration `123_seed_users_force_change.sql` seeds three real accounts, each with the temporary password `Universe#1234` and `must_change_password=true`, so each is **forced to set a new password on first login** (hard server-side gate + mandatory client modal):

   | Username | Name | Role | Can create users? |
   |---|---|---|---|
   | `chongo.nkalamo` | Chongo Nkalamo | Chief Actuary (level 2) | Yes |
   | `edwin.taruvinga` | Edwin Taruvinga | Underwriter (level 5) | No |
   | `catho.ba` | Catho Ba | Underwriter (level 5) | No |

   **Seed a real admin / provision users.** Log in as the Chief Actuary (`chongo.nkalamo` / `Universe#1234`) — the only seeded account with user-creation authority (Chief level, ≤ 2) — and change its password when prompted. Then create real accounts via **Admin → Add User** (restricted to Chief Underwriter / Chief Executive / Chief Actuary). An account created without a password is given a generated one-time temp (returned to the creating admin to relay) and `must_change_password=true`; it never carries a shared/static hash. Rotate or deactivate any seeded account you don't need.

7. **Confirm logs flow.** Tail your chosen runtime's logs and confirm one or two real requests show up cleanly with request IDs.

## 9. Updating the application

The flow for picking up new commits from this repository:

```bash
cd /opt/universe         # or /home/universe/app for Option C
git pull origin main
npm run install:all      # only if package.json changed
npm run build

# Apply schema changes BEFORE restarting the app so a bad migration
# can't take the running version down. migrate:up is idempotent.
npm run migrate:status --prefix server   # confirm pending set
npm run migrate:up     --prefix server

# Then, depending on runtime:
pm2 reload ecosystem.config.cjs                # Option A
docker compose up -d --build                   # Option B — docker-compose
                                               # opts back in to boot-time
                                               # migrations, so the
                                               # pre-deploy step is
                                               # optional but harmless
sudo systemctl restart universe                # Option C
```

For an Option B (docker-compose) host that wants the same tighter control as A/C, unset `RUN_MIGRATIONS_ON_BOOT` in `docker-compose.yml` and run migrations before `up -d`. The runtime image has **no npm** (it is stripped for security), so inside the container call `node` directly rather than an npm script:

```bash
docker compose run --rm universe-app node server/src/db/migrate.js
```

Outside the container (from a checkout with dev deps installed) `npm run migrate:up --prefix server` is equivalent.

## 10. Security notes — read before going live

### Resolved since the original snapshot (verified — no action needed)

The auth-hardening work has landed; the items below are how the app behaves **today**:

1. **Real credential auth.** `POST /api/auth/login` verifies the password against the user's stored **scrypt** hash and issues a signed bearer token. The `demo2026` password is a dev/test convenience gated behind `ALLOW_DEMO_AUTH=true` and is **never honoured in production**. There is no `DEMO_HASH_2026` placeholder on real accounts — every create/update path stores a scrypt hash (`server/src/routes/auth.js`).

2. **Token-based, DB-backed authorisation.** Authorisation comes from the verified bearer token, not headers. `x-user-*` headers are trusted **only** under `ALLOW_DEMO_AUTH=true` (local dev). Role and authority level are re-read from the database on every request, so a stale token can't preserve elevated rights (`server/src/middleware/requestContext.js`).

3. **Server-derived audit actor.** Audit/approval events take the actor from the verified `req.user` identity, never a client-supplied `_actor`/header.

4. **Content-Security-Policy is enforcing.** Helmet ships an enforcing nonce-based CSP (`script-src` is `'self'` + per-request nonce; no `unsafe-inline` for scripts — the only `unsafe-inline` is a documented styles-only exception for React inline style attributes). `img-src`/`frame-src` also allow `https://res.cloudinary.com` for document previews when remote storage is configured. Violations are still collected at `/csp-report` for monitoring (see `SECURITY.md` → "Content-Security-Policy"). `server/src/app.js`.

5. **Password hashing is async + cost-calibrated.** scrypt runs off the event loop (no login-path blocking) at a tunable work factor (`PASSWORD_SCRYPT_COST`, default 2^15); legacy hashes verify unchanged and upgrade opportunistically on next login (`server/src/lib/passwordHash.js`).

6. **Upload hardening.** Every document upload is checked against a MIME/extension allowlist with magic-byte content sniffing (the stored `mime_type` is content-derived, not the client header), and optionally malware-scanned (ClamAV, fail-closed). Production refuses ephemeral local-disk storage by default (`server/src/lib/uploadValidation.js`, `uploadStorage.js`).

7. **Hardened container image.** Non-root runtime, `tini` PID 1, healthcheck, pinned minimal base; CI builds an SBOM (Syft) and scans the image (Trivy). See `SECURITY.md` → "Container image".

5. **Password policy.** A single enforced policy (`validatePasswordStrength`, used by both change-password and every user-creation path) requires a **minimum of 12 characters**, rejects the seeded temp `Universe#1234`, and rejects obviously weak/common values.

6. **Boot-time secret gate.** Production refuses to start without a strong `AUTH_JWT_SECRET` (see §7).

### Still your responsibility before / at go-live

1. **Set `CORS_ORIGIN` to the public URL** — never `*` in production. `.env.example` ships a development default.
2. **Rate limiting: set `REDIS_URL` for any multi-instance deploy.** Limits use a shared Redis/Valkey store when `REDIS_URL` is set (counts shared across instances; degrades to per-instance with a loud `[ratelimit] degraded` log if Redis drops). With it unset, limits are **per-process** — fine for a single Node process, but PM2 cluster mode or multiple replicas would let N processes allow N× the ceiling. The boot posture check flags this in production (`lib/rateLimitStore.js`, §7).
3. **Configure durable private upload storage and enable malware scanning.** Set `CLOUDINARY_URL` (uploads fail `503 STORAGE_NOT_DURABLE` in production otherwise) and `CLAMAV_ENABLED=true` with a reachable clamd. See §7 and `SECURITY.md`.
4. **Enable SSO + MFA and define break-glass accounts** for the enterprise login posture — `docs/runbooks/sso-mfa-break-glass.md`.
5. **Provide and protect `AUTH_JWT_SECRET`** as a real secret (secrets manager / env injection), and rotate the seeded users' temporary passwords on first login (§8).

## 11. Backup and recovery

The repo ships a checked-in, restore-**verified** backup pair (so backups are
reproducible, not tribal knowledge). They are operator-scheduled — installing the
schedule is your step; the app does not run them itself.

| Script | What it does |
|---|---|
| `scripts/backup-db.sh` | Compressed `pg_dump -Fc` of `DATABASE_URL` into `BACKUP_DIR` (default `/var/backups/universe`), then prunes dumps older than `BACKUP_RETENTION_DAYS` (default 30). Logs to stderr; prints the dump path on stdout. |
| `scripts/verify-restore.sh` | Restores the newest dump into a throwaway scratch DB on the same server, runs a sanity query (`public._migrations` and `public.country` row counts), drops the scratch DB, and **exits non-zero if the dump won't restore** — so a silently-corrupt backup is caught. |
| `scripts/universe-backup.cron` | Host-cron schedule: nightly dump (02:00) + weekly restore-rehearsal (Sun 03:30). |

**Schedule it.** On a self-hosted host (§6 Option A/C): set `DATABASE_URL` (and optionally `BACKUP_DIR`/`BACKUP_RETENTION_DAYS`) in the cron environment, then `crontab scripts/universe-backup.cron` (or drop it in `/etc/cron.d/`). Send dumps to off-host storage and retain ≥ 30 days. Verify by hand once:

```bash
DATABASE_URL=postgresql://universe:PASSWORD@localhost:5432/universe \
BACKUP_DIR=/var/backups/universe scripts/backup-db.sh
DATABASE_URL=postgresql://universe:PASSWORD@localhost:5432/universe \
BACKUP_DIR=/var/backups/universe scripts/verify-restore.sh   # exits 0 = restorable
```

**Production (Render) — the real fallback.** The production service deploys on Render (`render.yaml`) against a **managed Postgres** (`DATABASE_URL` is set in the dashboard, `sync: false`). Your first line of recovery there is the **managed provider's automated daily snapshots / point-in-time recovery** — confirm they are enabled and note the retention/RPO in your dashboard. Render has no host crontab, so to also keep the independent, restore-verified dumps above, run `scripts/backup-db.sh` (and a weekly `scripts/verify-restore.sh`) as **Render Cron Jobs** pointed at the same `DATABASE_URL`. Don't assume the host cron runs on Render — it doesn't.

**Uploads.** Back up the **uploads directory** (`/opt/universe/uploads` or your `UPLOAD_DIR`) alongside the database — slips and documents live there. If you use Cloudinary instead of local storage this directory is empty, and the equivalent backup is your Cloudinary account/retention.

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
| AI slip ingest / market intelligence returns `403 AI_DISABLED` | `AI_FEATURES_ENABLED` explicitly set to `false` — the gate is ON by default, so something turned it off | Remove the override (or set it to `true`) on the service and restart. In Render this is a dashboard env var — `render.yaml` only applies it on a blueprint sync. |
| AI slip ingest returns 500 or `403 AI_NOT_CONFIGURED` | Provider key (`OPENAI_API_KEY`/`GEMINI_API_KEY`) missing or invalid | Set the env var, restart. Feature is optional — disable the slip-ingest button if AI not desired. |

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
