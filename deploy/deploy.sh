#!/usr/bin/env bash
# deploy/deploy.sh — release (or update) Universe on this server.
#
#   sudo deploy/deploy.sh                 # deploy the checked-out branch's latest commit
#   sudo deploy/deploy.sh --ref v3.1.0    # deploy a tag / branch / commit
#   sudo deploy/deploy.sh --no-git        # skip fetch/checkout (deploy what is on disk)
#
# Steps, in order — each one must succeed before the next runs:
#   1. git fetch + checkout the requested ref          (as the app user)
#   2. npm ci for root, client and server              (reproducible, from lockfiles)
#   3. build the client bundle (client/dist)
#   4. apply pending DB migrations                     (BEFORE the restart, so a bad
#                                                       migration never takes the
#                                                       running app down)
#   5. seed reference data (countries, currencies, …)  (idempotent; never contracts —
#                                                       the SEED_ON_DEPLOY test-portfolio
#                                                       hook stays a no-op unless set)
#   6. restart the systemd service and smoke-test it
#
# Flags: --ref <ref>  --no-git  --skip-install  --skip-build  --no-restart  --no-seed
# Env:   APP_DIR (default: the repo this script lives in)  APP_USER=universe
#        ENV_FILE=/etc/universe/universe.env  SERVICE=universe  GIT_REF (same as --ref)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_USER="${APP_USER:-universe}"
ENV_FILE="${ENV_FILE:-/etc/universe/universe.env}"
SERVICE="${SERVICE:-universe}"
REF="${GIT_REF:-}"
DO_GIT=1 DO_INSTALL=1 DO_BUILD=1 DO_RESTART=1 DO_SEED=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift ;;
    --ref=*) REF="${1#--ref=}" ;;
    --no-git) DO_GIT=0 ;;
    --skip-install) DO_INSTALL=0 ;;
    --skip-build) DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --no-seed) DO_SEED=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { echo; echo "▶ $*"; }
die()  { echo "✗ $*" >&2; exit 1; }

# Run a command inside APP_DIR as the app user (or directly when we already are).
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
run_as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    (cd "$APP_DIR" && "$@")
  elif [ "$(id -u)" = 0 ]; then
    runuser -u "$APP_USER" -- env HOME="${APP_HOME:-/var/lib/$APP_USER}" PATH="$PATH" \
      bash -c 'cd "$1" && shift && exec "$@"' _ "$APP_DIR" "$@"
  else
    die "run as root (sudo) or as $APP_USER"
  fi
}

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout"
command -v node >/dev/null || die "node is not installed (see deploy/README.md → Step 1)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node $(node -v) is too old — Node 20+ required"

# Load the environment file so migrate/seed see DATABASE_URL etc. The app
# itself gets the same file through systemd's EnvironmentFile=.
if [ -r "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  echo "! $ENV_FILE not readable — relying on the current environment for DATABASE_URL" >&2
fi
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set (create $ENV_FILE — see deploy/README.md → Step 4)"

log "Universe deploy — $(date -u +%Y-%m-%dT%H:%M:%SZ)  dir=$APP_DIR  user=$APP_USER  node=$(node -v)"

if [ "$DO_GIT" = 1 ]; then
  if [ -z "$REF" ]; then
    REF="$(run_as_app git rev-parse --abbrev-ref HEAD)"
    [ "$REF" != HEAD ] || REF=main
  fi
  log "1. fetching origin and checking out '$REF'"
  run_as_app git fetch --prune --tags origin
  if run_as_app git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    run_as_app git checkout -q -B "$REF" "origin/$REF"
  else
    run_as_app git checkout -q "$REF"
  fi
else
  log "1. git step skipped (--no-git)"
fi
echo "   at $(run_as_app git log -1 --format='%h %s (%ci)')"

if [ "$DO_INSTALL" = 1 ]; then
  log "2. installing dependencies from lockfiles (npm ci)"
  # NODE_ENV=production (from the env file) makes npm skip devDependencies, but
  # the client BUILD needs them (vite) — include them explicitly for root and
  # client. The server ships no devDependencies, so its install stays lean.
  run_as_app npm ci --no-audit --no-fund --include=dev
  run_as_app npm ci --no-audit --no-fund --include=dev --prefix client
  run_as_app npm ci --no-audit --no-fund --prefix server
else
  log "2. install skipped (--skip-install)"
fi

if [ "$DO_BUILD" = 1 ]; then
  log "3. building the client bundle"
  run_as_app npm run build --prefix client
  [ -f "$APP_DIR/client/dist/index.html" ] || die "client/dist/index.html missing after build"
else
  log "3. build skipped (--skip-build)"
fi

log "4. database migrations"
run_as_app npm run migrate:status --prefix server
run_as_app npm run migrate:up --prefix server

if [ "$DO_SEED" = 1 ]; then
  log "5. reference data (countries, currencies, brokers, cedants, …) — never contracts"
  run_as_app node server/src/db/seeds/run.js
  # Test-portfolio hook (server/scripts/seedOnDeploy.js): a no-op unless
  # SEED_ON_DEPLOY is set in the env file. Production keeps it UNSET; a demo box
  # may set SEED_ON_DEPLOY=1 to load the treaty test portfolio once.
  run_as_app npm run --silent seed:deploy --prefix server
else
  log "5. reference seed skipped (--no-seed)"
fi

if [ "$DO_RESTART" = 1 ]; then
  log "6. restarting $SERVICE"
  [ "$(id -u)" = 0 ] || die "restarting the service needs root — re-run with sudo, or use --no-restart"
  systemctl restart "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=0 status "$SERVICE" || true
  log "smoke test"
  BASE_URL="http://127.0.0.1:${PORT:-4000}" "$SCRIPT_DIR/smoke-test.sh"
else
  log "6. restart skipped (--no-restart) — run: sudo systemctl restart $SERVICE && deploy/smoke-test.sh"
fi

log "done — $(run_as_app git log -1 --format='%h') is deployed"
