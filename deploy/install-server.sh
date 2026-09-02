#!/usr/bin/env bash
# deploy/install-server.sh — one-shot host preparation for Ubuntu 22.04 / 24.04.
#
# Installs Node 20, PostgreSQL 16 and nginx, creates the `universe` service
# user and directories, clones the repository, provisions the database, writes
# /etc/universe/universe.env with generated secrets, and installs the systemd
# unit + nginx site. It does NOT build or start the app — run deploy/deploy.sh
# next (the script prints the exact command).
#
#   sudo APP_DOMAIN=universe.example.internal \
#        REPO_URL=https://github.com/iwadaya/Saudi_re.git GIT_REF=main \
#        bash deploy/install-server.sh
#
# Environment (all optional except APP_DOMAIN, and REPO_URL on a fresh box):
#   APP_DOMAIN    hostname users will browse to (nginx server_name, CORS origin)
#   REPO_URL      git URL to clone into APP_DIR when it is empty
#   GIT_REF       branch/tag to check out after cloning       (default: main)
#   APP_USER      service user                                (default: universe)
#   APP_DIR       code checkout                               (default: /opt/universe)
#   DB_NAME / DB_USER / DB_PASSWORD   passed to deploy/provision-db.sh
#   NODE_MAJOR    Node.js major from NodeSource               (default: 20)
#   PG_VERSION    PostgreSQL major                            (default: 16)
#   SKIP_POSTGRES=1   the database lives on another host (set DATABASE_URL instead)
#   DATABASE_URL  used verbatim in the env file when SKIP_POSTGRES=1
#
# Idempotent: re-running upgrades nothing destructively and never overwrites an
# existing /etc/universe/universe.env.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash deploy/install-server.sh" >&2; exit 1; }

APP_DOMAIN="${APP_DOMAIN:?set APP_DOMAIN (e.g. universe.example.internal)}"
APP_USER="${APP_USER:-universe}"
APP_DIR="${APP_DIR:-/opt/universe}"
APP_HOME="/var/lib/$APP_USER"
ENV_DIR="/etc/universe"
ENV_FILE="$ENV_DIR/universe.env"
GIT_REF="${GIT_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-20}"
PG_VERSION="${PG_VERSION:-16}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

log() { echo; echo "▶ $*"; }

log "1/8 base packages"
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg git nginx ufw ssl-cert openssl

log "2/8 Node.js $NODE_MAJOR"
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
  echo "   node $(node -v) already present"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -q nodejs
  echo "   installed node $(node -v)"
fi

if [ "${SKIP_POSTGRES:-0}" = 1 ]; then
  log "3/8 PostgreSQL — skipped (SKIP_POSTGRES=1); installing client tools only"
  apt-get install -y -q postgresql-client
else
  log "3/8 PostgreSQL $PG_VERSION"
  if ! apt-cache policy "postgresql-$PG_VERSION" | grep -q 'Candidate: [0-9]'; then
    echo "   adding the PostgreSQL apt repository (PGDG)"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -q
  fi
  apt-get install -y -q "postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION"
  systemctl enable --now postgresql
fi

log "4/8 service user and directories"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
  echo "   created user $APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME" "$APP_HOME/uploads" "$APP_DIR"
install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 /var/backups/universe

log "5/8 source checkout in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "   already a checkout — leaving as is (deploy/deploy.sh --ref updates it)"
elif [ -n "${REPO_URL:-}" ]; then
  runuser -u "$APP_USER" -- git clone --branch "$GIT_REF" "$REPO_URL" "$APP_DIR"
  echo "   cloned $REPO_URL @ $GIT_REF"
else
  echo "   ! $APP_DIR is empty and REPO_URL is unset — clone the repository there as $APP_USER before deploying" >&2
fi

log "6/8 database"
if [ "${SKIP_POSTGRES:-0}" = 1 ]; then
  DB_URL="${DATABASE_URL:?SKIP_POSTGRES=1 needs DATABASE_URL for the remote database}"
else
  DB_URL="$(bash "$KIT_DIR/provision-db.sh" | tail -1)"
  DB_URL="${DB_URL#DATABASE_URL=}"
fi

log "7/8 environment file $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  echo "   exists — not touched"
else
  gen_secret() { openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_'; }
  AUTH_SECRET="$(gen_secret)" SESSION_SECRET_VAL="$(gen_secret)" DB_URL="$DB_URL" ORIGIN="https://$APP_DOMAIN" \
  node -e '
    const fs = require("fs");
    const set = { DATABASE_URL: process.env.DB_URL, CORS_ORIGIN: process.env.ORIGIN,
                  AUTH_JWT_SECRET: process.env.AUTH_SECRET, SESSION_SECRET: process.env.SESSION_SECRET_VAL };
    const out = fs.readFileSync(process.argv[1], "utf8").split("\n").map((line) => {
      const m = /^([A-Z_]+)=/.exec(line);
      return m && set[m[1]] !== undefined ? `${m[1]}=${set[m[1]]}` : line;
    }).join("\n");
    fs.writeFileSync(process.argv[2], out, { mode: 0o600 });
  ' "$KIT_DIR/universe.env.example" "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  if grep -q '^DATABASE_URL=.*<existing password>' "$ENV_FILE"; then
    echo "   ! the DB role already existed, so its password is unknown here — edit DATABASE_URL in $ENV_FILE" >&2
  fi
  echo "   written with generated secrets (CORS_ORIGIN=https://$APP_DOMAIN)"
fi
ln -sfn "$ENV_FILE" "$APP_DIR/.env"   # dotenv picks it up for CLI scripts (migrate, seed, manage-user)

log "8/8 systemd unit + nginx site"
sed -e "s|^User=.*|User=$APP_USER|" -e "s|^Group=.*|Group=$APP_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$APP_HOME|" \
    -e "s|^ExecStart=.*|ExecStart=$(command -v node) server/src/index.js|" \
    "$KIT_DIR/universe.service" > /etc/systemd/system/universe.service
systemctl daemon-reload
systemctl enable universe >/dev/null 2>&1 || true

sed "s/universe\.example\.internal/$APP_DOMAIN/g" "$KIT_DIR/nginx/universe.conf" > /etc/nginx/sites-available/universe
ln -sfn /etc/nginx/sites-available/universe /etc/nginx/sites-enabled/universe
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
echo "   firewall: 22, 80, 443 open; 4000 and 5432 stay local"

cat <<NEXT

Host prepared.

  app user      $APP_USER        code  $APP_DIR
  env file      $ENV_FILE  (review it: sudo -e $ENV_FILE)
  uploads       $APP_HOME/uploads
  service       universe.service (enabled, not started yet)
  nginx         https://$APP_DOMAIN  (placeholder certificate — replace it, README Step 7)

Next: build, migrate, seed reference data and start the service:

  sudo $APP_DIR/deploy/deploy.sh --ref $GIT_REF

NEXT
