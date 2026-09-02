# Universe — Linux + PostgreSQL deployment manual

Step-by-step instructions for standing up Universe on **one Linux server**:
the app as a single Node process under **systemd**, **nginx** terminating TLS,
and **PostgreSQL 16** on the same box (or a separate DB host — noted where it
differs). The database is migrated and seeded with **reference data only**
(countries, currencies, brokers, reinsurers, cedants, treaty types, classes of
business, roles). **No contracts, quotes or claims are ever seeded.**

Everything referenced here lives in this `deploy/` directory:

| File | Purpose |
|---|---|
| `install-server.sh` | One-shot host preparation (packages, user, DB, env file, systemd, nginx, firewall). Steps 1–4 and 6–7 in one go. |
| `provision-db.sh` | Creates the Postgres role + database, prints a ready `DATABASE_URL`. |
| `deploy.sh` | Release/update: fetch → `npm ci` → build → migrate → seed reference data → restart → smoke test. |
| `smoke-test.sh` | Health, DB, user-list, SPA and (optionally) login checks against a running instance. |
| `universe.env.example` | Production environment template → `/etc/universe/universe.env`. |
| `universe.service` | systemd unit (hardened, read-only code, writable uploads only). |
| `nginx/universe.conf` | nginx site: HTTP→HTTPS redirect, TLS, reverse proxy to `127.0.0.1:4000`. |

Verified on: Ubuntu 24.04, Node 20/22, PostgreSQL 16, commit of this manual.
Time to a working instance on a fresh VM: roughly 20 minutes.

---

## 0. Before you start

**Server.** Ubuntu 22.04 or 24.04 LTS, 4 vCPU, 8 GB RAM, 60 GB SSD (2 vCPU / 4 GB
works for a pilot). A non-root sudo user with your SSH key. Outbound HTTPS to
`deb.nodesource.com`, `apt.postgresql.org` (22.04 only) and your git host.

**Decide and have ready:**

- [ ] The hostname users will type: e.g. `universe.example.internal` (call it `APP_DOMAIN` below). DNS must resolve to the server.
- [ ] A TLS certificate for that hostname from your corporate CA, **or** a public hostname for Let's Encrypt. **TLS is mandatory** — the app marks its login cookie `Secure` in production, so over plain `http://` every login silently fails.
- [ ] Git access to this repository from the server (HTTPS token or deploy key) and the branch/tag to deploy.
- [ ] Same-box PostgreSQL (default) or the connection details of a separate PostgreSQL 14+ server.
- [ ] Who will hold the Chief Underwriter password (Step 9).

**Ports.** 22 (SSH), 80 and 443 (nginx) inbound. 4000 (app) and 5432 (Postgres) stay on localhost.

---

## 1. Prepare the server

**Automated (recommended)** — run `install-server.sh` from a checkout of this repo.
It performs Steps 1, 2, 3 (clone), 4, 6 and 7 and is safe to re-run:

```bash
# On the server, as your sudo user:
git clone https://github.com/iwadaya/Saudi_re.git /tmp/universe-kit
sudo APP_DOMAIN=universe.example.internal \
     REPO_URL=https://github.com/iwadaya/Saudi_re.git GIT_REF=main \
     bash /tmp/universe-kit/deploy/install-server.sh
```

It prints what it created and the exact `deploy.sh` command to run next. If you
used it, continue at **Step 5**, then come back to **Step 7** for the real
certificate. Read on if you prefer, or are required, to do each step by hand.

**By hand:**

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ca-certificates gnupg git nginx ufw ssl-cert openssl

# Node.js 20 LTS (NodeSource). Node 22 also works.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # v20.x

# PostgreSQL 16. Ubuntu 24.04 has it in the archive; on 22.04 add the PGDG repo first:
#   sudo install -d /usr/share/postgresql-common/pgdg
#   sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
#   echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
#   sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql

# Service user and directories
sudo useradd --system --create-home --home-dir /var/lib/universe --shell /usr/sbin/nologin universe
sudo install -d -o universe -g universe -m 750 /var/lib/universe/uploads /opt/universe /var/backups/universe
sudo install -d -o root -g universe -m 750 /etc/universe

# Firewall
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

Postgres stays bound to `localhost` (the default in `/etc/postgresql/16/main/postgresql.conf`).
`max_connections = 100` is enough: the app pool is 50 per process and there is one process.

---

## 2. Create the database

**Automated:** `sudo deploy/provision-db.sh` creates role `universe` (login, not
superuser) and database `universe` owned by it, generates a password, and prints
the `DATABASE_URL` line to paste into the env file. Re-running never changes an
existing password unless you pass `DB_PASSWORD=…`.

**By hand:**

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE universe WITH LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE universe OWNER universe ENCODING 'UTF8' TEMPLATE template0;
SQL
```

No superuser grants are needed: the migrations create the `pgcrypto` and
`uuid-ossp` extensions, which the database owner may do on PostgreSQL 13+.

The connection string is `postgresql://universe:PASSWORD@localhost:5432/universe`.
URL-encode special characters in the password (`@`→`%40`, `:`→`%3A`, `/`→`%2F`,
`#`→`%23`, `%`→`%25`).

**Separate DB host:** run the SQL there, allow the app server's IP in
`pg_hba.conf`, set `listen_addresses`, and use
`postgresql://universe:PASSWORD@db.internal:5432/universe?sslmode=require`.
On the app server install only `postgresql-client-16` and run
`install-server.sh` with `SKIP_POSTGRES=1 DATABASE_URL=…`.

---

## 3. Get the code

```bash
sudo -u universe git clone --branch main https://github.com/iwadaya/Saudi_re.git /opt/universe
```

The checkout is owned by `universe`; the service reads it read-only. To deploy a
specific tag or branch later, use `deploy.sh --ref <ref>` (Step 5).

---

## 4. Configure the environment

All configuration is one file, `/etc/universe/universe.env`, read by systemd
(`EnvironmentFile=`) and by the CLI scripts through the `/opt/universe/.env`
symlink. Plain `KEY=VALUE` lines, no quotes.

```bash
sudo install -m 640 -o root -g universe /opt/universe/deploy/universe.env.example /etc/universe/universe.env
sudo ln -sfn /etc/universe/universe.env /opt/universe/.env

# Generate the two secrets (>= 32 chars each):
openssl rand -base64 48 | tr '+/' '-_'     # → AUTH_JWT_SECRET
openssl rand -base64 48 | tr '+/' '-_'     # → SESSION_SECRET

sudo -e /etc/universe/universe.env
```

Set every `CHANGE_ME` value:

| Key | Value |
|---|---|
| `DATABASE_URL` | from Step 2 |
| `CORS_ORIGIN` | `https://APP_DOMAIN` — exactly what users type, no trailing slash |
| `AUTH_JWT_SECRET`, `SESSION_SECRET` | the generated secrets |

Leave the rest at the template defaults unless you know why:
`NODE_ENV=production`, `PORT=4000`, `RUN_MIGRATIONS_ON_BOOT=false`,
`UPLOAD_DIR=/var/lib/universe/uploads`, `ALLOW_LOCAL_UPLOADS=true`,
`AI_FEATURES_ENABLED=false`, `OTEL_ENABLED=0`. The template documents each.

The server **refuses to boot** in production if `AUTH_JWT_SECRET` is missing, a
placeholder, or shorter than 32 characters, or if `ALLOW_DEMO_AUTH` is set. That
is deliberate.

---

## 5. Build, migrate, seed reference data, start

**Automated (recommended):**

```bash
sudo /opt/universe/deploy/deploy.sh --ref main
```

`deploy.sh` runs, in order and stopping on the first failure:

1. `git fetch` + checkout of `--ref` (as `universe`).
2. `npm ci` for root, client and server — reproducible installs from the lockfiles.
3. `npm run build --prefix client` → `client/dist` (the API serves it).
4. `npm run migrate:status` then `npm run migrate:up` — every pending SQL migration (149 on a fresh database today), idempotent, under an advisory lock. They run **before** the restart so a failing migration never takes a running instance down.
5. `node server/src/db/seeds/run.js` — the reference-data seed (details in §12). It counts `contract`, `quote`, `claim` and `uw_user` before and after and **aborts if any of them changed**. It then calls `npm run seed:deploy`, the test-portfolio hook, which is a **no-op while `SEED_ON_DEPLOY` is unset** — keep it unset on this server.
6. `systemctl restart universe` and `deploy/smoke-test.sh`.

The first run also needs the service installed (Step 6) before step 6 succeeds;
`install-server.sh` did that for you. If you are going by hand, run
`deploy.sh --no-restart` now, do Step 6, then `sudo systemctl start universe`.

**By hand (what the script does):**

```bash
sudo -u universe -H bash -c 'cd /opt/universe && set -a && . /etc/universe/universe.env && set +a &&
  npm ci --include=dev && npm ci --include=dev --prefix client && npm ci --prefix server &&
  npm run build --prefix client &&
  npm run migrate:status --prefix server && npm run migrate:up --prefix server &&
  npm run seed:reference'
```

Expected tail of the seed output on a fresh database:

```
Reference data after seeding:
  countries            75
  currencies           32
  brokers              11
  reinsurers           25
  cedants              40
  treaty_types         11
  classes_of_business  15
  roles                9
Business data (unchanged):
  contracts  0
  quotes     0
  claims     0
  users      6
```

`npm run seed:reference:check` prints the same report without writing anything —
use it any time to confirm a database holds no contracts.

---

## 6. Install the systemd service

```bash
sudo install -m 644 /opt/universe/deploy/universe.service /etc/systemd/system/universe.service
sudo systemctl daemon-reload
sudo systemctl enable --now universe
sudo systemctl status universe --no-pager
journalctl -u universe -f          # JSON logs; Ctrl-C to stop
```

The unit runs `node server/src/index.js` as `universe` in `/opt/universe`, with
`ProtectSystem=strict` (code is read-only) and `ReadWritePaths=/var/lib/universe`
(uploads). `Restart=always`. A `SIGTERM` drains in-flight requests for up to 10 s.

Expected startup log lines: `database connection verified`, `migrations skipped`
(correct — deploy.sh already ran them), `reference data ready`, `http server
listening`. Three `[posture]` warnings are expected for this single-server,
local-login deployment and need no action: SSO is off, `REDIS_URL` is unset
(one process, so per-process rate limits are exact), and uploads use local disk
(`ALLOW_LOCAL_UPLOADS=true` — the disk is persistent here and Step 10 backs it up).

---

## 7. nginx and TLS

```bash
sudo install -m 644 /opt/universe/deploy/nginx/universe.conf /etc/nginx/sites-available/universe
sudo sed -i 's/universe\.example\.internal/universe.example.internal/g' /etc/nginx/sites-available/universe   # your APP_DOMAIN
sudo ln -sfn /etc/nginx/sites-available/universe /etc/nginx/sites-enabled/universe
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The site ships pointing at Ubuntu's placeholder certificate so nginx starts
immediately. **Replace it before users log in:**

*Corporate CA / purchased certificate:* copy the full-chain certificate and key
into place and update the two `ssl_certificate*` lines:

```bash
sudo install -m 644 fullchain.pem /etc/ssl/certs/universe.pem
sudo install -m 600 privkey.pem   /etc/ssl/private/universe.key
sudo sed -i 's#/etc/ssl/certs/ssl-cert-snakeoil.pem#/etc/ssl/certs/universe.pem#; s#/etc/ssl/private/ssl-cert-snakeoil.key#/etc/ssl/private/universe.key#' /etc/nginx/sites-available/universe
sudo nginx -t && sudo systemctl reload nginx
```

*Let's Encrypt (public hostname only):*

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d universe.example.internal     # rewrites the ssl_certificate lines, sets up auto-renewal
```

The proxy passes `X-Forwarded-For`/`-Proto` and the app trusts exactly one proxy
hop, so rate limiting and audit IPs are the real client's. `client_max_body_size`
is 50 MB to match the API's upload limit.

---

## 8. Smoke test

```bash
/opt/universe/deploy/smoke-test.sh                                  # local, via the app port
BASE_URL=https://universe.example.internal /opt/universe/deploy/smoke-test.sh   # through nginx + TLS
```

Checks: `/api/health` (status ok, env production), `/api/health/deep` (`db.ok`
true with ping time and pool size), the login user list is served from the
database, and `GET /` returns the SPA. Add `SMOKE_USER`/`SMOKE_PASSWORD` to
prove a real login sets the `auth_token` cookie; add `SMOKE_INSECURE=1` while
the placeholder certificate is still in place. Exit code 0 means all green.

Then open `https://APP_DOMAIN` in a browser and log in (next step).

---

## 9. First login and locking down the seeded accounts

The migrations create **six generic demo personas**, all with the password
`demo2026`:

| Username | Role | Purpose |
|---|---|---|
| `chief.underwriter` | Chief Underwriter (level 2) | Approvals authority; can create and manage users |
| `retro.manager` | Retro Manager (level 3) | Outwards retrocession programmes |
| `underwriter1` … `underwriter4` | Underwriter (level 4) | Pricing personas |

Treat `demo2026` as public. Before sharing the URL:

```bash
cd /opt/universe/server

# 1. Give the Chief Underwriter account a real password (prompted, hidden), then log in with it.
sudo -u universe -H node scripts/manage-user.js set-password chief.underwriter

# 2. Either retire the other personas…
sudo -u universe -H node scripts/manage-user.js deactivate underwriter1   # …2, 3, 4, retro.manager
#    …or hand them to real people with a one-time password they must change on first login:
sudo -u universe -H NEW_PASSWORD='<temp password>' node scripts/manage-user.js set-password underwriter1 --must-change

sudo -u universe -H node scripts/manage-user.js list
```

Every `manage-user` action revokes the account's live sessions and writes an
`audit_log` row with actor `OPS_CLI`. Passwords must be at least 12 characters
and not a common value — the same policy the app enforces. The tool refuses to
deactivate the last active admin-level account.

Now log in as `chief.underwriter` and create real users from the **⚙ USERS**
button in the top bar (`/admin/users`); each new account gets a generated
one-time temporary password and is forced to change it on first login. Real names for the pilot testers can also be enabled via the
passwordless name login (`ALLOW_NAME_AUTH=true` in the env file, then
`sudo systemctl restart universe`) — supervised pilots only; turn it off after.

---

## 10. Backups

`scripts/backup-db.sh` (compressed `pg_dump`, local retention) and
`scripts/verify-restore.sh` (proves the newest dump restores) are already in the
repo; `scripts/universe-backup.cron` schedules them nightly at 02:00 and weekly.

```bash
sudo install -m 640 -o root -g root /dev/stdin /etc/cron.d/universe-backup <<'CRON'
SHELL=/bin/bash
BACKUP_DIR=/var/backups/universe
BACKUP_RETENTION_DAYS=30
0 2 * * *  universe  cd /opt/universe && set -a && . /etc/universe/universe.env && set +a && scripts/backup-db.sh >> /var/lib/universe/backup.log 2>&1
30 3 * * 0 universe  cd /opt/universe && set -a && . /etc/universe/universe.env && set +a && scripts/verify-restore.sh >> /var/lib/universe/backup.log 2>&1
CRON
```

`verify-restore.sh` creates and drops a scratch database on the same server, so
grant the role that right once: `sudo -u postgres psql -c 'ALTER ROLE universe CREATEDB'`.
Copy `/var/backups/universe` **and** `/var/lib/universe/uploads` off the box
(rsync/S3; `BACKUP_S3_BUCKET` is supported by the scripts — see
`docs/backup-recovery.md`). Run each script by hand once and check the log.

---

## 11. Updating to a new version

```bash
sudo /opt/universe/deploy/deploy.sh --ref main        # or a tag: --ref v3.2.0
```

Same six steps as the first install; migrations and the reference seed are
idempotent, so an update that changes neither is harmless. A deploy never loads
test contracts unless `SEED_ON_DEPLOY` is set in the env file. Downtime is the
service restart (a few seconds). Flags: `--no-git` (deploy what is on disk),
`--skip-install`, `--skip-build`, `--no-seed`, `--no-restart`.

**Rollback:** `sudo deploy/deploy.sh --ref <previous tag or commit>` redeploys
the old code. Migrations are forward-only; if a migration itself is the problem,
restore the last dump first:

```bash
sudo systemctl stop universe
sudo -u postgres pg_restore --clean --if-exists -d universe /var/backups/universe/universe-<stamp>.dump
sudo deploy/deploy.sh --ref <previous ref>
```

---

## 12. What gets seeded (and what does not)

| Seeded on deploy | Source | Rows on a fresh DB |
|---|---|---|
| Countries (with region) | migrations 005/045 + `ensureReferenceData` | 75 |
| Currencies + USD exchange rates | migrations 005/016 + `ensureReferenceData` | 32 |
| Country inflation series | migration 013 | per country |
| CRESTA zones, fac property reference, taxonomies | migrations 008/077/078/134 | — |
| Brokers | `ensureReferenceData` | 11 |
| Reinsurers | `ensureReferenceData` + `seeds/002_reference_data.sql` (GCC extras) | 25 |
| Cedants (companies) | `ensureReferenceData` + `seeds/002_reference_data.sql` (GCC extras) | 40 |
| Treaty types, classes of business | migrations + `ensureReferenceData` | 11 / 15 |
| Roles and mandate hierarchy | migrations 034/118/143 | 9 |
| Demo user personas | migrations 034/123/132/143 | 6 (rotate — Step 9) |

| **Never seeded by a deploy** | How it would get there |
|---|---|
| Contracts, quotes, renewals, claims, finance | only by users, or by the explicit test-data scripts below |
| Uploaded documents | only by users |

The test-portfolio generators (`npm run seed:treaties`, `npm run seed:loadtest`)
only run when someone invokes them, or when `SEED_ON_DEPLOY` is set in the env
file (`1` loads the fabricated treaty portfolio once, `reset` reloads it on every
deploy — see `docs/seed-test-treaties.md`). Keep that variable unset on this
server. `npm run seed:reference:check` will show `contracts 0` for as long as
that holds.

---

## 13. Operations cheat-sheet

| Task | Command |
|---|---|
| Status / logs | `systemctl status universe` · `journalctl -u universe -f` |
| Restart | `sudo systemctl restart universe` |
| Health | `curl -s localhost:4000/api/health/deep` |
| Deploy / update | `sudo /opt/universe/deploy/deploy.sh --ref <ref>` |
| Migrations pending? | `cd /opt/universe && sudo -u universe -H npm run migrate:status` |
| Reference data counts | `cd /opt/universe && sudo -u universe -H npm run seed:reference:check` |
| Users | `cd /opt/universe/server && sudo -u universe -H node scripts/manage-user.js list` |
| Reset a password | `… node scripts/manage-user.js set-password <user> [--must-change]` |
| Unlock (clears lockout too) | `… node scripts/manage-user.js set-password <user>` |
| Change config | `sudo -e /etc/universe/universe.env && sudo systemctl restart universe` |
| Disk | `du -sh /var/lib/universe/uploads /var/backups/universe` |

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Service exits at once; log says `AUTH_JWT_SECRET is required` / `must not be a placeholder` | Step 4 incomplete | Set a real ≥32-char secret in `/etc/universe/universe.env`, restart |
| `ALLOW_DEMO_AUTH must not be enabled in production` | dev flag in env file | Remove it |
| Login form submits but you stay logged out; network tab shows the `auth_token` cookie is not stored | Browsing over `http://` — cookie is `Secure` | Use `https://` (Step 7); check `CORS_ORIGIN` matches the URL exactly |
| `502 Bad Gateway` from nginx | app not listening on 4000 | `systemctl status universe`, `journalctl -u universe -n 100` |
| `ECONNREFUSED …:5432` or `password authentication failed` | wrong `DATABASE_URL` | `psql "$DATABASE_URL" -c 'select 1'` as `universe`; re-run `provision-db.sh` with `DB_PASSWORD=` to rotate |
| `permission denied for schema public` during migrate | DB not owned by the role | `sudo -u postgres psql -c 'ALTER DATABASE universe OWNER TO universe'` |
| Login screen shows `cuo` / `underwriter` only | migrations never ran (demo fallback) | `sudo deploy/deploy.sh --no-git` and check step 4 output |
| `vite: not found` during build | `npm ci` ran with `NODE_ENV=production` and skipped devDependencies | use `deploy.sh` (it passes `--include=dev`) or `npm ci --include=dev --prefix client` |
| Uploads fail with `503 STORAGE_NOT_DURABLE` | `ALLOW_LOCAL_UPLOADS` unset | keep `ALLOW_LOCAL_UPLOADS=true` + `UPLOAD_DIR` under `/var/lib/universe` |
| Uploads fail with `EACCES` | `UPLOAD_DIR` outside `ReadWritePaths` | keep it under `/var/lib/universe`, or extend `ReadWritePaths` in the unit |
| `X-Pool-Waiting` > 0 sustained on `/api/health/deep` | DB pool saturated | raise `DB_POOL_MAX` (keep < Postgres `max_connections` − 20) |
| Page looks stale after a deploy | browser cache | hard refresh (Ctrl/Cmd-Shift-R) |

For the wider background (architecture, security posture, PM2 cluster option,
observability, Render/Docker paths) see `DEPLOYMENT.md`, `SECURITY.md`,
`docs/deployment.md` and `docs/scaling.md`.
