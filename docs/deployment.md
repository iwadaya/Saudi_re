# Deployment — internal test environment

Everything needed to stand up Universe 3 on a single Linux server for
internal testing by ~30 concurrent users. The target environment is
intentionally modest; production-grade scale-out lives in
[`scaling.md`](./scaling.md) once you've outgrown this.

---

## 1. Specification

### Hardware sizing

Sized against the measured k6 baseline (459 req/s sustained at 300
virtual users on a single Node process; p95 < 500 ms on every surface
except the dashboard aggregate). 30 real users generate nothing close
to that load, so this is deliberately over-provisioned for head-room.

| Role | Minimum | Recommended | Notes |
|------|---------|-------------|-------|
| App VM | 2 vCPU · 4 GB RAM · 40 GB SSD | **4 vCPU · 8 GB RAM · 60 GB SSD** | PM2 cluster defaults to 1 worker per CPU core (capped at 4) |
| Postgres | 2 vCPU · 4 GB RAM · 50 GB SSD | 2 vCPU · 4 GB RAM · 100 GB SSD | Can be co-located on the App VM for test only |
| Uplink | 100 Mbps | 1 Gbps | Excel exports and PDF uploads dominate the bytes |

**Recommendation for 30 users:** one VM (4/8/60) running app + Postgres,
or two small VMs (2/4/40 each) if you want separation. Either works.

### Software prerequisites

| Component | Version | Source |
|-----------|---------|--------|
| OS | Ubuntu Server 22.04 LTS (or Debian 12 / RHEL 9 equivalent) | |
| Node.js | **20.18.0** (pinned in `.nvmrc`) | nodesource repo or nvm |
| PostgreSQL | **16.x** | apt postgres-16 or managed service |
| nginx | latest stable | distro repo |
| PM2 | installed by `npm install` (listed in devDependencies) | npm |
| Git | latest | distro repo |
| Certbot | latest | snap or distro repo (only needed if you want TLS via Let's Encrypt) |

### Ports / network

| Port | Direction | Exposed? | Purpose |
|------|-----------|----------|---------|
| 22 | inbound | yes (SSH keys only, no password) | admin |
| 80 | inbound | yes | Let's Encrypt ACME challenge → 301 to 443 |
| 443 | inbound | yes | nginx terminates TLS, reverse-proxies to app |
| 4000 | internal | no (bind `127.0.0.1` only) | app HTTP |
| 5432 | internal | no | Postgres |
| 9464 | internal | no | Prometheus scrape (only if OTel enabled) |

### Environment variables

Declared in `/etc/universe/.env` (mode 600, owned by the service user).
See `README.md` for the full list; the deployment-critical ones:

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://universe:<password>@localhost:5432/universe
CORS_ORIGIN=https://universe.internal.example.com
UPLOAD_DIR=/var/lib/universe/uploads
RUN_MIGRATIONS_ON_BOOT=true
DB_POOL_MAX=50         # default; cluster mode re-derives per worker
SHUTDOWN_GRACE_MS=10000
# Pricing drift verifier: leave unset during warn-only rollout; set to 1
# only after the observability gate in docs/observability.md is satisfied.
# PRICING_STRICT=1

# Optional observability — leave blank to disable
OTEL_ENABLED=0
OTEL_EXPORTER_OTLP_ENDPOINT=
PROM_EXPORTER_PORT=9464
```

Secrets (`DATABASE_URL` password, any API keys) belong in this file.
**Do not commit a populated `.env` to git.**

---

## 2. Deployment — step by step

The steps assume **Ubuntu 22.04** on a fresh VM with a non-root sudo
user and your SSH public key already in `~/.ssh/authorized_keys`.
Adapt package names for Debian/RHEL as needed.

### 2.1 Provision the VM

Ubuntu cloud image or whatever your hypervisor gives you. One mount at
`/` is fine for a test install.

```bash
ssh admin@<vm-ip>
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone UTC
```

### 2.2 Install base packages

```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Postgres 16, nginx, build essentials, certbot
sudo apt install -y postgresql-16 postgresql-client-16 \
                    nginx build-essential git ufw \
                    certbot python3-certbot-nginx

node --version   # v20.18.x
psql --version   # psql (PostgreSQL) 16.x
```

### 2.3 Create a service user + directories

```bash
sudo useradd --system --create-home --home-dir /var/lib/universe --shell /usr/sbin/nologin universe
sudo mkdir -p /var/lib/universe/uploads /var/log/universe /etc/universe /opt/universe
sudo chown -R universe:universe /var/lib/universe /var/log/universe
sudo chown universe:universe /opt/universe
```

### 2.4 Configure the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status
```

### 2.5 Provision the database

```bash
sudo -u postgres psql <<'SQL'
  CREATE USER universe WITH PASSWORD '<generate-a-strong-one>';
  CREATE DATABASE universe OWNER universe;
  GRANT ALL PRIVILEGES ON DATABASE universe TO universe;
SQL
```

Keep Postgres bound to localhost (the default). Edit
`/etc/postgresql/16/main/postgresql.conf`:

```conf
listen_addresses = 'localhost'
max_connections = 100       # default; headroom for pool + migrations
```

Restart: `sudo systemctl restart postgresql`.

### 2.6 Clone, install, configure

```bash
sudo -u universe -H bash
cd /opt/universe
git clone --branch main <repo-url> .
git checkout <release-tag-or-branch>

npm run install:all          # root + server + client

sudo tee /etc/universe/.env > /dev/null <<'ENV'
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://universe:<password>@localhost:5432/universe
CORS_ORIGIN=https://universe.internal.example.com
UPLOAD_DIR=/var/lib/universe/uploads
RUN_MIGRATIONS_ON_BOOT=true
DB_POOL_MAX=50
SHUTDOWN_GRACE_MS=10000
OTEL_ENABLED=0
ENV
sudo chown universe:universe /etc/universe/.env
sudo chmod 600 /etc/universe/.env
```

### 2.7 Build the client bundle

```bash
cd /opt/universe
npm run build          # outputs client/dist
```

### 2.8 Run migrations

```bash
cd /opt/universe/server
DATABASE_URL=postgresql://universe:<password>@localhost:5432/universe \
  npm run migrate
```

Expect ~56 migration files to apply. An advisory lock guards against
races, so re-running is safe.

### 2.9 Start in cluster mode via PM2

```bash
cd /opt/universe

# Symlink .env to where the app looks for it
ln -sf /etc/universe/.env .env

# Cluster (defaults to min(CPUs, 4) workers)
npm run start:cluster

# Confirm it's up
curl -s http://127.0.0.1:4000/api/health | jq .
# expect {"status":"ok","requestId":"..."}
```

Persist across reboots:

```bash
pm2 startup systemd -u universe --hp /var/lib/universe
# Follow the printed sudo command, then:
pm2 save
```

### 2.10 Front with nginx + TLS

`/etc/nginx/sites-available/universe`:

```nginx
server {
  listen 80;
  server_name universe.internal.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name universe.internal.example.com;

  # Let's Encrypt will fill these in on first run
  ssl_certificate     /etc/letsencrypt/live/universe.internal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/universe.internal.example.com/privkey.pem;

  client_max_body_size 25M;      # xlsx imports, slip PDFs
  proxy_read_timeout   60s;
  proxy_send_timeout   60s;

  # Pass real client info through so rate limiter + logs are accurate
  proxy_set_header Host              $host;
  proxy_set_header X-Real-IP         $remote_addr;
  proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  # Gzip static assets (app already sets long-cache ETags)
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
  }
}
```

Enable + certificate:

```bash
sudo ln -s /etc/nginx/sites-available/universe /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d universe.internal.example.com
```

### 2.11 Log rotation

PM2 manages its own rotating logs. Also set up a daily logrotate so
app `/var/log/universe/*.log` doesn't fill the disk:

`/etc/logrotate.d/universe`:

```
/var/log/universe/*.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
```

### 2.12 Smoke test

```bash
# From your laptop
curl -s https://universe.internal.example.com/api/health | jq .
# {"status":"ok","requestId":"...","env":"production"}

# Deep health — requires DB
curl -s https://universe.internal.example.com/api/health/deep | jq .
# ...returns db.ok:true, pool stats, no 'x-pool-waiting' hits at rest
```

Then open the URL in a browser, log in, and walk through a quick
prop treaty to prove the wizard, save, and back/next all work.

---

## 3. Operations

### Rolling reload (zero-downtime)

```bash
cd /opt/universe
git pull
npm run install:all
npm run build
cd server && npm run migrate && cd ..
npm run cluster:reload        # restarts workers one at a time
```

### Stop / start / status / logs

```bash
npm run cluster:stop
npm run start:cluster
npm run cluster:status
npm run cluster:logs          # tails all workers, merged stream
```

### Database backup

```bash
# Daily cron as postgres user
pg_dump -Fc universe > /var/backups/universe/universe-$(date +%F).dump
# Keep 14 days
find /var/backups/universe/ -name '*.dump' -mtime +14 -delete
```

### Health monitoring

Hit `/api/health/deep` every 30 s from your monitoring system
(Uptime-Kuma, Datadog, Pingdom — any HTTP check). The response
includes pool stats and a `x-pool-waiting` header. Non-zero for
more than a minute at a time = bump `DB_POOL_MAX`.

### Enabling OpenTelemetry (optional)

If/when you want traces + metrics, edit `/etc/universe/.env`:

```env
OTEL_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318
OTEL_SERVICE_NAME=universe-server
```

Then `npm run cluster:reload`. See [`observability.md`](./observability.md)
for three copy-paste collector setups (Grafana Cloud, local
Jaeger+Prometheus, Honeycomb).

---

## 4. Security baseline

- **SSH:** key-only, `PasswordAuthentication no` in `/etc/ssh/sshd_config`.
- **Firewall:** ufw allows only 22/80/443 inbound; everything else denied.
- **TLS:** Let's Encrypt certs auto-renew via certbot's systemd timer.
- **Secrets:** `/etc/universe/.env` mode 600, owned by `universe:universe`.
  Not in git.
- **Database:** listens on 127.0.0.1 only; app connects via Unix socket
  would be even tighter but TCP/localhost is fine for test.
- **Application user:** runs as `universe` (non-root). No shell.
- **Patching:** `sudo unattended-upgrades` enabled, or manual
  `apt update && apt upgrade` monthly.

---

## 5. Troubleshooting

| Symptom | Likely cause | Diagnostic |
|---------|--------------|------------|
| `/api/health` returns 502 via nginx | App not listening | `pm2 status`, then `pm2 logs` |
| `/api/health/deep` returns `db.ok: false` | Postgres down or wrong DATABASE_URL | `sudo systemctl status postgresql`; `psql "$DATABASE_URL" -c 'select 1'` |
| `x-pool-waiting > 0` under load | DB pool saturated | Bump `DB_POOL_MAX` in `.env`; raise Postgres `max_connections` if needed |
| Save endpoints returning 400 VALIDATION_FAILED | Client/schema drift | The error body lists offending `fields[]` — check `server/src/validation/` for the schema used on that route |
| Dashboard 500 `column cob.class_name does not exist` | Schema drift — pre-May-2026 fix | Pull `fa44afa` or later |
| Browser shows stale UI after deploy | Browser cache | Hard refresh (Cmd-Shift-R) or append `?v=<build-hash>` query to test |
| PM2 worker restarting repeatedly | App-level error at boot | `pm2 logs universe --lines 200`; check migration output |
| Disk filling | Logs + uploads + backups | `du -sh /var/log/universe /var/lib/universe/uploads /var/backups/universe` |

---

## 6. Rollback

```bash
cd /opt/universe
git log --oneline -20                 # pick a known-good commit
git checkout <good-commit>
npm run install:all && npm run build
cd server && npm run migrate && cd .. # migrations are idempotent
npm run cluster:reload
```

If a migration itself is the problem, restore the Postgres dump:

```bash
sudo -u postgres pg_restore --clean --if-exists \
  -d universe /var/backups/universe/universe-<date>.dump
```

---

## 7. Deployment Changelog

| Date | Change | Production env state | Notes |
| --- | --- | --- | --- |
| 2026-05-01 | Pricing drift strict-mode rollout recorded. | `PRICING_STRICT` remains unset for the 7-day warn-only window. Set `PRICING_STRICT=1` only after the triage tail is empty for 48h. | Runbook: [`observability.md` → Pricing Drift Triage](./observability.md#pricing-drift-triage). The production change is `/etc/universe/.env`: add `PRICING_STRICT=1`, then `npm run cluster:reload`. Monitor `422 PRICING_DRIFT` and fix drift sources rather than rolling back the flag. |

---

## 8. Converting this doc to PDF

Run on your Mac (or on the VM after `sudo apt install -y pandoc`):

```bash
# Basic
pandoc docs/deployment.md -o deployment.pdf

# Styled (needs a LaTeX toolchain — wkhtmltopdf alt below)
pandoc docs/deployment.md -o deployment.pdf \
  --pdf-engine=xelatex \
  -V geometry:margin=1in -V fontsize=11pt \
  --toc --toc-depth=2

# No LaTeX? Use wkhtmltopdf via html intermediate
pandoc docs/deployment.md -o deployment.html --standalone --toc
wkhtmltopdf deployment.html deployment.pdf
```
